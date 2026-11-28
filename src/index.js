import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { readFileSync, existsSync } from 'fs'
import QRCode from 'qrcode'
import crypto from 'crypto'
import dotenv from 'dotenv'
dotenv.config()
import { connectToWhatsApp, flushWhatsAppSession, getWhatsAppStatus, sendWhatsAppMessage, logoutWhatsApp } from './whatsapp.js'
import { hashPassword, loadPersistedAuthMeta, savePersistedAuthMeta, verifyPassword } from './d1Auth.js'

const app = new Hono()

// Universal Environment Variables
const APP_NAME = process.env.APP_NAME || 'HisabDesk WhatsApp Gateway'
const customAdmin = process.env.ADMIN_USER ? process.env.ADMIN_USER.toLowerCase().trim() : null
const ALLOWED_USERS = [customAdmin, 'admin'].filter(Boolean)

const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'hisabdesk123'
const ALLOWED_API_KEYS = [process.env.API_KEY].filter(Boolean)

let passwordHash = null
let mustChangePassword = true
let authMetaLoaded = false

async function ensureAuthMetaLoaded() {
    if (authMetaLoaded) return
    authMetaLoaded = true
    const saved = await loadPersistedAuthMeta()
    if (saved?.passwordHash) {
        passwordHash = saved.passwordHash
        mustChangePassword = Boolean(saved.mustChangePassword)
    }
}

function isAdminPasswordValid(candidate) {
    if (passwordHash) {
        return verifyPassword(candidate, passwordHash)
    }
    return candidate === DEFAULT_ADMIN_PASSWORD
}

// In-memory active session tokens
const activeSessions = new Map()

function generateSessionToken(username) {
    const token = crypto.randomBytes(32).toString('hex')
    activeSessions.set(token, { createdAt: Date.now(), username })
    return token
}

function isValidSession(token) {
    if (!token) return false
    const session = activeSessions.get(token)
    if (!session) return false
    if (Date.now() - session.createdAt > 24 * 60 * 60 * 1000) {
        activeSessions.delete(token)
        return false
    }
    return true
}

function checkAuthorized(c) {
    // 1. API Key Header (Server-to-Server from HisabDesk)
    const apiKey = c.req.header('x-api-key')
    if (apiKey && ALLOWED_API_KEYS.includes(apiKey.trim())) {
        return { authorized: true, type: 'api_key', user: 'system' }
    }

    // 2. Bearer Token Header (API Key from HisabDesk or Frontend Dashboard session)
    const authHeader = c.req.header('authorization') || ''
    if (authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice(7).trim()
        if (ALLOWED_API_KEYS.includes(token)) {
            return { authorized: true, type: 'api_key', user: 'system' }
        }
        if (isValidSession(token)) {
            const sess = activeSessions.get(token)
            return { authorized: true, type: 'session', user: sess?.username || 'admin' }
        }
    }

    // 3. Cookie
    const cookieHeader = c.req.header('cookie') || ''
    const match = cookieHeader.match(/bot_session=([a-f0-9]+)/)
    if (match && isValidSession(match[1])) {
        const sess = activeSessions.get(match[1])
        return { authorized: true, type: 'cookie', user: sess?.username || 'admin' }
    }

    // 4. Basic Auth Fallback
    if (authHeader.startsWith('Basic ')) {
        try {
            const b64 = authHeader.slice(6).trim()
            const decoded = Buffer.from(b64, 'base64').toString('utf-8')
            const [u, p] = decoded.split(':')
            if (u && p && ALLOWED_USERS.includes(u.toLowerCase().trim()) && isAdminPasswordValid(p)) {
                return { authorized: true, type: 'basic_auth', user: u }
            }
        } catch { }
    }

    return { authorized: false }
}

function requirePasswordReady(c) {
    if (mustChangePassword) {
        return c.json({
            success: false,
            mustChangePassword: true,
            error: 'Password change required before using bot.'
        }, 403)
    }
    return null
}

// -------------------------------------------------------------
// STATIC ASSET ROUTES (Brand Logos)
// -------------------------------------------------------------
app.get('/BrandLogo.png', (c) => {
    try {
        if (existsSync('./BrandLogo.png')) {
            const img = readFileSync('./BrandLogo.png')
            c.header('Content-Type', 'image/png')
            c.header('Cache-Control', 'public, max-age=86400')
            return c.body(img)
        }
    } catch { }
    return c.text('Not found', 404)
})

app.get('/iconlogo.png', (c) => {
    try {
        if (existsSync('./iconlogo.png')) {
            const img = readFileSync('./iconlogo.png')
            c.header('Content-Type', 'image/png')
            c.header('Cache-Control', 'public, max-age=86400')
            return c.body(img)
        }
    } catch { }
    return c.text('Not found', 404)
})

