// app/routes/tournaments.js

import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { getIO, emitLineupFromDB } from '../socket.js';

const router = Router();
const prisma = new PrismaClient();

/* =========================================================
   helpers
========================================================= */

const FIN = 'FINISHED';
const isFinished = (s) => String(s).toUpperCase() === String(FIN).toUpperCase();

/* ---------- totals: игры/победы/голы/кол-во турниров у команды ---------- */
async function recalcTeamTotals(teamId) {
  // все заявки этой команды в турнирах
  const tts = await prisma.tournamentTeam.findMany({
    where: { teamId },
    select: { id: true, tournamentId: true },
  });

  const tournamentsCount = tts.length;

  if (!tts.length) {
    await prisma.team.update({
      where: { id: teamId },
      data: {
        games: 0,
        wins: 0,
        goals: 0,
        tournaments: 0,
      },
    });
    return;
  }

  const ttIds = tts.map((t) => t.id);

  // все завершённые матчи с участием этих заявок
  const matches = await prisma.tournamentMatch.findMany({
    where: {
      status: 'FINISHED',
      OR: [{ team1TTId: { in: ttIds } }, { team2TTId: { in: ttIds } }],
    },
    select: {
      team1TTId: true,
      team2TTId: true,
      team1Score: true,
      team2Score: true,
    },
  });

  let games = 0;
  let wins = 0;
  let goals = 0;
  for (const m of matches) {
    const isT1 = ttIds.includes(m.team1TTId);
    const gf = isT1 ? (m.team1Score ?? 0) : (m.team2Score ?? 0);
    const ga = isT1 ? (m.team2Score ?? 0) : (m.team1Score ?? 0);
    games += 1;
    goals += gf;
    if (gf > ga) wins += 1;
  }

  await prisma.team.update({
    where: { id: teamId },
    data: {
      games,
      wins,
      goals,
      tournaments: tournamentsCount,
    },
  });
}

// вызывать пересчёт только если матч уже FINISHED
async function recalcTotalsIfFinished(matchId) {
  const m = await prisma.tournamentMatch.findUnique({
    where: { id: matchId },
    select: {
      status: true,
      team1TT: { select: { team: { select: { id: true } } } },
      team2TT: { select: { team: { select: { id: true } } } },
    },
  });
  if (!m || !isFinished(m.status)) return;
  await Promise.all([
    recalcTeamTotals(m.team1TT.team.id),
    recalcTeamTotals(m.team2TT.team.id),
  ]);
}

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
  const from = total === 0 ? 0 : start;
  const to = total === 0 ? 0 : start + Math.max(0, count - 1);
  res.setHeader('Content-Range', `${name} ${from}-${to}/${total}`);
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

/* ---------- default match referee helper (MAIN first) ---------- */
async function getDefaultRefereeIdForMatch(matchId) {
  const m = await prisma.tournamentMatch.findUnique({
    where: { id: matchId },
    select: { groupId: true },
  });
  if (!m) return null;

  if (m.groupId) {
    const g = await prisma.tournamentGroup.findUnique({
      where: { id: m.groupId },
      select: { defaultRefereeId: true },
    });
    if (g?.defaultRefereeId) return g.defaultRefereeId;
  }

  // сначала ищем MAIN; если нет — любого
  const main = await prisma.tournamentMatchReferee.findFirst({
    where: { matchId, role: 'MAIN' },
    orderBy: { matchId: 'asc' },
  });
  if (main) return main.refereeId;

  const any = await prisma.tournamentMatchReferee.findFirst({
    where: { matchId },
    orderBy: { matchId: 'asc' },
  });
  return any?.refereeId ?? null;
}

