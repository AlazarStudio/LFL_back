// app/socket.js
import { Server } from 'socket.io';

let io;

// ===================== ХРАНИЛКИ СОСТОЯНИЙ =====================
const clocks = new Map(); // matchId -> состояние часов
const overlays = new Map(); // matchId -> флаги оверлеев (показов)

// ===================== НАСТРОЙКИ ОВЕРЛЕЕВ =====================
const DEFAULT_FLAGS = {
  OpenScore: false, // счет показать/убрать
  OpenWaiting: false, // ожидание матча
  OpenBreak: false, // перерыв между таймами
  ShowSostavTeam1: false, // показать состав команды 1
  ShowSostavTeam2: false, // показать состав команды 2
  ShowPlug: false, // заглушка показать/убрать
};

const allowedKeys = new Set(Object.keys(DEFAULT_FLAGS));

const makeOverlayDefault = (matchId) => ({
  matchId: Number(matchId),
  ...DEFAULT_FLAGS,
  serverTimestamp: Date.now(),
});

const applyOverlayPatch = (matchId, patch = {}) => {
  const id = Number(matchId);
  const curr = overlays.get(id) || makeOverlayDefault(id);
  const next = { ...curr };

  for (const [k, v] of Object.entries(patch)) {
    if (allowedKeys.has(k)) next[k] = !!v;
  }

  next.serverTimestamp = Date.now();
  overlays.set(id, next);
  return next;
};

// ===================== ЧАСЫ МАТЧА =====================
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
    startedAt: isPaused ? null : now, // когда запустили/возобновили (ms)
    serverTimestamp: now, // для синхронизации
    addedSec: Math.max(0, Number(p?.addedSec ?? 0)), // «+X»
  };
};

// ===================== ИНИЦИАЛИЗАЦИЯ SOCKET.IO =====================
export function initSocket(httpServer) {
  io = new Server(httpServer, {
    path: '/socket.io',
    cors: {
      // Добавь сюда домены, с которых будешь управлять
      origin: [
        'http://localhost:5173',
        'http://127.0.0.1:5173',
        'https://mlf09.ru',
        'https://backend.mlf09.ru',
        // 'https://your-remote-control-site.tld',
      ],
      methods: ['GET', 'POST'],
      credentials: false, // если не используешь куки
    },
  });

  io.on('connection', (socket) => {
    // ===== Общие комнаты =====
    socket.on('room:join', (room) => room && socket.join(room));
    socket.on('room:leave', (room) => room && socket.leave(room));

    // ===== Совместимость с существующей логикой =====
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

    // ===== СОБЫТИЯ ЧАСОВ =====
    // Установить новое состояние часов и разослать в комнату матча
    socket.on('tmatch:clock:set', (payload) => {
      if (!payload?.matchId) return;
      const state = normClock(payload);
      clocks.set(state.matchId, state);
      io.to(`tmatch:${state.matchId}`).emit('tmatch:clock', state);
    });

    // Отдать текущее состояние часов по запросу
    socket.on('tmatch:clock:get', ({ matchId }) => {
      const st = clocks.get(Number(matchId));
      if (st) socket.emit('tmatch:clock', st);
    });

    // ===== СОБЫТИЯ ОВЕРЛЕЕВ (ФЛАГИ ПОКАЗОВ) =====
    // Частичное обновление нескольких флагов сразу
    // payload: { matchId, OpenScore?, OpenWaiting?, OpenBreak?, ShowSostavTeam1?, ShowSostavTeam2?, ShowPlug? }
    socket.on('tmatch:overlay:set', (payload = {}) => {
      const id = Number(payload.matchId);
      if (!id) return;
      const st = applyOverlayPatch(id, payload);
      io.to(`tmatch:${id}`).emit('tmatch:overlay', st);
    });

    // Получить текущее состояние (создаёт дефолт если отсутствует)
    socket.on('tmatch:overlay:get', ({ matchId }) => {
      const id = Number(matchId);
      if (!id) return;
      const st = overlays.get(id) || makeOverlayDefault(id);
      overlays.set(id, st);
      socket.emit('tmatch:overlay', st);
    });

    // Переключить один флаг по имени
    // payload: { matchId, key: "OpenScore" | "OpenWaiting" | "OpenBreak" | "ShowSostavTeam1" | "ShowSostavTeam2" | "ShowPlug" }
    socket.on('tmatch:overlay:toggle', ({ matchId, key }) => {
      const id = Number(matchId);
      if (!id || !allowedKeys.has(key)) return;
      const curr = overlays.get(id) || makeOverlayDefault(id);
      const st = applyOverlayPatch(id, { [key]: !curr[key] });
      io.to(`tmatch:${id}`).emit('tmatch:overlay', st);
    });

    // Сброс всех флагов в false
    socket.on('tmatch:overlay:reset', ({ matchId }) => {
      const id = Number(matchId);
      if (!id) return;
      const st = makeOverlayDefault(id);
      overlays.set(id, st);
      io.to(`tmatch:${id}`).emit('tmatch:overlay', st);
    });
  });

  return io;
}

export const getIO = () => io;
