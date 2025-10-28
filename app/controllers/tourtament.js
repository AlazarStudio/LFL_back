import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { getIO, emitLineupFromDB } from '../socket.js';

const router = Router();
const prisma = new PrismaClient();

/* =========================================================
   helpers
========================================================= */
const safeJSON = (v, fb) => {
  try {
    return v ? JSON.parse(String(v)) : fb;
  } catch {
    return fb;
  }
};
const toInt = (v, d = undefined) => (v === '' || v == null ? d : Number(v));
const toDate = (v, d = undefined) => (v ? new Date(v) : d);
const setRange = (res, name, start, count, total) => {
  res.setHeader(
    'Content-Range',
    `${name} ${start}-${start + count - 1}/${total}`
  );
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range');
};
const toStrArr = (val) => {
  const arr = Array.isArray(val) ? val : [val];
  return arr
    .filter(Boolean)
    .map((x) => (typeof x === 'string' ? x : x?.src || x?.url || x?.path || ''))
    .filter(Boolean);
};
const isGoalType = (t) => t === 'GOAL' || t === 'PENALTY_SCORED';

const STARTERS_BY_FORMAT = {
  F5x5: 5,
  F6x6: 6,
  F7x7: 7,
  F8x8: 8,
  F9x9: 9,
  F10x10: 10,
  F11x11: 11,
};

/* ---------- bracket helpers (только генерация) ---------- */
const STAGE_ORDER = [
  'ROUND_OF_32',
  'ROUND_OF_16',
  'QUARTERFINAL',
  'SEMIFINAL',
  'FINAL',
];

function stageForTeamCount(n) {
  switch (n) {
    case 32:
      return 'ROUND_OF_32';
    case 16:
      return 'ROUND_OF_16';
    case 8:
      return 'QUARTERFINAL';
    case 4:
      return 'SEMIFINAL';
    case 2:
      return 'FINAL';
    default:
      return null;
  }
}

async function getOrCreateRound(
  tx,
  tournamentId,
  stage,
  number = null,
  name = null,
  date = null
) {
  let round = await tx.tournamentRound.findFirst({
    where: { tournamentId, stage },
  });
  if (!round) {
    round = await tx.tournamentRound.create({
      data: {
        tournamentId,
        stage,
        number,
        name,
        date,
      },
    });
  }
  return round;
}

/* -------------------- include builders -------------------- */
const buildTournamentInclude = (p) => {
  const parts = String(p || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return {
    teams: parts.includes('teams')
      ? {
          include: {
            team: true,
            roster: parts.includes('roster')
              ? { include: { player: true } }
              : false,
            captainRosterItem: !!parts.includes('roster'),
          },
        }
      : false,
    rounds: !!parts.includes('rounds'),
    ties: parts.includes('ties')
      ? {
          include: {
            team1TT: { include: { team: true } },
            team2TT: { include: { team: true } },
          },
        }
      : false,
    matches: parts.includes('matches')
      ? {
          include: {
            team1TT: { include: { team: true } },
            team2TT: { include: { team: true } },
            stadiumRel: true,
            referees: { include: { referee: true } },
          },
        }
      : false,
    groups: parts.includes('groups')
      ? {
          include: {
            teams: { include: { tournamentTeam: { include: { team: true } } } },
          },
        }
      : false,
  };
};

const buildTMatchInclude = (p) => {
  const parts = String(p || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return {
    tournament: !!parts.includes('tournament'),
    round: !!parts.includes('round'),
    tie: !!parts.includes('tie'),
    group: !!parts.includes('group'),
    team1TT: parts.includes('team1') ? { include: { team: true } } : false,
    team2TT: parts.includes('team2') ? { include: { team: true } } : false,
    stadiumRel: !!parts.includes('stadium'),
    referees: parts.includes('referees')
      ? { include: { referee: true } }
      : false,
    events: parts.includes('events')
      ? {
          include: {
            rosterItem: { include: { player: true } },
            assistRosterItem: { include: { player: true } },
            tournamentTeam: { include: { team: true } },
          },
        }
      : false,
    participants: parts.includes('participants')
      ? { include: { tournamentTeamPlayer: { include: { player: true } } } }
      : false,
  };
};

/* -------------------- guards & asserts -------------------- */
async function assertTournamentTeam(tournamentId, teamId) {
  const t = await prisma.tournamentTeam.findUnique({
    where: { tournamentId_teamId: { tournamentId, teamId } },
    select: { id: true },
  });
  if (!t) throw new Error('Команда не заявлена в турнире');
  return t.id;
}
async function assertRosterItemBelongs(rosterItemId, tournamentTeamId) {
  const it = await prisma.tournamentTeamPlayer.findUnique({
    where: { id: rosterItemId },
    select: { tournamentTeamId: true },
  });
  if (!it) throw new Error('Игрок-заявка не найдена');
  if (it.tournamentTeamId !== tournamentTeamId)
    throw new Error('Игрок не принадлежит этой заявке');
}

/* -------------------- stats helpers (global PlayerStat) -------------------- */
async function incPlayerStatByRoster(rosterItemId, type) {
  const it = await prisma.tournamentTeamPlayer.findUnique({
    where: { id: rosterItemId },
    select: { playerId: true },
  });
  if (!it) return;
  const { playerId } = it;
  await prisma.playerStat.upsert({
    where: { playerId },
    update: {
      goals: isGoalType(type) ? { increment: 1 } : undefined,
      assists: type === 'ASSIST' ? { increment: 1 } : undefined,
      yellow_cards: type === 'YELLOW_CARD' ? { increment: 1 } : undefined,
      red_cards: type === 'RED_CARD' ? { increment: 1 } : undefined,
    },
    create: {
      playerId,
      matchesPlayed: 1,
      goals: isGoalType(type) ? 1 : 0,
      assists: type === 'ASSIST' ? 1 : 0,
      yellow_cards: type === 'YELLOW_CARD' ? 1 : 0,
      red_cards: type === 'RED_CARD' ? 1 : 0,
    },
  });
}
async function decPlayerStatByRoster(rosterItemId, type) {
  const it = await prisma.tournamentTeamPlayer.findUnique({
    where: { id: rosterItemId },
    select: { playerId: true },
  });
  if (!it) return;
  const { playerId } = it;
  await prisma.playerStat.updateMany({
    where: { playerId },
    data: {
      goals: isGoalType(type) ? { decrement: 1 } : undefined,
      assists: type === 'ASSIST' ? { decrement: 1 } : undefined,
      yellow_cards: type === 'YELLOW_CARD' ? { decrement: 1 } : undefined,
      red_cards: type === 'RED_CARD' ? { decrement: 1 } : undefined,
    },
  });
}

/* -------------------- scoring & tie logic -------------------- */
async function recomputeTMatchScore(matchId) {
  await prisma.$transaction(async (tx) => {
    const grouped = await tx.tournamentMatchEvent.groupBy({
      by: ['tournamentTeamId'],
      where: { matchId, type: { in: ['GOAL', 'PENALTY_SCORED'] } },
      _count: { _all: true },
    });
    const m = await tx.tournamentMatch.findUnique({
      where: { id: matchId },
      select: { id: true, team1TTId: true, team2TTId: true },
    });
    if (!m) return;
    const countMap = new Map(
      grouped.map((g) => [g.tournamentTeamId, g._count._all])
    );
    const team1Score = countMap.get(m.team1TTId) || 0;
    const team2Score = countMap.get(m.team2TTId) || 0;
    await tx.tournamentMatch.update({
      where: { id: matchId },
      data: { team1Score, team2Score },
    });
  });
}

async function recalcTie(tieId) {
  const tie = await prisma.tournamentTie.findUnique({
    where: { id: tieId },
    select: { id: true, team1TTId: true, team2TTId: true },
  });
  if (!tie) return null;

  const matches = await prisma.tournamentMatch.findMany({
    where: { tieId, status: 'FINISHED' },
    select: {
      team1TTId: true,
      team2TTId: true,
      team1Score: true,
      team2Score: true,
    },
  });
  let agg1 = 0;
  let agg2 = 0;
  for (const m of matches) {
    if (m.team1TTId === tie.team1TTId && m.team2TTId === tie.team2TTId) {
      agg1 += m.team1Score;
      agg2 += m.team2Score;
    } else if (m.team1TTId === tie.team2TTId && m.team2TTId === tie.team1TTId) {
      agg1 += m.team2Score;
      agg2 += m.team1Score;
    } else {
      if (m.team1TTId === tie.team1TTId) agg1 += m.team1Score;
      if (m.team2TTId === tie.team1TTId) agg1 += m.team2Score;
      if (m.team1TTId === tie.team2TTId) agg2 += m.team1Score;
      if (m.team2TTId === tie.team2TTId) agg2 += m.team2Score;
    }
  }
  let winnerTTId = null;
  if (agg1 > agg2) winnerTTId = tie.team1TTId;
  else if (agg2 > agg1) winnerTTId = tie.team2TTId;

  const updated = await prisma.tournamentTie.update({
    where: { id: tieId },
    data: { winnerTTId },
    include: {
      team1TT: { include: { team: true } },
      team2TT: { include: { team: true } },
    },
  });

  const io = getIO();
  io.to(`ttie:${updated.id}`).emit('tie:updated', {
    ...updated,
    aggregate: { team1: agg1, team2: agg2 },
  });
  io.to(
    `tournament:${updated.team1TT.tournamentId || updated.team2TT.tournamentId || ''}`
  ).emit('tie:updated', {
    ...updated,
    aggregate: { team1: agg1, team2: agg2 },
  });

  return { ...updated, aggregate: { team1: agg1, team2: agg2 } };
}

/* =========================================================
   DISCIPLINE (дисквалификации)
========================================================= */

async function getDisciplineSettings(tournamentId) {
  return prisma.tournament.findUnique({
    where: { id: tournamentId },
    select: {
      disciplineEnabled: true,
      disciplinePeriod: true,
      yellowToSuspend: true,
      redToSuspend: true,
      suspendGames: true,
    },
  });
}

// подсчёт карточек по периоду (TOURNAMENT/ROUND/GROUP)
async function countCardsScoped({ tournamentId, rosterItemId, period, match }) {
  const whereMatch = { tournamentId };
  if (period === 'ROUND') whereMatch.roundId = match.roundId ?? undefined;
  if (period === 'GROUP') whereMatch.groupId = match.groupId ?? undefined;

  const baseWhere = { rosterItemId, match: whereMatch };

  const [yellows, reds] = await Promise.all([
    prisma.tournamentMatchEvent.count({
      where: { ...baseWhere, type: 'YELLOW_CARD' },
    }),
    prisma.tournamentMatchEvent.count({
      where: { ...baseWhere, type: 'RED_CARD' },
    }),
  ]);
  return { yellows, reds };
}

async function maybeCreateSuspensionAfterEvent(createdEvent) {
  // нужен матчик для периода
  const m = await prisma.tournamentMatch.findUnique({
    where: { id: createdEvent.matchId },
    select: {
      id: true,
      date: true,
      tournamentId: true,
      roundId: true,
      groupId: true,
    },
  });
  if (!m) return;
  const set = await getDisciplineSettings(m.tournamentId);
  if (!set?.disciplineEnabled) return;
  if (!createdEvent.rosterItemId) return;
  if (!['YELLOW_CARD', 'RED_CARD'].includes(createdEvent.type)) return;

  const { yellows, reds } = await countCardsScoped({
    tournamentId: m.tournamentId,
    rosterItemId: createdEvent.rosterItemId,
    period: set.disciplinePeriod,
    match: m,
  });

  if (createdEvent.type === 'RED_CARD' && reds >= set.redToSuspend) {
    await prisma.tournamentSuspension.create({
      data: {
        tournamentId: m.tournamentId,
        tournamentTeamPlayerId: createdEvent.rosterItemId,
        reason: 'RED',
        startsAfter: m.date,
        remainingGames: set.suspendGames,
        triggerMatchId: m.id,
      },
    });
  }
  if (createdEvent.type === 'YELLOW_CARD' && yellows >= set.yellowToSuspend) {
    await prisma.tournamentSuspension.create({
      data: {
        tournamentId: m.tournamentId,
        tournamentTeamPlayerId: createdEvent.rosterItemId,
        reason: 'YELLOWS',
        startsAfter: m.date,
        remainingGames: set.suspendGames,
        triggerMatchId: m.id,
      },
    });
  }
}

async function serveSuspensionsAfterMatch(matchId) {
  const m = await prisma.tournamentMatch.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      date: true,
      tournamentId: true,
      team1TTId: true,
      team2TTId: true,
    },
  });
  if (!m) return;

  const rosterIds = await prisma.tournamentTeamPlayer
    .findMany({
      where: { tournamentTeamId: { in: [m.team1TTId, m.team2TTId] } },
      select: { id: true },
    })
    .then((x) => x.map((r) => r.id));

  if (!rosterIds.length) return;

  const activeSusp = await prisma.tournamentSuspension.findMany({
    where: {
      tournamentId: m.tournamentId,
      tournamentTeamPlayerId: { in: rosterIds },
      isActive: true,
      remainingGames: { gt: 0 },
      OR: [{ startsAfter: null }, { startsAfter: { lt: m.date } }],
    },
    select: { id: true, remainingGames: true },
  });

  for (const s of activeSusp) {
    const left = s.remainingGames - 1;
    await prisma.tournamentSuspension.update({
      where: { id: s.id },
      data: { remainingGames: left, isActive: left > 0 },
    });
  }
}

