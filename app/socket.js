// app/socket.js
import { Server } from 'socket.io';

let io;
let prismaRef = null;

/* ===================== ХРАНИЛКИ СОСТОЯНИЙ ===================== */
const clocks = new Map(); // matchId -> состояние часов
const overlays = new Map(); // matchId -> флаги оверлеев
const lineups = new Map(); // matchId -> { team1:{ttId,list}, team2:{ttId,list} }
const officials = new Map(); // matchId -> { referees:[], commentators:[], mainReferee, mainCommentator }

/* ===================== УТИЛИТЫ ===================== */
const nowMs = () => Date.now();

const DEFAULT_FLAGS = {
  OpenScore: false,
  OpenWaiting: false,
  OpenBreak: false,
  ShowSostavTeam1: false,
  ShowSostavTeam2: false,
  ShowPlug: false,
  ShowTimeOut: false,
  ShowJudge: false,
  ShowCommentator: false,
};

const onlyKnownFlags = (obj = {}) =>
  Object.fromEntries(
    Object.entries(obj)
      .filter(([k]) => k in DEFAULT_FLAGS)
      .map(([k, v]) => [k, !!v])
  );

/**
 * Читаем конфиг тайма из турнира матча
 */
async function getTournamentClockConfig(matchId) {
  const id = Number(matchId);
  let halfMinutes = 45;
  let halves = 2;

  if (prismaRef) {
    const row = await prismaRef.tournamentMatch.findUnique({
      where: { id },
      select: { tournament: { select: { halfMinutes: true, halves: true } } },
    });
    if (row?.tournament) {
      if (Number.isFinite(Number(row.tournament.halfMinutes))) {
        halfMinutes = Number(row.tournament.halfMinutes);
      }
      if (Number.isFinite(Number(row.tournament.halves))) {
        halves = Number(row.tournament.halves);
      }
    }
  }
  return { halfMinutes, halves };
}

/**
 * Нормализует состояние часов.
 * ВАЖНО: startedAt ставим только когда идёт (isPaused=false).
 */
const normClock = (p) => {
  const now = nowMs();
  const halfMinutes = Number(p?.halfMinutes ?? 45);
  const half = Number(p?.half ?? 1);
  const baseElapsedSec = Math.max(0, Number(p?.baseElapsedSec ?? 0));
  const isPaused = !!p?.isPaused;
  const phase = String(p?.phase || (half === 1 ? 'H1' : 'H2')); // H1, HT, H2, ET1, ET2, FT, PEN
  const addedSec = Math.max(0, Number(p?.addedSec ?? 0));
  const halves = Number(p?.halves ?? 2);

  return {
    matchId: Number(p.matchId),
    phase,
    half,
    halfMinutes,
    halves,
    baseElapsedSec,
    addedSec,
    isPaused,
    startedAt: isPaused ? null : now,
    serverTimestamp: now,
  };
};

/**
 * Добавляем производные поля для удобного отображения абсолютного времени
 * - absOffsetSec  = смещение в секундах за счёт прошедших таймов
 * - displayBaseSec = base+added+offset (можно сразу рисовать mm:ss)
 */
const enrichClock = (st) => {
  if (!st) return st;
  const halfMinutes = Number(st?.halfMinutes ?? 45);
  const half = Number(st?.half ?? 1);
  const base = Math.max(0, Number(st?.baseElapsedSec ?? 0));
  const added = Math.max(0, Number(st?.addedSec ?? 0));
  const absOffsetSec = (half - 1) * halfMinutes * 60;
  const displayBaseSec = base + added + absOffsetSec;
  return { ...st, absOffsetSec, displayBaseSec };
};

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
      include: { player: true, tournamentTeam: true },
      orderBy: [{ role: 'asc' }, { number: 'asc' }, { id: 'asc' }],
    });
    rows = roster.map((r) => ({
      matchId: id,
      tournamentTeamPlayerId: r.id,
      role: r.role || 'STARTER',
      position: r.position || null,
      // капитан из заявки:
      isCaptain: !!(r.tournamentTeam?.captainRosterItemId === r.id),
      order: r.number ?? 0,
      tournamentTeamPlayer: {
        id: r.id,
        number: r.number,
        playerId: r.playerId,
        position: r.position ?? null,
        player: r.player,
        tournamentTeamId: r.tournamentTeamId,
        tournamentTeam: r.tournamentTeam,
      },
    }));
  }

  const toList = (ttId) =>
    rows
      .filter((r) => r.tournamentTeamPlayer.tournamentTeamId === ttId)
      .map((r) => {
        const player = r.tournamentTeamPlayer?.player;
        const photo =
          Array.isArray(player?.images) && player.images.length
            ? player.images[0]
            : null;
        const capId =
          r.tournamentTeamPlayer?.tournamentTeam?.captainRosterItemId;
        return {
          rosterItemId: r.tournamentTeamPlayerId,
          playerId: r.tournamentTeamPlayer.playerId,
          name: r.tournamentTeamPlayer.player?.name || '',
          number: r.tournamentTeamPlayer.number,
          position: (r.position ?? r.tournamentTeamPlayer?.position) || null,
          role: r.role || 'STARTER',
          isCaptain: !!(
            r.isCaptain ||
            (capId && capId === r.tournamentTeamPlayerId)
          ),
          order: r.order ?? 0,
          photo,
          images: Array.isArray(player?.images) ? player.images : [],
        };
      });

  return {
    matchId: id,
    team1: { ttId: m.team1TTId, list: toList(m.team1TTId) },
    team2: { ttId: m.team2TTId, list: toList(m.team2TTId) },
  };
}

