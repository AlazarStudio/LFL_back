// app/socket.js
import { Server } from 'socket.io';

let io;
const clocks = new Map(); // matchId -> state

const normClock = (p) => {
  const now = Date.now();
  const halfMinutes = Number(p?.halfMinutes ?? 45);
  const half = Number(p?.half ?? 1);
  const baseElapsedSec = Math.max(0, Number(p?.baseElapsedSec ?? 0));
  const isPaused = !!p?.isPaused;
  const phase = String(p?.phase || 'H1'); // H1, HT, H2, ET1, ET2, FT, PEN
  return {
    matchId: Number(p.matchId),
    phase,
    half,
    halfMinutes,
    baseElapsedSec, // сколько секунд прошло в тайме на момент записи
    isPaused,
    startedAt: isPaused ? null : now, // когда возобновили/стартанули (ms)
    serverTimestamp: now, // для синхронизации
    addedSec: Math.max(0, Number(p?.addedSec ?? 0)), // «+X»
  };
};

export function initSocket(httpServer) {
  io = new Server(httpServer, {
    path: '/socket.io',
    cors: {
      origin: ['http://localhost:5173', 'http://localhost:3000', '*'],
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      credentials: true,
    },
  });

  io.on('connection', (socket) => {
    // комнаты
    socket.on('room:join', (room) => room && socket.join(room));
    socket.on('room:leave', (room) => room && socket.leave(room));

    // совместимость
    socket.on('join', ({ matchId, tournamentId, tieId }) => {
      if (matchId) socket.join(`tmatch:${matchId}`);
      if (tournamentId) socket.join(`tournament:${tournamentId}`);
      if (tieId) socket.join(`ttie:${tieId}`);
    });
    socket.on('leave', ({ matchId, tournamentId, tieId }) => {
      if (matchId) socket.leave(`tmatch:${matchId}`);
      if (tournamentId) socket.leave(`tournament:${tournamentId}`);
      if (tieId) socket.leave(`ttie:${tieId}`);
    });

    // часы: модалка присылает set → всем в комнате
    socket.on('tmatch:clock:set', (payload) => {
      if (!payload?.matchId) return;
      const state = normClock(payload);
      clocks.set(state.matchId, state);
      io.to(`tmatch:${state.matchId}`).emit('tmatch:clock', state);
    });

    // монитор только запрашивает последнее состояние, если есть
    socket.on('tmatch:clock:get', ({ matchId }) => {
      const st = clocks.get(Number(matchId));
      if (st) socket.emit('tmatch:clock', st);
    });
  });

  return io;
}
export const getIO = () => io;