/* =========================================================
   AUTOPUBLISH roster → participants (с учётом банов)
========================================================= */
async function publishRosterToMatch(matchId, ttId, roleFilter = 'ALL') {
  const m = await prisma.tournamentMatch.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      date: true,
      tournamentId: true,
      team1TTId: true,
      team2TTId: true,
    },
  });
  if (!m) throw new Error('Матч не найден');

  const tt = await prisma.tournamentTeam.findUnique({
    where: { id: ttId },
    select: { id: true, tournamentId: true, captainRosterItemId: true },
  });
  if (!tt || tt.tournamentId !== m.tournamentId)
    throw new Error('Команда не из турнира матча');

  const roster = await prisma.tournamentTeamPlayer.findMany({
    where: {
      tournamentTeamId: ttId,
      ...(roleFilter === 'STARTER' ? { role: 'STARTER' } : {}),
    },
    orderBy: [{ role: 'asc' }, { number: 'asc' }, { id: 'asc' }],
  });

  const susp = await prisma.tournamentSuspension.findMany({
    where: {
      tournamentId: m.tournamentId,
      tournamentTeamPlayerId: { in: roster.map((r) => r.id) },
      isActive: true,
      remainingGames: { gt: 0 },
      OR: [{ startsAfter: null }, { startsAfter: { lt: m.date } }],
    },
    select: { tournamentTeamPlayerId: true },
  });
  const banned = new Set(susp.map((s) => s.tournamentTeamPlayerId));

  const allowed = roster.filter((r) => !banned.has(r.id));
  if (!allowed.length) return [];

  await prisma.tournamentPlayerMatch.createMany({
    data: allowed.map((r) => ({
      matchId: m.id,
      tournamentTeamPlayerId: r.id,
      role: r.role ?? 'STARTER',
      position: r.position ?? null,
      isCaptain: tt.captainRosterItemId
        ? r.id === tt.captainRosterItemId
        : false,
      order: r.number != null ? r.number : 0,
    })),
    skipDuplicates: true,
  });

  return allowed.map((a) => a.id);
}

/* =========================================================
   TOURNAMENTS — CRUD
========================================================= */

router.get('/tournaments', async (req, res) => {
  try {
    const range = safeJSON(req.query.range, [0, 49]);
    const sort = safeJSON(req.query.sort, ['startDate', 'DESC']);
    const filter = safeJSON(req.query.filter, {});
    const [start, end] = range;
    const take = Math.max(0, end - start + 1);
    const sortField = String(sort[0] || 'startDate');
    const sortOrder =
      String(sort[1] || 'DESC').toLowerCase() === 'desc' ? 'desc' : 'asc';
    const include = buildTournamentInclude(req.query.include);

    const AND = [];
    if (Array.isArray(filter.id) && filter.id.length) {
      AND.push({ id: { in: filter.id.map(Number).filter(Number.isFinite) } });
    }
    if (filter.city) {
      AND.push({
        city: { contains: String(filter.city), mode: 'insensitive' },
      });
    }
    if (filter.season) {
      AND.push({
        season: { contains: String(filter.season), mode: 'insensitive' },
      });
    }
    const q = (req.query.q ?? filter.q ?? '').toString().trim();
    if (q) {
      AND.push({
        OR: [
          { title: { contains: q, mode: 'insensitive' } },
          { city: { contains: q, mode: 'insensitive' } },
        ],
      });
    }
    if (filter.start_gte || filter.start_lte) {
      AND.push({
        startDate: {
          gte: filter.start_gte ? new Date(filter.start_gte) : undefined,
          lte: filter.start_lte ? new Date(filter.start_lte) : undefined,
        },
      });
    }
    const where = AND.length ? { AND } : undefined;

    const [rows, total] = await Promise.all([
      prisma.tournament.findMany({
        skip: start,
        take,
        where,
        orderBy: { [sortField]: sortOrder },
        include,
      }),
      prisma.tournament.count({ where }),
    ]);
    setRange(res, 'tournaments', start, rows.length, total);
    res.json(rows);
  } catch (e) {
    console.error('GET /tournaments', e);
    res.status(500).json({ error: 'Ошибка загрузки турниров' });
  }
});

router.get('/tournaments/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const include = buildTournamentInclude(
      req.query.include || 'teams,rounds,ties,groups'
    );
    const item = await prisma.tournament.findUnique({ where: { id }, include });
    if (!item) return res.status(404).json({ error: 'Турнир не найден' });
    res.json(item);
  } catch (e) {
    console.error('GET /tournaments/:id', e);
    res.status(500).json({ error: 'Ошибка получения турнира' });
  }
});

router.post('/tournaments', async (req, res) => {
  try {
    const {
      title,
      season,
      city,
      images = [],
      format,
      halfMinutes,
      halves,
      startDate,
      endDate,
      registrationDeadline,
      disciplineEnabled,
      disciplinePeriod,
      yellowToSuspend,
      redToSuspend,
      suspendGames,
      autoPublishParticipants,
    } = req.body;

    const created = await prisma.tournament.create({
      data: {
        title,
        season: season ?? null,
        city: city ?? null,
        images: toStrArr(images),
        format: format ?? 'F11x11',
        halfMinutes: toInt(halfMinutes, 45),
        halves: toInt(halves, 2),
        startDate: toDate(startDate, new Date()),
        endDate: toDate(endDate, null),
        registrationDeadline: toDate(registrationDeadline, null),
        disciplineEnabled: !!disciplineEnabled,
        disciplinePeriod: disciplinePeriod ?? 'TOURNAMENT',
        yellowToSuspend: toInt(yellowToSuspend, 2),
        redToSuspend: toInt(redToSuspend, 1),
        suspendGames: toInt(suspendGames, 1),
        autoPublishParticipants:
          autoPublishParticipants == null ? true : !!autoPublishParticipants,
      },
    });

    getIO().emit('tournament:created', created);
    res.status(201).json(created);
  } catch (e) {
    console.error('POST /tournaments', e);
    res.status(500).json({ error: 'Ошибка создания турнира' });
  }
});

