// sockets/clock.js (пример)
import { Server } from 'socket.io';

export function attachClock(io /** @type {Server} */) {
  // in-memory (замени на БД, если нужно)
  const clocks = new Map(); // matchId -> state

  const def = (matchId) => ({
    matchId,
    phase: 'H1',
    half: 1,
    halfMinutes: 45,
    baseElapsedSec: 0,
    addedSec: 0,
    isPaused: true,
    startedAt: null, // timestamp ms
  });

  io.on('connection', (s) => {
    s.on('room:join', (room) => s.join(room));
    s.on('room:leave', (room) => s.leave(room));

    s.on('tmatch:clock:get', ({ matchId }) => {
      const st = clocks.get(matchId) || def(matchId);
      s.emit('tmatch:clock', st);
    });

    s.on('tmatch:clock:set', (patch) => {
      const { matchId } = patch || {};
      if (!matchId) return;

      const prev = clocks.get(matchId) || def(matchId);
      const next = { ...prev, ...patch };

      // если переводим в "играем" — фиксируем startedAt
      if (next.isPaused === false) {
        next.startedAt = Date.now();
      } else {
        next.startedAt = null;
      }

      clocks.set(matchId, next);
      io.to(`tmatch:${matchId}`).emit('tmatch:clock', next);
    });
  });
}
