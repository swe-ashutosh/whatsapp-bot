import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, rmSync } from 'node:fs'

process.env.NODE_ENV = 'test'
process.env.API_KEY = 'test-api-key-123'
process.env.ADMIN_USER = 'admin'
process.env.ADMIN_PASSWORD = 'hisabdesk123'
process.env.APP_NAME = 'HisabDesk Test Bot'
process.env.SESSION_ID = 'test-session-xyz'
process.env.RENDER_EXTERNAL_URL = 'https://hisabdesk-whatsapp-bot-test.onrender.com'
process.env.HISABDESK_ACTIVATE_URL = 'https://hisabdesk.com/whatsapp/activate'
process.env.AUTH_DIR = './.tmp-test-auth'

const { app } = await import('../src/index.js')
const {
    getWhatsAppStatus,
    sendWhatsAppMessage,
    getRandomDelayMs,
    getBatchCooldownMs,
    applyMessageVariation,
    checkAntiBanLimits,
    resetAntiBanState
} = await import('../src/whatsapp.js')
const { createD1Client, useD1AuthState, hashPassword, verifyPassword } = await import('../src/d1Auth.js')

test('GET /health returns 200 with healthy status and mustChangePassword flag', async () => {
    const res = await app.request('/health')
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.status, 'healthy')
    assert.equal(body.appName, 'HisabDesk Test Bot')
    assert.equal(body.mustChangePassword, true)
    assert.equal(typeof body.whatsapp.isConnected, 'boolean')
})

test('GET /api/config returns configured appName', async () => {
    const res = await app.request('/api/config')
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.appName, 'HisabDesk Test Bot')
})

test('hardcoded fallback API keys (sanskar123, genius123, secret123) are rejected', async () => {
    for (const badKey of ['sanskar123', 'genius123', 'secret123']) {
        const res = await app.request('/status', {
            headers: { 'x-api-key': badKey }
        })
        assert.equal(res.status, 401)
    }
})

test('forceful password change blocks /status, /send-message, /logout until password is changed', async () => {
    try {
        // Login with default password
        const loginRes = await app.request('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: 'hisabdesk123' })
        })
        assert.equal(loginRes.status, 200)
        const loginBody = await loginRes.json()
        assert.equal(loginBody.mustChangePassword, true)
        const token = loginBody.token

        // Protected endpoints must return 403 while mustChangePassword is true
        const blockedStatus = await app.request('/status', {
            headers: { Authorization: `Bearer ${token}` }
        })
        assert.equal(blockedStatus.status, 403)
        assert.equal((await blockedStatus.json()).mustChangePassword, true)

        const blockedSend = await app.request('/send-message', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': 'test-api-key-123' },
            body: JSON.stringify({ number: '919999999999', message: 'Hi' })
        })
        assert.equal(blockedSend.status, 403)

        // Reject same password
        const samePassRes = await app.request('/api/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ currentPassword: 'hisabdesk123', newPassword: 'hisabdesk123' })
        })
        assert.equal(samePassRes.status, 400)

        // Reject short password
        const shortPassRes = await app.request('/api/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ currentPassword: 'hisabdesk123', newPassword: '123' })
        })
        assert.equal(shortPassRes.status, 400)

        // Reject wrong current password
        const wrongCurRes = await app.request('/api/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ currentPassword: 'wrong', newPassword: 'new-strong-password' })
        })
        assert.equal(wrongCurRes.status, 401)

        // Valid password change unlocks endpoints
        const changeRes = await app.request('/api/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ currentPassword: 'hisabdesk123', newPassword: 'new-strong-password' })
        })
        assert.equal(changeRes.status, 200)
        const changeBody = await changeRes.json()
        assert.equal(changeBody.success, true)
        assert.equal(changeBody.mustChangePassword, false)

        // Stored password file must be scrypt hashed, not plaintext
        const savedJson = readFileSync('./.tmp-test-auth/admin_auth.json', 'utf-8')
        assert.doesNotMatch(savedJson, /new-strong-password/)
        assert.match(savedJson, /passwordHash/)

        // Old password fails, new password succeeds
        const oldLogin = await app.request('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: 'hisabdesk123' })
        })
        assert.equal(oldLogin.status, 401)

        const newLogin = await app.request('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: 'new-strong-password' })
        })
        assert.equal(newLogin.status, 200)
        assert.equal((await newLogin.json()).mustChangePassword, false)

        // /status now works
        const statusRes = await app.request('/status', {
            headers: { 'x-api-key': 'test-api-key-123' }
        })
        assert.equal(statusRes.status, 200)
        assert.equal((await statusRes.json()).authenticated, true)

        // /api/activation-info returns zero-copy-paste link
        const actRes = await app.request('/api/activation-info', {
            headers: { Authorization: `Bearer ${token}` }
        })
        assert.equal(actRes.status, 200)
        const actBody = await actRes.json()
        assert.equal(actBody.sessionId, 'test-session-xyz')
        assert.equal(actBody.botUrl, 'https://hisabdesk-whatsapp-bot-test.onrender.com')
        assert.equal(actBody.apiKey, 'test-api-key-123')
        assert.match(actBody.activateUrl, /^https:\/\/hisabdesk\.com\/whatsapp\/activate\?/)

        // /send-message validates payload & returns 500 when disconnected
        const badSend = await app.request('/send-message', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': 'test-api-key-123' },
            body: JSON.stringify({ number: '919999999999' })
        })
        assert.equal(badSend.status, 400)

        const discSend = await app.request('/send-message', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': 'test-api-key-123' },
            body: JSON.stringify({ number: '919999999999', message: 'Hello' })
        })
        assert.equal(discSend.status, 500)
        assert.match((await discSend.json()).error, /disconnected/i)

        // HisabDesk format: POST /send with Authorization: Bearer <API_KEY> and { to, text }
        const hdSend = await app.request('/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-api-key-123' },
            body: JSON.stringify({ to: '919999999999', text: 'Hello from HisabDesk' })
        })
        assert.equal(hdSend.status, 500)
        assert.match((await hdSend.json()).error, /disconnected/i)
    } finally {
        rmSync('./.tmp-test-auth', { recursive: true, force: true })
    }
})

