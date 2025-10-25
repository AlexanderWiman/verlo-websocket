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
app.get(['/', '/health'], (req, res) =>
  res.status(200).json({ status: 'ok', message: 'WebSocket server running' })
);

// Create HTTP server (required by Railway)
const server = createServer(app);

// ✅ Attach WebSocketServer directly to the same server
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
async function splitTextIntoChunks(text, maxChunkLength = 50) {
  const words = text.split(' ');
  const chunks = [];
  let currentChunk = '';
  
  for (const word of words) {
    if (currentChunk.length + word.length + 1 <= maxChunkLength) {
      currentChunk += (currentChunk ? ' ' : '') + word;
    } else {
      if (currentChunk) chunks.push(currentChunk);
      currentChunk = word;
    }
  }
  
  if (currentChunk) chunks.push(currentChunk);
  return chunks;
}

async function getCachedTranslation(from, to, text) {
  if (!text) return null;
  const key = `t:${from}:${to}:${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 120)}`;
  try {
    const cached = await redis.get(key);
    if (cached) {
      console.log(`💾 Redis HIT: ${key}`);
      console.log(`📦 Raw cached value: ${cached} (type: ${typeof cached})`);
      
      // Handle case where Redis returns an object instead of string
      const cachedString = typeof cached === 'string' ? cached : JSON.stringify(cached);
      
      try {
        const parsed = JSON.parse(cachedString);
        return parsed;
      } catch (parseError) {
        console.error(`❌ JSON parse error for key ${key}:`, parseError);
        console.error(`❌ Cached value: ${cachedString}`);
        return null;
      }
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
          console.log(`🚀 Session started: ${sessionId} (${fromLang} → ${toLang})`);
          ws.send(JSON.stringify({ type: 'connected', sessionId }));
          break;

        case 'chunk':
          audioChunks.push(data.audio);
          break;

        case 'stop':
          const combinedAudio = audioChunks.join('');
          const cleanBase64 = combinedAudio.replace(/^data:audio\/\w+;base64,/, "");
          const audioBuffer = Buffer.from(cleanBase64, "base64");
          const tmpPath = path.join('/tmp', `audio_${Date.now()}.wav`);
          fs.writeFileSync(tmpPath, audioBuffer);

          // 1. Transcribe with Whisper
          const whisperStart = Date.now();
          const transcriptionRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
            body: (() => {
              const f = new FormData();
              f.append('file', new Blob([audioBuffer]), 'audio.wav');
              f.append('model', 'whisper-1');
              f.append('language', fromLang);
              f.append('response_format', 'json');
              f.append('temperature', '0.0');
              f.append('compression_ratio_threshold', '2.4');
              return f;
            })(),
          });

          const { text: originalText } = await transcriptionRes.json();
          const whisperTime = Date.now() - whisperStart;
          console.log(`⏱️ Whisper time: ${whisperTime}ms`);
          fs.unlinkSync(tmpPath);
          
          // Validate originalText
          if (!originalText || typeof originalText !== 'string') {
            console.error('❌ Invalid originalText:', originalText);
            ws.send(JSON.stringify({ type: 'error', error: 'No text transcribed from audio' }));
            return;
          }
          
          ws.send(JSON.stringify({ type: 'partial', text: originalText }));

          // 2. Cache check
          const cached = await getCachedTranslation(fromLang, toLang, originalText);
          const fromLangName = getLanguageName(fromLang);
          const toLangName = getLanguageName(toLang);

          if (cached) {
            console.log('💾 Cache HIT! Returning cached translation');
            ws.send(JSON.stringify({
              type: 'final',
              original: originalText,
              translated: cached.t,
              cached: true,
              fromLang, // ✅ fixed
              toLang,   // ✅ fixed
            }));
            console.log(`📤 Final message sent (cached): fromLang=${fromLang}, toLang=${toLang}`);

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

          // 3. Translate via GPT
          const gptStart = Date.now();
          const translationResponse = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
              {
                role: 'system',
                content: `You are a translation assistant. Translate the following text from ${fromLangName} to ${toLangName}. Return only the translation.`,
              },
              { role: 'user', content: originalText }
            ],
            max_tokens: 50,
            temperature: 0.0,
            top_p: 0.1,
            frequency_penalty: 0,
            presence_penalty: 0,
          });

          const translatedText = translationResponse.choices[0].message.content;
          const gptTime = Date.now() - gptStart;
          console.log(`⏱️ GPT time: ${gptTime}ms`);

          // ✅ fixed: correct order
          ws.send(JSON.stringify({
            type: 'final',
            original: originalText,
            translated: translatedText,
            cached: false,
            fromLang,
            toLang,
          }));
          console.log(`📤 Final message sent: fromLang=${fromLang}, toLang=${toLang}`);

          // Cache it (non-blocking)
          setCachedTranslation(fromLang, toLang, originalText, { t: translatedText, a: null }).catch(e => console.warn('Cache set failed:', e));

          // 4. Generate streaming TTS
          (async () => {
            const ttsStart = Date.now();
            
            // Split text into chunks for streaming
            const textChunks = await splitTextIntoChunks(translatedText, 30);
            console.log(`🎵 Streaming TTS: ${textChunks.length} chunks`);
            
            // Generate TTS for each chunk in parallel
            const ttsPromises = textChunks.map(async (chunk, index) => {
              const chunkStart = Date.now();
              const tts = await openai.audio.speech.create({
                model: 'tts-1',
                voice: toLang === 'en' ? 'alloy' : 'nova',
                input: chunk,
                speed: 1.2,
                response_format: 'mp3',
              });
              
              const ttsBase64 = Buffer.from(await tts.arrayBuffer()).toString('base64');
              const chunkTime = Date.now() - chunkStart;
              console.log(`🎵 Chunk ${index + 1}/${textChunks.length} ready in ${chunkTime}ms`);
              
              return {
                index,
                audio: `data:audio/mp3;base64,${ttsBase64}`,
                chunkTime
              };
            });
            
            // Send chunks as they become available
            const chunkResults = await Promise.all(ttsPromises);
            
            // Send first chunk immediately
            if (chunkResults.length > 0) {
              ws.send(JSON.stringify({ 
                type: 'audio_chunk', 
                url: chunkResults[0].audio,
                chunkIndex: 0,
                totalChunks: chunkResults.length
              }));
              console.log(`🎵 First chunk sent in ${Date.now() - ttsStart}ms`);
            }
            
            // Send remaining chunks
            for (let i = 1; i < chunkResults.length; i++) {
              ws.send(JSON.stringify({ 
                type: 'audio_chunk', 
                url: chunkResults[i].audio,
                chunkIndex: i,
                totalChunks: chunkResults.length
              }));
            }
            
            // Send completion signal
            ws.send(JSON.stringify({ 
              type: 'audio_complete',
              totalChunks: chunkResults.length
            }));
            
            const totalTtsTime = Date.now() - ttsStart;
            console.log(`⏱️ Streaming TTS time: ${totalTtsTime}ms`);
            ws.send(JSON.stringify({ type: 'end', sessionId }));
          })().catch(err => {
            console.error('Streaming TTS generation failed:', err);
            ws.send(JSON.stringify({ type: 'end', sessionId }));
          });
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
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ WebSocket server running on port ${PORT}`);
  console.log(`Health: https://verlo-websocket-production.up.railway.app/health`);
});
