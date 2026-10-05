import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { readFileSync } from 'fs'
import QRCode from 'qrcode'
import dotenv from 'dotenv'
dotenv.config()
import { connectToWhatsApp, getWhatsAppStatus, sendWhatsAppMessage, logoutWhatsApp } from './whatsapp.js'

const app = new Hono()

app.get('/', (c) => {
    try {
        const html = readFileSync('./src/dashboard.html', 'utf-8')
        return c.html(html)
    } catch (error) {
        return c.text('Dashboard file not found!', 500)
    }
})

app.get('/status', async (c) => {
    const status = getWhatsAppStatus();
    let qrImage = null;
    
    if (status.qrCodeData) {
        qrImage = await QRCode.toDataURL(status.qrCodeData);
    }

    return c.json({
        isConnected: status.isConnected,
        userNumber: status.userNumber,
        qrImage: qrImage,
        stats: status.stats // Naya data yahan se ja raha hai
    })
})

app.post('/send-message', async (c) => {
    const apiKey = c.req.header('x-api-key');
    const expectedKey = process.env.API_KEY || 'sanskar123'; 

    if (apiKey !== expectedKey) return c.json({ success: false, error: "Galat API Key!" }, 401);

    try {
        const body = await c.req.json();
        const { number, message } = body;
        if (!number || !message) return c.json({ success: false, error: "Number aur message zaruri hai." }, 400);
        
        const result = await sendWhatsAppMessage(number, message);
        return c.json(result);
    } catch (error) {
        return c.json({ success: false, error: error.message }, 500);
    }
})

app.post('/logout', async (c) => {
    await logoutWhatsApp();
    return c.json({ success: true, message: "Logged out successfully!" });
})

connectToWhatsApp();

const port = process.env.PORT || 3000
serve({ fetch: app.fetch, port })
console.log(`🚀 Server chal raha hai: http://localhost:${port}`)