router.patch('/tournaments/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const {
      title,
      season,
      city,
      images,
      format,
      halfMinutes,
      halves,
      startDate,
      endDate,
      registrationDeadline,
      disciplineEnabled,
      disciplinePeriod,
      yellowToSuspend,
      redToSuspend,
      suspendGames,
      autoPublishParticipants,
    } = req.body;

    const patch = {};
    if (title !== undefined) patch.title = title;
    if (season !== undefined) patch.season = season;
    if (city !== undefined) patch.city = city;
    if (images !== undefined) patch.images = toStrArr(images);
    if (format !== undefined) patch.format = format;
    if (halfMinutes !== undefined) patch.halfMinutes = toInt(halfMinutes, 45);
    if (halves !== undefined) patch.halves = toInt(halves, 2);
    if (startDate !== undefined) patch.startDate = toDate(startDate);
    if (endDate !== undefined) patch.endDate = toDate(endDate, null);
    if (registrationDeadline !== undefined)
      patch.registrationDeadline = toDate(registrationDeadline, null);

    if (disciplineEnabled !== undefined)
      patch.disciplineEnabled = !!disciplineEnabled;
    if (disciplinePeriod !== undefined)
      patch.disciplinePeriod = disciplinePeriod;
    if (yellowToSuspend !== undefined)
      patch.yellowToSuspend = toInt(yellowToSuspend, 2);
    if (redToSuspend !== undefined) patch.redToSuspend = toInt(redToSuspend, 1);
    if (suspendGames !== undefined) patch.suspendGames = toInt(suspendGames, 1);
    if (autoPublishParticipants !== undefined)
      patch.autoPublishParticipants = !!autoPublishParticipants;

    const updated = await prisma.tournament.update({
      where: { id },
      data: patch,
    });

    getIO().to(`tournament:${id}`).emit('tournament:update', updated);
    res.json(updated);
  } catch (e) {
    console.error('PATCH /tournaments/:id', e);
    res.status(400).json({ error: 'Ошибка обновления турнира' });
  }
});
router.put('/tournaments/:id(\\d+)', (req, res) => {
  req.method = 'PATCH';
  router.handle(req, res);
});

router.delete('/tournaments/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    await prisma.tournament.delete({ where: { id } });
    const io = getIO();
    io.to(`tournament:${id}`).emit('tournament:deleted', { tournamentId: id });
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /tournaments/:id', e);
    res.status(500).json({ error: 'Ошибка удаления турнира' });
  }
});

/* =========================================================
   BRACKET GENERATION (без авто-проставления)
========================================================= */
router.post('/tournaments/:id(\\d+)/bracket/generate', async (req, res) => {
  try {
    const tournamentId = Number(req.params.id);
    const {
      mode = 'seed',
      pairs = [],
      legs = 1,
      includeThirdPlace = false,
      createMatches = false,
      startDate = null,
      reset = false,
    } = req.body || {};

    const ttRows = await prisma.tournamentTeam.findMany({
      where: { tournamentId },
      include: { team: true },
      orderBy: [{ seed: 'asc' }, { id: 'asc' }],
    });

    const N = ttRows.length;
    const allowed = [2, 4, 8, 16, 32];
    if (!allowed.includes(N)) {
      return res.status(400).json({
        error: `Для генерации сетки нужно 2/4/8/16/32 команд (сейчас ${N})`,
      });
    }

    const startStage = stageForTeamCount(N);
    const startIdx = STAGE_ORDER.indexOf(startStage);
    const planStages = STAGE_ORDER.slice(startIdx);

    const pairList = [];
    if (mode === 'explicit') {
      const teamIdToTT = new Map(ttRows.map((r) => [r.teamId, r.id]));
      for (const [a, b] of pairs) {
        const aTT = teamIdToTT.get(Number(a));
        const bTT = teamIdToTT.get(Number(b));
        if (!aTT || !bTT) {
          return res
            .status(400)
            .json({ error: 'pairs содержит команду, не заявленную в турнире' });
        }
        pairList.push([aTT, bTT]);
      }
      if (pairList.length * 2 !== N) {
        return res.status(400).json({
          error: 'Количество пар в pairs должно покрывать все команды',
        });
      }
    } else {
      let ordered = ttRows.slice();
      if (mode === 'random') {
        ordered = ordered.sort(() => Math.random() - 0.5);
      } else {
        ordered = ordered.sort((a, b) => {
          const sa = a.seed ?? 999999;
          const sb = b.seed ?? 999999;
          if (sa !== sb) return sa - sb;
          return (a.team.title || '').localeCompare(b.team.title || '');
        });
      }
      for (let i = 0; i < N / 2; i++)
        pairList.push([ordered[i].id, ordered[N - 1 - i].id]);
    }

    const created = await prisma.$transaction(async (tx) => {
      if (reset) {
        await tx.tournamentMatch.deleteMany({
          where: { tournamentId, round: { stage: { in: planStages } } },
        });
        await tx.tournamentTie.deleteMany({
          where: { tournamentId, round: { stage: { in: planStages } } },
        });
        await tx.tournamentRound.deleteMany({
          where: { tournamentId, stage: { in: planStages } },
        });
      }

      const rounds = {};
      for (let i = 0; i < planStages.length; i++) {
        const st = planStages[i];
        rounds[st] = await getOrCreateRound(
          tx,
          tournamentId,
          st,
          i + 1,
          st.replaceAll('_', ' ')
        );
      }

      const startRound = rounds[startStage];
      const tiesCreated = [];
      for (const [tt1, tt2] of pairList) {
        const tie = await tx.tournamentTie.create({
          data: {
            tournamentId,
            roundId: startRound.id,
            team1TTId: tt1,
            team2TTId: tt2,
            legs: Number(legs) || 1,
          },
        });
        tiesCreated.push(tie);

        if (createMatches) {
          const L = Number(legs) || 1;
          for (let leg = 1; leg <= L; leg++) {
            await tx.tournamentMatch.create({
              data: {
                date: startDate ? new Date(startDate) : new Date(),
                status: 'SCHEDULED',
                legNumber: leg,
                tournament: { connect: { id: tournamentId } },
                round: { connect: { id: startRound.id } },
                tie: { connect: { id: tie.id } },
                team1TT: { connect: { id: tt1 } },
                team2TT: { connect: { id: tt2 } },
              },
            });
          }
        }
      }

      let size = pairList.length;
      for (let i = startIdx + 1; i < STAGE_ORDER.length; i++) {
        const st = STAGE_ORDER[i];
        size = Math.max(1, Math.floor(size / 2));
        for (let k = 0; k < size; k++) {
          await tx.tournamentTie.create({
            data: { tournamentId, roundId: rounds[st].id, legs: 1 },
          });
        }
      }

      if (includeThirdPlace && startStage !== 'FINAL') {
        const third = await getOrCreateRound(
          tx,
          tournamentId,
          'THIRD_PLACE',
          null,
          '3rd place'
        );
        const exists = await tx.tournamentTie.findFirst({
          where: { tournamentId, roundId: third.id },
        });
        if (!exists) {
          await tx.tournamentTie.create({
            data: { tournamentId, roundId: third.id, legs: 1 },
          });
        }
      }

      const allTies = await tx.tournamentTie.findMany({
        where: { tournamentId },
        include: {
          round: true,
          team1TT: { include: { team: true } },
          team2TT: { include: { team: true } },
        },
        orderBy: [{ roundId: 'asc' }, { id: 'asc' }],
      });
      return { ties: allTies };
    });

    const io = getIO();
    io.to(`tournament:${tournamentId}`).emit(
      'tournament:bracket:generated',
      created
    );
    res.status(201).json({ success: true, ...created });
  } catch (e) {
    console.error('POST /tournaments/:id/bracket/generate', e);
    res
      .status(400)
      .json({ error: e.message || 'Не удалось сгенерировать сетку' });
  }
});

/* =========================================================
   TOURNAMENT TEAMS
========================================================= */
router.get('/tournaments/:id(\\d+)/teams', async (req, res) => {
  try {
    const tournamentId = Number(req.params.id);
    const includeRoster = String(req.query.include || '')
      .split(',')
      .includes('roster');
    const rows = await prisma.tournamentTeam.findMany({
      where: { tournamentId },
      include: {
        team: true,
        ...(includeRoster
          ? { roster: { include: { player: true } }, captainRosterItem: true }
          : {}),
      },
      orderBy: [{ seed: 'asc' }, { id: 'asc' }],
    });
    res.json(rows);
  } catch (e) {
    console.error('GET /tournaments/:id/teams', e);
    res.status(500).json({ error: 'Ошибка загрузки команд турнира' });
  }
});

router.post(
  '/tournaments/:id(\\d+)/teams/:teamId(\\d+)/attach',
  async (req, res) => {
    try {
      const tournamentId = Number(req.params.id);
      const teamId = Number(req.params.teamId);
      const seed = toInt(req.body?.seed, null);
      const tt = await prisma.tournamentTeam.upsert({
        where: { tournamentId_teamId: { tournamentId, teamId } },
        update: { seed },
        create: { tournamentId, teamId, seed },
      });

      getIO()
        .to(`tournament:${tournamentId}`)
        .emit('tournament:teams:updated', { type: 'attach', item: tt });
      res.status(201).json(tt);
    } catch (e) {
      console.error('attach tournament team', e);
      res.status(400).json({ error: 'Не удалось прикрепить команду' });
    }
  }
);

router.delete(
  '/tournaments/:id(\\d+)/teams/:teamId(\\d+)/detach',
  async (req, res) => {
    try {
      const tournamentId = Number(req.params.id);
      const teamId = Number(req.params.teamId);
      await prisma.tournamentTeam.delete({
        where: { tournamentId_teamId: { tournamentId, teamId } },
      });

      getIO()
        .to(`tournament:${tournamentId}`)
        .emit('tournament:teams:updated', { type: 'detach', teamId });
      res.json({ success: true });
    } catch (e) {
      console.error('detach tournament team', e);
      res.status(400).json({ error: 'Не удалось открепить команду' });
    }
  }
);

router.get('/tournament-teams/:ttId(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.ttId);
    const item = await prisma.tournamentTeam.findUnique({
      where: { id },
      include: {
        tournament: true,
        team: true,
        roster: { include: { player: true } },
        captainRosterItem: true,
      },
    });
    if (!item) return res.status(404).json({ error: 'Не найдено' });
    res.json(item);
  } catch (e) {
    console.error('GET /tournament-teams/:ttId', e);
    res.status(500).json({ error: 'Ошибка' });
  }
});

