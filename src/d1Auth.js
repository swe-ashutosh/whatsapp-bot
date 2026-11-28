import { initAuthCreds, BufferJSON, WAProto } from '@whiskeysockets/baileys'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Hashes a password with a random salt using scrypt.
 */
export function hashPassword(password) {
    const salt = randomBytes(16).toString('hex')
    const derived = scryptSync(String(password), salt, 64).toString('hex')
    return `${salt}:${derived}`
}

/**
 * Verifies a plaintext password against a stored scrypt hash.
 */
export function verifyPassword(password, storedHash) {
    if (!storedHash || !storedHash.includes(':')) return false
    const [salt, keyHex] = storedHash.split(':')
    if (!salt || !keyHex) return false
    const derived = scryptSync(String(password), salt, 64)
    const keyBuf = Buffer.from(keyHex, 'hex')
    if (derived.length !== keyBuf.length) return false
    return timingSafeEqual(derived, keyBuf)
}

/**
 * Creates a Cloudflare D1 storage client using either:
 * 1. Direct Cloudflare D1 REST API (CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID, CLOUDFLARE_API_TOKEN)
 * 2. HisabDesk D1 HTTP Sync endpoint (D1_SYNC_URL, optional D1_SYNC_KEY / API_KEY)
 */
export function createD1Client(env = process.env, fetchImpl = fetch) {
    const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim()
    const databaseId = env.CLOUDFLARE_D1_DATABASE_ID?.trim()
    const apiToken = env.CLOUDFLARE_API_TOKEN?.trim()

    if (accountId && databaseId && apiToken) {
        const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`

        const query = async (sql, params = []) => {
            const res = await fetchImpl(endpoint, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${apiToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ sql, params })
            })

            if (!res.ok) {
                throw new Error(`Cloudflare D1 HTTP ${res.status}`)
            }

            const json = await res.json()
            if (!json?.success) {
                const msg = json?.errors?.[0]?.message || 'Cloudflare D1 query failed'
                throw new Error(msg)
            }
            return json.result?.[0]?.results || []
        }

        return {
            mode: 'cloudflare-d1-rest',
            async ensureTable() {
                try {
                    await query(
                        'CREATE TABLE IF NOT EXISTS wa_sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER)'
                    )
                    return true
                } catch (e) {
                    console.warn('[WhatsApp D1] Table check failed:', e.message)
                    return false
                }
            },
            async get(id) {
                const rows = await query('SELECT data FROM wa_sessions WHERE id = ? LIMIT 1', [id])
                return rows[0]?.data ? JSON.parse(rows[0].data) : null
            },
            async set(id, data) {
                await query(
                    'INSERT OR REPLACE INTO wa_sessions (id, data, updated_at) VALUES (?, ?, ?)',
                    [id, JSON.stringify(data), Date.now()]
                )
            },
            async del(id) {
                await query('DELETE FROM wa_sessions WHERE id = ?', [id])
            }
        }
    }

    const syncUrl = env.D1_SYNC_URL?.trim()?.replace(/\/+$/, '')
    if (syncUrl) {
        const syncKey = (env.D1_SYNC_KEY || '').trim()
        const headers = {
            'Content-Type': 'application/json',
            ...(syncKey ? { 'x-session-secret': syncKey } : {})
        }

        return {
            mode: 'hisabdesk-d1-sync',
            async ensureTable() {
                return true
            },
            async get(id) {
                const res = await fetchImpl(`${syncUrl}?id=${encodeURIComponent(id)}`, { headers })
                if (res.status === 404) return null
                if (res.status === 403) {
                    const err = new Error('Bot is disabled or not activated in HisabDesk')
                    err.code = 'REMOTE_DISABLED'
                    throw err
                }
                if (!res.ok) throw new Error(`D1 sync GET HTTP ${res.status}`)
                const json = await res.json()
                return json?.data ?? null
            },
            async set(id, data) {
                const res = await fetchImpl(syncUrl, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ id, data })
                })
                if (res.status === 403) {
                    const err = new Error('Bot is disabled or not activated in HisabDesk')
                    err.code = 'REMOTE_DISABLED'
                    throw err
                }
                if (!res.ok) throw new Error(`D1 sync POST HTTP ${res.status}`)
            },
            async del(id) {
                const res = await fetchImpl(`${syncUrl}?id=${encodeURIComponent(id)}`, {
                    method: 'DELETE',
                    headers
                })
                if (!res.ok && res.status !== 404) {
                    throw new Error(`D1 sync DELETE HTTP ${res.status}`)
                }
            }
        }
    }

    return null
}

/**
 * Single-blob Baileys auth state backed by Cloudflare D1 + RAM cache.
 * Minimizes Worker/D1 API calls: 1 GET on startup, in-memory key ops, debounced 1 POST on save.
 */
export async function useD1AuthState(client, sessionId = 'session-1', options = {}) {
    const debounceMs = options.debounceMs ?? 30000
    let remoteDisabled = false

    let blob = null
    try {
        blob = await client.get(sessionId)
    } catch (e) {
        if (e.code === 'REMOTE_DISABLED') remoteDisabled = true
        console.warn('[WhatsApp D1 Auth] Initial load notice:', e.message)
    }

    const parsedBlob = blob ? JSON.parse(JSON.stringify(blob), BufferJSON.reviver) : {}
    let creds = parsedBlob.creds || initAuthCreds()
    const keysStore = parsedBlob.keys && typeof parsedBlob.keys === 'object' ? parsedBlob.keys : {}
    let authMeta = parsedBlob.auth && typeof parsedBlob.auth === 'object' ? parsedBlob.auth : {}

    let dirty = !blob?.creds
    let flushTimer = null

    const flush = async () => {
        if (flushTimer) {
            clearTimeout(flushTimer)
            flushTimer = null
        }
        if (!dirty || remoteDisabled) return
        dirty = false
        try {
            const payload = JSON.parse(
                JSON.stringify({ creds, keys: keysStore, auth: authMeta }, BufferJSON.replacer)
            )
            await client.set(sessionId, payload)
        } catch (e) {
            dirty = true
            if (e.code === 'REMOTE_DISABLED') remoteDisabled = true
            console.warn('[WhatsApp D1 Auth] flush error:', e.message)
        }
    }

    const scheduleFlush = () => {
        dirty = true
        if (flushTimer) return
        flushTimer = setTimeout(() => {
            flush().catch(() => { })
        }, debounceMs)
        if (typeof flushTimer.unref === 'function') flushTimer.unref()
    }

    if (dirty && !remoteDisabled) {
        await flush()
    }

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {}
                    const typeStore = keysStore[type] || {}
                    for (const id of ids) {
                        let value = typeStore[id] ?? null
                        if (type === 'app-state-sync-key' && value) {
                            value = WAProto.Message.AppStateSyncKeyData.fromObject(value)
                        }
                        data[id] = value
                    }
                    return data
                },
                set: async (data) => {
                    for (const category in data) {
                        if (!keysStore[category]) keysStore[category] = {}
                        for (const id in data[category]) {
                            const value = data[category][id]
                            if (value) keysStore[category][id] = value
                            else delete keysStore[category][id]
                        }
                    }
                    scheduleFlush()
                }
            }
        },
        saveCreds: async () => {
            scheduleFlush()
        },
        flush,
        getAuthMeta: () => authMeta,
        setAuthMeta: async (nextMeta) => {
            authMeta = { ...authMeta, ...nextMeta }
            dirty = true
            await flush()
        },
        isRemoteDisabled: () => remoteDisabled
    }
}

/**
 * Loads persisted password metadata from D1 single-blob or local fallback file.
 */
export async function loadPersistedAuthMeta(env = process.env, fetchImpl = fetch) {
    const sessionId = env.SESSION_ID || 'session-1'
    const d1Client = createD1Client(env, fetchImpl)
    if (d1Client) {
        try {
            const blob = await d1Client.get(sessionId)
            if (blob?.auth?.passwordHash) {
                return {
                    passwordHash: String(blob.auth.passwordHash),
                    mustChangePassword: Boolean(blob.auth.mustChangePassword)
                }
            }
        } catch (e) {
            console.warn('[WhatsApp Auth] Failed to load auth meta from D1:', e.message)
        }
    }

    const authDir = env.AUTH_DIR || './auth_info_baileys'
    const filePath = join(authDir, 'admin_auth.json')
    try {
        if (existsSync(filePath)) {
            const parsed = JSON.parse(readFileSync(filePath, 'utf-8'))
            if (parsed?.passwordHash) {
                return {
                    passwordHash: String(parsed.passwordHash),
                    mustChangePassword: Boolean(parsed.mustChangePassword)
                }
            }
        }
    } catch { }
    return null
}

/**
 * Saves hashed admin password metadata to D1 single-blob (preserving existing blob) or local fallback file.
 */
export async function savePersistedAuthMeta(meta, env = process.env, fetchImpl = fetch) {
    const sessionId = env.SESSION_ID || 'session-1'
    const d1Client = createD1Client(env, fetchImpl)
    if (d1Client) {
        let existing = {}
        try {
            existing = (await d1Client.get(sessionId)) || {}
        } catch {
            existing = {}
        }
        const nextBlob = {
            ...existing,
            auth: {
                ...(existing.auth || {}),
                ...meta,
                updatedAt: Date.now()
            }
        }
        await d1Client.set(sessionId, nextBlob)
        return { storage: d1Client.mode }
    }

    const authDir = env.AUTH_DIR || './auth_info_baileys'
    if (!existsSync(authDir)) mkdirSync(authDir, { recursive: true })
    writeFileSync(
        join(authDir, 'admin_auth.json'),
        JSON.stringify({ ...meta, updatedAt: Date.now() }, null, 2),
        'utf-8'
    )
    return { storage: 'local-file' }
}
