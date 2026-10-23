/**
 * Main application entry point for the Real-Time Multiplayer Backend.
 */

require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const RoomManager = require('./src/roomManager');
const setupSocketHandlers = require('./src/socketHandlers');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const ROOM_CLEANUP_TTL_MS = parseInt(process.env.ROOM_CLEANUP_TTL_MS, 10) || 300000;
const MAX_PAYLOAD_BYTES = parseInt(process.env.MAX_PAYLOAD_BYTES, 10) || 65536;
const RATE_LIMIT_STATE_PER_SEC = parseInt(process.env.RATE_LIMIT_STATE_PER_SEC, 10) || 60;
const RATE_LIMIT_CURSOR_PER_SEC = parseInt(process.env.RATE_LIMIT_CURSOR_PER_SEC, 10) || 120;

const app = express();
const server = http.createServer(app);

// CORS configuration
app.use(cors({
  origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(',').map(s => s.trim()),
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: true
}));

app.use(express.json({ limit: `${Math.ceil(MAX_PAYLOAD_BYTES / 1024)}kb` }));

// Serve static frontend assets
app.use(express.static(path.join(__dirname, 'public')));

// Shareable room route fallback
app.get('/room', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Socket.IO Server configuration
const io = new Server(server, {
  cors: {
    origin: CORS_ORIGIN === '*' ? '*' : CORS_ORIGIN.split(',').map(s => s.trim()),
    methods: ['GET', 'POST'],
    credentials: true
  },
  pingInterval: 10000,
  pingTimeout: 5000,
  maxHttpBufferSize: MAX_PAYLOAD_BYTES
});

const roomManager = new RoomManager({ cleanupTtlMs: ROOM_CLEANUP_TTL_MS });

setupSocketHandlers(io, roomManager, {
  maxPayloadBytes: MAX_PAYLOAD_BYTES,
  stateRateLimit: RATE_LIMIT_STATE_PER_SEC,
  cursorRateLimit: RATE_LIMIT_CURSOR_PER_SEC
});

// Health check endpoint (must be after io and roomManager are initialized)
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    rooms: roomManager.getRoomCount(),
    activeSockets: io.engine.clientsCount,
    timestamp: new Date().toISOString()
  });
});

// Only bind if run directly
if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`[Multiplayer Server] Running on http://${HOST}:${PORT}`);
    console.log(`[Multiplayer Server] Health check at http://${HOST}:${PORT}/health`);
  });
}

module.exports = {
  app,
  server,
  io,
  roomManager
};