router.get('/tournament-teams/:ttId(\\d+)/roster', async (req, res) => {
  try {
    const id = Number(req.params.ttId);
    const rows = await prisma.tournamentTeamPlayer.findMany({
      where: { tournamentTeamId: id },
      orderBy: [{ role: 'asc' }, { number: 'asc' }, { id: 'asc' }],
      include: { player: true },
    });
    res.json(rows);
  } catch (e) {
    console.error('GET /tournament-teams/:ttId/roster', e);
    res.status(500).json({ error: 'Ошибка' });
  }
});

router.put('/tournament-teams/:ttId(\\d+)/roster', async (req, res) => {
  try {
    const id = Number(req.params.ttId);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const captainPlayerId = toInt(req.body?.captainPlayerId, null);

    const tt = await prisma.tournamentTeam.findUnique({
      where: { id },
      include: { team: true, tournament: true },
    });
    if (!tt) return res.status(404).json({ error: 'TournamentTeam не найден' });

    // проверка, что все игроки из команды
    for (const it of items) {
      const pid = Number(it.playerId);
      const p = await prisma.player.findUnique({
        where: { id: pid },
        select: { teamId: true },
      });
      if (!p || p.teamId !== tt.teamId)
        return res.status(400).json({ error: 'Игрок не из этой команды' });
    }
    if (captainPlayerId) {
      const p = await prisma.player.findUnique({
        where: { id: captainPlayerId },
        select: { teamId: true },
      });
      if (!p || p.teamId !== tt.teamId)
        return res.status(400).json({ error: 'Капитан не из этой команды' });
    }

    // лимит стартеров по формату турнира
    const maxStarters =
      STARTERS_BY_FORMAT[tt.tournament.format || 'F11x11'] ?? 11;
    const startersCount = items.filter(
      (it) => (it.role || 'STARTER') === 'STARTER'
    ).length;
    if (startersCount > maxStarters) {
      return res.status(400).json({
        error: `Стартеров больше лимита (${maxStarters}) для формата ${tt.tournament.format}`,
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      await tx.tournamentTeamPlayer.deleteMany({
        where: { tournamentTeamId: id },
      });
      let created = [];
      if (items.length) {
        created = await Promise.all(
          items.map((it) =>
            tx.tournamentTeamPlayer.create({
              data: {
                tournamentTeamId: id,
                playerId: Number(it.playerId),
                number: toInt(it.number, null),
                position: it.position ?? null,
                role: it.role ?? null,
                notes: it.notes ?? null,
              },
            })
          )
        );
      }
      if (captainPlayerId) {
        const cap =
          created.find((r) => r.playerId === captainPlayerId) ||
          (await tx.tournamentTeamPlayer.findFirst({
            where: { tournamentTeamId: id, playerId: captainPlayerId },
          }));
        if (cap) {
          await tx.tournamentTeam.update({
            where: { id },
            data: { captainRosterItemId: cap.id },
          });
        }
      } else {
        await tx.tournamentTeam.update({
          where: { id },
          data: { captainRosterItemId: null },
        });
      }

      return tx.tournamentTeam.findUnique({
        where: { id },
        include: {
          roster: { include: { player: true } },
          captainRosterItem: true,
        },
      });
    });

    getIO()
      .to(`tournament:${tt.tournamentId}`)
      .emit('troster:updated', { tournamentTeamId: id });
    res.json(result);
  } catch (e) {
    console.error('PUT /tournament-teams/:ttId/roster', e);
    res.status(400).json({ error: 'Ошибка сохранения заявки' });
  }
});

router.post('/tournament-teams/:ttId(\\d+)/roster', async (req, res) => {
  try {
    const id = Number(req.params.ttId);
    const tt = await prisma.tournamentTeam.findUnique({
      where: { id },
      include: { team: true, tournament: true },
    });
    if (!tt) return res.status(404).json({ error: 'TournamentTeam не найден' });

    const playerId = toInt(req.body.playerId);
    if (!playerId)
      return res.status(400).json({ error: 'playerId обязателен' });

    const p = await prisma.player.findUnique({
      where: { id: playerId },
      select: { teamId: true },
    });
    if (!p || p.teamId !== tt.teamId)
      return res.status(400).json({ error: 'Игрок не из этой команды' });

    // если добавляем STARTER — проверим лимит
    if ((req.body.role ?? 'STARTER') === 'STARTER') {
      const maxStarters =
        STARTERS_BY_FORMAT[tt.tournament.format || 'F11x11'] ?? 11;
      const startersNow = await prisma.tournamentTeamPlayer.count({
        where: { tournamentTeamId: id, role: 'STARTER' },
      });
      if (startersNow + 1 > maxStarters) {
        return res.status(400).json({
          error: `Стартеров больше лимита (${maxStarters}) для формата ${tt.tournament.format}`,
        });
      }
    }

    const item = await prisma.tournamentTeamPlayer.upsert({
      where: { tournamentTeamId_playerId: { tournamentTeamId: id, playerId } },
      update: {
        number: toInt(req.body.number, undefined),
        position: req.body.position ?? undefined,
        role: req.body.role ?? undefined,
        notes: req.body.notes ?? undefined,
      },
      create: {
        tournamentTeamId: id,
        playerId,
        number: toInt(req.body.number, null),
        position: req.body.position ?? null,
        role: req.body.role ?? null,
        notes: req.body.notes ?? null,
      },
    });

    getIO()
      .to(`tournament:${tt.tournamentId}`)
      .emit('troster:updated', { tournamentTeamId: id });
    res.status(201).json(item);
  } catch (e) {
    console.error('POST /tournament-teams/:ttId/roster', e);
    res.status(400).json({ error: 'Не удалось добавить игрока' });
  }
});

router.delete(
  '/tournament-teams/:ttId(\\d+)/roster/:playerId(\\d+)',
  async (req, res) => {
    try {
      const id = Number(req.params.ttId);
      const playerId = Number(req.params.playerId);
      const tt = await prisma.tournamentTeam.findUnique({
        where: { id },
        select: { tournamentId: true },
      });

      await prisma.tournamentTeamPlayer.delete({
        where: {
          tournamentTeamId_playerId: { tournamentTeamId: id, playerId },
        },
      });

      if (tt) {
        getIO()
          .to(`tournament:${tt.tournamentId}`)
          .emit('troster:updated', { tournamentTeamId: id });
      }
      res.json({ success: true });
    } catch (e) {
      console.error('DELETE /tournament-teams/:ttId/roster/:playerId', e);
      res.status(400).json({ error: 'Не удалось удалить игрока' });
    }
  }
);

router.post('/tournament-teams/:ttId(\\d+)/captain', async (req, res) => {
  try {
    const id = Number(req.params.ttId);
    const rosterItemId = toInt(req.body?.rosterItemId);
    const playerId = toInt(req.body?.playerId);

    let setId = null;
    if (rosterItemId) {
      await assertRosterItemBelongs(rosterItemId, id);
      setId = rosterItemId;
    } else if (playerId) {
      const it = await prisma.tournamentTeamPlayer.findFirst({
        where: { tournamentTeamId: id, playerId },
      });
      if (!it) return res.status(400).json({ error: 'Игрок не в заявке' });
      setId = it.id;
    }

    const updated = await prisma.tournamentTeam.update({
      where: { id },
      data: { captainRosterItemId: setId },
      include: { captainRosterItem: true },
    });

    const tt = await prisma.tournamentTeam.findUnique({
      where: { id },
      select: { tournamentId: true },
    });
    if (tt) {
      getIO()
        .to(`tournament:${tt.tournamentId}`)
        .emit('troster:updated', { tournamentTeamId: id });
    }
    res.json(updated);
  } catch (e) {
    console.error('POST /tournament-teams/:ttId/captain', e);
    res.status(400).json({ error: 'Не удалось обновить капитана' });
  }
});

router.post('/tournament-teams/:ttId(\\d+)/publish', async (req, res) => {
  try {
    const id = Number(req.params.ttId);
    const { matchId, reset = true, roleFilter = 'ALL' } = req.body || {};
    if (!matchId) return res.status(400).json({ error: 'matchId обязателен' });

    const tt = await prisma.tournamentTeam.findUnique({
      where: { id },
      include: { tournament: true, captainRosterItem: true },
    });
    if (!tt) return res.status(404).json({ error: 'TournamentTeam не найден' });

    const m = await prisma.tournamentMatch.findUnique({
      where: { id: Number(matchId) },
      select: {
        id: true,
        tournamentId: true,
        team1TTId: true,
        team2TTId: true,
      },
    });
    if (!m) return res.status(404).json({ error: 'Матч не найден' });
    if (m.tournamentId !== tt.tournamentId)
      return res.status(400).json({ error: 'Матч не из этого турнира' });
    if (![m.team1TTId, m.team2TTId].includes(tt.id))
      return res.status(400).json({ error: 'Команда не участвует в матче' });

    const roster = await prisma.tournamentTeamPlayer.findMany({
      where: {
        tournamentTeamId: id,
        ...(roleFilter === 'STARTER' ? { role: 'STARTER' } : {}),
      },
      orderBy: [{ role: 'asc' }, { number: 'asc' }, { id: 'asc' }],
    });

    const rows = await prisma.$transaction(async (tx) => {
      if (reset) {
        await tx.tournamentPlayerMatch.deleteMany({
          where: {
            matchId: Number(matchId),
            tournamentTeamPlayerId: { in: roster.map((r) => r.id) },
          },
        });
      }
      if (roster.length) {
        await tx.tournamentPlayerMatch.createMany({
          data: roster.map((r) => ({
            matchId: Number(matchId),
            tournamentTeamPlayerId: r.id,
            role: r.role ?? 'STARTER',
            position: r.position ?? null,
            isCaptain: tt.captainRosterItemId
              ? r.id === tt.captainRosterItemId
              : false,
            order: r.number != null ? r.number : 0,
          })),
          skipDuplicates: true,
        });
      }

      return tx.tournamentPlayerMatch.findMany({
        where: { matchId: Number(matchId) },
        include: { tournamentTeamPlayer: { include: { player: true } } },
        orderBy: [{ role: 'asc' }, { order: 'asc' }],
      });
    });

    const io = getIO();
    io.to(`tmatch:${m.id}`).emit('tparticipants:updated', rows);
    io.to(`tournament:${m.tournamentId}`).emit('tparticipants:updated', {
      matchId: m.id,
    });
    await emitLineupFromDB(prisma, Number(matchId));
    res.json(rows);
  } catch (e) {
    console.error('POST /tournament-teams/:ttId/publish', e);
    res
      .status(400)
      .json({ error: e.message || 'Не удалось опубликовать заявку' });
  }
});

/* =========================================================
   ROUNDS
========================================================= */
router.get('/tournaments/:id(\\d+)/rounds', async (req, res) => {
  try {
    const tournamentId = Number(req.params.id);
    const rows = await prisma.tournamentRound.findMany({
      where: { tournamentId },
      orderBy: [{ number: 'asc' }, { stage: 'asc' }],
    });
    res.json(rows);
  } catch (e) {
    console.error('GET /tournaments/:id/rounds', e);
    res.status(500).json({ error: 'Ошибка загрузки раундов' });
  }
});

router.post('/tournaments/:id(\\d+)/rounds', async (req, res) => {
  try {
    const tournamentId = Number(req.params.id);
    const { stage, name, number, date } = req.body || {};
    if (!stage)
      return res.status(422).json({ error: 'Поле stage обязательно' });

    const exists = await prisma.tournamentRound.findFirst({
      where: {
        tournamentId,
        stage,
        number: number == null ? null : Number(number),
      },
    });
    if (exists) return res.status(200).json(exists);

    const created = await prisma.tournamentRound.create({
      data: {
        tournamentId,
        stage,
        name: name ?? null,
        number: number == null || number === '' ? null : Number(number),
        date: date ? new Date(date) : null,
      },
    });

    getIO().to(`tournament:${tournamentId}`).emit('rounds:updated');
    res.status(201).json(created);
  } catch (e) {
    if (e?.code === 'P2002') {
      return res
        .status(409)
        .json({ error: 'Раунд с такой стадией и номером уже существует' });
    }
    console.error('POST /tournaments/:id/rounds', e);
    res.status(400).json({ error: e?.message || 'Ошибка создания раунда' });
  }
});

router.put('/tournament-rounds/:roundId(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.roundId);
    const { stage, name, number, date } = req.body;
    const upd = await prisma.tournamentRound.update({
      where: { id },
      data: {
        stage: stage ?? undefined,
        name: name ?? undefined,
        number: toInt(number, undefined),
        date: toDate(date, undefined),
      },
    });

    const t = await prisma.tournamentRound.findUnique({
      where: { id },
      select: { tournamentId: true },
    });
    if (t) getIO().to(`tournament:${t.tournamentId}`).emit('rounds:updated');
    res.json(upd);
  } catch (e) {
    console.error('PUT /tournament-rounds/:roundId', e);
    res.status(400).json({ error: 'Ошибка обновления раунда' });
  }
});

