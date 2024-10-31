const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { createClient } = require('redis');
require("dotenv").config();

// Initialize Express
const app = express();
const port = process.env.PORT || 3000;

// Setup health check endpoint
app.get('/', (req, res) => {
    res.send('WhatsApp bot is running!');
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});

// Validate API key
const API_KEY = process.env.API_KEY;
if (!API_KEY) {
    console.error('API_KEY environment variable is not set!');
    process.exit(1);
}

// Initialize Gemini with retry logic
const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Retry configuration
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1 second

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

// Utility function for delay
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Initialize WhatsApp client with enhanced Puppeteer configuration
const client = new Client({
    authStrategy: new RedisLocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    }
});

// Enhanced error handling for WhatsApp client
client.on('disconnected', (reason) => {
    console.log('Client was disconnected:', reason);
    setTimeout(() => {
        console.log('Attempting to reconnect...');
        client.initialize();
    }, 5000);
});

client.on('auth_failure', (msg) => {
    console.error('Authentication failure:', msg);
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

// AI Response generator with enhanced error handling and retry logic
const generateAIResponse = async (message, retryCount = 0) => {
    try {
        // Add timeout to the fetch request
        const completion = await Promise.race([
            model.generateContent(message),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Request timeout')), 30000)
            )
        ]);

        const aiResponse = completion.response.text();
        return aiResponse || 'I apologize, but I was unable to generate a response.';
    } catch (err) {
        console.error(`Failed to generate AI response (attempt ${retryCount + 1}):`, err);

        // Check if we should retry
        if (retryCount < MAX_RETRIES) {
            console.log(`Retrying in ${RETRY_DELAY}ms...`);
            await delay(RETRY_DELAY * (retryCount + 1)); // Exponential backoff
            return generateAIResponse(message, retryCount + 1);
        }

        // If all retries failed, return error message
        return 'I encountered a network error while processing your request. Please try again later.';
    }
};

// Message event handling with enhanced error handling
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

// Keep-alive interval with error handling
setInterval(async () => {
    try {
        const chatId = '255764903468@c.us';
        await client.sendMessage(chatId, 'keep-alive bot');
    } catch (error) {
        console.error('Error sending keep-alive message:', error);
    }
}, 5 * 60 * 1000);

// Graceful shutdown handling
process.on('SIGTERM', async () => {
    console.log('SIGTERM received. Cleaning up...');
    try {
        await client.destroy();
        await redisClient.quit();
        process.exit(0);
    } catch (error) {
        console.error('Error during cleanup:', error);
        process.exit(1);
    }
});

// Initialize WhatsApp client
client.initialize();