/* -------------------- include builders -------------------- */
// вместо прежних buildTournamentInclude / buildTMatchInclude
const buildTournamentInclude = (p) => {
  const parts = String(p || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const inc = {};
  if (parts.includes('teams')) {
    inc.teams = {
      include: {
        team: true,
        ...(parts.includes('roster') && {
          roster: { include: { player: true } },
          captainRosterItem: true,
        }),
      },
    };
  }
  if (parts.includes('matches')) {
    inc.matches = {
      include: {
        team1TT: { include: { team: true } },
        team2TT: { include: { team: true } },
        stadiumRel: true,
        referees: { include: { referee: true } },
      },
    };
  }
  if (parts.includes('groups') || parts.includes('stages')) {
    inc.groups = {
      include: {
        teams: { include: { tournamentTeam: { include: { team: true } } } },
        defaultReferee: true,
      },
    };
  }
  return inc;
};

const buildTMatchInclude = (p) => {
  const parts = String(p || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const inc = {};
  if (parts.includes('tournament')) inc.tournament = true;
  if (parts.includes('group')) inc.group = true;
  if (parts.includes('team1')) inc.team1TT = { include: { team: true } };
  if (parts.includes('team2')) inc.team2TT = { include: { team: true } };
  if (parts.includes('stadium')) inc.stadiumRel = true;
  if (parts.includes('referees')) inc.referees = { include: { referee: true } };
  if (parts.includes('events')) {
    inc.events = {
      include: {
        rosterItem: { include: { player: true } },
        assistRosterItem: { include: { player: true } },
        tournamentTeam: { include: { team: true } },
      },
    };
  }
  if (parts.includes('participants')) {
    inc.participants = {
      include: { tournamentTeamPlayer: { include: { player: true } } },
    };
  }
  return inc;
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

/* ---------- normalize match for frontend ---------- */
function normalizeMatch(m) {
  if (!m) return m;
  const stadium = m.stadiumRel || null;
  const stadiumTitle = stadium?.title || stadium?.name || null;
  const refs = Array.isArray(m.referees) ? m.referees : [];
  const mainRel = refs.find((r) => r.role === 'MAIN') || refs[0] || null;
  const referee = mainRel?.referee || null;
  const refereeId = referee?.id ?? null;
  const refereeName = referee?.name ?? null;
  return {
    ...m,
    stadium,
    stadiumTitle,
    referee,
    refereeId,
    refereeName,
  };
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

/* -------------------- scoring -------------------- */
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

// period=ROUND трактуем как groupId (раунды отключены)
async function countCardsScoped({ tournamentId, rosterItemId, period, match }) {
  const whereMatch = { tournamentId };
  if (period === 'ROUND') whereMatch.groupId = match.groupId ?? undefined;
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
  const m = await prisma.tournamentMatch.findUnique({
    where: { id: createdEvent.matchId },
    select: {
      id: true,
      date: true,
      tournamentId: true,
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
   AUTOPUBLISH roster → participants (учёт банов)
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

  if (![m.team1TTId, m.team2TTId].includes(ttId))
    throw new Error('Команда не участвует в этом матче');

  const tt = await prisma.tournamentTeam.findUnique({
    where: { id: ttId },
    select: {
      id: true,
      tournamentId: true,
      captainRosterItemId: true,
      tournament: { select: { format: true } },
    },
  });
  if (!tt || tt.tournamentId !== m.tournamentId)
    throw new Error('Команда не из турнира матча');

  const maxStarters =
    STARTERS_BY_FORMAT[tt.tournament?.format || 'F11x11'] ?? 11;

  const roster = await prisma.tournamentTeamPlayer.findMany({
    where: {
      tournamentTeamId: ttId,
      ...(roleFilter === 'STARTER' ? { role: 'STARTER' } : {}),
    },
    orderBy: [{ role: 'asc' }, { number: 'asc' }, { id: 'asc' }],
  });

  // вычтем баны
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

  let allowed = roster.filter((r) => !banned.has(r.id));
  if (roleFilter === 'STARTER' && allowed.length > maxStarters) {
    allowed = allowed.slice(0, maxStarters);
  }

  // полное удаление участников этой команды в матче
  await prisma.tournamentPlayerMatch.deleteMany({
    where: {
      matchId: m.id,
      tournamentTeamPlayer: { tournamentTeamId: ttId },
    },
  });

  if (allowed.length) {
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
  }

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
    const include = buildTournamentInclude(req.query.include || 'teams,groups');
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

    // сохраним команды, чтобы пересчитать после удаления турнира
    const teamIds = await prisma.tournamentTeam
      .findMany({
        where: { tournamentId: id },
        select: { teamId: true },
      })
      .then((x) => Array.from(new Set(x.map((r) => r.teamId))));

    await prisma.tournament.delete({ where: { id } });

    // пересчёт totals тем, кто участвовал в этом турнире
    if (teamIds.length) {
      await Promise.all(teamIds.map((tid) => recalcTeamTotals(tid)));
    }

    const io = getIO();
    io.to(`tournament:${id}`).emit('tournament:deleted', { tournamentId: id });
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /tournaments/:id', e);
    res.status(500).json({ error: 'Ошибка удаления турнира' });
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

      // проверим, что команда существует
      const team = await prisma.team.findUnique({ where: { id: teamId } });
      if (!team) return res.status(404).json({ error: 'Команда не найдена' });

      const tt = await prisma.tournamentTeam.upsert({
        where: { tournamentId_teamId: { tournamentId, teamId } },
        update: { seed },
        create: { tournamentId, teamId, seed },
      });

      // ← пересчёт totals: турниры++ (по заявкам), игры/голы не меняются
      await recalcTeamTotals(teamId);

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

      // ← пересчёт totals: уменьшится количество турниров
      await recalcTeamTotals(teamId);

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

    // валидация «игрок из этой команды»
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
        await tx.tournamentTeam.update({
          where: { id },
          data: { captainRosterItemId: cap ? cap.id : null },
        });
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
    if (![m.team1TTId, m.team2TTId].includes(id))
      return res.status(400).json({ error: 'Команда не участвует в матче' });

    if (reset) {
      await prisma.tournamentPlayerMatch.deleteMany({
        where: {
          matchId: Number(matchId),
          tournamentTeamPlayer: { tournamentTeamId: id },
        },
      });
    }

    await publishRosterToMatch(Number(matchId), id, roleFilter);

    const rows = await prisma.tournamentPlayerMatch.findMany({
      where: { matchId: Number(matchId) },
      include: { tournamentTeamPlayer: { include: { player: true } } },
      orderBy: [{ role: 'asc' }, { order: 'asc' }],
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
   GROUPS (круги)
========================================================= */
router.get('/tournaments/:id(\\d+)/groups', async (req, res) => {
  try {
    const tournamentId = Number(req.params.id);
    const rows = await prisma.tournamentGroup.findMany({
      where: { tournamentId },
      include: {
        defaultReferee: true,
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
    const { name, type = 'ROUND1', defaultRefereeId = null } = req.body || {};
    const created = await prisma.tournamentGroup.create({
      data: {
        tournamentId,
        name,
        type,
        defaultRefereeId: toInt(defaultRefereeId, null),
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

// PUT /tournament-groups/:groupId/referee?apply=true
router.put('/tournament-groups/:groupId(\\d+)/referee', async (req, res) => {
  try {
    const groupId = Number(req.params.groupId);
    const refereeId = toInt(req.body?.refereeId, null);
    const apply = String(req.query.apply || 'false') === 'true';

    const g = await prisma.tournamentGroup.update({
      where: { id: groupId },
      data: { defaultRefereeId: refereeId },
      select: { id: true, tournamentId: true, defaultRefereeId: true },
    });

    if (apply && refereeId) {
      const ids = await prisma.tournamentMatch
        .findMany({
          where: { groupId },
          select: { id: true },
        })
        .then((r) => r.map((x) => x.id));

      if (ids.length) {
        await prisma.tournamentMatchReferee.createMany({
          data: ids.map((id) => ({ matchId: id, refereeId, role: 'MAIN' })),
          skipDuplicates: true,
        });
        // проставим судью в событиях без выдавшего
        await prisma.tournamentMatchEvent.updateMany({
          where: { matchId: { in: ids }, issuedByRefereeId: null },
          data: { issuedByRefereeId: refereeId },
        });
      }
    }

    res.json(g);
  } catch (e) {
    console.error('PUT /tournament-groups/:groupId/referee', e);
    res.status(400).json({ error: 'Не удалось сохранить судью группы' });
  }
});

router.post('/tournament-groups/:groupId(\\d+)/referee', (req, res) => {
  // просто прокидываем в уже реализованный PUT-хендлер
  req.method = 'PUT';
  router.handle(req, res);
});

router.post(
  '/tournament-groups/:groupId(\\d+)/referee/apply',
  async (req, res) => {
    try {
      const groupId = Number(req.params.groupId);
      const g = await prisma.tournamentGroup.findUnique({
        where: { id: groupId },
        select: { defaultRefereeId: true, tournamentId: true },
      });
      if (!g) return res.status(404).json({ error: 'Группа не найдена' });
      if (!g.defaultRefereeId)
        return res.status(400).json({ error: 'В группе не выбран судья' });

      const matches = await prisma.tournamentMatch.findMany({
        where: { groupId },
        select: { id: true },
      });
      const ids = matches.map((m) => m.id);

      if (ids.length) {
        await prisma.tournamentMatchReferee.createMany({
          data: ids.map((id) => ({
            matchId: id,
            refereeId: g.defaultRefereeId,
            role: 'MAIN',
          })),
          skipDuplicates: true,
        });

        await prisma.tournamentMatchEvent.updateMany({
          where: { matchId: { in: ids }, issuedByRefereeId: null },
          data: { issuedByRefereeId: g.defaultRefereeId },
        });
      }

      res.json({ success: true, affectedMatches: ids.length });
    } catch (e) {
      console.error('POST /tournament-groups/:groupId/referee/apply', e);
      res.status(400).json({ error: 'Не удалось применить судью для группы' });
    }
  }
);

router.post(
  '/tournament-groups/:groupId(\\d+)/teams/:ttId(\\d+)',
  async (req, res) => {
    try {
      const groupId = Number(req.params.groupId);
      const tournamentTeamId = Number(req.params.ttId);

      // валидируем принадлежность TT турниру группы
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

      const row = await prisma.tournamentGroupTeam.upsert({
        where: { groupId_tournamentTeamId: { groupId, tournamentTeamId } },
        update: {},
        create: { tournamentId: g.tournamentId, groupId, tournamentTeamId },
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
      const tournamentTeamId = Number(req.params.ttId);
      await prisma.tournamentGroupTeam.delete({
        where: { groupId_tournamentTeamId: { groupId, tournamentTeamId } },
      });
      res.json({ success: true });
    } catch (e) {
      console.error('DELETE /tournament-groups/:groupId/teams/:ttId', e);
      res.status(400).json({ error: 'Не удалось убрать команду из группы' });
    }
  }
);

// генерация «каждый с каждым» только для ROUND1/ROUND2 (1 или 2 круга подряд)
// генерация «каждый с каждым» c днями недели и лимитом матчей в день
router.post('/tournament-groups/:groupId(\\d+)/generate', async (req, res) => {
  try {
    const groupId = Number(req.params.groupId);
    const {
      rounds, // 1|2 (если не передан — из типа группы)
      dateStart = null, // 'YYYY-MM-DDTHH:mm'
      perDay = 2, // Сколько матчей в день
      daysOfWeek = [6, 7], // 1=Пн ... 7=Вс
      stadiumId: rawGenStadiumId = null, // опционально общий стадион
    } = req.body || {};

    const g = await prisma.tournamentGroup.findUnique({
      where: { id: groupId },
      include: {
        tournament: true,
        teams: { include: { tournamentTeam: true } },
      },
    });
    if (!g) return res.status(404).json({ error: 'Группа не найдена' });
    if (g.type === 'PLAYOFF') {
      return res.status(400).json({ error: 'PLAYOFF генерируйте вручную' });
    }

    const list = g.teams.map((t) => t.tournamentTeamId);
    const N = list.length;
    if (N < 2)
      return res.status(400).json({ error: 'Недостаточно команд в группе' });

    // ----- круговой алгоритм -----
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

    const effectiveRounds = Number.isFinite(Number(rounds))
      ? Number(rounds)
      : g.type === 'ROUND2'
        ? 2
        : 1;

    // Сформируем плоский список пар (учитываем 2-й круг с реверсом)
    const pairList = [];
    for (let r = 1; r <= effectiveRounds; r++) {
      for (const pairs of roundsSchedule) {
        for (const [a, b] of pairs) {
          pairList.push(r === 1 ? [a, b] : [b, a]);
        }
      }
    }

    // ----- подготовка слот-дней -----
    const base = dateStart ? new Date(dateStart) : new Date();
    const timeH = base.getHours();
    const timeM = base.getMinutes();

    let dows = Array.isArray(daysOfWeek)
      ? daysOfWeek.map((n) => Number(n)).filter((n) => n >= 1 && n <= 7)
      : [];
    if (!dows.length) dows = [6, 7]; // Сб, Вс по умолчанию
    dows.sort((a, b) => a - b);

    const startOfWeekMon = (d) => {
      const js = d.getDay(); // 0=Вс ... 6=Сб
      const delta = js === 0 ? -6 : 1 - js; // до понедельника
      const x = new Date(d);
      x.setHours(0, 0, 0, 0);
      x.setDate(x.getDate() + delta);
      return x;
    };

    const slots = [];
    const need = pairList.length;
    const week0 = startOfWeekMon(base);

    for (let w = 0; slots.length < need && w < 1000; w++) {
      for (const dow of dows) {
        const addDays = dow - 1 + w * 7; // 1=Пн → +0
        const day = new Date(week0);
        day.setDate(day.getDate() + addDays);
        day.setHours(timeH, timeM, 0, 0);
        if (day < base) continue;
        for (let k = 0; k < Math.max(1, Number(perDay)); k++) {
          slots.push(new Date(day));
          if (slots.length >= need) break;
        }
        if (slots.length >= need) break;
      }
    }
    if (slots.length < need) {
      return res
        .status(400)
        .json({ error: 'Недостаточно слотов по заданным дням/лимитам' });
    }

    const genStadiumId = toInt(rawGenStadiumId, null);

    // ----- создаём матчи по слотам -----
    const created = [];
    for (let i = 0; i < pairList.length; i++) {
      const [tt1, tt2] = pairList[i];
      const when = slots[i];

      const m = await prisma.tournamentMatch.create({
        data: {
          date: when,
          status: 'SCHEDULED',
          tournament: { connect: { id: g.tournamentId } },
          group: { connect: { id: g.id } },
          team1TT: { connect: { id: tt1 } },
          team2TT: { connect: { id: tt2 } },
          ...(genStadiumId
            ? { stadiumRel: { connect: { id: genStadiumId } } }
            : {}),
        },
      });
      created.push(m);

      if (g.defaultRefereeId) {
        await prisma.tournamentMatchReferee.createMany({
          data: [
            { matchId: m.id, refereeId: g.defaultRefereeId, role: 'MAIN' },
          ],
          skipDuplicates: true,
        });
      }
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
   STAGES (алиасы над GROUPS)
========================================================= */

router.get('/tournaments/:id(\\d+)/stages', async (req, res) => {
  req.url = req.url.replace('/stages', '/groups');
  return router.handle(req, res);
});

router.post('/tournaments/:id(\\d+)/stages', async (req, res) => {
  try {
    const tournamentId = Number(req.params.id);
    const { name, type = 'ROUND1', defaultRefereeId = null } = req.body || {};
    const created = await prisma.tournamentGroup.create({
      data: {
        tournamentId,
        name,
        type,
        defaultRefereeId: toInt(defaultRefereeId, null),
      },
    });
    res.status(201).json(created);
  } catch (e) {
    console.error('POST /tournaments/:id/stages', e);
    res.status(400).json({ error: 'Не удалось создать этап' });
  }
});

router.delete('/tournament-stages/:stageId(\\d+)', async (req, res) => {
  try {
    await prisma.tournamentGroup.delete({
      where: { id: Number(req.params.stageId) },
    });
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /tournament-stages/:stageId', e);
    res.status(400).json({ error: 'Не удалось удалить этап' });
  }
});

router.post(
  '/tournament-stages/:stageId(\\d+)/teams/:ttId(\\d+)',
  async (req, res) => {
    req.url = req.url
      .replace('/tournament-stages/', '/tournament-groups/')
      .replace('/teams/', '/teams/');
    return router.handle(req, res);
  }
);
router.delete(
  '/tournament-stages/:stageId(\\d+)/teams/:ttId(\\d+)',
  async (req, res) => {
    req.url = req.url
      .replace('/tournament-stages/', '/tournament-groups/')
      .replace('/teams/', '/teams/');
    return router.handle(req, res);
  }
);

router.post('/tournament-stages/:stageId(\\d+)/generate', async (req, res) => {
  req.url = req.url.replace('/tournament-stages/', '/tournament-groups/');
  return router.handle(req, res);
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
    const [rowsRaw, total] = await Promise.all([
      prisma.tournamentMatch.findMany({
        skip: start,
        take,
        where,
        orderBy: { [sortField]: sortOrder },
        include,
      }),
      prisma.tournamentMatch.count({ where }),
    ]);

    // нормализация стадиона
    const rows = rowsRaw.map(normalizeMatch);

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

    res.json(normalizeMatch(item));
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
      groupId,
      team1TTId,
      team2TTId,
      date,
      status = 'SCHEDULED',
      stadiumId, // может быть и объект stadium.id
      team1Formation,
      team2Formation,
      team1Coach,
      team2Coach,
      referees = [],
    } = req.body;

    if (Number(team1TTId) === Number(team2TTId)) {
      return res.status(400).json({ error: 'Команды в матче совпадают' });
    }

    // валидация TT принадлежности турниру
    const [tt1, tt2] = await Promise.all([
      prisma.tournamentTeam.findUnique({
        where: { id: Number(team1TTId) },
        select: { tournamentId: true },
      }),
      prisma.tournamentTeam.findUnique({
        where: { id: Number(team2TTId) },
        select: { tournamentId: true },
      }),
    ]);
    if (!tt1 || !tt2) return res.status(400).json({ error: 'TT не найдены' });
    if (
      tt1.tournamentId !== tournamentId ||
      tt2.tournamentId !== tournamentId
    ) {
      return res
        .status(400)
        .json({ error: 'Команда не принадлежит этому турниру' });
    }

    if (toInt(groupId, null)) {
      const g = await prisma.tournamentGroup.findUnique({
        where: { id: Number(groupId) },
        select: { tournamentId: true },
      });
      if (!g || g.tournamentId !== tournamentId) {
        return res
          .status(400)
          .json({ error: 'Группа не принадлежит этому турниру' });
      }
    }

    const stadiumIdNum = toInt(stadiumId ?? req.body?.stadium?.id, null);

    const data = {
      date: toDate(date, new Date()),
      status,
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
    if (toInt(groupId, null)) data.group = { connect: { id: Number(groupId) } };
    if (stadiumIdNum) data.stadiumRel = { connect: { id: stadiumIdNum } };

    const created = await prisma.tournamentMatch.create({
      data,
      include: buildTMatchInclude('team1,team2,stadium,referees,group'),
    });

    // если у группы задан судья — добавить как MAIN
    if (created.groupId) {
      const grp = await prisma.tournamentGroup.findUnique({
        where: { id: created.groupId },
        select: { defaultRefereeId: true },
      });
      if (grp?.defaultRefereeId) {
        await prisma.tournamentMatchReferee.createMany({
          data: [
            {
              matchId: created.id,
              refereeId: grp.defaultRefereeId,
              role: 'MAIN',
            },
          ],
          skipDuplicates: true,
        });
      }
    }

    // автопубликация
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

    res.status(201).json(normalizeMatch(created));
  } catch (e) {
    console.error('POST /tournaments/:id/matches', e);
    res.status(400).json({ error: e.message || 'Ошибка создания матча' });
  }
});

// patch (с обработкой FINISHED)
router.patch('/tournament-matches/:matchId(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.matchId);
    const old = await prisma.tournamentMatch.findUnique({
      where: { id },
      select: {
        id: true,
        tournamentId: true,
        groupId: true,
        team1TTId: true,
        team2TTId: true,
        status: true,
      },
    });
    if (!old) return res.status(404).json({ error: 'Матч не найден' });

    const patch = {};
    const keys = [
      'groupId',
      'team1TTId',
      'team2TTId',
      'date',
      'status',
      'stadiumId',
      'team1Formation',
      'team2Formation',
      'team1Coach',
      'team2Coach',
      'team1Score',
      'team2Score',
    ];
    for (const k of keys) {
      if (!(k in req.body)) continue;
      if (k.endsWith('Id') || ['team1Score', 'team2Score'].includes(k))
        patch[k] = toInt(req.body[k], null);
      else if (k === 'date') patch[k] = toDate(req.body[k], undefined);
      else patch[k] = req.body[k] ?? null;
    }

    // поддержка stadium как объекта
    if ('stadium' in req.body && !('stadiumId' in req.body)) {
      patch.stadiumId = toInt(req.body.stadium?.id, null);
    }

    // валидации TT, group
    if (patch.team1TTId != null || patch.team2TTId != null) {
      const team1TTId = patch.team1TTId ?? old.team1TTId;
      const team2TTId = patch.team2TTId ?? old.team2TTId;
      if (team1TTId === team2TTId)
        return res.status(400).json({ error: 'Команды в матче совпадают' });

      const [tt1, tt2] = await Promise.all([
        prisma.tournamentTeam.findUnique({
          where: { id: team1TTId },
          select: { tournamentId: true },
        }),
        prisma.tournamentTeam.findUnique({
          where: { id: team2TTId },
          select: { tournamentId: true },
        }),
      ]);
      if (!tt1 || !tt2) return res.status(400).json({ error: 'TT не найдены' });
      if (
        tt1.tournamentId !== old.tournamentId ||
        tt2.tournamentId !== old.tournamentId
      )
        return res.status(400).json({ error: 'TT не из турнира матча' });
    }
    if (patch.groupId != null) {
      const g = await prisma.tournamentGroup.findUnique({
        where: { id: patch.groupId },
        select: { tournamentId: true },
      });
      if (!g || g.tournamentId !== old.tournamentId)
        return res.status(400).json({ error: 'Группа не из турнира матча' });
    }

    const upd = await prisma.tournamentMatch.update({
      where: { id },
      data: patch,
      include: buildTMatchInclude('team1,team2,stadium,referees,group'),
    });

    if (patch.groupId !== undefined) {
      const newGroupId = upd.groupId;
      if (newGroupId) {
        const g = await prisma.tournamentGroup.findUnique({
          where: { id: newGroupId },
          select: { defaultRefereeId: true },
        });
        if (g?.defaultRefereeId) {
          const hasMain = await prisma.tournamentMatchReferee.findFirst({
            where: { matchId: id, role: 'MAIN' },
            select: { id: true },
          });
          if (!hasMain) {
            await prisma.tournamentMatchReferee.create({
              data: {
                matchId: id,
                refereeId: g.defaultRefereeId,
                role: 'MAIN',
              },
            });
            await prisma.tournamentMatchEvent.updateMany({
              where: { matchId: id, issuedByRefereeId: null },
              data: { issuedByRefereeId: g.defaultRefereeId },
            });
          }
        }
      }
    }

    // если матч стал FINISHED или обновили счёт у FINISHED — пересчитать
    if (!isFinished(old.status) && isFinished(upd.status)) {
      await recomputeTMatchScore(id); // на случай если правили события/счёт вручную
      await serveSuspensionsAfterMatch(id);
      await recalcTotalsIfFinished(id);
    }

    // НОВОЕ: если матч был FINISHED и стал не FINISHED — убрать из тоталов
    if (isFinished(old.status) && !isFinished(upd.status)) {
      const t1Id = upd.team1TT?.team?.id;
      const t2Id = upd.team2TT?.team?.id;
      if (t1Id) await recalcTeamTotals(t1Id);
      if (t2Id) await recalcTeamTotals(t2Id);
    }

    const io = getIO();
    io.to(`tmatch:${id}`).emit('tmatch:update', upd);
    io.to(`tournament:${upd.tournamentId}`).emit('tmatch:update', upd);

    res.json(normalizeMatch(upd));
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

    // возьмём статус и команды ДО удаления
    const before = await prisma.tournamentMatch.findUnique({
      where: { id },
      select: {
        tournamentId: true,
        status: true,
        team1TT: { select: { team: { select: { id: true } } } },
        team2TT: { select: { team: { select: { id: true } } } },
      },
    });

    await prisma.tournamentMatch.delete({ where: { id } });

    // если удалили завершённый матч — пересчитаем тоталы команд
    if (before && isFinished(before.status)) {
      await Promise.all([
        recalcTeamTotals(before.team1TT.team.id),
        recalcTeamTotals(before.team2TT.team.id),
      ]);
    }

    const io = getIO();
    io.to(`tmatch:${id}`).emit('tmatch:deleted', { matchId: id });
    if (before) {
      io.to(`tournament:${before.tournamentId}`).emit('tmatch:deleted', {
        matchId: id,
      });
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
    await recalcTotalsIfFinished(id); // <— важный вызов

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

    await recalcTotalsIfFinished(id); // <— если матч уже FINISHED

    const io = getIO();
    io.to(`tmatch:${id}`).emit('tmatch:score', {
      matchId: id,
      team1Score,
      team2Score,
    });
    io.to(`tournament:${m.tournamentId}`).emit('tmatch:update', m);
    res.json(m);
  } catch (e) {
    console.error('POST /tournament-matches/:id/score', e);
    res.status(400).json({ error: 'Не удалось обновить счёт' });
  }
  try {
    const t1 = await prisma.tournamentMatch.findUnique({
      where: { id },
      select: {
        team1TT: { select: { teamId: true } },
        team2TT: { select: { teamId: true } },
        status: true,
      },
    });
    if (t1?.team1TT?.teamId) await recalcTeamTotals(t1.team1TT.teamId);
    if (t1?.team2TT?.teamId) await recalcTeamTotals(t1.team2TT.teamId);
  } catch {}
  // если матч уже завершён — ещё раз подтвердим
  await recalcTotalsIfFinished(id);
});

router.post('/maintenance/recalc/team-totals', async (req, res) => {
  try {
    const teamIds = await prisma.team
      .findMany({ select: { id: true } })
      .then((x) => x.map((t) => t.id));
    for (const id of teamIds) await recalcTeamTotals(id);
    res.json({ success: true, teams: teamIds.length });
  } catch (e) {
    console.error('recalc all teams', e);
    res.status(500).json({ error: 'Не удалось пересчитать' });
  }
});

// пересчитать конкретной команде
router.post('/teams/:teamId(\\d+)/recalc', async (req, res) => {
  try {
    const teamId = Number(req.params.teamId);
    await recalcTeamTotals(teamId);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Не удалось пересчитать команду' });
  }
});

/* ---- referees ---- */
router.get('/tournament-matches/:matchId(\\d+)/referees', async (req, res) => {
  try {
    const id = Number(req.params.matchId);
    const rows = await prisma.tournamentMatchReferee.findMany({
      where: { matchId: id },
      include: { referee: true },
      orderBy: { refereeId: 'asc' },
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
          skipDuplicates: true,
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

      // валидация: игроки должны принадлежать одной из двух команд этого матча
      const m = await prisma.tournamentMatch.findUnique({
        where: { id },
        select: { tournamentId: true, team1TTId: true, team2TTId: true },
      });
      if (!m) return res.status(404).json({ error: 'Матч не найден' });

      const rosterItems = await prisma.tournamentTeamPlayer.findMany({
        where: {
          id: { in: items.map((p) => Number(p.tournamentTeamPlayerId)) },
        },
        select: { id: true, tournamentTeamId: true },
      });
      const allowedTT = new Set([m.team1TTId, m.team2TTId]);
      for (const ri of rosterItems) {
        if (!allowedTT.has(ri.tournamentTeamId)) {
          return res.status(400).json({ error: 'Участник не из команд матча' });
        }
      }

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
        orderBy: [{ role: 'asc' }, { order: 'asc' }],
      });

      const io = getIO();
      io.to(`tmatch:${id}`).emit('tparticipants:updated', rows);
      io.to(`tournament:${m.tournamentId}`).emit('tparticipants:updated', {
        matchId: id,
      });
      await emitLineupFromDB(prisma, id);
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

    const m = await prisma.tournamentMatch.findUnique({
      where: { id: matchId },
      select: { tournamentId: true, team1TTId: true, team2TTId: true },
    });
    if (!m) return res.status(404).json({ error: 'Матч не найден' });

    // валидация команды события
    if (![m.team1TTId, m.team2TTId].includes(Number(tournamentTeamId))) {
      return res.status(400).json({ error: 'Событие не этой команды матча' });
    }

    // валидации заявок (если переданы)
    if (toInt(rosterItemId, null)) {
      const it = await prisma.tournamentTeamPlayer.findUnique({
        where: { id: Number(rosterItemId) },
        select: { tournamentTeamId: true },
      });
      if (!it || it.tournamentTeamId !== Number(tournamentTeamId)) {
        return res.status(400).json({ error: 'Игрок не из этой заявки' });
      }
    }
    if (toInt(assistRosterItemId, null)) {
      const it = await prisma.tournamentTeamPlayer.findUnique({
        where: { id: Number(assistRosterItemId) },
        select: { tournamentTeamId: true },
      });
      if (!it || it.tournamentTeamId !== Number(tournamentTeamId)) {
        return res
          .status(400)
          .json({ error: 'Ассистент не из этой заявки/команды' });
      }
    }

    // auto-judge: если не передали — возьмём судью группы/матча
    const providedRefId = toInt(issuedByRefereeId, undefined);
    const finalRefId =
      providedRefId !== undefined
        ? providedRefId
        : await getDefaultRefereeIdForMatch(matchId);

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
        issuedByRefereeId: toInt(finalRefId, null),
      },
      include: {
        tournamentTeam: { include: { team: true } },
        rosterItem: { include: { player: true } },
        assistRosterItem: { include: { player: true } },
      },
    });

    // апдейт статистики
    if (created.rosterItemId)
      await incPlayerStatByRoster(created.rosterItemId, created.type);
    if (created.type === 'ASSIST' && created.rosterItemId)
      await incPlayerStatByRoster(created.rosterItemId, 'ASSIST');
    if (created.assistRosterItemId && created.type === 'GOAL')
      await incPlayerStatByRoster(created.assistRosterItemId, 'ASSIST');

    if (isGoalType(created.type)) await recomputeTMatchScore(matchId);
    await maybeCreateSuspensionAfterEvent(created);

    // если матч FINISHED — синхронизируем тоталы
    await recalcTotalsIfFinished(matchId);

    const m2 = await prisma.tournamentMatch.findUnique({
      where: { id: matchId },
      select: {
        id: true,
        tournamentId: true,
        team1Score: true,
        team2Score: true,
      },
    });
    const io = getIO();
    io.to(`tmatch:${matchId}`).emit('tevent:created', created);
    if (m2) {
      io.to(`tmatch:${matchId}`).emit('tmatch:score', {
        matchId,
        team1Score: m2.team1Score,
        team2Score: m2.team2Score,
      });
      io.to(`tournament:${m2.tournamentId}`).emit('tmatch:update', {
        id: matchId,
        team1Score: m2.team1Score,
        team2Score: m2.team2Score,
      });
    }

    res.status(201).json(created);
  } catch (e) {
    console.error('POST /tournament-matches/:id/events', e);
    res.status(400).json({ error: 'Ошибка создания события' });
  }
});

// рядом с participants/events
router.get('/tournament-matches/:matchId(\\d+)/lineup', async (req, res) => {
  try {
    const id = Number(req.params.matchId);
    const m = await prisma.tournamentMatch.findUnique({
      where: { id },
      select: { id: true, team1TTId: true, team2TTId: true },
    });
    if (!m) return res.status(404).json({ error: 'Матч не найден' });

    const rows = await prisma.tournamentPlayerMatch.findMany({
      where: { matchId: id },
      include: {
        tournamentTeamPlayer: {
          include: { player: true, tournamentTeam: true },
        },
      },
      orderBy: [{ role: 'asc' }, { order: 'asc' }, { id: 'asc' }],
    });

    const toList = (ttId) =>
      rows
        .filter((r) => r.tournamentTeamPlayer.tournamentTeamId === ttId)
        .map((r) => ({
          rosterItemId: r.tournamentTeamPlayerId,
          playerId: r.tournamentTeamPlayer.playerId,
          name: r.tournamentTeamPlayer.player?.name || '',
          number: r.tournamentTeamPlayer.number,
          position: r.position,
          role: r.role || 'STARTER',
          isCaptain: !!r.isCaptain,
          order: r.order ?? 0,
        }));

    res.json({
      matchId: id,
      team1: { ttId: m.team1TTId, list: toList(m.team1TTId) },
      team2: { ttId: m.team2TTId, list: toList(m.team2TTId) },
    });
  } catch (e) {
    console.error('GET /tournament-matches/:id/lineup', e);
    res.status(500).json({ error: 'Ошибка получения состава' });
  }
});

router.put('/tournament-events/:eventId(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.eventId);
    const old = await prisma.tournamentMatchEvent.findUnique({ where: { id } });
    if (!old) return res.status(404).json({ error: 'Событие не найдено' });

    // - снимаем прошлую статистику
    if (old.rosterItemId)
      await decPlayerStatByRoster(old.rosterItemId, old.type);
    if (old.type === 'ASSIST' && old.rosterItemId)
      await decPlayerStatByRoster(old.rosterItemId, 'ASSIST');
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

    // валидации
    const m = await prisma.tournamentMatch.findUnique({
      where: { id: old.matchId },
      select: { team1TTId: true, team2TTId: true },
    });
    if (tournamentTeamId != null) {
      if (![m.team1TTId, m.team2TTId].includes(Number(tournamentTeamId))) {
        return res.status(400).json({ error: 'Событие не этой команды матча' });
      }
    }
    const ttForCheck = Number(tournamentTeamId ?? old.tournamentTeamId);

    if (toInt(rosterItemId, undefined) !== undefined) {
      if (toInt(rosterItemId, null)) {
        const it = await prisma.tournamentTeamPlayer.findUnique({
          where: { id: Number(rosterItemId) },
          select: { tournamentTeamId: true },
        });
        if (!it || it.tournamentTeamId !== ttForCheck)
          return res.status(400).json({ error: 'Игрок не из этой заявки' });
      }
    }
    if (toInt(assistRosterItemId, undefined) !== undefined) {
      if (toInt(assistRosterItemId, null)) {
        const it = await prisma.tournamentTeamPlayer.findUnique({
          where: { id: Number(assistRosterItemId) },
          select: { tournamentTeamId: true },
        });
        if (!it || it.tournamentTeamId !== ttForCheck)
          return res.status(400).json({ error: 'Ассистент не из этой заявки' });
      }
    }

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

    // + накатываем новую статистику
    if (updated.rosterItemId)
      await incPlayerStatByRoster(updated.rosterItemId, updated.type);
    if (updated.type === 'ASSIST' && updated.rosterItemId)
      await incPlayerStatByRoster(updated.rosterItemId, 'ASSIST');
    if (updated.assistRosterItemId && updated.type === 'GOAL')
      await incPlayerStatByRoster(updated.assistRosterItemId, 'ASSIST');

    if (isGoalType(updated.type) || isGoalType(old.type))
      await recomputeTMatchScore(updated.matchId);

    // если матч FINISHED — синхронизируем тоталы
    await recalcTotalsIfFinished(updated.matchId);

    const m2 = await prisma.tournamentMatch.findUnique({
      where: { id: updated.matchId },
      select: {
        id: true,
        tournamentId: true,
        team1Score: true,
        team2Score: true,
      },
    });
    const io = getIO();
    io.to(`tmatch:${updated.matchId}`).emit('tevent:updated', updated);
    if (m2) {
      io.to(`tmatch:${m2.id}`).emit('tmatch:score', {
        matchId: m2.id,
        team1Score: m2.team1Score,
        team2Score: m2.team2Score,
      });
      io.to(`tournament:${m2.tournamentId}`).emit('tmatch:update', {
        id: m2.id,
        team1Score: m2.team1Score,
        team2Score: m2.team2Score,
      });
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
    if (old.type === 'ASSIST' && old.rosterItemId)
      await decPlayerStatByRoster(old.rosterItemId, 'ASSIST');
    if (old.assistRosterItemId && old.type === 'GOAL')
      await decPlayerStatByRoster(old.assistRosterItemId, 'ASSIST');

    if (isGoalType(old.type)) await recomputeTMatchScore(old.matchId);

    // если матч FINISHED — синхронизируем тоталы
    await recalcTotalsIfFinished(old.matchId);

    const m = await prisma.tournamentMatch.findUnique({
      where: { id: old.matchId },
      select: {
        id: true,
        tournamentId: true,
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

/* ===== COMPAT: update group ===== */
router.patch('/tournament-groups/:groupId(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.groupId);
    const { name, type, defaultRefereeId } = req.body || {};
    const patch = {};
    if (name !== undefined) patch.name = name;
    if (type !== undefined) patch.type = type;
    if (defaultRefereeId !== undefined) {
      patch.defaultRefereeId = Number.isFinite(Number(defaultRefereeId))
        ? Number(defaultRefereeId)
        : null;
    }

    const g = await prisma.tournamentGroup.update({
      where: { id },
      data: patch,
      include: {
        defaultReferee: true,
        teams: { include: { tournamentTeam: { include: { team: true } } } },
      },
    });

    getIO().to(`tournament:${g.tournamentId}`).emit('tgroup:updated', g);
    res.json(g);
  } catch (e) {
    console.error('PATCH /tournament-groups/:groupId', e);
    res.status(400).json({ error: 'Не удалось обновить группу' });
  }
});
router.put('/tournament-groups/:groupId(\\d+)', (req, res) => {
  req.method = 'PATCH';
  router.handle(req, res);
});

/* ===== assign referee (compat) ===== */
router.post(
  '/tournament-groups/:groupId(\\d+)/referee/:refId(\\d+)',
  async (req, res) => {
    try {
      const groupId = Number(req.params.groupId);
      const refId = Number(req.params.refId);

      const g = await prisma.tournamentGroup.update({
        where: { id: groupId },
        data: { defaultRefereeId: refId },
        select: { id: true, tournamentId: true, defaultRefereeId: true },
      });

      getIO().to(`tournament:${g.tournamentId}`).emit('tgroup:updated', g);
      res.json(g);
    } catch (e) {
      console.error('POST /tournament-groups/:groupId/referee/:refId', e);
      res.status(400).json({ error: 'Не удалось назначить судью группе' });
    }
  }
);

/* ===== clear referee (compat) ===== */
router.delete('/tournament-groups/:groupId(\\d+)/referee', async (req, res) => {
  try {
    const groupId = Number(req.params.groupId);
    const g = await prisma.tournamentGroup.update({
      where: { id: groupId },
      data: { defaultRefereeId: null },
      select: { id: true, tournamentId: true, defaultRefereeId: true },
    });

    getIO().to(`tournament:${g.tournamentId}`).emit('tgroup:updated', g);
    res.json(g);
  } catch (e) {
    console.error('DELETE /tournament-groups/:groupId/referee', e);
    res.status(400).json({ error: 'Не удалось снять судью с группы' });
  }
});

// ↓ рядом с другими GROUPS-роутами
router.get('/tournament-groups/:groupId(\\d+)/matches', async (req, res) => {
  try {
    const groupId = Number(req.params.groupId);

    const rows = await prisma.tournamentMatch.findMany({
      where: { groupId },
      orderBy: [{ date: 'asc' }, { id: 'asc' }],
      include: buildTMatchInclude('team1,team2,stadium,referees,group'),
    });

    const normalized = rows.map((m) => {
      const nm = normalizeMatch(m);
      return {
        ...nm,
        team1: nm.team1TT?.team || null,
        team2: nm.team2TT?.team || null,
      };
    });

    res.json(normalized);
  } catch (e) {
    console.error('GET /tournament-groups/:groupId/matches', e);
    res.status(500).json({ error: 'Ошибка загрузки матчей группы' });
  }
});

// ===== standings (group table)
router.get('/tournament-groups/:groupId(\\d+)/standings', async (req, res) => {
  try {
    const groupId = Number(req.params.groupId);
    // по умолчанию считаем только завершённые
    const statuses = (req.query.statuses || 'FINISHED')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

    const g = await prisma.tournamentGroup.findUnique({
      where: { id: groupId },
      include: {
        tournament: true,
        teams: { include: { tournamentTeam: { include: { team: true } } } },
      },
    });
    if (!g) return res.status(404).json({ error: 'Группа не найдена' });

    // подготовим строки таблицы под все команды группы
    const rowsMap = new Map();
    for (const gt of g.teams) {
      const tt = gt.tournamentTeam;
      rowsMap.set(gt.tournamentTeamId, {
        tournamentTeamId: gt.tournamentTeamId,
        teamId: tt.team.id,
        teamTitle: tt.team.title,
        logo: (tt.team.logo?.[0]?.src || tt.team.images?.[0]) ?? null,
        seed: tt.seed ?? null,
        played: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        goalsFor: 0,
        goalsAgainst: 0,
        goalDiff: 0,
        points: 0,
        yellow: 0,
        red: 0,
      });
    }

    // берём матчи группы (по умолчанию только FINISHED)
    const matches = await prisma.tournamentMatch.findMany({
      where: { groupId, status: { in: statuses } },
      select: {
        status: true,
        team1TTId: true,
        team2TTId: true,
        team1Score: true,
        team2Score: true,
      },
      orderBy: [{ date: 'asc' }, { id: 'asc' }],
    });

    for (const m of matches) {
      const r1 = rowsMap.get(m.team1TTId);
      const r2 = rowsMap.get(m.team2TTId);
      if (!r1 || !r2) continue;

      if (m.status !== 'FINISHED') continue;

      const s1 = Number(m.team1Score ?? 0);
      const s2 = Number(m.team2Score ?? 0);

      r1.played++;
      r2.played++;
      r1.goalsFor += s1;
      r1.goalsAgainst += s2;
      r2.goalsFor += s2;
      r2.goalsAgainst += s1;

      if (s1 > s2) {
        r1.wins++;
        r2.losses++;
        r1.points += 3;
      } else if (s1 < s2) {
        r2.wins++;
        r1.losses++;
        r2.points += 3;
      } else {
        r1.draws++;
        r2.draws++;
        r1.points += 1;
        r2.points += 1;
      }
    }

    // дифференциал
    rowsMap.forEach((r) => {
      r.goalDiff = r.goalsFor - r.goalsAgainst;
    });

    // карточки по матчам этой группы
    const cards = await prisma.tournamentMatchEvent.groupBy({
      by: ['tournamentTeamId', 'type'],
      where: {
        match: { groupId },
        type: { in: ['YELLOW_CARD', 'RED_CARD'] },
      },
      _count: { _all: true },
    });
    for (const c of cards) {
      const row = rowsMap.get(c.tournamentTeamId);
      if (!row) continue;
      if (c.type === 'YELLOW_CARD') row.yellow += c._count._all;
      if (c.type === 'RED_CARD') row.red += c._count._all;
    }

    // сортировка
    const table = Array.from(rowsMap.values()).sort(
      (a, b) =>
        b.points - a.points ||
        b.goalDiff - a.goalDiff ||
        b.goalsFor - a.goalsFor ||
        (a.seed ?? 1e9) - (b.seed ?? 1e9) ||
        String(a.teamTitle).localeCompare(String(b.teamTitle), 'ru')
    );
    table.forEach((r, i) => (r.place = i + 1));

    res.json({
      groupId,
      tournamentId: g.tournamentId,
      rules: { pointsPerWin: 3, pointsPerDraw: 1, pointsPerLoss: 0 },
      table,
    });
  } catch (e) {
    console.error('GET /tournament-groups/:groupId/standings', e);
    res.status(500).json({ error: 'Ошибка расчёта таблицы группы' });
  }
});

export default router;