async function buildDefaultClockFromDB(matchId) {
  const id = Number(matchId);
  const cfg = await getTournamentClockConfig(id); // { halfMinutes, halves }
  // Пауза в 1-м тайме, 0:00
  return enrichClock({
    matchId: id,
    phase: 'H1',
    half: 1,
    halfMinutes: cfg.halfMinutes,
    halves: cfg.halves,
    baseElapsedSec: 0,
    isPaused: true,
    startedAt: null,
    serverTimestamp: Date.now(),
    addedSec: 0,
  });
}

/* ===================== OFFICIALS (судьи/комментаторы) ===================== */
function deriveOfficials(obj = {}) {
  const normList = (arr = []) =>
    arr
      .filter(Boolean)
      .map((x) => ({
        id: Number(x.id ?? x.refereeId ?? x.commentatorId),
        name: String(x.name ?? ''),
        role: x.role ? String(x.role) : null, // MAIN / CO / AR1 / AR2 / ...
        images: Array.isArray(x.images) ? x.images : [],
      }))
      .filter((x) => Number.isFinite(x.id));

  const referees = normList(obj.referees);
  const commentators = normList(obj.commentators);

  const pickMain = (list, mainRole = 'MAIN') =>
    list.find((x) => x.role === mainRole) || list[0] || null;

  return {
    matchId: Number(obj.matchId),
    referees,
    commentators,
    mainReferee: pickMain(referees, 'MAIN'),
    mainCommentator: pickMain(commentators, 'MAIN'),
  };
}

