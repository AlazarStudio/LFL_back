// app/socket.js
import { Server } from 'socket.io';

let io;

/** Инициализация Socket.IO на базе переданного http/https сервера */
export function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: [
        'http://localhost:5173',
        'http://localhost:3000',
        // добавь домены твоих фронтов:
        'https://твойдругойсайт.домен',
        'https://текущийфронт.домен',
      ],
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      credentials: true,
    },
  });

  io.on('connection', (socket) => {
    // Подписка на комнаты матча/лиги
    socket.on('join', ({ matchId, leagueId }) => {
      if (matchId) socket.join(`match:${matchId}`);
      if (leagueId) socket.join(`league:${leagueId}`);
    });
    socket.on('leave', ({ matchId, leagueId }) => {
      if (matchId) socket.leave(`match:${matchId}`);
      if (leagueId) socket.leave(`league:${leagueId}`);
    });
  });

  return io;
}

export function getIO() {
  if (!io) throw new Error('Socket.io not initialized');
  return io;
}
