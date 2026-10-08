import { 
    makeWASocket, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    initAuthCreds, 
    BufferJSON, 
    proto, 
    useMultiFileAuthState 
} from '@whiskeysockets/baileys'
import pino from 'pino'
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config()

// Supabase Connection (Optional / Cloud Persistence)
const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseKey = process.env.SUPABASE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

let supabase = null
if (supabaseUrl && supabaseKey) {
    try {
        supabase = createClient(supabaseUrl, supabaseKey)
    } catch (e) {
        console.warn('[WhatsApp] Supabase client init warning:', e.message)
    }
}

let sock = null
let qrCodeData = null
let isConnected = false
let userNumber = null

let totalMessagesSent = 0
let botStartTime = Date.now()
let lastMessageTime = "None yet"

const messageQueue = []
let isProcessingQueue = false

const formatUptime = (ms) => {
    const h = Math.floor(ms / 3600000)
    const m = Math.floor((ms % 3600000) / 60000)
    const s = Math.floor((ms % 60000) / 1000)
    return `${h}h ${m}m ${s}s`
}

// Check if wa_sessions table exists in Supabase
async function verifySupabaseTable() {
    if (!supabase) return false
    try {
        const { error } = await supabase.from('wa_sessions').select('id').limit(1)
        if (error) {
            console.warn('[WhatsApp] wa_sessions table not found in Supabase. Using local multi-file storage.')
            return false
        }
        return true
    } catch {
        return false
    }
}

// Remote Supabase Auth Adapter
const useSupabaseAuthState = async (sessionId) => {
    const writeData = async (data, id) => {
        try {
            const json = JSON.stringify(data, BufferJSON.replacer)
            await supabase.from('wa_sessions').upsert({ id: `${sessionId}-${id}`, data: JSON.parse(json) })
        } catch (e) {
            console.warn('[WhatsApp Auth] writeData error:', e.message)
        }
    }
    const readData = async (id) => {
        try {
            const { data } = await supabase.from('wa_sessions').select('data').eq('id', `${sessionId}-${id}`).maybeSingle()
            if (data?.data) return JSON.parse(JSON.stringify(data.data), BufferJSON.reviver)
        } catch (e) {
            console.warn('[WhatsApp Auth] readData error:', e.message)
        }
        return null
    }
    const removeData = async (id) => {
        try {
            await supabase.from('wa_sessions').delete().eq('id', `${sessionId}-${id}`)
        } catch (e) {
            console.warn('[WhatsApp Auth] removeData error:', e.message)
        }
    }

    let creds = await readData('creds')
    if (!creds) {
        creds = initAuthCreds()
        await writeData(creds, 'creds')
    }

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {}
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(`${type}-${id}`)
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value)
                        }
                        data[id] = value
                    }))
                    return data
                },
                set: async (data) => {
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id]
                            const key = `${category}-${id}`
                            if (value) await writeData(value, key)
                            else await removeData(key)
                        }
                    }
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds')
    }
}

// Selects Supabase if table is ready; otherwise multi-file disk storage
async function getAuthState(sessionId) {
    const isSupabaseOk = await verifySupabaseTable()
    if (isSupabaseOk) {
        console.log(`[WhatsApp] Using remote Supabase session storage: ${sessionId}`)
        return await useSupabaseAuthState(sessionId)
    }
    console.log(`[WhatsApp] Using local multi-file session storage: ./auth_info_baileys`)
    return await useMultiFileAuthState('./auth_info_baileys')
}

export async function connectToWhatsApp() {
    try {
        const sessionId = process.env.SESSION_ID || 'session-1'
        const { state, saveCreds } = await getAuthState(sessionId)
        const { version } = await fetchLatestBaileysVersion()

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }), 
            browser: ['Desktop', 'Chrome', '1.0.0'] 
        })

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update

            if (qr) qrCodeData = qr 

            if (connection === 'close') {
                isConnected = false
                userNumber = null
                const statusCode = lastDisconnect?.error?.output?.statusCode
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut
                console.log(`[WhatsApp] Connection closed (code: ${statusCode}). Reconnecting: ${shouldReconnect}`)
                if (shouldReconnect) {
                    setTimeout(() => connectToWhatsApp(), 3000) 
                } else {
                    qrCodeData = null
                }
            } else if (connection === 'open') {
                isConnected = true
                qrCodeData = null 
                userNumber = sock.user.id.split(':')[0]
                console.log(`[WhatsApp] Connected successfully! Active number: +${userNumber}`)
            }
        })

        sock.ev.on('creds.update', saveCreds)
    } catch (err) {
        console.error('[WhatsApp] Connection initialization error:', err)
        setTimeout(() => connectToWhatsApp(), 5000)
    }
}

const processQueue = async () => {
    if (isProcessingQueue || messageQueue.length === 0) return
    isProcessingQueue = true

    while (messageQueue.length > 0) {
        const { jid, text, resolve, reject } = messageQueue[0]
        
        try {
            await sock.sendMessage(jid, { text })
            totalMessagesSent++
            lastMessageTime = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
            resolve({ success: true, message: "Message dispatched successfully!" })
        } catch (error) {
            reject(new Error(error.message))
        }

        messageQueue.shift() 
        if (messageQueue.length > 0) await new Promise(r => setTimeout(r, 3500)) 
    }
    isProcessingQueue = false
}

export const getWhatsAppStatus = () => {
    return { 
        isConnected, 
        qrCodeData, 
        userNumber,
        stats: { totalMessagesSent, botUptime: formatUptime(Date.now() - botStartTime), lastMessageTime, pendingMessages: messageQueue.length }
    }
}

export const sendWhatsAppMessage = (number, text) => {
    return new Promise((resolve, reject) => {
        if (!isConnected) return reject(new Error("WhatsApp device is currently disconnected!"))
        const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`
        messageQueue.push({ jid, text, resolve, reject })
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
}