router.delete('/tournament-rounds/:roundId(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.roundId);
    const t = await prisma.tournamentRound.findUnique({
      where: { id },
      select: { tournamentId: true },
    });
    await prisma.tournamentRound.delete({ where: { id } });

    if (t) getIO().to(`tournament:${t.tournamentId}`).emit('rounds:updated');
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /tournament-rounds/:roundId', e);
    res.status(500).json({ error: 'Ошибка удаления раунда' });
  }
});

/* =========================================================
   GROUPS (круги)
========================================================= */
router.get('/tournaments/:id(\\d+)/groups', async (req, res) => {
  try {
    const tournamentId = Number(req.params.id);
    const rows = await prisma.tournamentGroup.findMany({
      where: { tournamentId },
      include: {
        teams: { include: { tournamentTeam: { include: { team: true } } } },
      },
      orderBy: [{ id: 'asc' }],
    });
    res.json(rows);
  } catch (e) {
    console.error('GET /tournaments/:id/groups', e);
    res.status(500).json({ error: 'Ошибка загрузки групп' });
  }
});

router.post('/tournaments/:id(\\d+)/groups', async (req, res) => {
  try {
    const tournamentId = Number(req.params.id);
    const { name, type = 'ROUND1', roundId = null } = req.body || {};
    const created = await prisma.tournamentGroup.create({
      data: {
        tournamentId,
        name,
        type,
        roundId: toInt(roundId, null),
      },
    });
    res.status(201).json(created);
  } catch (e) {
    console.error('POST /tournaments/:id/groups', e);
    res.status(400).json({ error: 'Не удалось создать группу' });
  }
});

router.delete('/tournament-groups/:groupId(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.groupId);
    await prisma.tournamentGroup.delete({ where: { id } });
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /tournament-groups/:groupId', e);
    res.status(400).json({ error: 'Не удалось удалить группу' });
  }
});

router.post(
  '/tournament-groups/:groupId(\\d+)/teams/:ttId(\\d+)',
  async (req, res) => {
    try {
      const groupId = Number(req.params.groupId);
      const tournamentTeamId = Number(req.params.ttId);
      const g = await prisma.tournamentGroup.findUnique({
        where: { id: groupId },
        select: { tournamentId: true },
      });
      if (!g) return res.status(404).json({ error: 'Группа не найдена' });

      const tt = await prisma.tournamentTeam.findUnique({
        where: { id: tournamentTeamId },
        select: { tournamentId: true },
      });
      if (!tt || tt.tournamentId !== g.tournamentId)
        return res.status(400).json({ error: 'Команда не из этого турнира' });

      const row = await prisma.tournamentGroupTeam.create({
        data: { tournamentId: g.tournamentId, groupId, tournamentTeamId },
      });
      res.status(201).json(row);
    } catch (e) {
      console.error('POST /tournament-groups/:groupId/teams/:ttId', e);
      res.status(400).json({ error: 'Не удалось добавить команду в группу' });
    }
  }
);

router.delete(
  '/tournament-groups/:groupId(\\d+)/teams/:ttId(\\d+)',
  async (req, res) => {
    try {
      const groupId = Number(req.params.groupId);
      const ttId = Number(req.params.ttId);
      await prisma.tournamentGroupTeam.deleteMany({
        where: { groupId, tournamentTeamId: ttId },
      });
      res.json({ success: true });
    } catch (e) {
      console.error('DELETE /tournament-groups/:groupId/teams/:ttId', e);
      res.status(400).json({ error: 'Не удалось убрать команду из группы' });
    }
  }
);

// генерация «каждый с каждым» (1 или 2 круга)
router.post('/tournament-groups/:groupId(\\d+)/generate', async (req, res) => {
  try {
    const groupId = Number(req.params.groupId);
    const {
      rounds = 1,
      roundId,
      dateStart = null,
      matchGapDays = 7,
    } = req.body || {};

    const g = await prisma.tournamentGroup.findUnique({
      where: { id: groupId },
      include: {
        tournament: true,
        teams: { include: { tournamentTeam: true } },
      },
    });
    if (!g) return res.status(404).json({ error: 'Группа не найдена' });
    if (!roundId && !g.roundId) {
      return res
        .status(400)
        .json({ error: 'Укажите roundId (или сохраните его в группе)' });
    }

    const rId = Number(roundId || g.roundId);
    const list = g.teams.map((t) => t.tournamentTeamId);
    const N = list.length;
    if (N < 2)
      return res.status(400).json({ error: 'Недостаточно команд в группе' });

    const BYE = -1;
    const teams = N % 2 ? [...list, BYE] : [...list];
    const K = teams.length;
    const half = K / 2;

    const roundsSchedule = [];
    let arr = teams.slice(1);
    for (let round = 0; round < K - 1; round++) {
      const fixed = teams[0];
      const left = [fixed, ...arr.slice(0, half - 1)];
      const right = arr.slice(half - 1).reverse();

      const pairs = [];
      for (let i = 0; i < half; i++) {
        const a = left[i];
        const b = right[i];
        if (a !== BYE && b !== BYE) pairs.push([a, b]);
      }
      roundsSchedule.push(pairs);
      arr = [arr[arr.length - 1], ...arr.slice(0, arr.length - 1)];
    }

    let curDate = dateStart ? new Date(dateStart) : new Date();

    const created = [];
    for (let r = 0; r < roundsSchedule.length; r++) {
      const pairs = roundsSchedule[r];
      for (const [tt1, tt2] of pairs) {
        const m1 = await prisma.tournamentMatch.create({
          data: {
            date: curDate,
            status: 'SCHEDULED',
            tournament: { connect: { id: g.tournamentId } },
            round: { connect: { id: rId } },
            group: { connect: { id: g.id } },
            team1TT: { connect: { id: tt1 } },
            team2TT: { connect: { id: tt2 } },
          },
        });
        created.push(m1);
        if (Number(rounds) === 2) {
          const m2 = await prisma.tournamentMatch.create({
            data: {
              date: new Date(
                curDate.getTime() + (matchGapDays || 7) * 24 * 3600 * 1000
              ),
              status: 'SCHEDULED',
              tournament: { connect: { id: g.tournamentId } },
              round: { connect: { id: rId } },
              group: { connect: { id: g.id } },
              team1TT: { connect: { id: tt2 } },
              team2TT: { connect: { id: tt1 } },
            },
          });
          created.push(m2);
        }
      }
      curDate = new Date(
        curDate.getTime() + (matchGapDays || 7) * 24 * 3600 * 1000
      );
    }

    const io = getIO();
    io.to(`tournament:${g.tournamentId}`).emit('tmatch:created', {
      groupId: g.id,
    });

    res.status(201).json({ success: true, created: created.length });
  } catch (e) {
    console.error('generate group', e);
    res
      .status(400)
      .json({ error: 'Не удалось сгенерировать календарь группы' });
  }
});