test('scrypt hashPassword and verifyPassword work correctly', () => {
    const hash = hashPassword('secret-pass-99')
    assert.notEqual(hash, 'secret-pass-99')
    assert.equal(verifyPassword('secret-pass-99', hash), true)
    assert.equal(verifyPassword('wrong-pass', hash), false)
    assert.equal(verifyPassword('secret-pass-99', 'invalid'), false)
})

test('single-blob useD1AuthState minimizes API calls (1 GET, RAM key ops, debounced 1 POST)', async () => {
    let getCalls = 0
    let postCalls = 0
    const store = new Map()

    const mockFetch = async (url, opts = {}) => {
        const parsed = new URL(url)
        const id = parsed.searchParams.get('id')
        if (opts.method === 'POST') {
            postCalls++
            const body = JSON.parse(opts.body)
            store.set(body.id, body.data)
            return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        getCalls++
        if (!store.has(id)) return new Response(JSON.stringify({ data: null }), { status: 404 })
        return new Response(JSON.stringify({ data: store.get(id) }), { status: 200 })
    }

    const client = createD1Client({ D1_SYNC_URL: 'https://hisabdesk.com/api/wa-session' }, mockFetch)
    const auth = await useD1AuthState(client, 'tenant-blob-1', { debounceMs: 5000 })

    // 1 GET for initial load + 1 POST for initial creds
    assert.equal(getCalls, 1)
    assert.equal(postCalls, 1)

    // Multiple key reads/writes happen purely in RAM (0 extra Worker calls)
    await auth.state.keys.set({ session: { '919999999999': { chainKey: 'k1' }, '918888888888': { chainKey: 'k2' } } })
    const fetched = await auth.state.keys.get('session', ['919999999999', '918888888888'])
    assert.deepEqual(fetched['919999999999'], { chainKey: 'k1' })
    assert.deepEqual(fetched['918888888888'], { chainKey: 'k2' })
    assert.equal(getCalls, 1)
    assert.equal(postCalls, 1)

    // Explicit flush sends 1 POST with full blob
    await auth.flush()
    assert.equal(postCalls, 2)
    assert.ok(store.get('tenant-blob-1').keys.session['919999999999'])
})

test('createD1Client marks remote disabled on 403', async () => {
    const client = createD1Client(
        { D1_SYNC_URL: 'https://hisabdesk.com/api/wa-session' },
        async () => new Response('Forbidden', { status: 403 })
    )
    const auth = await useD1AuthState(client, 'disabled-session')
    assert.equal(auth.isRemoteDisabled(), true)
})

test('whatsapp module exposes status and rejects send when disconnected', async () => {
    const status = getWhatsAppStatus()
    assert.equal(status.isConnected, false)
    await assert.rejects(() => sendWhatsAppMessage('919999999999', 'test', { waitMs: 0 }), /disconnected/i)
})

test('anti-ban helpers enforce 10s-20s delay, 1-5m batch cooldown, variation + reply prompt, and 150/hr cap', () => {
    for (let i = 0; i < 20; i++) {
        const d = getRandomDelayMs(10000, 20000)
        assert.ok(d >= 10000 && d <= 20000)
    }

    assert.equal(getBatchCooldownMs(24, 25, 60000, 300000), 0)
    const cooldown = getBatchCooldownMs(25, 25, 60000, 300000)
    assert.ok(cooldown >= 60000 && cooldown <= 300000)

    const varied = applyMessageVariation('Invoice #101 paid', new Date('2026-11-28T10:15:00'))
    assert.match(varied, /^Invoice #101 paid\n\n_/)
    assert.match(varied, /10:15/)
    assert.match(varied, /Reply \*(OK|1)\*/i)

    resetAntiBanState()
    checkAntiBanLimits('919999999999@s.whatsapp.net', 'Hello', 1000)
})

test('repo config removes Supabase and provides true 1-click Render blueprint', () => {
    const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))
    assert.equal(pkg.dependencies['@supabase/supabase-js'], undefined)

    const renderYaml = readFileSync('./render.yaml', 'utf-8')
    assert.match(renderYaml, /healthCheckPath:\s*\/health/)
    assert.match(renderYaml, /pnpm install --frozen-lockfile/)
    assert.match(renderYaml, /pnpm start/)
    assert.match(renderYaml, /D1_SYNC_URL/)
    assert.match(renderYaml, /HISABDESK_ACTIVATE_URL/)
    assert.match(renderYaml, /KEEP_ALIVE/)
    assert.match(renderYaml, /ADMIN_PASSWORD[\s\S]*value:\s*hisabdesk123/)
    assert.match(renderYaml, /SESSION_ID[\s\S]*generateValue:\s*true/)
    assert.doesNotMatch(renderYaml, /sync:\s*false/)
    assert.doesNotMatch(renderYaml, /SUPABASE/i)

    assert.equal(existsSync('./.env.example'), true)
})