// Health check endpoint for Render & self-ping (0 Worker/D1 calls)
app.get('/health', (c) => {
    const status = getWhatsAppStatus()
    return c.json({
        ok: true,
        status: 'healthy',
        appName: APP_NAME,
        mustChangePassword,
        whatsapp: {
            isConnected: status.isConnected,
            userNumber: status.userNumber
        }
    })
})

// Public Config (App Name & Branding)
app.get('/api/config', (c) => {
    return c.json({
        appName: APP_NAME,
        poweredBy: 'Jugaduji'
    })
})

// Web Dashboard UI (Dynamic Client Name Injected)
app.get('/', (c) => {
    try {
        let html = readFileSync('./src/dashboard.html', 'utf-8')
        html = html.replace(/{{APP_NAME}}/g, APP_NAME)
        return c.html(html)
    } catch (error) {
        return c.text('Dashboard file not found!', 500)
    }
})

// Authentication: Login with ID & Password
app.post('/api/login', async (c) => {
    await ensureAuthMetaLoaded()
    try {
        const body = await c.req.json()
        const username = (body.username || body.email || body.id || '').toLowerCase().trim()
        const password = String(body.password || '')

        if (!username || !password) {
            return c.json({ success: false, error: 'Both ID and Password are required.' }, 400)
        }

        const isValidUser = ALLOWED_USERS.includes(username)
        const isValidPass = isAdminPasswordValid(password)

        if (!isValidUser || !isValidPass) {
            return c.json({ success: false, error: 'Invalid ID or Password! Please provide authorized admin credentials.' }, 401)
        }

        const token = generateSessionToken(username)
        c.header('Set-Cookie', `bot_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`)
        return c.json({
            success: true,
            token,
            username,
            appName: APP_NAME,
            mustChangePassword,
            message: 'Access granted!'
        })
    } catch (err) {
        return c.json({ success: false, error: 'Login error: ' + err.message }, 500)
    }
})

// Check Authentication Session
app.get('/api/check-auth', async (c) => {
    await ensureAuthMetaLoaded()
    const auth = checkAuthorized(c)
    if (auth.authorized) {
        return c.json({
            authenticated: true,
            user: auth.user,
            appName: APP_NAME,
            mustChangePassword
        })
    }
    return c.json({ authenticated: false, appName: APP_NAME })
})

// Change Admin Password (Persisted as scrypt hash in D1 or local storage)
app.post('/api/change-password', async (c) => {
    await ensureAuthMetaLoaded()
    const auth = checkAuthorized(c)
    if (!auth.authorized) {
        return c.json({ success: false, error: 'Unauthorized: Please login first.' }, 401)
    }

    try {
        const body = await c.req.json()
        const currentPassword = String(body.currentPassword || '')
        const newPassword = String(body.newPassword || '')

        if (!currentPassword || !newPassword) {
            return c.json({ success: false, error: 'Current and new password are required.' }, 400)
        }
        if (!isAdminPasswordValid(currentPassword)) {
            return c.json({ success: false, error: 'Current password is incorrect.' }, 401)
        }
        if (newPassword.length < 6) {
            return c.json({ success: false, error: 'New password must be at least 6 characters.' }, 400)
        }
        if (newPassword === currentPassword) {
            return c.json({ success: false, error: 'New password must be different from current password.' }, 400)
        }

        const nextHash = hashPassword(newPassword)
        const saved = await savePersistedAuthMeta({
            passwordHash: nextHash,
            mustChangePassword: false
        })
        passwordHash = nextHash
        mustChangePassword = false

        return c.json({
            success: true,
            mustChangePassword: false,
            storage: saved.storage,
            message: 'Admin password updated successfully!'
        })
    } catch (err) {
        return c.json({ success: false, error: 'Failed to update password: ' + err.message }, 500)
    }
})

// HisabDesk Activation Link Info (Zero Copy-Paste)
app.get('/api/activation-info', async (c) => {
    await ensureAuthMetaLoaded()
    const auth = checkAuthorized(c)
    if (!auth.authorized) {
        return c.json({ success: false, error: 'Unauthorized' }, 401)
    }
    const blocked = requirePasswordReady(c)
    if (blocked) return blocked

    const sessionId = process.env.SESSION_ID || 'session-1'
    const botUrl = (process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '')
    const apiKey = process.env.API_KEY || ''
    const sessionSecret = process.env.D1_SYNC_KEY || ''
    const baseActivateUrl = (process.env.HISABDESK_ACTIVATE_URL || 'https://app.hisabdesk.in').replace(/\/+$/, '')

    // Put secrets in URL fragment (#) so they are never sent in Referer headers or server logs
    const params = new URLSearchParams({ sessionId, botUrl, apiKey, sessionSecret })
    return c.json({
        success: true,
        sessionId,
        botUrl,
        apiKey,
        activateUrl: `${baseActivateUrl}/#wa-activate&${params.toString()}`
    })
})

