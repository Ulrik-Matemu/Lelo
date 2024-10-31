const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { createClient } = require('redis');
require("dotenv").config();

const API_KEY = process.env.API_KEY;
const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Set up Redis client
const redisClient = createClient({
    password: process.env.REDIS_PASSWORD,
    socket: {
        host: 'redis-12807.c325.us-east-1-4.ec2.redns.redis-cloud.com',
        port: 12807
    }
});

redisClient.on('error', (err) => console.log('Redis Client Error', err));

(async () => {
    await redisClient.connect();
    console.log("Connected to Redis successfully!");
})();

// Extend LocalAuth with Redis-based session storage
class RedisLocalAuth extends LocalAuth {
    constructor(options = {}) {
        super(options);
    }

    async saveSession(data) {
        await redisClient.set('whatsapp-session', JSON.stringify(data));
    }

    async loadSession() {
        const session = await redisClient.get('whatsapp-session');
        return session ? JSON.parse(session) : null;
    }

    async clearSession() {
        await redisClient.del('whatsapp-session');
    }
}

// Initialize WhatsApp client with RedisLocalAuth
const client = new Client({
    authStrategy: new RedisLocalAuth(),
    puppeteer: {
        args: ['--no-sandbox']
    }
});

// QR code event
client.on('qr', (qr) => {
    console.log('QR RECEIVED', qr);
    qrcode.generate(qr, { small: true });
});

// Ready event
client.on('ready', () => {
    console.log('Client is ready!');
});

// Message event handling
client.on('message', async (message) => {
    try {
        console.log('New message received:', message.body);

        // Ignore status and ephemeral messages
        if (message.type === 'status' || message.type === 'ephemeral') {
            return;
        }

        // Handle direct messages
        if (!message.isGroupMsg) {
            const response = await generateAIResponse(message.body);
            await client.sendMessage(message.from, response);
            return;
        }

        // Handle group messages with quoted text only
        if (message.isGroupMsg && message.hasQuotedMsg) {
            try {
                const quotedMessage = await message.getQuotedMessage();
                if (quotedMessage && quotedMessage.body) {
                    console.log('Processing quoted message:', quotedMessage.body);
                    const response = await generateAIResponse(quotedMessage.body);
                    await client.sendMessage(message.from, response);
                }
            } catch (quotedError) {
                console.error('Error handling quoted message:', quotedError);
                await client.sendMessage(message.from, 'Sorry, I could not access the quoted message. Please try quoting the message again.');
            }
            return;
        }

    } catch (error) {
        console.error('Error processing message:', error);
        try {
            await client.sendMessage(message.from, 'Sorry, I encountered an error. Please try again.');
        } catch (sendError) {
            console.error('Error sending error message:', sendError);
        }
    }
});

// AI Response generator
const generateAIResponse = async (message) => {
    try {
        const completion = await model.generateContent(message);
        const aiResponse = completion.response.text();
        return aiResponse || 'I apologize, but I was unable to generate a response.';
    } catch (err) {
        console.error('Failed to generate AI response:', err);
        return 'I encountered an error while processing your request. Please try again later.';
    }
};

// Keep-alive interval
setInterval(async () => {
    try {
        const chatId = '255764903468@c.us';
        await client.sendMessage(chatId, 'keep-alive bot');
    } catch (error) {
        console.error('Error sending keep-alive message', error);
    }
}, 5 * 60 * 1000);

client.initialize();
