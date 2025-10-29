// app/socket.js
import { Server } from 'socket.io';

let io;

/* ===================== ХРАНИЛКИ СОСТОЯНИЙ ===================== */
const clocks = new Map(); // matchId -> состояние часов
const overlays = new Map(); // matchId -> флаги оверлеев (показов)
const lineups = new Map(); // matchId -> составы команд (server-only)

/* ===================== УТИЛИТЫ ===================== */
const toInt = (v, d = undefined) => (v === '' || v == null ? d : Number(v));

/* ===================== НАСТРОЙКИ ОВЕРЛЕЕВ ===================== */
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

/* ===================== ЧАСЫ МАТЧА ===================== */
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
    baseElapsedSec,
    isPaused,
    startedAt: isPaused ? null : now,
    serverTimestamp: now,
    addedSec: Math.max(0, Number(p?.addedSec ?? 0)), // «+X»
  };
};

/* ===================== СОСТАВЫ (SERVER-ONLY) ===================== */
const pickPlayer = (p = {}) => ({
  rosterItemId: toInt(p.rosterItemId, null), // id TournamentTeamPlayer
  playerId: toInt(p.playerId, null),
  name: String(p.name ?? ''),
  number: toInt(p.number, null),
  position: p.position ?? null, // FieldPosition
  role: p.role ?? 'STARTER', // LineupRole
  isCaptain: !!p.isCaptain,
});
const sanitizeList = (list = []) =>
  (Array.isArray(list) ? list : []).map(pickPlayer);

const sanitizeTeam = (t = {}) => ({
  teamId: toInt(t.teamId, null),
  title: String(t.title ?? ''),
  smallTitle: typeof t.smallTitle === 'string' ? t.smallTitle.trim() : null,
  coach: String(t.coach ?? ''),
  formation: String(t.formation ?? ''),
  logo: t.logo ?? null, // строка (путь/URL) или null
  list: sanitizeList(t.list),
});

const makeLineupDefault = (matchId) => ({
  matchId: Number(matchId),
  team1: sanitizeTeam(),
  team2: sanitizeTeam(),
  serverTimestamp: Date.now(),
});

const ensureLineup = (matchId) => {
  const id = Number(matchId);
  if (!lineups.has(id)) lineups.set(id, makeLineupDefault(id));
  return lineups.get(id);
};

/** Записать составы и разослать (вызывать только с бэка) */
export function setMatchLineup(matchId, payload = {}) {
  const id = Number(matchId);
  if (!id || !io) return;
  const prev = ensureLineup(id);
  const next = {
    matchId: id,
    team1: payload.team1 ? sanitizeTeam(payload.team1) : prev.team1,
    team2: payload.team2 ? sanitizeTeam(payload.team2) : prev.team2,
    serverTimestamp: Date.now(),
  };
  lineups.set(id, next);
  io.to(`tmatch:${id}`).emit('tmatch:lineup', next);
}

/** Собрать из БД (participants + команды) и разослать */
export async function emitLineupFromDB(prisma, matchId) {
  const id = Number(matchId);
  const m = await prisma.tournamentMatch.findUnique({
    where: { id },
    include: {
      participants: {
        include: {
          tournamentTeamPlayer: {
            include: { player: true, tournamentTeam: true },
          },
        },
      },
      team1TT: { include: { team: true, captainRosterItem: true } },
      team2TT: { include: { team: true, captainRosterItem: true } },
    },
  });
  if (!m) return;

  const t1Id = m.team1TT?.id ?? null;
  const t2Id = m.team2TT?.id ?? null;
  const cap1 =
    m.team1TT?.captainRosterItem?.id ?? m.team1TT?.captainRosterItemId ?? null;
  const cap2 =
    m.team2TT?.captainRosterItem?.id ?? m.team2TT?.captainRosterItemId ?? null;

  const fromParticipant = (p) => {
    const r = p.tournamentTeamPlayer;
    return {
      rosterItemId: r.id,
      playerId: r.playerId,
      name: r.player?.name ?? '',
      number: r.number ?? null,
      position: r.position ?? null,
      role: p.role ?? r.role ?? 'STARTER',
      isCaptain:
        r.id ===
        (r.tournamentTeamId === t1Id
          ? cap1
          : r.tournamentTeamId === t2Id
            ? cap2
            : null),
    };
  };

  // 1) Пытаемся собрать из participants
  let t1 = [];
  let t2 = [];
  for (const p of m.participants ?? []) {
    const r = p.tournamentTeamPlayer;
    if (!r) continue;
    if (r.tournamentTeamId === t1Id) t1.push(fromParticipant(p));
    else if (r.tournamentTeamId === t2Id) t2.push(fromParticipant(p));
  }

  // 2) Фоллбэк: если participants пустые — берём прямо из tournamentTeamPlayer
  if (t1.length === 0 && t2.length === 0 && (t1Id || t2Id)) {
    const [t1List, t2List] = await Promise.all([
      t1Id
        ? prisma.tournamentTeamPlayer.findMany({
            where: { tournamentTeamId: t1Id },
            include: { player: true },
          })
        : Promise.resolve([]),
      t2Id
        ? prisma.tournamentTeamPlayer.findMany({
            where: { tournamentTeamId: t2Id },
            include: { player: true },
          })
        : Promise.resolve([]),
    ]);

    const mapTTP = (r, cap) => ({
      rosterItemId: r.id,
      playerId: r.playerId,
      name: r.player?.name ?? '',
      number: r.number ?? null,
      position: r.position ?? null,
      role: r.role ?? 'STARTER',
      isCaptain: r.id === cap,
    });

    t1 = t1List.map((r) => mapTTP(r, cap1));
    t2 = t2List.map((r) => mapTTP(r, cap2));
  }

  setMatchLineup(id, {
    team1: {
      teamId: m.team1TT?.teamId ?? null,
      title: m.team1TT?.team?.title ?? '',
      smallTitle: m.team1TT?.team?.smallTitle ?? null,
      coach: m.team1Coach ?? '',
      formation: m.team1Formation ?? '',
      logo: m.team1TT?.team?.logo?.[0] ?? null,
      list: t1,
    },
    team2: {
      teamId: m.team2TT?.teamId ?? null,
      title: m.team2TT?.team?.title ?? '',
      smallTitle: m.team2TT?.team?.smallTitle ?? null,
      coach: m.team2Coach ?? '',
      formation: m.team2Formation ?? '',
      logo: m.team2TT?.team?.logo?.[0] ?? null,
      list: t2,
    },
  });
}