/* =========================================================
   TIES (пары плей-офф)
========================================================= */
router.get('/tournaments/:id(\\d+)/ties', async (req, res) => {
  try {
    const tournamentId = Number(req.params.id);
    const rows = await prisma.tournamentTie.findMany({
      where: { tournamentId },
      include: {
        team1TT: { include: { team: true } },
        team2TT: { include: { team: true } },
      },
      orderBy: [{ id: 'asc' }],
    });
    res.json(rows);
  } catch (e) {
    console.error('GET /tournaments/:id/ties', e);
    res.status(500).json({ error: 'Ошибка загрузки пар' });
  }
});

router.post('/tournaments/:id(\\d+)/ties', async (req, res) => {
  try {
    const tournamentId = Number(req.params.id);
    const { roundId, team1TTId, team2TTId, legs = 1 } = req.body;
    const created = await prisma.tournamentTie.create({
      data: {
        tournamentId,
        roundId: Number(roundId),
        team1TTId: Number(team1TTId),
        team2TTId: Number(team2TTId),
        legs: toInt(legs, 1),
      },
    });

    getIO().to(`tournament:${tournamentId}`).emit('tie:updated', created);
    res.status(201).json(created);
  } catch (e) {
    console.error('POST /tournaments/:id/ties', e);
    res.status(400).json({ error: 'Ошибка создания пары' });
  }
});

router.put('/tournament-ties/:tieId(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.tieId);
    const { roundId, team1TTId, team2TTId, legs, winnerTTId } = req.body;
    const upd = await prisma.tournamentTie.update({
      where: { id },
      data: {
        roundId: toInt(roundId, undefined),
        team1TTId: toInt(team1TTId, undefined),
        team2TTId: toInt(team2TTId, undefined),
        legs: toInt(legs, undefined),
        winnerTTId: toInt(winnerTTId, undefined),
      },
    });

    getIO().to(`ttie:${id}`).emit('tie:updated', upd);
    res.json(upd);
  } catch (e) {
    console.error('PUT /tournament-ties/:tieId', e);
    res.status(400).json({ error: 'Ошибка обновления пары' });
  }
});

router.post('/tournament-ties/:tieId(\\d+)/recalc', async (req, res) => {
  try {
    const id = Number(req.params.tieId);
    const result = await recalcTie(id);
    res.json(result);
  } catch (e) {
    console.error('POST /tournament-ties/:tieId/recalc', e);
    res.status(400).json({ error: 'Не удалось пересчитать итог пары' });
  }
});

router.delete('/tournament-ties/:tieId(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.tieId);
    const t = await prisma.tournamentTie.findUnique({
      where: { id },
      select: { tournamentId: true },
    });
    await prisma.tournamentTie.delete({ where: { id } });

    if (t) {
      getIO()
        .to(`tournament:${t.tournamentId}`)
        .emit('tie:updated', { deletedId: id });
    }
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /tournament-ties/:tieId', e);
    res.status(500).json({ error: 'Ошибка удаления пары' });
  }
});

/* =========================================================
   MATCHES (турнирные матчи)
========================================================= */

// list
router.get('/tournaments/:id(\\d+)/matches', async (req, res) => {
  try {
    const tournamentId = Number(req.params.id);
    const range = safeJSON(req.query.range, [0, 49]);
    const sort = safeJSON(req.query.sort, ['date', 'ASC']);
    const filter = safeJSON(req.query.filter, {});
    const [start, end] = range;
    const take = Math.max(0, end - start + 1);
    const sortField = String(sort[0] || 'date');
    const sortOrder =
      String(sort[1] || 'ASC').toLowerCase() === 'desc' ? 'desc' : 'asc';
    const include = buildTMatchInclude(
      req.query.include || 'team1,team2,stadium,referees'
    );

    const AND = [{ tournamentId }];
    if (filter.roundId != null) AND.push({ roundId: Number(filter.roundId) });
    if (filter.tieId != null) AND.push({ tieId: Number(filter.tieId) });
    if (filter.groupId != null) AND.push({ groupId: Number(filter.groupId) });
    if (typeof filter.status === 'string' && filter.status.trim())
      AND.push({ status: filter.status.trim() });
    if (filter.date_gte || filter.date_lte) {
      AND.push({
        date: {
          gte: filter.date_gte ? new Date(filter.date_gte) : undefined,
          lte: filter.date_lte ? new Date(filter.date_lte) : undefined,
        },
      });
    }

    const where = { AND };
    const [rows, total] = await Promise.all([
      prisma.tournamentMatch.findMany({
        skip: start,
        take,
        where,
        orderBy: { [sortField]: sortOrder },
        include,
      }),
      prisma.tournamentMatch.count({ where }),
    ]);
    setRange(res, 'tournamentMatches', start, rows.length, total);
    res.json(rows);
  } catch (e) {
    console.error('GET /tournaments/:id/matches', e);
    res.status(500).json({ error: 'Ошибка загрузки матчей' });
  }
});

// item
router.get('/tournament-matches/:matchId(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.matchId);
    const include = buildTMatchInclude(
      req.query.include || 'team1,team2,stadium,referees,events,group'
    );
    const item = await prisma.tournamentMatch.findUnique({
      where: { id },
      include,
    });
    if (!item) return res.status(404).json({ error: 'Матч не найден' });
    res.json(item);
  } catch (e) {
    console.error('GET /tournament-matches/:matchId', e);
    res.status(500).json({ error: 'Ошибка получения матча' });
  }
});

// create
router.post('/tournaments/:id(\\d+)/matches', async (req, res) => {
  try {
    const tournamentId = Number(req.params.id);
    const {
      roundId,
      tieId,
      groupId,
      team1TTId,
      team2TTId,
      date,
      status = 'SCHEDULED',
      stadiumId,
      legNumber,
      team1Formation,
      team2Formation,
      team1Coach,
      team2Coach,
      referees = [],
    } = req.body;

    const data = {
      date: toDate(date, new Date()),
      status,
      legNumber: toInt(legNumber, null),
      team1Formation: team1Formation ?? null,
      team2Formation: team2Formation ?? null,
      team1Coach: team1Coach ?? null,
      team2Coach: team2Coach ?? null,
      referees: {
        create: (referees || []).map((r) => ({
          refereeId: Number(r.refereeId),
          role: r.role ?? null,
        })),
      },
      tournament: { connect: { id: Number(tournamentId) } },
      team1TT: { connect: { id: Number(team1TTId) } },
      team2TT: { connect: { id: Number(team2TTId) } },
    };
    if (toInt(roundId, null)) data.round = { connect: { id: Number(roundId) } };
    if (toInt(tieId, null)) data.tie = { connect: { id: Number(tieId) } };
    if (toInt(groupId, null)) data.group = { connect: { id: Number(groupId) } };
    if (toInt(stadiumId, null))
      data.stadiumRel = { connect: { id: Number(stadiumId) } };

    const created = await prisma.tournamentMatch.create({
      data,
      include: buildTMatchInclude('team1,team2,stadium,referees,group'),
    });

    // автопубликация заявок
    const tset = await prisma.tournament.findUnique({
      where: { id: created.tournamentId },
      select: { autoPublishParticipants: true },
    });
    if (tset?.autoPublishParticipants) {
      await publishRosterToMatch(created.id, created.team1TTId);
      await publishRosterToMatch(created.id, created.team2TTId);
    }

    await emitLineupFromDB(prisma, created.id);

    const io = getIO();
    io.to(`tournament:${tournamentId}`).emit('tmatch:created', created);
    io.to(`tmatch:${created.id}`).emit('tmatch:update', created);
    if (created.tieId)
      io.to(`ttie:${created.tieId}`).emit('tmatch:created', created);

    res.status(201).json(created);
  } catch (e) {
    console.error('POST /tournaments/:id/matches', e);
    res.status(400).json({ error: e.message || 'Ошибка создания матча' });
  }
});

// patch
router.patch('/tournament-matches/:matchId(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.matchId);
    const patch = {};
    const keys = [
      'roundId',
      'tieId',
      'groupId',
      'team1TTId',
      'team2TTId',
      'date',
      'status',
      'stadiumId',
      'legNumber',
      'team1Formation',
      'team2Formation',
      'team1Coach',
      'team2Coach',
      'team1Score',
      'team2Score',
    ];
    for (const k of keys) {
      if (!(k in req.body)) continue;
      if (
        k.endsWith('Id') ||
        ['legNumber', 'team1Score', 'team2Score'].includes(k)
      )
        patch[k] = toInt(req.body[k], null);
      else if (k === 'date') patch[k] = toDate(req.body[k], undefined);
      else patch[k] = req.body[k] ?? null;
    }
    const upd = await prisma.tournamentMatch.update({
      where: { id },
      data: patch,
    });

    const io = getIO();
    io.to(`tmatch:${id}`).emit('tmatch:update', upd);
    io.to(`tournament:${upd.tournamentId}`).emit('tmatch:update', upd);
    if (upd.tieId) io.to(`ttie:${upd.tieId}`).emit('tmatch:update', upd);
    if (patch.status === 'FINISHED' && upd.tieId) await recalcTie(upd.tieId);

    res.json(upd);
  } catch (e) {
    console.error('PATCH /tournament-matches/:matchId', e);
    res.status(400).json({ error: 'Ошибка обновления матча' });
  }
});
router.put('/tournament-matches/:matchId(\\d+)', (req, res) => {
  req.method = 'PATCH';
  router.handle(req, res);
});

