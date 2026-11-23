import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Server } from 'socket.io';
import { verifyToken } from './auth.js';
import {
  register, authenticate, getUserById, getChats, createChat,
  getMessages, addMessage, getUsersExcept,
} from './database.js';

const app = express();
app.use(cors());
app.use(express.json());

// --- Проверка JWT ---
function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const payload = verifyToken(token);
  const user = payload && getUserById(payload.id);
  if (!user) return res.status(401).json({ error: 'Не авторизован' });
  req.user = user;
  next();
}

app.post('/api/register', (req, res) => {
  try {
    res.status(201).json(register(req.body.username, req.body.password));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/login', (req, res) => {
  try {
    res.json(authenticate(req.body.username, req.body.password));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/me', auth, (req, res) => res.json(req.user));

app.get('/api/chats', auth, (req, res) => res.json(getChats(req.user.id)));

app.get('/api/users', auth, (req, res) => res.json(getUsersExcept(req.user.id)));

app.post('/api/chats', auth, (req, res) => {
  try {
    const id = createChat(req.user.id, req.body.name, req.body.memberIds);
    res.json({ id, name: req.body.name.trim() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/chats/:id/messages', auth, (req, res) => {
  const messages = getMessages(req.params.id, req.user.id);
  if (!messages) return res.status(403).json({ error: 'Нет доступа к чату' });
  res.json(messages);
});

app.post('/api/chats/:id/messages', auth, (req, res) => {
  try {
    const message = addMessage(req.params.id, req.user.id, req.body.text);
    // Рассылаем сообщение всем участникам чата в реальном времени
    io.to(`chat_${req.params.id}`).emit('message:new', message);
    res.status(201).json(message);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- Отдаём собранный клиент (для деплоя на одном порту) ---
const clientDist = resolve(process.env.CLIENT_DIST || '../client/dist');
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => res.sendFile(resolve(clientDist, 'index.html')));
  console.log(`📁 Клиент раздаётся из ${clientDist}`);
}

// --- Socket.io: реальное время ---
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

const onlineUsers = new Map(); // userId -> set of socket ids

io.use((socket, next) => {
  const payload = verifyToken(socket.handshake.auth?.token);
  const user = payload && getUserById(payload.id);
  if (!user) return next(new Error('Не авторизован'));
  socket.user = user;
  next();
});

io.on('connection', (socket) => {
  const userId = socket.user.id;

  if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
  onlineUsers.get(userId).add(socket.id);

  // Подключаемся ко всем чатам пользователя
  for (const chat of getChats(userId)) socket.join(`chat_${chat.id}`);

  io.emit('users:online', [...onlineUsers.keys()]);

  socket.on('typing', ({ chatId, isTyping }) => {
    socket.to(`chat_${chatId}`).emit('typing', {
      userId,
      username: socket.user.username,
      isTyping,
    });
  });

  socket.on('disconnect', () => {
    const set = onlineUsers.get(userId);
    set?.delete(socket.id);
    if (set?.size === 0) onlineUsers.delete(userId);
    io.emit('users:online', [...onlineUsers.keys()]);
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`✅ Сервер чата запущен: http://localhost:${PORT}`);
});