// Logout / Lock Web Console
app.post('/api/logout-session', (c) => {
    const authHeader = c.req.header('authorization') || ''
    if (authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice(7).trim()
        activeSessions.delete(token)
    }
    const cookieHeader = c.req.header('cookie') || ''
    const match = cookieHeader.match(/bot_session=([a-f0-9]+)/)
    if (match) {
        activeSessions.delete(match[1])
    }
    c.header('Set-Cookie', 'bot_session=; Path=/; HttpOnly; Max-Age=0')
    return c.json({ success: true, message: 'Console locked.' })
})

// Protected: Live WhatsApp Status & QR Code
app.get('/status', async (c) => {
    await ensureAuthMetaLoaded()
    const auth = checkAuthorized(c)
    if (!auth.authorized) {
        return c.json({
            success: false,
            authenticated: false,
            error: 'Access Denied: Please log in with authorized ID and Password.'
        }, 401)
    }
    const blocked = requirePasswordReady(c)
    if (blocked) return blocked

    const status = getWhatsAppStatus()
    let qrImage = null

    if (status.qrCodeData) {
        qrImage = await QRCode.toDataURL(status.qrCodeData)
    }

    return c.json({
        success: true,
        authenticated: true,
        isConnected: status.isConnected,
        userNumber: status.userNumber,
        qrImage: qrImage,
        stats: status.stats,
        appName: APP_NAME
    })
})

// Protected: Send Message Endpoint (supports both /send-message and /send, {number,message} and {to,text})
async function handleSendMessage(c) {
    await ensureAuthMetaLoaded()
    const auth = checkAuthorized(c)
    if (!auth.authorized) {
        return c.json({ success: false, error: 'Unauthorized: Valid API Key or Session required.' }, 401)
    }
    const blocked = requirePasswordReady(c)
    if (blocked) return blocked

    try {
        const body = await c.req.json()
        const number = body.number || body.to
        const message = body.message || body.text
        if (!number || !message) {
            return c.json({ success: false, error: 'Both phone number and message are required.' }, 400)
        }

        const result = await sendWhatsAppMessage(number, message)
        return c.json(result)
    } catch (error) {
        return c.json({ success: false, error: error.message }, 500)
    }
}

app.post('/send-message', handleSendMessage)
app.post('/send', handleSendMessage)

// Protected: Logout / Unlink WhatsApp Device
app.post('/logout', async (c) => {
    await ensureAuthMetaLoaded()
    const auth = checkAuthorized(c)
    if (!auth.authorized) {
        return c.json({
            success: false,
            error: 'Access Denied: Only authorized administrators can logout the WhatsApp device.'
        }, 401)
    }
    const blocked = requirePasswordReady(c)
    if (blocked) return blocked

    await logoutWhatsApp()
    return c.json({ success: true, message: 'WhatsApp device unlinked successfully!' })
})

export { app }

if (process.env.NODE_ENV !== 'test') {
    ensureAuthMetaLoaded().catch(() => { })
    connectToWhatsApp()

    const port = process.env.PORT || 3000
    serve({ fetch: app.fetch, port })
    console.log(`🚀 Universal WhatsApp Server running on: http://localhost:${port} [${APP_NAME}]`)

    // Render self-ping to keep instance awake (0 Worker/D1 calls)
    const externalUrl = process.env.RENDER_EXTERNAL_URL?.trim()?.replace(/\/+$/, '')
    if (externalUrl && process.env.KEEP_ALIVE !== 'false') {
        const pingIntervalMs = Number(process.env.KEEP_ALIVE_INTERVAL_MS || 10 * 60 * 1000)
        const timer = setInterval(() => {
            fetch(`${externalUrl}/health`).catch(() => { })
        }, pingIntervalMs)
        if (typeof timer.unref === 'function') timer.unref()
        console.log(`[KeepAlive] Self-ping enabled every ${Math.round(pingIntervalMs / 60000)}m -> ${externalUrl}/health`)
    }

    const handleShutdown = async () => {
        await flushWhatsAppSession()
        process.exit(0)
    }
    process.on('SIGTERM', handleShutdown)
    process.on('SIGINT', handleShutdown)
}
