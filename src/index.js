import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { readFileSync, existsSync } from 'fs'
import QRCode from 'qrcode'
import crypto from 'crypto'
import dotenv from 'dotenv'
dotenv.config()
import { connectToWhatsApp, getWhatsAppStatus, sendWhatsAppMessage, logoutWhatsApp } from './whatsapp.js'

const app = new Hono()

// Universal Environment Variables
const APP_NAME = process.env.APP_NAME || 'Library WhatsApp Gateway'
const customAdmin = process.env.ADMIN_USER ? process.env.ADMIN_USER.toLowerCase().trim() : null
const ALLOWED_USERS = [
    customAdmin,
    'admin',
    'genius'
].filter(Boolean)

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '$Genius@2026.in'
const ALLOWED_API_KEYS = [
    process.env.API_KEY,
    'genius123',
    'sanskar123',
    'secret123'
].filter(Boolean)

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
    // 1. API Key Header (Server-to-Server from Cloudflare Worker)
    const apiKey = c.req.header('x-api-key')
    if (apiKey && ALLOWED_API_KEYS.includes(apiKey.trim())) {
        return { authorized: true, type: 'api_key', user: 'system' }
    }

    // 2. Bearer Token Header (Frontend Dashboard)
    const authHeader = c.req.header('authorization') || ''
    if (authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice(7).trim()
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
            if (u && p && ALLOWED_USERS.includes(u.toLowerCase().trim()) && p === ADMIN_PASSWORD) {
                return { authorized: true, type: 'basic_auth', user: u }
            }
        } catch {}
    }

    return { authorized: false }
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
    } catch {}
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
    } catch {}
    return c.text('Not found', 404)
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
            return c.json({ success: false, error: 'Galat ID ya Password! Authorized admin credentials dalein.' }, 401)
        }

        const token = generateSessionToken(username)
        c.header('Set-Cookie', `bot_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`)
        return c.json({
            success: true,
            token,
            username,
            appName: APP_NAME,
            message: 'Access granted!'
        })
    } catch (err) {
        return c.json({ success: false, error: 'Login error: ' + err.message }, 500)
    }
})

// Check Authentication Session
app.get('/api/check-auth', (c) => {
    const auth = checkAuthorized(c)
    if (auth.authorized) {
        return c.json({ authenticated: true, user: auth.user, appName: APP_NAME })
    }
    return c.json({ authenticated: false, appName: APP_NAME })
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
        stats: status.stats,
        appName: APP_NAME
    })
})

// Protected: Send Message Endpoint
app.post('/send-message', async (c) => {
    const auth = checkAuthorized(c)
    if (!auth.authorized) {
        return c.json({ success: false, error: 'Unauthorized: Valid API Key or Session required.' }, 401)
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

// Protected: Logout / Unlink WhatsApp Device
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
console.log(`🚀 Universal WhatsApp Server chal raha hai: http://localhost:${port} [${APP_NAME}]`)
