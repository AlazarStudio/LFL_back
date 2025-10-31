// app/socket.js
import { Server } from 'socket.io';

let io;
let prismaRef = null;

/* ===================== ХРАНИЛКИ СОСТОЯНИЙ ===================== */
const clocks = new Map(); // matchId -> состояние часов
const overlays = new Map(); // matchId -> флаги оверлеев
const lineups = new Map(); // matchId -> { team1:{ttId,list}, team2:{ttId,list} }

/* ===================== УТИЛИТЫ ===================== */
const nowMs = () => Date.now();

const DEFAULT_FLAGS = {
  OpenScore: false,
  OpenWaiting: false,
  OpenBreak: false,
  ShowSostavTeam1: false,
  ShowSostavTeam2: false,
  ShowPlug: false,
};

const normClock = (p) => {
  const now = nowMs();
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
    baseElapsedSec,
    isPaused,
    startedAt: isPaused ? null : now, // фиксируем момент старта/возобновления на сервере
    serverTimestamp: now,
    addedSec: Math.max(0, Number(p?.addedSec ?? 0)),
  };
};

const getOverlay = (matchId) => {
  const id = Number(matchId);
  return { ...DEFAULT_FLAGS, ...(overlays.get(id) || {}) };
};

const onlyKnownFlags = (obj = {}) =>
  Object.fromEntries(
    Object.entries(obj)
      .filter(([k]) => k in DEFAULT_FLAGS)
      .map(([k, v]) => [k, !!v])
  );

/* ===================== ЛАЙНАП И ЧАСЫ ИЗ БД ===================== */
async function buildLineupFromDB(prisma, matchId) {
  const id = Number(matchId);
  const m = await prisma.tournamentMatch.findUnique({
    where: { id },
    select: {
      id: true,
      tournamentId: true,
      team1TTId: true,
      team2TTId: true,
    },
  });
  if (!m) return null;

  // 1) Из участников матча
  let rows = await prisma.tournamentPlayerMatch.findMany({
    where: { matchId: id },
    include: {
      tournamentTeamPlayer: {
        include: { player: true, tournamentTeam: true },
      },
    },
    orderBy: [{ role: 'asc' }, { order: 'asc' }, { id: 'asc' }],
  });

  // 2) Фолбэк: из заявки TT
  if (!rows.length) {
    const roster = await prisma.tournamentTeamPlayer.findMany({
      where: { tournamentTeamId: { in: [m.team1TTId, m.team2TTId] } },
      include: { player: true },
      orderBy: [{ role: 'asc' }, { number: 'asc' }, { id: 'asc' }],
    });
    rows = roster.map((r) => ({
      matchId: id,
      tournamentTeamPlayerId: r.id,
      role: r.role || 'STARTER',
      position: r.position || null,
      isCaptain: false,
      order: r.number ?? 0,
      tournamentTeamPlayer: {
        id: r.id,
        number: r.number,
        playerId: r.playerId,
        player: r.player,
        tournamentTeamId: r.tournamentTeamId,
      },
    }));
  }

  const toList = (ttId) =>
    rows
      .filter((r) => r.tournamentTeamPlayer.tournamentTeamId === ttId)
      .map((r) => ({
        rosterItemId: r.tournamentTeamPlayerId,
        playerId: r.tournamentTeamPlayer.playerId,
        name: r.tournamentTeamPlayer.player?.name || '',
        number: r.tournamentTeamPlayer.number,
        position: r.position || null,
        role: r.role || 'STARTER',
        isCaptain: !!r.isCaptain,
        order: r.order ?? 0,
      }));

  return {
    matchId: id,
    team1: { ttId: m.team1TTId, list: toList(m.team1TTId) },
    team2: { ttId: m.team2TTId, list: toList(m.team2TTId) },
  };
}

async function buildDefaultClockFromDB(matchId) {
  const id = Number(matchId);
  let halfMinutes = 45;
  if (prismaRef) {
    const m = await prismaRef.tournamentMatch.findUnique({
      where: { id },
      select: { tournament: { select: { halfMinutes: true } } },
    });
    halfMinutes = Number(m?.tournament?.halfMinutes ?? 45);
  }
  // Пауза в 1-м тайме, 0:00
  return {
    matchId: id,
    phase: 'H1',
    half: 1,
    halfMinutes,
    baseElapsedSec: 0,
    isPaused: true,
    startedAt: null,
    serverTimestamp: Date.now(),
    addedSec: 0,
  };
}

