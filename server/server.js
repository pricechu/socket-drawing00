// server.js
import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, '../public')));

const PORT = process.env.PORT || 3000;

// In-memory rabbit state
let rabbits = []; // { id, name, imgData, x, y, scale, createdAt }
let nextId = 1;

// Broadcast helper
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;

  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('close', (code, reason) => {
    console.log('[ws] closed', code, reason?.toString?.() ?? '');
  });
  ws.on('error', (err) => {
    console.error('[ws] error', err);
  });

  // Send current state to new client
  ws.send(JSON.stringify({ type: 'sync_state', rabbits }));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      switch (msg.type) {
        case 'add_rabbit': {
          // Expect: { type:'add_rabbit', name, imgData, w, h }
          const { name = 'Rabbit', imgData, w, h } = msg ?? {};
          if (!imgData || typeof imgData !== 'string') return;

          // Very light sanity checks (limit size to ~1.5MB)
          if (!imgData.startsWith('data:image/') || imgData.length > 1_500_000) {
            console.warn('[ws] rejected image (format/size)');
            return;
          }

          // Random placement and mild scaling for variety
          const scale = Math.min(1.2, Math.max(0.6, (w && h) ? 320 / Math.max(w, h) : 1));
          const newRabbit = {
            id: nextId++,
            name,
            imgData, // data URL (png/webp)
            x: Math.random(),               // normalized 0..1 (convert to pixels client-side)
            y: 0.55 + Math.random() * 0.35, // bias toward lower meadow
            scale,
            createdAt: Date.now()
          };
          rabbits.push(newRabbit);
          broadcast({ type: 'new_rabbit', rabbit: newRabbit });
          break;
        }
        case 'clear_all': {
          rabbits = [];
          broadcast({ type: 'clear_all' });
          break;
        }
        case 'remove_rabbit': {
          const { id } = msg;
          if (!id) break;
          rabbits = rabbits.filter(r => r.id !== id);
          broadcast({ type: 'remove_rabbit', id });
          break;
        }
        default:
          // ignore unknown
          break;
      }
    } catch (e) {
      console.error('Invalid message:', e);
    }
  });
});

// Basic heartbeat (optional)
const HEARTBEAT_INTERVAL = 30000;
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log('[ws] terminating dead socket');
      return ws.terminate();
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { console.warn('[ws] ping failed', e); }
  });
}, HEARTBEAT_INTERVAL);

wss.on('close', () => clearInterval(interval));

server.listen(PORT, () => {
  console.log(`🐇 Rabbit Zoo running at http://localhost:${PORT}`);
  console.log(`Open the Zoo:  http://localhost:${PORT}/zoo.html`);
  console.log(`Draw a rabbit:  http://localhost:${PORT}/draw.html`);
});
