const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { createClient } = require('redis');
require("dotenv").config();

// Initialize Express
const app = express();
const port = process.env.PORT || 3000;

// Enhanced health check endpoint
app.get('/', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString()
    });
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

// Enhanced retry configuration
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000;
const MAX_RETRY_DELAY = 10000;

// Set up Redis client with reconnection logic
const createRedisClient = () => {
    const client = createClient({
        password: process.env.REDIS_PASSWORD,
        socket: {
            host: 'redis-12807.c325.us-east-1-4.ec2.redns.redis-cloud.com',
            port: 12807
        },
        retry_strategy: function(options) {
            if (options.error && options.error.code === 'ECONNREFUSED') {
                return new Error('The server refused the connection');
            }
            if (options.total_retry_time > 1000 * 60 * 60) {
                return new Error('Retry time exhausted');
            }
            if (options.attempt > 10) {
                return undefined;
            }
            return Math.min(options.attempt * 100, 3000);
        }
    });

    client.on('error', (err) => console.log('Redis Client Error', err));
    client.on('reconnecting', () => console.log('Redis Client reconnecting...'));
    client.on('connect', () => console.log('Redis Client connected'));

    return client;
};

const redisClient = createRedisClient();

(async () => {
    await redisClient.connect();
    console.log("Connected to Redis successfully!");
})();

// Enhanced Redis-based session storage
class RedisLocalAuth extends LocalAuth {
    constructor(options = {}) {
        super(options);
        this.sessionKey = 'whatsapp-session';
    }

    async saveSession(data) {
        try {
            await redisClient.set(this.sessionKey, JSON.stringify(data));
        } catch (error) {
            console.error('Error saving session:', error);
            throw error;
        }
    }

    async loadSession() {
        try {
            const session = await redisClient.get(this.sessionKey);
            return session ? JSON.parse(session) : null;
        } catch (error) {
            console.error('Error loading session:', error);
            return null;
        }
    }

    async clearSession() {
        try {
            await redisClient.del(this.sessionKey);
        } catch (error) {
            console.error('Error clearing session:', error);
            throw error;
        }
    }
}

// Enhanced utility functions
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const exponentialBackoff = (retryCount) => {
    const backoff = Math.min(
        INITIAL_RETRY_DELAY * Math.pow(2, retryCount),
        MAX_RETRY_DELAY
    );
    return backoff + Math.random() * 1000; // Add jitter
};

// Initialize WhatsApp client with enhanced Puppeteer configuration
const createWhatsAppClient = () => {
    return new Client({
        authStrategy: new RedisLocalAuth(),
        puppeteer: {
            headless: true,
            timeout: 0,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--disable-extensions',
                '--disable-infobars',
                '--window-position=0,0',
                '--ignore-certificate-errors',
                '--ignore-certificate-errors-spki-list',
                '--disable-features=IsolateOrigins,site-per-process'
            ],
            ignoreHTTPSErrors: true,
            defaultViewport: null
        }
    });
};

let client = createWhatsAppClient();
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

// Enhanced error handling for WhatsApp client
const setupClientListeners = (client) => {
    client.on('disconnected', async (reason) => {
        console.log('Client was disconnected:', reason);
        
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            const backoffTime = exponentialBackoff(reconnectAttempts);
            console.log(`Attempting to reconnect in ${backoffTime}ms...`);
            await delay(backoffTime);
            
            try {
                await client.destroy();
                client = createWhatsAppClient();
                setupClientListeners(client);
                await client.initialize();
                reconnectAttempts++;
            } catch (error) {
                console.error('Reconnection failed:', error);
            }
        } else {
            console.error('Max reconnection attempts reached. Manual intervention required.');
            process.exit(1);
        }
    });

    client.on('auth_failure', async (msg) => {
        console.error('Authentication failure:', msg);
        await redisClient.del('whatsapp-session');
        process.exit(1);
    });

    client.on('qr', (qr) => {
        console.log('QR RECEIVED');
        qrcode.generate(qr, { small: true });
    });

    client.on('ready', () => {
        console.log('Client is ready!');
        reconnectAttempts = 0; // Reset reconnect attempts on successful connection
    });
};

// Enhanced AI Response generator
const generateAIResponse = async (message, retryCount = 0) => {
    try {
        const timeout = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Request timeout')), 30000)
        );

        const completion = await Promise.race([
            model.generateContent(message),
            timeout
        ]);

        return completion.response.text() || 'I apologize, but I was unable to generate a response.';
    } catch (err) {
        console.error(`Failed to generate AI response (attempt ${retryCount + 1}):`, err);

        if (retryCount < MAX_RETRIES) {
            const backoffTime = exponentialBackoff(retryCount);
            console.log(`Retrying in ${backoffTime}ms...`);
            await delay(backoffTime);
            return generateAIResponse(message, retryCount + 1);
        }

        return 'I encountered a network error while processing your request. Please try again later.';
    }
};

// Enhanced message handling
const handleMessage = async (message) => {
    try {
        console.log('New message received:', message.body);

        if (message.type === 'status' || message.type === 'ephemeral') {
            return;
        }

        if (!message.isGroupMsg) {
            const response = await generateAIResponse(message.body);
            await client.sendMessage(message.from, response);
            return;
        }

        if (message.isGroupMsg && message.hasQuotedMsg) {
            const quotedMessage = await message.getQuotedMessage();
            if (quotedMessage?.body) {
                console.log('Processing quoted message:', quotedMessage.body);
                const response = await generateAIResponse(quotedMessage.body);
                await client.sendMessage(message.from, response);
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
};

client.on('message', handleMessage);

// Enhanced keep-alive mechanism
const keepAliveInterval = [ 32000,
    45000,
    54000,
    68000,
    75000,
    92000,
    105000,
    113000,
    126000,
    138000,
    143000,
    159000,
    170000]; // Random intervals under 3 minutes
const browserPingInterval = 30000; // 30 seconds

const getRandomInterval = async (arr) => {
    const randomIndex = Math.floor(Math.random() * arr.length);
    console.log(arr[randomIndex]);
     return arr[randomIndex];
};

let keepAliveTimer = setInterval(async () => {
    try {
        const chatId = '255764903468@c.us';
        await client.sendMessage(chatId, 'still alive');
    } catch (error) {
        console.error('Error sending keep-alive message:', error);
    }
}, 1 * 60 * 1000);

let browserPingTimer = setInterval(async () => {
    try {
        if (client.pupBrowser) {
            const pages = await client.pupBrowser.pages();
            if (!pages || pages.length === 0) {
                throw new Error('No pages available');
            }
        }
    } catch (error) {
        console.error('Browser ping failed:', error);
        clearInterval(browserPingTimer);
        clearInterval(keepAliveTimer);
        
        try {
            await client.destroy();
            client = createWhatsAppClient();
            setupClientListeners(client);
            await client.initialize();
            
            // Restart timers
            browserPingTimer = setInterval(browserPing, browserPingInterval);
            keepAliveTimer = setInterval(keepAlive, keepAliveInterval);
        } catch (reinitError) {
            console.error('Failed to reinitialize client:', reinitError);
        }
    }
}, browserPingInterval);

// Enhanced graceful shutdown
const cleanup = async () => {
    console.log('Cleaning up...');
    clearInterval(browserPingTimer);
    clearInterval(keepAliveTimer);
    
    try {
        await client.destroy();
        await redisClient.quit();
        console.log('Cleanup completed successfully');
        process.exit(0);
    } catch (error) {
        console.error('Error during cleanup:', error);
        process.exit(1);
    }
};

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    cleanup();
});

// Initialize WhatsApp client
setupClientListeners(client);
client.initialize();