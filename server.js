import express from 'express';
import { WebSocketServer } from 'ws';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { createServer } from 'http';
import { Redis } from '@upstash/redis';

// Express app
const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Health check
app.get(['/','/health'], (req, res) =>
  res.status(200).json({ status: 'ok', message: 'WebSocket server running' })
);

// Create HTTP server (required by Railway)
const server = createServer(app);

// ✅ FIX: Attach WebSocketServer directly to the same server
const wss = new WebSocketServer({ server });

// Language map
const LANGUAGE_NAMES = {
  sv: 'Swedish', en: 'English', tr: 'Turkish', ar: 'Arabic',
  es: 'Spanish', fr: 'French', de: 'German', it: 'Italian',
  pt: 'Portuguese', ru: 'Russian', zh: 'Chinese', ja: 'Japanese', ko: 'Korean'
};
const getLanguageName = (code) => LANGUAGE_NAMES[code] || code;

// Redis + OpenAI
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Cache helpers
async function getCachedTranslation(from, to, text) {
  if (!text) return null;
  const key = `t:${from}:${to}:${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 120)}`;
  try {
    const cached = await redis.get(key);
    if (cached) {
      console.log(`💾 Redis HIT: ${key}`);
      return JSON.parse(cached);
    }
  } catch (e) {
    console.warn("Redis get failed", e);
  }
  return null;
}
async function setCachedTranslation(from, to, text, value) {
  if (!text) return;
  const key = `t:${from}:${to}:${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 120)}`;
  const wordCount = text.split(" ").length;
  const ttl = wordCount <= 5 ? 86400 : 3600;
  try {
    await redis.setex(key, ttl, JSON.stringify(value));
    console.log(`💾 Cache SET: ${key} (TTL ${ttl}s)`);
  } catch (e) {
    console.warn("Redis set failed", e);
  }
}

// WebSocket handling
wss.on('connection', (ws, request) => {
  console.log('🔌 WS connected from', request.socket.remoteAddress);
  ws.send(JSON.stringify({ type: 'connected', message: 'WebSocket ready' }));

  let audioChunks = [], sessionId, fromLang, toLang;

  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      switch (data.type) {
        case 'start':
          sessionId = data.sessionId;
          fromLang = data.fromLang;
          toLang = data.toLang;
          audioChunks = [];
          console.log(`🎯 Session started: ${sessionId}, fromLang: ${fromLang}, toLang: ${toLang}`);
          ws.send(JSON.stringify({ type: 'connected', sessionId }));
          break;

        case 'chunk':
          audioChunks.push(data.audio);
          break;

        case 'stop':
          console.log(`🛑 Stop received - sessionId: ${sessionId}, fromLang: ${fromLang}, toLang: ${toLang}`);
          
          // Fallback if session data is missing
          if (!fromLang || !toLang) {
            console.log('⚠️ Missing session data, using defaults');
            fromLang = fromLang || 'sv'; // Default to Swedish
            toLang = toLang || 'en'; // Default to English
          }
          
          const combinedAudio = audioChunks.join('');
          const audioBuffer = Buffer.from(combinedAudio, "base64");
          const tmpPath = path.join('/tmp', `audio_${Date.now()}.m4a`);
          fs.writeFileSync(tmpPath, audioBuffer);

          console.log(`📁 Audio file saved: ${tmpPath} (${audioBuffer.length} bytes)`);

          try {
            const transcriptionData = await openai.audio.transcriptions.create({
              file: fs.createReadStream(tmpPath),
              model: 'whisper-1',
              language: fromLang,
              response_format: 'json'
            });
            const originalText = transcriptionData.text;
            fs.unlinkSync(tmpPath);
            
            if (!originalText) {
              ws.send(JSON.stringify({ type: 'error', error: 'No text transcribed from audio' }));
              return;
            }
            
            ws.send(JSON.stringify({ type: 'partial', text: originalText }));

            const cached = await getCachedTranslation(fromLang, toLang, originalText);
            const fromLangName = getLanguageName(fromLang);
            const toLangName = getLanguageName(toLang);

            const translated = cached?.t ?? (
              await openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                  { role: 'system', content: `Translate from ${fromLangName} to ${toLangName}. Only return translation.` },
                  { role: 'user', content: originalText }
                ],
                temperature: 0,
                max_tokens: 100
              })
            ).choices[0].message.content;

            ws.send(JSON.stringify({ type: 'final', original: originalText, translated, cached: !!cached }));
            if (!cached) await setCachedTranslation(fromLang, toLang, originalText, { t: translated });

            const tts = await openai.audio.speech.create({
              model: 'tts-1',
              voice: toLang === 'en' ? 'alloy' : 'nova',
              input: translated,
              speed: 1.0,
              response_format: 'mp3',
            });
            const ttsBase64 = Buffer.from(await tts.arrayBuffer()).toString('base64');
            ws.send(JSON.stringify({ type: 'audio', url: `data:audio/mp3;base64,${ttsBase64}` }));
            ws.send(JSON.stringify({ type: 'end', sessionId }));
            
          } catch (error) {
            console.error(`❌ Transcription error:`, error);
            ws.send(JSON.stringify({ type: 'error', error: `Transcription failed: ${error.message}` }));
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
          }
          break;

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }));
          break;
      }
    } catch (err) {
      console.error('❌ WS error:', err);
      ws.send(JSON.stringify({ type: 'error', error: err.message }));
    }
  });

  ws.on('close', () => console.log('🔌 WS closed'));
});

// Start server
const PORT = process.env.PORT || 8080; // Railway sets PORT automatically
server.listen(PORT, () => {
  console.log(`✅ WebSocket server running on port ${PORT}`);
  console.log(`Health: https://verlo-websocket-production.up.railway.app/health`);
});