// delete
router.delete('/tournament-matches/:matchId(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.matchId);
    const m = await prisma.tournamentMatch.findUnique({
      where: { id },
      select: { tournamentId: true, tieId: true },
    });
    await prisma.tournamentMatch.delete({ where: { id } });

    const io = getIO();
    io.to(`tmatch:${id}`).emit('tmatch:deleted', { matchId: id });
    if (m) {
      io.to(`tournament:${m.tournamentId}`).emit('tmatch:deleted', {
        matchId: id,
      });
      if (m.tieId)
        io.to(`ttie:${m.tieId}`).emit('tmatch:deleted', { matchId: id });
      io.in(`tmatch:${id}`).socketsLeave(`tmatch:${id}`);
    }
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /tournament-matches/:matchId', e);
    res.status(500).json({ error: 'Ошибка удаления матча' });
  }
});

// status helpers
router.post('/tournament-matches/:matchId(\\d+)/start', async (req, res) => {
  try {
    const id = Number(req.params.matchId);
    const upd = await prisma.tournamentMatch.update({
      where: { id },
      data: { status: 'LIVE' },
    });

    const io = getIO();
    io.to(`tmatch:${id}`).emit('tmatch:status', {
      matchId: id,
      status: 'LIVE',
    });
    io.to(`tournament:${upd.tournamentId}`).emit('tmatch:update', upd);
    await emitLineupFromDB(prisma, id);
    res.json(upd);
  } catch (e) {
    console.error('POST /tournament-matches/:id/start', e);
    res.status(400).json({ error: 'Не удалось начать матч' });
  }
});

router.post('/tournament-matches/:matchId(\\d+)/finish', async (req, res) => {
  try {
    const id = Number(req.params.matchId);
    await recomputeTMatchScore(id);
    const m = await prisma.tournamentMatch.update({
      where: { id },
      data: { status: 'FINISHED' },
    });

    await serveSuspensionsAfterMatch(id);

    const io = getIO();
    io.to(`tmatch:${id}`).emit('tmatch:status', {
      matchId: id,
      status: 'FINISHED',
    });
    io.to(`tmatch:${id}`).emit('tmatch:score', {
      matchId: id,
      team1Score: m.team1Score,
      team2Score: m.team2Score,
    });
    io.to(`tournament:${m.tournamentId}`).emit('tmatch:update', m);
    if (m.tieId) await recalcTie(m.tieId);

    res.json(m);
  } catch (e) {
    console.error('POST /tournament-matches/:id/finish', e);
    res.status(400).json({ error: 'Не удалось завершить матч' });
  }
});

router.post('/tournament-matches/:matchId(\\d+)/score', async (req, res) => {
  try {
    const id = Number(req.params.matchId);
    const team1Score = toInt(req.body.team1Score, 0);
    const team2Score = toInt(req.body.team2Score, 0);
    const m = await prisma.tournamentMatch.update({
      where: { id },
      data: { team1Score, team2Score },
    });

    const io = getIO();
    io.to(`tmatch:${id}`).emit('tmatch:score', {
      matchId: id,
      team1Score,
      team2Score,
    });
    io.to(`tournament:${m.tournamentId}`).emit('tmatch:update', m);
    if (m.status === 'FINISHED' && m.tieId) await recalcTie(m.tieId);
    res.json(m);
  } catch (e) {
    console.error('POST /tournament-matches/:id/score', e);
    res.status(400).json({ error: 'Не удалось обновить счёт' });
  }
});

/* ---- referees ---- */
router.get('/tournament-matches/:matchId(\\d+)/referees', async (req, res) => {
  try {
    const id = Number(req.params.matchId);
    const rows = await prisma.tournamentMatchReferee.findMany({
      where: { matchId: id },
      include: { referee: true },
      orderBy: { id: 'asc' },
    });
    res.json(rows);
  } catch (e) {
    console.error('GET /tournament-matches/:id/referees', e);
    res.status(500).json({ error: 'Ошибка загрузки судей' });
  }
});

router.post('/tournament-matches/:matchId(\\d+)/referees', async (req, res) => {
  try {
    const id = Number(req.params.matchId);
    const list = Array.isArray(req.body)
      ? req.body
      : Array.isArray(req.body?.items)
        ? req.body.items
        : [];
    await prisma.$transaction(async (tx) => {
      await tx.tournamentMatchReferee.deleteMany({ where: { matchId: id } });
      if (list.length) {
        await tx.tournamentMatchReferee.createMany({
          data: list.map((r) => ({
            matchId: id,
            refereeId: Number(r.refereeId),
            role: r.role ?? null,
          })),
        });
      }
    });
    const rows = await prisma.tournamentMatchReferee.findMany({
      where: { matchId: id },
      include: { referee: true },
    });

    const m = await prisma.tournamentMatch.findUnique({
      where: { id },
      select: { tournamentId: true },
    });
    if (m) {
      const io = getIO();
      io.to(`tmatch:${id}`).emit('treferees:updated', rows);
      io.to(`tournament:${m.tournamentId}`).emit('treferees:updated', {
        matchId: id,
      });
    }
    res.json(rows);
  } catch (e) {
    console.error('POST /tournament-matches/:id/referees', e);
    res.status(400).json({ error: 'Не удалось сохранить судей' });
  }
});

router.post(
  '/tournament-matches/:matchId(\\d+)/referees/assign',
  async (req, res) => {
    try {
      const matchId = Number(req.params.matchId);
      const refereeId = toInt(req.body.refereeId);
      const role = req.body.role ?? null;
      if (!refereeId)
        return res.status(400).json({ error: 'refereeId обязателен' });

      const row = await prisma.tournamentMatchReferee.upsert({
        where: { matchId_refereeId: { matchId, refereeId } },
        update: { role },
        create: { matchId, refereeId, role },
      });

      const rows = await prisma.tournamentMatchReferee.findMany({
        where: { matchId },
        include: { referee: true },
      });
      const m = await prisma.tournamentMatch.findUnique({
        where: { id: matchId },
        select: { tournamentId: true },
      });
      if (m) {
        const io = getIO();
        io.to(`tmatch:${matchId}`).emit('treferees:updated', rows);
        io.to(`tournament:${m.tournamentId}`).emit('treferees:updated', {
          matchId,
        });
      }
      res.json(row);
    } catch (e) {
      console.error('POST /tournament-matches/:id/referees/assign', e);
      res.status(400).json({ error: 'Не удалось назначить судью' });
    }
  }
);

router.delete(
  '/tournament-matches/:matchId(\\d+)/referees/:refId(\\d+)',
  async (req, res) => {
    try {
      const matchId = Number(req.params.matchId);
      const refereeId = Number(req.params.refId);
      await prisma.tournamentMatchReferee.delete({
        where: { matchId_refereeId: { matchId, refereeId } },
      });

      const rows = await prisma.tournamentMatchReferee.findMany({
        where: { matchId },
        include: { referee: true },
      });
      const m = await prisma.tournamentMatch.findUnique({
        where: { id: matchId },
        select: { tournamentId: true },
      });
      if (m) {
        const io = getIO();
        io.to(`tmatch:${matchId}`).emit('treferees:updated', rows);
        io.to(`tournament:${m.tournamentId}`).emit('treferees:updated', {
          matchId,
        });
      }
      res.json({ success: true });
    } catch (e) {
      console.error('DELETE /tournament-matches/:id/referees/:refId', e);
      res.status(400).json({ error: 'Не удалось снять судью' });
    }
  }
);

/* ---- participants ---- */
router.get(
  '/tournament-matches/:matchId(\\d+)/participants',
  async (req, res) => {
    try {
      const id = Number(req.params.matchId);
      const rows = await prisma.tournamentPlayerMatch.findMany({
        where: { matchId: id },
        include: { tournamentTeamPlayer: { include: { player: true } } },
        orderBy: [{ role: 'asc' }, { order: 'asc' }],
      });
      res.json(rows);
    } catch (e) {
      console.error('GET /tournament-matches/:id/participants', e);
      res.status(500).json({ error: 'Ошибка загрузки участников' });
    }
  }
);

router.put(
  '/tournament-matches/:matchId(\\d+)/participants',
  async (req, res) => {
    try {
      const id = Number(req.params.matchId);
      const items = Array.isArray(req.body)
        ? req.body
        : Array.isArray(req.body?.items)
          ? req.body.items
          : [];
      await prisma.$transaction(async (tx) => {
        await tx.tournamentPlayerMatch.deleteMany({ where: { matchId: id } });
        if (items.length) {
          await tx.tournamentPlayerMatch.createMany({
            data: items.map((p) => ({
              matchId: id,
              tournamentTeamPlayerId: Number(p.tournamentTeamPlayerId),
              role: p.role ?? 'STARTER',
              position: p.position ?? null,
              isCaptain: Boolean(p.isCaptain),
              order: Number.isFinite(Number(p.order)) ? Number(p.order) : 0,
              minutesIn: toInt(p.minutesIn, null),
              minutesOut: toInt(p.minutesOut, null),
            })),
          });
        }
      });
      const rows = await prisma.tournamentPlayerMatch.findMany({
        where: { matchId: id },
        include: { tournamentTeamPlayer: { include: { player: true } } },
      });

      const m = await prisma.tournamentMatch.findUnique({
        where: { id },
        select: { tournamentId: true },
      });
      if (m) {
        const io = getIO();
        io.to(`tmatch:${id}`).emit('tparticipants:updated', rows);
        io.to(`tournament:${m.tournamentId}`).emit('tparticipants:updated', {
          matchId: id,
        });
      }
      res.json(rows);
    } catch (e) {
      console.error('PUT /tournament-matches/:id/participants', e);
      res.status(400).json({ error: 'Не удалось сохранить участников' });
    }
  }
);

router.post(
  '/tournament-matches/:matchId(\\d+)/lineup/emit',
  async (req, res) => {
    await emitLineupFromDB(prisma, Number(req.params.matchId));
    res.json({ success: true });
  }
);

/* ---- events ---- */
router.get('/tournament-matches/:matchId(\\d+)/events', async (req, res) => {
  try {
    const id = Number(req.params.matchId);
    const rows = await prisma.tournamentMatchEvent.findMany({
      where: { matchId: id },
      orderBy: [{ half: 'asc' }, { minute: 'asc' }, { id: 'asc' }],
      include: {
        tournamentTeam: { include: { team: true } },
        rosterItem: { include: { player: true } },
        assistRosterItem: { include: { player: true } },
      },
    });
    res.json(rows);
  } catch (e) {
    console.error('GET /tournament-matches/:id/events', e);
    res.status(500).json({ error: 'Ошибка загрузки событий' });
  }
});

