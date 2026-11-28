import { 
    makeWASocket, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    useMultiFileAuthState 
} from '@whiskeysockets/baileys'
import pino from 'pino'
import dotenv from 'dotenv'
import { createD1Client, useD1AuthState } from './d1Auth.js'

dotenv.config()

let sock = null
let qrCodeData = null
let isConnected = false
let isConnecting = false
let userNumber = null
let activeFlushFn = null

let totalMessagesSent = 0
let botStartTime = Date.now()
let lastMessageTime = 'None yet'

const messageQueue = []
let isProcessingQueue = false

// Anti-ban tracking stores
const recentMessages = new Map()
const sentTimestamps = []

const formatUptime = (ms) => {
    const h = Math.floor(ms / 3600000)
    const m = Math.floor((ms % 3600000) / 60000)
    const s = Math.floor((ms % 60000) / 1000)
    return `${h}h ${m}m ${s}s`
}

/**
 * Returns a random integer delay in ms between minMs and maxMs (default 10s-20s).
 */
export function getRandomDelayMs(
    minMs = Number(process.env.MIN_DELAY_MS || 10000),
    maxMs = Number(process.env.MAX_DELAY_MS || 20000)
) {
    const low = Math.max(0, Math.min(minMs, maxMs))
    const high = Math.max(low, maxMs)
    return Math.floor(Math.random() * (high - low + 1)) + low
}

/**
 * Returns a 1-5 min batch cooldown in ms every N messages (0 otherwise).
 */
export function getBatchCooldownMs(
    sentCount,
    everyN = Number(process.env.COOLDOWN_EVERY_N || 25),
    minMs = Number(process.env.COOLDOWN_MIN_MS || 60000),
    maxMs = Number(process.env.COOLDOWN_MAX_MS || 300000)
) {
    if (everyN > 0 && sentCount > 0 && sentCount % everyN === 0) {
        return getRandomDelayMs(minMs, maxMs)
    }
    return 0
}

/**
 * Appends a subtle, natural time/greeting variation and two-way reply prompt.
 */
export function applyMessageVariation(text, now = new Date()) {
    if (process.env.AUTO_MESSAGE_VARIATION === 'false') return text
    const hour = now.getHours()
    const greetings = hour < 12
        ? ['Good morning', 'Have a great morning', 'Best regards']
        : hour < 17
            ? ['Good afternoon', 'Have a great day', 'Best regards']
            : ['Good evening', 'Warm regards', 'Best regards']
    const replyPrompts = [
        'Reply *OK* to confirm',
        'Reply *1* if received',
        'Please reply *OK* once seen'
    ]
    const greeting = greetings[Math.floor(Math.random() * greetings.length)]
    const replyPrompt = replyPrompts[Math.floor(Math.random() * replyPrompts.length)]
    const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
    const dateStr = now.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
    return `${text}\n\n_${greeting} | ${dateStr}, ${timeStr}_\n_${replyPrompt}_`
}

/**
 * Enforces hourly (default 150/hr) and daily (default 1000/day) rate limits and duplicate protection.
 */
export function checkAntiBanLimits(jid, rawText, nowMs = Date.now()) {
    const maxPerHour = Number(process.env.MAX_MESSAGES_PER_HOUR || 150)
    const maxPerDay = Number(process.env.MAX_MESSAGES_PER_DAY || 1000)
    const dupWindowMs = Number(process.env.DUPLICATE_WINDOW_MS || 60000)

    const oneDayAgo = nowMs - 24 * 60 * 60 * 1000
    const oneHourAgo = nowMs - 60 * 60 * 1000

    while (sentTimestamps.length > 0 && sentTimestamps[0] < oneDayAgo) {
        sentTimestamps.shift()
    }

    const dayCount = sentTimestamps.length
    const hourCount = sentTimestamps.filter((t) => t >= oneHourAgo).length

    if (hourCount >= maxPerHour) {
        throw new Error(`Hourly rate limit reached (${maxPerHour}/hr). Please try later.`)
    }
    if (dayCount >= maxPerDay) {
        throw new Error(`Daily rate limit reached (${maxPerDay}/day). Please try tomorrow.`)
    }

    const dupKey = `${jid}::${rawText.trim()}`
    const lastSentAt = recentMessages.get(dupKey)
    if (lastSentAt && nowMs - lastSentAt < dupWindowMs) {
        throw new Error('Duplicate message blocked to prevent WhatsApp spam detection.')
    }
}

export function resetAntiBanState() {
    recentMessages.clear()
    sentTimestamps.length = 0
}

// Selects Cloudflare D1 single-blob if configured; otherwise local multi-file disk storage
async function getAuthState() {
    const sessionId = process.env.SESSION_ID || 'session-1'
    const d1Client = createD1Client()
    if (d1Client && await d1Client.ensureTable()) {
        console.log(`[WhatsApp] Using Cloudflare D1 single-blob storage (${d1Client.mode}): ${sessionId}`)
        const d1State = await useD1AuthState(d1Client, sessionId)
        activeFlushFn = d1State.flush
        return d1State
    }

    const authDir = process.env.AUTH_DIR || './auth_info_baileys'
    console.log(`[WhatsApp] Using local multi-file session storage: ${authDir}`)
    activeFlushFn = null
    return await useMultiFileAuthState(authDir)
}

