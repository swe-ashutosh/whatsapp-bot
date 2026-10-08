import { makeWASocket, DisconnectReason, fetchLatestBaileysVersion, initAuthCreds, BufferJSON } from '@whiskeysockets/baileys'
import pino from 'pino'
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config()

// Supabase Connection
const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseKey = process.env.SUPABASE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing Supabase config. Set SUPABASE_URL and SUPABASE_KEY or NEXT_PUBLIC_SUPABASE_URL/NEXT_PUBLIC_SUPABASE_ANON_KEY in your .env file.')
}

const supabase = createClient(supabaseUrl, supabaseKey)

let sock;
let qrCodeData = null;
let isConnected = false;
let userNumber = null;

let totalMessagesSent = 0;
let botStartTime = Date.now();
let lastMessageTime = "Abhi tak koi nahi";

const messageQueue = [];
let isProcessingQueue = false;

const formatUptime = (ms) => {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${h}h ${m}m ${s}s`;
}

// Supabase Auth State Adapter
const useSupabaseAuthState = async (sessionId) => {
    const writeData = async (data, id) => {
        const json = JSON.stringify(data, BufferJSON.replacer)
        await supabase.from('wa_sessions').upsert({ id: `${sessionId}-${id}`, data: JSON.parse(json) })
    }
    const readData = async (id) => {
        const { data } = await supabase.from('wa_sessions').select('data').eq('id', `${sessionId}-${id}`).single()
        if (data?.data) return JSON.parse(JSON.stringify(data.data), BufferJSON.reviver)
        return null;
    }
    const removeData = async (id) => {
        await supabase.from('wa_sessions').delete().eq('id', `${sessionId}-${id}`)
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
                            value = baileys.proto.Message.AppStateSyncKeyData.fromObject(value)
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

export async function connectToWhatsApp() {
    // Ab session local folder ki jagah Supabase me 'session-1' ke naam se save hoga
    const sessionId = process.env.SESSION_ID || 'session-1'
    const { state, saveCreds } = await useSupabaseAuthState(sessionId)
    const { version } = await fetchLatestBaileysVersion()

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }), 
        browser: ['Jugaduji Bot', 'Chrome', '1.0.0'] 
    })

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr) qrCodeData = qr; 

        if (connection === 'close') {
            isConnected = false;
            userNumber = null;
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                setTimeout(() => connectToWhatsApp(), 2000); 
            } else {
                qrCodeData = null;
            }
        } else if (connection === 'open') {
            isConnected = true;
            qrCodeData = null; 
            userNumber = sock.user.id.split(':')[0]; 
        }
    })

    sock.ev.on('creds.update', saveCreds)
}

const processQueue = async () => {
    if (isProcessingQueue || messageQueue.length === 0) return;
    isProcessingQueue = true;

    while (messageQueue.length > 0) {
        const { jid, text, resolve, reject } = messageQueue[0];
        
        try {
            await sock.sendMessage(jid, { text });
            totalMessagesSent++;
            lastMessageTime = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            resolve({ success: true, message: "Message chala gaya!" });
        } catch (error) {
            reject(new Error(error.message));
        }

        messageQueue.shift(); 
        if (messageQueue.length > 0) await new Promise(r => setTimeout(r, 3500)); 
    }
    isProcessingQueue = false;
};

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
        if (!isConnected) return reject(new Error("Bhai, WhatsApp abhi connect nahi hai!"));
        const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;
        messageQueue.push({ jid, text, resolve, reject });
        processQueue();
    });
}

export const logoutWhatsApp = async () => {
    if (sock) await sock.logout();
}