async function buildOfficialsFromDB(prisma, matchId) {
  const id = Number(matchId);
  const m = await prisma.tournamentMatch.findUnique({
    where: { id },
    select: {
      id: true,
      group: {
        select: {
          defaultReferee: { select: { id: true, name: true, images: true } },
          defaultCommentator: {
            select: { id: true, name: true, images: true },
          },
        },
      },
      referees: { include: { referee: true } }, // TournamentMatchReferee[]
      commentators: { include: { commentator: true } }, // TournamentMatchCommentator[]
    },
  });
  if (!m) {
    return {
      matchId: id,
      referees: [],
      commentators: [],
      mainReferee: null,
      mainCommentator: null,
    };
  }

  const refs =
    m.referees?.map((r) => ({
      id: r.referee?.id,
      name: r.referee?.name,
      images: r.referee?.images ?? [],
      role: r.role || 'MAIN',
    })) ?? [];

  const comms =
    m.commentators?.map((c) => ({
      id: c.commentator?.id,
      name: c.commentator?.name,
      images: c.commentator?.images ?? [],
      role: c.role || 'MAIN',
    })) ?? [];

  // фолбэки из группы
  if (!refs.length && m.group?.defaultReferee) {
    refs.push({
      id: m.group.defaultReferee.id,
      name: m.group.defaultReferee.name,
      images: m.group.defaultReferee.images ?? [],
      role: 'MAIN',
    });
  }
  if (!comms.length && m.group?.defaultCommentator) {
    comms.push({
      id: m.group.defaultCommentator.id,
      name: m.group.defaultCommentator.name,
      images: m.group.defaultCommentator.images ?? [],
      role: 'MAIN',
    });
  }

  return deriveOfficials({ matchId: id, referees: refs, commentators: comms });
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

      // На всякий случай подтягиваем свежие значения из турнира (если их меняли)
      const cfg = await getTournamentClockConfig(id);
      if (st.halfMinutes !== cfg.halfMinutes || st.halves !== cfg.halves) {
        st = enrichClock({
          ...st,
          halfMinutes: cfg.halfMinutes,
          halves: cfg.halves,
        });
        clocks.set(id, st);
      }

      ack && ack(st);
      socket.emit('tmatch:clock', st);
    });

    socket.on('tmatch:clock:set', async (patch, ack) => {
      try {
        const id = Number(patch?.matchId);
        if (!id) throw new Error('matchId required');
        const next = await setClock(id, patch); // нормализует и пошлёт в комнату
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

    /* ====== Судьи/Комментаторы ====== */
    socket.on('tmatch:officials:get', async ({ matchId }, ack) => {
      const id = Number(matchId);
      let st = officials.get(id);
      if (!st && prismaRef) {
        st = await buildOfficialsFromDB(prismaRef, id);
        officials.set(id, st);
      }
      const fallback = {
        matchId: id,
        referees: [],
        commentators: [],
        mainReferee: null,
        mainCommentator: null,
      };
      ack && ack(st || fallback);
      socket.emit('tmatch:officials', st || fallback);
    });

    socket.on('tmatch:officials:set', (payload, ack) => {
      try {
        const id = Number(payload?.matchId);
        if (!id) throw new Error('matchId required');

        const st = deriveOfficials({
          matchId: id,
          referees: payload?.referees, // ожидаем [{id, name?, role?, images?}]
          commentators: payload?.commentators,
        });

        officials.set(id, st);
        io.to(`tmatch:${id}`).emit('tmatch:officials', st);
        ack && ack(st);
      } catch (e) {
        ack && ack({ error: String(e) });
      }
    });
  });

  return io;
}

export function getIO() {
  if (!io) throw new Error('Socket.io is not initialized');
  return io;
}

/* ===== часы ===== */
export async function setClock(matchId, statePatch) {
  const id = Number(matchId);
  const prev = clocks.get(id);
  const cfg = await getTournamentClockConfig(id); // { halfMinutes, halves }

  // гарантируем турнирные настройки
  const patch = {
    ...statePatch,
    halfMinutes: Number(
      statePatch?.halfMinutes ?? prev?.halfMinutes ?? cfg.halfMinutes
    ),
    halves: Number(statePatch?.halves ?? prev?.halves ?? cfg.halves),
  };

  // если меняем тайм/фазу — переносим базу на конец прошлого тайма,
  // чтобы второй (и далее) начинался не с 0, а с конца предыдущего
  const prevHalf = Number(prev?.half ?? 1);
  const nextHalf = Number(patch?.half ?? prevHalf);
  const phaseChanged =
    (patch?.phase && patch.phase !== prev?.phase) || nextHalf !== prevHalf;

  if (phaseChanged && patch.baseElapsedSec == null && prev) {
    const hm =
      Number(prev?.halfMinutes ?? patch.halfMinutes ?? cfg.halfMinutes) || 45;
    const prevBase = Math.max(0, Number(prev?.baseElapsedSec ?? 0));
    const prevAdded = Math.max(0, Number(prev?.addedSec ?? 0));
    const prevDisplayBase = prevBase + prevAdded + (prevHalf - 1) * hm * 60;
    patch.baseElapsedSec = prevDisplayBase; // <- ключевая строка
  }

  const next = enrichClock(normClock({ matchId: id, ...prev, ...patch }));
  clocks.set(id, next);
  getIO().to(`tmatch:${id}`).emit('tmatch:clock', next);
  return next;
}

/* ===== оверлеи ===== */
const getOverlay = (matchId) => {
  const id = Number(matchId);
  return { ...DEFAULT_FLAGS, ...(overlays.get(id) || {}) };
};

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

/* ===== officials: публичная функция для роутов ===== */
export async function emitOfficialsFromDB(prisma, matchId) {
  const id = Number(matchId);
  const payload = await buildOfficialsFromDB(prisma, id);
  officials.set(id, payload);
  getIO().to(`tmatch:${id}`).emit('tmatch:officials', payload);
  return payload;
}
