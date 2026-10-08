import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { readFileSync } from 'fs'
import QRCode from 'qrcode'
import crypto from 'crypto'
import dotenv from 'dotenv'
dotenv.config()
import { connectToWhatsApp, getWhatsAppStatus, sendWhatsAppMessage, logoutWhatsApp } from './whatsapp.js'

const app = new Hono()

// Supported Admin Credentials
const PRIMARY_ADMIN = (process.env.ADMIN_USER || 'geniuslibrarymadhupur@gmail.com').toLowerCase().trim()
const ALLOWED_USERS = [
    PRIMARY_ADMIN,
    'admin',
    'genius'
]
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '$Genius@2026.in'
const ALLOWED_API_KEYS = [
    process.env.API_KEY || 'genius123',
    'genius123',
    'sanskar123'
]

// In-memory active authenticated session tokens
// token -> { createdAt: number, username: string }
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
    // 24 hour session expiration
    if (Date.now() - session.createdAt > 24 * 60 * 60 * 1000) {
        activeSessions.delete(token)
        return false
    }
    return true
}

function checkAuthorized(c) {
    // 1. Check API Key header (Used by Cloudflare Worker API & Web queue)
    const apiKey = c.req.header('x-api-key')
    if (apiKey && ALLOWED_API_KEYS.includes(apiKey.trim())) {
        return { authorized: true, type: 'api_key', user: 'system' }
    }

    // 2. Check Bearer Token header (Used by Web Dashboard frontend)
    const authHeader = c.req.header('authorization') || ''
    if (authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice(7).trim()
        if (isValidSession(token)) {
            const sess = activeSessions.get(token)
            return { authorized: true, type: 'session', user: sess?.username || 'admin' }
        }
    }

    // 3. Check Cookie
    const cookieHeader = c.req.header('cookie') || ''
    const match = cookieHeader.match(/bot_session=([a-f0-9]+)/)
    if (match && isValidSession(match[1])) {
        const sess = activeSessions.get(match[1])
        return { authorized: true, type: 'cookie', user: sess?.username || 'admin' }
    }

    // 4. Check HTTP Basic Auth header as fallback
    if (authHeader.startsWith('Basic ')) {
        try {
            const b64 = authHeader.slice(6).trim()
            const decoded = Buffer.from(b64, 'base64').toString('utf-8')
            const [u, p] = decoded.split(':')
            if (u && p && ALLOWED_USERS.includes(u.toLowerCase().trim()) && p === ADMIN_PASSWORD) {
                return { authorized: true, type: 'basic_auth', user: u }
            }
        } catch {}
    }

    return { authorized: false }
}

// -------------------------------------------------------------
// ROUTES
// -------------------------------------------------------------

// Web Dashboard UI
app.get('/', (c) => {
    try {
        const html = readFileSync('./src/dashboard.html', 'utf-8')
        return c.html(html)
    } catch (error) {
        return c.text('Dashboard file not found!', 500)
    }
})

// Authentication: Login with ID & Password
app.post('/api/login', async (c) => {
    try {
        const body = await c.req.json()
        const username = (body.username || body.email || body.id || '').toLowerCase().trim()
        const password = String(body.password || '')

        if (!username || !password) {
            return c.json({ success: false, error: 'ID aur Password dono zaruri hain.' }, 400)
        }

        const isValidUser = ALLOWED_USERS.includes(username)
        const isValidPass = password === ADMIN_PASSWORD

        if (!isValidUser || !isValidPass) {
            return c.json({ success: false, error: 'Galat ID ya Password! Sirf authorized admin hi access kar sakte hain.' }, 401)
        }

        const token = generateSessionToken(username)
        c.header('Set-Cookie', `bot_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`)
        return c.json({
            success: true,
            token,
            username,
            message: 'Access granted!'
        })
    } catch (err) {
        return c.json({ success: false, error: 'Login process error: ' + err.message }, 500)
    }
})

// Authentication: Check current session
app.get('/api/check-auth', (c) => {
    const auth = checkAuthorized(c)
    if (auth.authorized) {
        return c.json({ authenticated: true, user: auth.user })
    }
    return c.json({ authenticated: false })
})

// Authentication: Logout from web session / lock console
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
    return c.json({ success: true, message: 'Console locked successfully.' })
})

// Protected: Get WhatsApp Connection & QR Status
app.get('/status', async (c) => {
    const auth = checkAuthorized(c)
    if (!auth.authorized) {
        return c.json({
            success: false,
            authenticated: false,
            error: 'Access Denied: Please log in with authorized ID and Password.'
        }, 401)
    }

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
        stats: status.stats
    })
})

// Protected: Send WhatsApp Message (Worker or authorized session)
app.post('/send-message', async (c) => {
    const auth = checkAuthorized(c)
    if (!auth.authorized) {
        return c.json({ success: false, error: 'Galat API Key ya Session! ID & Password required.' }, 401)
    }

    try {
        const body = await c.req.json()
        const { number, message } = body
        if (!number || !message) {
            return c.json({ success: false, error: 'Number aur message dono zaruri hain.' }, 400)
        }
        
        const result = await sendWhatsAppMessage(number, message)
        return c.json(result)
    } catch (error) {
        return c.json({ success: false, error: error.message }, 500)
    }
})

// Protected: Disconnect / Logout WhatsApp Device
app.post('/logout', async (c) => {
    const auth = checkAuthorized(c)
    if (!auth.authorized) {
        return c.json({
            success: false,
            error: 'Access Denied: Sirf authorized admin hi WhatsApp device logout kar sakte hain. ID & Password required.'
        }, 401)
    }

    await logoutWhatsApp()
    return c.json({ success: true, message: 'WhatsApp device unlinked successfully!' })
})

connectToWhatsApp()

const port = process.env.PORT || 3000
serve({ fetch: app.fetch, port })
console.log(`🚀 Server chal raha hai: http://localhost:${port}`)
