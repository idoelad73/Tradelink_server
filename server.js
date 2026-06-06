import 'dotenv/config';
import { createServer } from 'http';
import { Server as SocketIO } from 'socket.io';
import jwt from 'jsonwebtoken';
import app from './app.js';
import { connectDB } from './config/db.js';
import Chat from './models/Chat.js';

const PORT = process.env.PORT || 3000;

const httpServer = createServer(app);

// ── Socket.io ─────────────────────────────────────────────────────────────────
const io = new SocketIO(httpServer, {
  cors: {
    origin: (origin, cb) => {
      if (!origin || origin.startsWith('http://localhost:') || origin === process.env.CLIENT_URL) {
        cb(null, true);
      } else {
        cb(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
  },
});

// Auth middleware — verify JWT sent in handshake
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('No token'));
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.userId   = decoded.id;
    socket.userType = decoded.type; // 'contractor' | 'trade'
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  // Client joins a chat room: { contractorId, tradeProId, siteId }
  socket.on('join_chat', ({ contractorId, tradeProId, siteId }) => {
    const room = `chat:${contractorId}:${tradeProId}:${siteId}`;
    socket.join(room);
    socket.currentRoom = room;
    socket.currentChat = { contractorId, tradeProId, siteId };
  });

  // Client sends a message: { contractorId, tradeProId, siteId, text }
  socket.on('send_message', async ({ contractorId, tradeProId, siteId, text }) => {
    if (!text?.trim()) return;

    const sender = socket.userType === 'trade' ? 'trade' : 'contractor';
    const msg    = { sender, text: text.trim(), timestamp: new Date() };
    const room   = `chat:${contractorId}:${tradeProId}:${siteId}`;

    try {
      // Persist to MongoDB
      const chat = await Chat.findOneAndUpdate(
        { contractorId, tradeProId, siteId },
        { $push: { messages: msg } },
        { new: true, upsert: true }
      );
      const saved = chat.messages[chat.messages.length - 1];

      // Broadcast to everyone in the room (including sender)
      io.to(room).emit('new_message', {
        _id:       saved._id,
        sender:    saved.sender,
        text:      saved.text,
        timestamp: saved.timestamp,
      });
    } catch (err) {
      socket.emit('chat_error', { message: 'Failed to save message' });
    }
  });

  socket.on('disconnect', () => {});
});

// Expose io on the Express app so controllers can broadcast from REST endpoints
app.set('io', io);

// ── Start ─────────────────────────────────────────────────────────────────────
connectDB().then(() => {
  httpServer.listen(PORT, () => {
    console.log(`TradeLink server running on port ${PORT}`);
  });
});
