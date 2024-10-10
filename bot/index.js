const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config();

const API_KEY = process.env.API_KEY;
const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox'],
    }
});

client.on('qr', (qr) => {
    console.log('QR RECEIVED', qr);
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('Client is ready!');
});

client.on('message', async (message) => {
    console.log('New message received:', message.body);
    
    if (!message.isGroupMsg) {
        const response = await generateAIResponse(message.body);
        await message.reply(response);
    }
});

const generateAIResponse = async (message) => {
    try {
        const completion = await model.generateContent(message);
        const aiResponse = completion.response.text();
        if (aiResponse) {
            return aiResponse;
        } else {
            return 'I apologize, but I couldn';
        }
    } catch (err) {
        console.error('Failed to generate response: ', err);
        return 'I encountered an error while processing your request. Please try again later.';
    }
};

client.initialize();