/* ===================== ИНИЦИАЛИЗАЦИЯ SOCKET.IO ===================== */
export function initSocket(httpServer) {
  io = new Server(httpServer, {
    path: '/socket.io',
    cors: {
      origin: [
        'http://localhost:5173',
        'http://127.0.0.1:5173',
        'https://mlf09.ru',
        'https://backend.mlf09.ru',
      ],
      methods: ['GET', 'POST'],
      credentials: false,
    },
  });

  io.on('connection', (socket) => {
    /* ===== Общие комнаты ===== */
    socket.on('room:join', (room) => room && socket.join(room));
    socket.on('room:leave', (room) => room && socket.leave(room));

    /* ===== Совместимость с существующей логикой ===== */
    socket.on('join', ({ matchId, tournamentId, tieId }) => {
      if (matchId) {
        socket.join(`tmatch:${matchId}`);
        // отдать текущее состояние часов/оверлеев/составов
        const clk = clocks.get(Number(matchId));
        if (clk) socket.emit('tmatch:clock', clk);

        const ov = overlays.get(Number(matchId)) || makeOverlayDefault(matchId);
        overlays.set(Number(matchId), ov);
        socket.emit('tmatch:overlay', ov);

        const lu = ensureLineup(matchId);
        socket.emit('tmatch:lineup', lu);
      }
      if (tournamentId) socket.join(`tournament:${tournamentId}`);
      if (tieId) socket.join(`ttie:${tieId}`);
    });

    socket.on('leave', ({ matchId, tournamentId, tieId }) => {
      if (matchId) socket.leave(`tmatch:${matchId}`);
      if (tournamentId) socket.leave(`tournament:${tournamentId}`);
      if (tieId) socket.leave(`ttie:${tieId}`);
    });

    /* ===== ЧАСЫ ===== */
    socket.on('tmatch:clock:set', (payload) => {
      if (!payload?.matchId) return;
      const state = normClock(payload);
      clocks.set(state.matchId, state);
      io.to(`tmatch:${state.matchId}`).emit('tmatch:clock', state);
    });
    socket.on('tmatch:clock:get', ({ matchId }) => {
      const st = clocks.get(Number(matchId));
      if (st) socket.emit('tmatch:clock', st);
    });

    /* ===== ОВЕРЛЕИ ===== */
    socket.on('tmatch:overlay:set', (payload = {}) => {
      const id = Number(payload.matchId);
      if (!id) return;
      const st = applyOverlayPatch(id, payload);
      io.to(`tmatch:${id}`).emit('tmatch:overlay', st);
    });
    socket.on('tmatch:overlay:get', ({ matchId }) => {
      const id = Number(matchId);
      if (!id) return;
      const st = overlays.get(id) || makeOverlayDefault(id);
      overlays.set(id, st);
      socket.emit('tmatch:overlay', st);
    });
    socket.on('tmatch:overlay:toggle', ({ matchId, key }) => {
      const id = Number(matchId);
      if (!id || !allowedKeys.has(key)) return;
      const curr = overlays.get(id) || makeOverlayDefault(id);
      const st = applyOverlayPatch(id, { [key]: !curr[key] });
      io.to(`tmatch:${id}`).emit('tmatch:overlay', st);
    });
    socket.on('tmatch:overlay:reset', ({ matchId }) => {
      const id = Number(matchId);
      if (!id) return;
      const st = makeOverlayDefault(id);
      overlays.set(id, st);
      io.to(`tmatch:${id}`).emit('tmatch:overlay', st);
    });

    /* ===== СОСТАВЫ (READ-ONLY ДЛЯ КЛИЕНТА) ===== */
    // Клиент может только запросить текущее состояние:
    socket.on('tmatch:lineup:get', ({ matchId }) => {
      const lu = ensureLineup(matchId);
      socket.emit('tmatch:lineup', lu);
    });
    // Обновлять составы через сокет с клиента — запрещено (нет handler'ов).
  });

  return io;
}

export const getIO = () => io;

/* ===================== ПРИМЕРЫ ИСПОЛЬЗОВАНИЯ (бэк) ===================== */
/*
import { setMatchLineup, emitLineupFromDB } from './app/socket.js';

// 1) После публикации участников матча:
await emitLineupFromDB(prisma, matchId);

// 2) Или если у тебя уже есть данные:
setMatchLineup(matchId, {
  team1: {
    teamId, title, coach, formation, logo,
    list: [
      { rosterItemId, playerId, name, number, position: 'CB', role: 'STARTER', isCaptain: true },
      // ...
    ]
  },
  team2: { ... }
});
*/