export async function flushWhatsAppSession() {
    if (typeof activeFlushFn === 'function') {
        await activeFlushFn()
    }
}

export async function connectToWhatsApp() {
    isConnecting = true
    try {
        const { state, saveCreds } = await getAuthState()
        const { version } = await fetchLatestBaileysVersion()

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ['Desktop', 'Chrome', '1.0.0']
        })

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update

            if (qr) {
                qrCodeData = qr
                isConnecting = false
            }

            if (connection === 'close') {
                isConnected = false
                isConnecting = false
                userNumber = null
                const statusCode = lastDisconnect?.error?.output?.statusCode
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut
                console.log(`[WhatsApp] Connection closed (code: ${statusCode}). Reconnecting: ${shouldReconnect}`)
                if (shouldReconnect) {
                    setTimeout(() => connectToWhatsApp(), 3000)
                } else {
                    qrCodeData = null
                    await flushWhatsAppSession()
                }
            } else if (connection === 'open') {
                isConnected = true
                isConnecting = false
                qrCodeData = null
                userNumber = sock.user.id.split(':')[0]
                console.log(`[WhatsApp] Connected successfully! Active number: +${userNumber}`)
                await flushWhatsAppSession()
            }
        })

        sock.ev.on('creds.update', saveCreds)
    } catch (err) {
        isConnecting = false
        console.error('[WhatsApp] Connection initialization error:', err)
        setTimeout(() => connectToWhatsApp(), 5000)
    }
}

const processQueue = async () => {
    if (isProcessingQueue || messageQueue.length === 0) return
    isProcessingQueue = true

    while (messageQueue.length > 0) {
        const { jid, rawText, text, typingMs, delayMs, resolve, reject } = messageQueue[0]

        try {
            const nowMs = Date.now()
            checkAntiBanLimits(jid, rawText, nowMs)

            if (typeof sock?.onWhatsApp === 'function') {
                const check = await sock.onWhatsApp(jid)
                if (Array.isArray(check) && !check[0]?.exists) {
                    throw new Error('Recipient number is not registered on WhatsApp.')
                }
            }

            if (typeof sock?.sendPresenceUpdate === 'function' && typingMs > 0) {
                await sock.sendPresenceUpdate('composing', jid).catch(() => { })
                await new Promise((r) => setTimeout(r, typingMs))
                await sock.sendPresenceUpdate('paused', jid).catch(() => { })
            }

            await sock.sendMessage(jid, { text })

            sentTimestamps.push(Date.now())
            recentMessages.set(`${jid}::${rawText.trim()}`, Date.now())
            totalMessagesSent++
            lastMessageTime = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
            resolve({ success: true, message: 'Message dispatched successfully!' })
        } catch (error) {
            reject(new Error(error.message))
        }

        messageQueue.shift()
        if (messageQueue.length > 0) {
            const cooldownMs = delayMs === undefined ? getBatchCooldownMs(totalMessagesSent) : 0
            const waitNextMs = delayMs ?? (cooldownMs > 0 ? cooldownMs : getRandomDelayMs())
            if (waitNextMs > 0) await new Promise((r) => setTimeout(r, waitNextMs))
        }
    }
    isProcessingQueue = false
}

export const getWhatsAppStatus = () => {
    return {
        isConnected,
        isConnecting,
        qrCodeData,
        userNumber,
        stats: { totalMessagesSent, botUptime: formatUptime(Date.now() - botStartTime), lastMessageTime, pendingMessages: messageQueue.length }
    }
}

/**
 * Waits briefly for WhatsApp socket to finish connecting after a Render cold start.
 */
async function waitForConnectionIfConnecting(timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (!isConnected && isConnecting && !qrCodeData && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500))
    }
}

export const sendWhatsAppMessage = async (number, text, options = {}) => {
    const waitMs = options.waitMs ?? Number(process.env.WAKEUP_WAIT_MS || 20000)
    if (!isConnected && isConnecting && !qrCodeData && waitMs > 0) {
        await waitForConnectionIfConnecting(waitMs)
    }

    const rawText = String(text)
    const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`
    const finalText = applyMessageVariation(rawText)
    const typingMs = options.typingMs ?? getRandomDelayMs(800, 1800)

    return new Promise((resolve, reject) => {
        if (!isConnected) return reject(new Error('WhatsApp device is currently disconnected!'))
        try {
            checkAntiBanLimits(jid, rawText)
        } catch (err) {
            return reject(err)
        }
        messageQueue.push({ jid, rawText, text: finalText, typingMs, delayMs: options.delayMs, resolve, reject })
        processQueue()
    })
}

export const logoutWhatsApp = async () => {
    if (sock) {
        try {
            await sock.logout()
        } catch (e) {
            console.warn('[WhatsApp] Logout notice:', e.message)
        }
    }
    await flushWhatsAppSession()
}