/* =========================================================
   ПУБЛИЧНЫЕ API ДЛЯ СЕРВЕРА
========================================================= */
export function initSocket(httpServer, { prisma } = {}) {
  prismaRef = prisma || null;

  io = new Server(httpServer, {
    path: '/socket.io',
    cors: {
      origin: '*',
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      credentials: false,
    },
  });

  io.on('connection', (socket) => {
    /* ====== Комнаты ====== */
    socket.on('room:join', (room, ack) => {
      try {
        if (room) socket.join(room);
        ack && ack({ ok: true, room });
      } catch (e) {
        ack && ack({ ok: false, error: String(e) });
      }
    });

    socket.on('room:leave', (room) => {
      try {
        if (room) socket.leave(room);
      } catch {}
    });

    /* ====== Часы ====== */
    socket.on('tmatch:clock:get', async ({ matchId }, ack) => {
      const id = Number(matchId);
      let st = clocks.get(id);
      if (!st) {
        st = await buildDefaultClockFromDB(id);
        clocks.set(id, st);
      }
      if (st) {
        ack && ack(st); // вернуть текущее состояние в ACK
        socket.emit('tmatch:clock', st); // и продублировать событием
      }
    });

    socket.on('tmatch:clock:set', (patch, ack) => {
      try {
        const id = Number(patch?.matchId);
        if (!id) throw new Error('matchId required');
        const next = setClock(id, patch); // нормализует и пошлёт в комнату
        ack && ack(next);
      } catch (e) {
        ack && ack({ error: String(e) });
      }
    });

    /* ====== Оверлеи ====== */
    socket.on('tmatch:overlay:get', ({ matchId }, ack) => {
      const st = getOverlay(matchId);
      ack && ack(st);
      socket.emit('tmatch:overlay', st);
    });

    socket.on('tmatch:overlay:set', (payload, ack) => {
      try {
        const id = Number(payload?.matchId);
        if (!id) throw new Error('matchId required');

        const prev = getOverlay(id);
        const patch = onlyKnownFlags(payload);

        // // взаимоисключение составов (опционально):
        // if (patch.ShowSostavTeam1) patch.ShowSostavTeam2 = false;
        // if (patch.ShowSostavTeam2) patch.ShowSostavTeam1 = false;

        const next = { ...prev, ...patch };
        overlays.set(id, next);
        io.to(`tmatch:${id}`).emit('tmatch:overlay', next);
        ack && ack(next);
      } catch (e) {
        ack && ack({ error: String(e) });
      }
    });

    /* ====== Составы ====== */
    socket.on('tmatch:lineup:get', async ({ matchId }) => {
      const id = Number(matchId);
      let lu = lineups.get(id);
      if (!lu && prismaRef) {
        lu = await buildLineupFromDB(prismaRef, id);
        if (lu) lineups.set(id, lu);
      }
      if (lu) socket.emit('tmatch:lineup', lu);
    });
  });

  return io;
}

export function getIO() {
  if (!io) throw new Error('Socket.io is not initialized');
  return io;
}

/* ===== часы ===== */
export function setClock(matchId, statePatch) {
  const id = Number(matchId);
  const prev = clocks.get(id);
  const next = normClock({ matchId: id, ...prev, ...statePatch });
  clocks.set(id, next);
  getIO().to(`tmatch:${id}`).emit('tmatch:clock', next);
  return next;
}

/* ===== оверлеи ===== */
export function setOverlayFlags(matchId, patch) {
  const id = Number(matchId);
  const prev = getOverlay(id);
  const next = { ...prev, ...onlyKnownFlags(patch) };
  overlays.set(id, next);
  getIO().to(`tmatch:${id}`).emit('tmatch:overlay', next);
  return next;
}

export function resetOverlay(matchId) {
  const id = Number(matchId);
  const st = { ...DEFAULT_FLAGS };
  overlays.set(id, st);
  getIO().to(`tmatch:${id}`).emit('tmatch:overlay', st);
  return st;
}

/* ===== лайнапы: публичная функция для роутов ===== */
export async function emitLineupFromDB(prisma, matchId) {
  const payload = await buildLineupFromDB(prisma, Number(matchId));
  if (!payload) return null;
  lineups.set(Number(matchId), payload);
  getIO()
    .to(`tmatch:${Number(matchId)}`)
    .emit('tmatch:lineup', payload);
  return payload;
}