router.post('/tournament-matches/:matchId(\\d+)/events', async (req, res) => {
  try {
    const matchId = Number(req.params.matchId);
    const {
      minute,
      half,
      type,
      description,
      tournamentTeamId,
      rosterItemId,
      assistRosterItemId,
      issuedByRefereeId,
    } = req.body;

    const created = await prisma.tournamentMatchEvent.create({
      data: {
        matchId,
        minute: toInt(minute, 0),
        half: toInt(half, 1),
        type,
        description: description ?? null,
        tournamentTeamId: Number(tournamentTeamId),
        rosterItemId: toInt(rosterItemId, null),
        assistRosterItemId: toInt(assistRosterItemId, null),
        issuedByRefereeId: toInt(issuedByRefereeId, null),
      },
      include: {
        tournamentTeam: { include: { team: true } },
        rosterItem: { include: { player: true } },
        assistRosterItem: { include: { player: true } },
      },
    });

    if (created.rosterItemId)
      await incPlayerStatByRoster(created.rosterItemId, type);
    if (created.assistRosterItemId && type === 'GOAL')
      await incPlayerStatByRoster(created.assistRosterItemId, 'ASSIST');
    if (isGoalType(type)) await recomputeTMatchScore(matchId);

    // дисциплина
    await maybeCreateSuspensionAfterEvent(created);

    const m = await prisma.tournamentMatch.findUnique({
      where: { id: matchId },
      select: {
        id: true,
        tournamentId: true,
        tieId: true,
        team1Score: true,
        team2Score: true,
      },
    });
    const io = getIO();
    io.to(`tmatch:${matchId}`).emit('tevent:created', created);
    if (m) {
      io.to(`tmatch:${matchId}`).emit('tmatch:score', {
        matchId,
        team1Score: m.team1Score,
        team2Score: m.team2Score,
      });
      io.to(`tournament:${m.tournamentId}`).emit('tmatch:update', {
        id: matchId,
        team1Score: m.team1Score,
        team2Score: m.team2Score,
      });
      if (m.tieId) {
        io.to(`ttie:${m.tieId}`).emit('tmatch:update', {
          id: matchId,
          team1Score: m.team1Score,
          team2Score: m.team2Score,
        });
      }
    }

    res.status(201).json(created);
  } catch (e) {
    console.error('POST /tournament-matches/:id/events', e);
    res.status(400).json({ error: 'Ошибка создания события' });
  }
});

router.put('/tournament-events/:eventId(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.eventId);
    const old = await prisma.tournamentMatchEvent.findUnique({ where: { id } });
    if (!old) return res.status(404).json({ error: 'Событие не найдено' });

    if (old.rosterItemId)
      await decPlayerStatByRoster(old.rosterItemId, old.type);
    if (old.assistRosterItemId && old.type === 'GOAL')
      await decPlayerStatByRoster(old.assistRosterItemId, 'ASSIST');

    const {
      minute,
      half,
      type,
      description,
      tournamentTeamId,
      rosterItemId,
      assistRosterItemId,
      issuedByRefereeId,
    } = req.body;

    const updated = await prisma.tournamentMatchEvent.update({
      where: { id },
      data: {
        minute: toInt(minute, 0),
        half: toInt(half, 1),
        type,
        description: description ?? null,
        tournamentTeamId: toInt(tournamentTeamId, undefined),
        rosterItemId: toInt(rosterItemId, null),
        assistRosterItemId: toInt(assistRosterItemId, null),
        issuedByRefereeId: toInt(issuedByRefereeId, undefined),
      },
      include: {
        tournamentTeam: { include: { team: true } },
        rosterItem: { include: { player: true } },
        assistRosterItem: { include: { player: true } },
      },
    });

    if (updated.rosterItemId)
      await incPlayerStatByRoster(updated.rosterItemId, updated.type);
    if (updated.assistRosterItemId && updated.type === 'GOAL')
      await incPlayerStatByRoster(updated.assistRosterItemId, 'ASSIST');
    if (isGoalType(updated.type) || isGoalType(old.type))
      await recomputeTMatchScore(updated.matchId);

    const m = await prisma.tournamentMatch.findUnique({
      where: { id: updated.matchId },
      select: {
        id: true,
        tournamentId: true,
        tieId: true,
        team1Score: true,
        team2Score: true,
      },
    });
    const io = getIO();
    io.to(`tmatch:${updated.matchId}`).emit('tevent:updated', updated);
    if (m) {
      io.to(`tmatch:${m.id}`).emit('tmatch:score', {
        matchId: m.id,
        team1Score: m.team1Score,
        team2Score: m.team2Score,
      });
      io.to(`tournament:${m.tournamentId}`).emit('tmatch:update', {
        id: m.id,
        team1Score: m.team1Score,
        team2Score: m.team2Score,
      });
      if (m.tieId) {
        io.to(`ttie:${m.tieId}`).emit('tmatch:update', {
          id: m.id,
          team1Score: m.team1Score,
          team2Score: m.team2Score,
        });
      }
    }

    res.json(updated);
  } catch (e) {
    console.error('PUT /tournament-events/:eventId', e);
    res.status(400).json({ error: 'Ошибка обновления события' });
  }
});

router.delete('/tournament-events/:eventId(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.eventId);
    const old = await prisma.tournamentMatchEvent.findUnique({ where: { id } });
    if (!old) return res.status(404).json({ error: 'Событие не найдено' });

    await prisma.tournamentMatchEvent.delete({ where: { id } });
    if (old.rosterItemId)
      await decPlayerStatByRoster(old.rosterItemId, old.type);
    if (old.assistRosterItemId && old.type === 'GOAL')
      await decPlayerStatByRoster(old.assistRosterItemId, 'ASSIST');
    if (isGoalType(old.type)) await recomputeTMatchScore(old.matchId);

    const m = await prisma.tournamentMatch.findUnique({
      where: { id: old.matchId },
      select: {
        id: true,
        tournamentId: true,
        tieId: true,
        team1Score: true,
        team2Score: true,
      },
    });
    const io = getIO();
    io.to(`tmatch:${old.matchId}`).emit('tevent:deleted', {
      id,
      matchId: old.matchId,
    });
    if (m) {
      io.to(`tmatch:${m.id}`).emit('tmatch:score', {
        matchId: m.id,
        team1Score: m.team1Score,
        team2Score: m.team2Score,
      });
      io.to(`tournament:${m.tournamentId}`).emit('tmatch:update', {
        id: m.id,
        team1Score: m.team1Score,
        team2Score: m.team2Score,
      });
      if (m.tieId) {
        io.to(`ttie:${m.tieId}`).emit('tmatch:update', {
          id: m.id,
          team1Score: m.team1Score,
          team2Score: m.team2Score,
        });
      }
    }

    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /tournament-events/:eventId', e);
    res.status(400).json({ error: 'Ошибка удаления события' });
  }
});

/* =========================================================
   SUSPENSIONS API
========================================================= */
router.get('/tournaments/:id(\\d+)/suspensions', async (req, res) => {
  try {
    const tournamentId = Number(req.params.id);
    const onlyActive = String(req.query.active || 'true') === 'true';
    const rows = await prisma.tournamentSuspension.findMany({
      where: { tournamentId, ...(onlyActive ? { isActive: true } : {}) },
      include: {
        tournamentTeamPlayer: {
          include: {
            player: true,
            tournamentTeam: { include: { team: true } },
          },
        },
        triggerMatch: true,
      },
      orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }],
    });
    res.json(rows);
  } catch (e) {
    console.error('GET /tournaments/:id/suspensions', e);
    res.status(500).json({ error: 'Ошибка загрузки дисквалификаций' });
  }
});

router.post('/tournaments/:id(\\d+)/suspensions/recalc', async (req, res) => {
  try {
    const tournamentId = Number(req.params.id);
    const set = await getDisciplineSettings(tournamentId);
    if (!set?.disciplineEnabled)
      return res.json({ success: true, message: 'Дисциплина выключена' });

    await prisma.tournamentSuspension.deleteMany({ where: { tournamentId } });

    const events = await prisma.tournamentMatchEvent.findMany({
      where: {
        match: { tournamentId },
        type: { in: ['YELLOW_CARD', 'RED_CARD'] },
        rosterItemId: { not: null },
      },
      include: { match: true },
    });

    const yCount = new Map();
    const rCount = new Map();
    for (const ev of events) {
      if (ev.type === 'YELLOW_CARD') {
        yCount.set(ev.rosterItemId, 1 + (yCount.get(ev.rosterItemId) || 0));
        if (yCount.get(ev.rosterItemId) === set.yellowToSuspend) {
          await prisma.tournamentSuspension.create({
            data: {
              tournamentId,
              tournamentTeamPlayerId: ev.rosterItemId,
              reason: 'YELLOWS',
              startsAfter: ev.match.date,
              remainingGames: set.suspendGames,
              triggerMatchId: ev.matchId,
            },
          });
        }
      } else if (ev.type === 'RED_CARD') {
        rCount.set(ev.rosterItemId, 1 + (rCount.get(ev.rosterItemId) || 0));
        if (rCount.get(ev.rosterItemId) === set.redToSuspend) {
          await prisma.tournamentSuspension.create({
            data: {
              tournamentId,
              tournamentTeamPlayerId: ev.rosterItemId,
              reason: 'RED',
              startsAfter: ev.match.date,
              remainingGames: set.suspendGames,
              triggerMatchId: ev.matchId,
            },
          });
        }
      }
    }
    res.json({ success: true });
  } catch (e) {
    console.error('POST /tournaments/:id/suspensions/recalc', e);
    res.status(500).json({ error: 'Не удалось пересчитать дисквалификации' });
  }
});

export default router;
