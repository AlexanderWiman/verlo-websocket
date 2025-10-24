import express from 'express';
import { WebSocketServer } from 'ws';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { createServer } from 'http';
import { Redis } from '@upstash/redis';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'WebSocket server is running' });
});

// WebSocket upgrade handler
server.on('upgrade', (request, socket, head) => {
  console.log('WebSocket upgrade request:', request.url);
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

const LANGUAGE_NAMES = {
  'sv': 'Swedish', 'en': 'English', 'tr': 'Turkish', 'ar': 'Arabic',
  'es': 'Spanish', 'fr': 'French', 'de': 'German', 'it': 'Italian',
  'pt': 'Portuguese', 'ru': 'Russian', 'zh': 'Chinese', 'ja': 'Japanese',
  'ko': 'Korean', 'sq': 'Albanian'
};

function getLanguageName(code) {
  return LANGUAGE_NAMES[code] || code;
}

// Redis client
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Cache functions
async function getCachedTranslation(from, to, text) {
  const key = `t:${from}:${to}:${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 120)}`;
  try {
    const cached = await redis.get(key);
    if (cached) {
      console.log(`Redis cache HIT: ${key}`);
      return JSON.parse(cached);
    }
  } catch (e) {
    console.warn("Redis get failed", e);
  }
  return null;
}

async function setCachedTranslation(from, to, text, value) {
  const key = `t:${from}:${to}:${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 120)}`;
  const wordCount = text.split(" ").length;
  const ttl = wordCount <= 5 ? 86400 : 3600;
  
  try {
    await redis.setex(key, ttl, JSON.stringify(value));
    console.log(`Cache SET: ${key} (TTL: ${ttl}s)`);
  } catch (e) {
    console.warn("Redis set failed", e);
  }
}

wss.on('connection', (ws) => {
  console.log('WebSocket connection established');
  
  let audioChunks = [];
  let sessionId = null;
  let fromLang = null;
  let toLang = null;
  
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());
      
      switch (data.type) {
        case 'start':
          sessionId = data.sessionId;
          fromLang = data.fromLang;
          toLang = data.toLang;
          audioChunks = [];
          console.log(`Session started: ${sessionId}`);
          ws.send(JSON.stringify({ type: 'connected', sessionId }));
          break;
          
        case 'chunk':
          audioChunks.push(data.audio);
          console.log(`Received audio chunk, total: ${audioChunks.length}`);
          break;
          
        case 'stop':
          console.log(`Processing audio for session: ${sessionId}`);
          
          // Combine audio chunks
          const combinedAudio = audioChunks.join('');
          
          // 1. Whisper transcription
          const cleanBase64 = combinedAudio.replace(/^data:audio\/\w+;base64,/, "");
          const audioBuffer = Buffer.from(cleanBase64, "base64");
          
          const tmpPath = path.join('/tmp', `audio_${Date.now()}.wav`);
          fs.writeFileSync(tmpPath, audioBuffer);
          
          const languageName = getLanguageName(fromLang);
          const prompt = `This is a ${languageName} conversation. Use proper ${languageName} spelling and grammar.`;
          
          const formData = new FormData();
          const fileBuffer = fs.readFileSync(tmpPath);
          const fileBlob = new Blob([fileBuffer], { type: 'audio/wav' });
          formData.append('file', fileBlob, 'audio.wav');
          formData.append('model', 'whisper-1');
          formData.append('language', fromLang);
          formData.append('prompt', prompt);
          formData.append('response_format', 'json');
          formData.append('temperature', '0.0');
          
          const transcriptionResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            },
            body: formData,
          });
          
          if (!transcriptionResponse.ok) {
            throw new Error(`Whisper error: ${transcriptionResponse.status}`);
          }
          
          const transcription = await transcriptionResponse.json();
          const originalText = transcription.text;
          
          fs.unlinkSync(tmpPath);
          
          // Send partial text
          ws.send(JSON.stringify({ type: 'partial', text: originalText }));
          
          // 2. Check cache
          const cached = await getCachedTranslation(fromLang, toLang, originalText);
          
          if (cached) {
            console.log('Cache HIT! Returning cached translation');
            ws.send(JSON.stringify({ type: 'final', original: originalText, translated: cached.t, cached: true }));
            
            // Generate audio for cached translation
            const ttsResponse = await openai.audio.speech.create({
              model: 'tts-1',
              voice: toLang === 'en' ? 'alloy' : 'nova',
              input: cached.t,
              speed: 1.0,
              response_format: 'mp3',
            });
            
            const audioArrayBuffer = await ttsResponse.arrayBuffer();
            const audioBase64 = Buffer.from(audioArrayBuffer).toString('base64');
            const audioDataUrl = `data:audio/mp3;base64,${audioBase64}`;
            
            ws.send(JSON.stringify({ type: 'audio', url: audioDataUrl }));
            ws.send(JSON.stringify({ type: 'end', sessionId }));
            return;
          }
          
          // 3. Translate text (GPT-4o-mini)
          const fromLanguage = getLanguageName(fromLang);
          const toLanguage = getLanguageName(toLang);
          
          const translationResponse = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
              {
                role: 'system',
                content: `You are a translation assistant. Translate the following text from ${fromLanguage} to ${toLanguage}. Return only the translation.`
              },
              {
                role: 'user',
                content: originalText
              }
            ],
            max_tokens: 100,
            temperature: 0.0,
            response_format: { type: 'text' },
            stream: false,
          });

          const translatedText = translationResponse.choices[0].message.content;
          
          // Send final translation
          ws.send(JSON.stringify({ type: 'final', original: originalText, translated: translatedText, cached: false }));
          
          // Cache the translation
          await setCachedTranslation(fromLang, toLang, originalText, {
            t: translatedText,
            a: null
          });
          
          // 4. Generate TTS audio
          const ttsResponse = await openai.audio.speech.create({
            model: 'tts-1',
            voice: toLang === 'en' ? 'alloy' : 'nova',
            input: translatedText,
            speed: 1.0,
            response_format: 'mp3',
          });
          
          const audioArrayBuffer = await ttsResponse.arrayBuffer();
          const audioBase64 = Buffer.from(audioArrayBuffer).toString('base64');
          const audioDataUrl = `data:audio/mp3;base64,${audioBase64}`;
          
          ws.send(JSON.stringify({ type: 'audio', url: audioDataUrl }));
          ws.send(JSON.stringify({ type: 'end', sessionId }));
          
        default:
          console.log('Unknown message type:', data.type);
      }
    } catch (error) {
      console.error('WebSocket error:', error);
      ws.send(JSON.stringify({ type: 'error', error: error.message }));
    }
  });
  
  ws.on('close', () => {
    console.log('WebSocket connection closed');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`WebSocket server running on port ${PORT}`);
});

