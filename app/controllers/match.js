// app/controllers/match.js
import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { getIO } from '../socket.js';

const router = Router();
const prisma = new PrismaClient();

/* ---------------- utils ---------------- */
const safeJSON = (v, fb) => {
  try {
    return v ? JSON.parse(String(v)) : fb;
  } catch {
    return fb;
  }
};
const toInt = (v, d = undefined) => (v === '' || v == null ? d : Number(v));
const toDate = (v, d = undefined) => (v ? new Date(v) : d);
const bool = (v) =>
  ['true', '1', 'yes', 'on'].includes(String(v).toLowerCase());
const setRange = (res, name, start, count, total) => {
  res.setHeader(
    'Content-Range',
    `${name} ${start}-${start + count - 1}/${total}`
  );
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range');
};
const buildInclude = (p) => {
  const parts = String(p || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return {
    league: !!parts.includes('league'),
    round: !!parts.includes('round'),
    stadiumRel: !!(parts.includes('stadium') || parts.includes('stadiumrel')),
    team1: parts.includes('team1')
      ? { select: { id: true, title: true, logo: true } }
      : false,
    team2: parts.includes('team2')
      ? { select: { id: true, title: true, logo: true } }
      : false,
    matchReferees: parts.includes('referees')
      ? { include: { referee: true } }
      : false,
    events: !!parts.includes('events'),
    participants: parts.includes('participants')
      ? {
          include: {
            player: {
              select: {
                id: true,
                name: true,
                number: true,
                teamId: true,
              },
            },
          },
        }
      : false,
  };
};

/* ---------------- validations ---------------- */
async function assertTeamsInLeague(leagueId, team1Id, team2Id) {
  if (!Number.isFinite(leagueId)) throw new Error('Некорректная лига');
  if (!Number.isFinite(team1Id) || !Number.isFinite(team2Id))
    throw new Error('Некорректные команды');
  if (team1Id === team2Id) throw new Error('Команды не могут совпадать');

  const rows = await prisma.leagueTeam.findMany({
    where: { leagueId, teamId: { in: [team1Id, team2Id] } },
    select: { teamId: true },
  });
  const ok = new Set(rows.map((r) => r.teamId));
  if (!ok.has(team1Id) || !ok.has(team2Id)) {
    throw new Error('Обе команды должны быть заявлены в выбранной лиге');
  }
}

/* ---------------- score & standings ---------------- */
async function recomputeMatchScore(matchId) {
  await prisma.$transaction(async (tx) => {
    const grouped = await tx.matchEvent.groupBy({
      by: ['teamId'],
      where: { matchId, type: { in: ['GOAL', 'PENALTY_SCORED'] } },
      _count: { _all: true },
    });
    const m = await tx.match.findUnique({
      where: { id: matchId },
      select: {
        id: true,
        team1Id: true,
        team2Id: true,
        leagueId: true,
      },
    });
    if (!m) return;
    const map = new Map(grouped.map((g) => [g.teamId, g._count._all]));
    const team1Score = map.get(m.team1Id) || 0;
    const team2Score = map.get(m.team2Id) || 0;
    const updated = await tx.match.update({
      where: { id: matchId },
      data: { team1Score, team2Score },
    });
    // эмитим свежий счёт
    try {
      const io = getIO();
      io.to(`match:${matchId}`).emit('match:score', {
        matchId,
        team1Score: updated.team1Score,
        team2Score: updated.team2Score,
      });
    } catch {}
  });
}

async function recalcStandings(leagueId) {
  await prisma.$transaction(async (tx) => {
    const matches = await tx.match.findMany({
      where: { leagueId, status: 'FINISHED' },
      select: {
        team1Id: true,
        team2Id: true,
        team1Score: true,
        team2Score: true,
      },
    });
    const table = new Map();
    const ensure = (tid) => {
      if (!table.has(tid)) {
        table.set(tid, {
          played: 0,
          wins: 0,
          draws: 0,
          losses: 0,
          goals_for: 0,
          goals_against: 0,
          points: 0,
        });
      }
      return table.get(tid);
    };
    for (const m of matches) {
      const a = ensure(m.team1Id);
      const b = ensure(m.team2Id);
      a.played++;
      b.played++;
      a.goals_for += m.team1Score;
      a.goals_against += m.team2Score;
      b.goals_for += m.team2Score;
      b.goals_against += m.team1Score;
      if (m.team1Score > m.team2Score) {
        a.wins++;
        a.points += 3;
        b.losses++;
      } else if (m.team1Score < m.team2Score) {
        b.wins++;
        b.points += 3;
        a.losses++;
      } else {
        a.draws++;
        b.draws++;
        a.points++;
        b.points++;
      }
    }
    await tx.leagueStanding.deleteMany({ where: { league_id: leagueId } });
    const data = [...table.entries()].map(([team_id, row]) => ({
      league_id: leagueId,
      team_id,
      ...row,
    }));
    if (data.length) await tx.leagueStanding.createMany({ data });
  });
  // уведомим подписчиков лиги
  try {
    const io = getIO();
    io.to(`league:${leagueId}`).emit('standings:changed', { leagueId });
  } catch {}
}

/* ===================== LIST ===================== */
router.get('/', async (req, res) => {
  try {
    const range = safeJSON(req.query.range, [0, 49]);
    const sort = safeJSON(req.query.sort, ['date', 'DESC']);
    const filter = safeJSON(req.query.filter, {});

    const [start, end] = range;
    const take = Math.max(0, end - start + 1);
    const sortField = String(sort[0] || 'date');
    const sortOrder =
      String(sort[1] || 'DESC').toLowerCase() === 'desc' ? 'desc' : 'asc';
    const include = buildInclude(req.query.include);

    const AND = [];
    if (Array.isArray(filter.id) && filter.id.length) {
      AND.push({ id: { in: filter.id.map(Number).filter(Number.isFinite) } });
    }
    if (filter.leagueId != null && Number.isFinite(Number(filter.leagueId))) {
      AND.push({ leagueId: Number(filter.leagueId) });
    }
    if (filter.roundId != null && Number.isFinite(Number(filter.roundId))) {
      AND.push({ roundId: Number(filter.roundId) });
    }
    if (typeof filter.status === 'string' && filter.status.trim()) {
      AND.push({ status: filter.status.trim() });
    }
    if (Array.isArray(filter.status) && filter.status.length) {
      AND.push({ status: { in: filter.status } });
    }
    if (filter.teamIdAny != null && Number.isFinite(Number(filter.teamIdAny))) {
      const tid = Number(filter.teamIdAny);
      AND.push({ OR: [{ team1Id: tid }, { team2Id: tid }] });
    }
    if (filter.date_gte || filter.date_lte) {
      AND.push({
        date: {
          gte: filter.date_gte ? new Date(filter.date_gte) : undefined,
          lte: filter.date_lte ? new Date(filter.date_lte) : undefined,
        },
      });
    }
    const q = (req.query.q ?? filter.q ?? '').toString().trim();
    if (q) {
      AND.push({
        OR: [
          { team1: { title: { contains: q, mode: 'insensitive' } } },
          { team2: { title: { contains: q, mode: 'insensitive' } } },
        ],
      });
    }

    const where = AND.length ? { AND } : undefined;
    const orderBy =
      sortField === 'league.title'
        ? { league: { title: sortOrder } }
        : { [sortField]: sortOrder };

    const [rows, total] = await Promise.all([
      prisma.match.findMany({
        skip: start,
        take,
        where,
        orderBy,
        include,
      }),
      prisma.match.count({ where }),
    ]);

    setRange(res, 'matches', start, rows.length, total);
    res.json(rows);
  } catch (e) {
    console.error('GET /matches', e);
    res.status(500).json({ error: 'Ошибка загрузки матчей' });
  }
});

/* ITEM */
router.get('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const include = buildInclude(
      req.query.include || 'league,stadium,team1,team2,referees'
    );
    const item = await prisma.match.findUnique({ where: { id }, include });
    if (!item) return res.status(404).json({ error: 'Матч не найден' });
    res.json(item);
  } catch (e) {
    console.error('GET /matches/:id', e);
    res.status(500).json({ error: 'Ошибка получения матча' });
  }
});

/* CREATE */
router.post('/', async (req, res) => {
  try {
    const {
      leagueId,
      team1Id,
      team2Id,
      date,
      status = 'SCHEDULED',
      stadiumId,
      roundId,
      team1Score = 0,
      team2Score = 0,
      team1Formation,
      team2Formation,
      team1Coach,
      team2Coach,
      matchReferees = [],
    } = req.body;

    const lid = Number(leagueId);
    const t1 = Number(team1Id);
    const t2 = Number(team2Id);
    await assertTeamsInLeague(lid, t1, t2);

    const created = await prisma.match.create({
      data: {
        leagueId: lid,
        roundId: roundId != null ? Number(roundId) : null,
        stadiumId: stadiumId != null ? Number(stadiumId) : null,
        date: toDate(date, new Date()),
        status,
        team1Id: t1,
        team2Id: t2,
        team1Score: Number(team1Score) || 0,
        team2Score: Number(team2Score) || 0,
        homeFormation: team1Formation ?? null,
        guestFormation: team2Formation ?? null,
        homeCoach: team1Coach ?? null,
        guestCoach: team2Coach ?? null,
        matchReferees: {
          create: (matchReferees || []).map((mr) => ({
            refereeId: Number(mr.refereeId),
            role: mr.role ?? null,
          })),
        },
      },
      include: buildInclude('league,stadium,team1,team2,referees'),
    });

    // Realtime
    try {
      const io = getIO();
      io.to(`league:${created.leagueId}`).emit('match:created', created);
      io.to(`match:${created.id}`).emit('match:update', created);
    } catch {}

    res.status(201).json(created);
  } catch (e) {
    console.error('POST /matches', e);
    res.status(400).json({ error: e.message || 'Ошибка создания матча' });
  }
});

/* PATCH */
router.patch('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const m = await prisma.match.findUnique({ where: { id } });
    if (!m) return res.status(404).json({ error: 'Матч не найден' });

    const patch = {};
    if (
      req.body.leagueId !== undefined ||
      req.body.team1Id !== undefined ||
      req.body.team2Id !== undefined
    ) {
      const lid =
        req.body.leagueId != null ? Number(req.body.leagueId) : m.leagueId;
      const t1 =
        req.body.team1Id != null ? Number(req.body.team1Id) : m.team1Id;
      const t2 =
        req.body.team2Id != null ? Number(req.body.team2Id) : m.team2Id;
      await assertTeamsInLeague(lid, t1, t2);
      patch.leagueId = lid;
      patch.team1Id = t1;
      patch.team2Id = t2;
    }
    if (req.body.roundId !== undefined)
      patch.roundId = toInt(req.body.roundId, null);
    if (req.body.stadiumId !== undefined)
      patch.stadiumId = toInt(req.body.stadiumId, null);
    if (req.body.date !== undefined) patch.date = toDate(req.body.date);
    if (req.body.status !== undefined) patch.status = req.body.status;
    if (req.body.team1Score !== undefined)
      patch.team1Score = toInt(req.body.team1Score, 0);
    if (req.body.team2Score !== undefined)
      patch.team2Score = toInt(req.body.team2Score, 0);
    if (req.body.team1Formation !== undefined)
      patch.homeFormation = req.body.team1Formation ?? null;
    if (req.body.team2Formation !== undefined)
      patch.guestFormation = req.body.team2Formation ?? null;
    if (req.body.team1Coach !== undefined)
      patch.homeCoach = req.body.team1Coach ?? null;
    if (req.body.team2Coach !== undefined)
      patch.guestCoach = req.body.team2Coach ?? null;

    const updated = await prisma.match.update({ where: { id }, data: patch });

    // Realtime
    try {
      const io = getIO();
      io.to(`match:${id}`).emit('match:update', updated);
      if (patch.status === 'FINISHED') {
        await recalcStandings(updated.leagueId);
      }
    } catch {}

    res.json(updated);
  } catch (e) {
    console.error('PATCH /matches/:id', e);
    res.status(400).json({ error: e.message || 'Ошибка обновления матча' });
  }
});

/* PUT -> PATCH */
router.put('/:id(\\d+)', async (req, res) => {
  req.method = 'PATCH';
  return router.handle(req, res);
});

/* DELETE */
router.delete('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const old = await prisma.match.findUnique({
      where: { id },
      select: { id: true, leagueId: true },
    });
    await prisma.match.delete({ where: { id } });
    try {
      const io = getIO();
      io.to(`league:${old?.leagueId}`).emit('match:deleted', {
        id,
        leagueId: old?.leagueId,
      });
      io.to(`match:${id}`).emit('match:deleted', { id });
    } catch {}
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /matches/:id', e);
    res.status(500).json({ error: 'Ошибка удаления матча' });
  }
});

/* -------- статусы -------- */
router.post('/:id(\\d+)/start', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const m = await prisma.match.update({
      where: { id },
      data: { status: 'LIVE' },
    });
    try {
      const io = getIO();
      io.to(`match:${id}`).emit('match:status', {
        matchId: id,
        status: 'LIVE',
      });
      io.to(`league:${m.leagueId}`).emit('match:status', {
        matchId: id,
        status: 'LIVE',
      });
    } catch {}
    res.json(m);
  } catch (e) {
    console.error('POST /matches/:id/start', e);
    res.status(400).json({ error: 'Не удалось перевести матч в LIVE' });
  }
});

router.post('/:id(\\d+)/finish', async (req, res) => {
  try {
    const id = Number(req.params.id);
    await recomputeMatchScore(id);
    const m = await prisma.match.update({
      where: { id },
      data: { status: 'FINISHED' },
    });
    await recalcStandings(m.leagueId);
    try {
      const io = getIO();
      io.to(`match:${id}`).emit('match:status', {
        matchId: id,
        status: 'FINISHED',
      });
      io.to(`match:${id}`).emit('match:score', {
        matchId: id,
        team1Score: m.team1Score,
        team2Score: m.team2Score,
      });
    } catch {}
    res.json(m);
  } catch (e) {
    console.error('POST /matches/:id/finish', e);
    res.status(400).json({ error: 'Не удалось завершить матч' });
  }
});

router.post('/:id(\\d+)/score', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const team1Score = toInt(req.body.team1Score, 0);
    const team2Score = toInt(req.body.team2Score, 0);
    const m = await prisma.match.update({
      where: { id },
      data: { team1Score, team2Score },
    });
    try {
      const io = getIO();
      io.to(`match:${id}`).emit('match:score', {
        matchId: id,
        team1Score,
        team2Score,
      });
      if (m.status === 'FINISHED') await recalcStandings(m.leagueId);
    } catch {}
    res.json(m);
  } catch (e) {
    console.error('POST /matches/:id/score', e);
    res.status(400).json({ error: 'Не удалось обновить счёт' });
  }
});

/* -------- удобные выборки -------- */
router.get('/:id(\\d+)/events', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const rows = await prisma.matchEvent.findMany({
      where: { matchId: id },
      orderBy: [{ half: 'asc' }, { minute: 'asc' }, { id: 'asc' }],
      include: { player: true, assist_player: true, team: true },
    });
    res.json(rows);
  } catch (e) {
    console.error('GET /matches/:id/events', e);
    res.status(500).json({ error: 'Ошибка загрузки событий' });
  }
});

router.get('/:id(\\d+)/referees', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const rows = await prisma.matchReferee.findMany({
      where: { matchId: id },
      include: { referee: true },
      orderBy: { id: 'asc' },
    });
    res.json(rows);
  } catch (e) {
    console.error('GET /matches/:id/referees', e);
    res.status(500).json({ error: 'Ошибка загрузки судей' });
  }
});

router.post('/:id(\\d+)/referees', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const list = Array.isArray(req.body)
      ? req.body
      : Array.isArray(req.body?.items)
        ? req.body.items
        : [];
    const data = list.map((mr) => ({
      matchId: id,
      refereeId: Number(mr.refereeId),
      role: mr.role ?? null,
    }));
    await prisma.$transaction(async (tx) => {
      await tx.matchReferee.deleteMany({ where: { matchId: id } });
      if (data.length) await tx.matchReferee.createMany({ data });
    });
    const rows = await prisma.matchReferee.findMany({
      where: { matchId: id },
      include: { referee: true },
    });
    // уведомим о смене судей как обновление матча
    try {
      getIO().to(`match:${id}`).emit('match:referees', rows);
    } catch {}
    res.json(rows);
  } catch (e) {
    console.error('POST /matches/:id/referees', e);
    res.status(400).json({ error: 'Не удалось сохранить судей' });
  }
});

router.post('/:id(\\d+)/referees/assign', async (req, res) => {
  try {
    const matchId = Number(req.params.id);
    const refereeId = toInt(req.body.refereeId);
    const role = req.body.role ?? null;
    if (!refereeId)
      return res.status(400).json({ error: 'refereeId обязателен' });
    const row = await prisma.matchReferee.upsert({
      where: { matchId_refereeId: { matchId, refereeId } },
      update: { role },
      create: { matchId, refereeId, role },
    });
    try {
      getIO().to(`match:${matchId}`).emit('match:refereesAssigned', row);
    } catch {}
    res.json(row);
  } catch (e) {
    console.error('POST /matches/:id/referees/assign', e);
    res.status(400).json({ error: 'Не удалось назначить судью' });
  }
});

router.delete('/:id(\\d+)/referees/:refId(\\d+)', async (req, res) => {
  try {
    const matchId = Number(req.params.id);
    const refereeId = Number(req.params.refId);
    await prisma.matchReferee.delete({
      where: { matchId_refereeId: { matchId, refereeId } },
    });
    try {
      getIO()
        .to(`match:${matchId}`)
        .emit('match:refereeRemoved', { matchId, refereeId });
    } catch {}
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /matches/:id/referees/:refId', e);
    res.status(400).json({ error: 'Не удалось снять судью' });
  }
});

router.get('/:id(\\d+)/participants', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const rows = await prisma.playerMatch.findMany({
      where: { matchId: id },
      orderBy: [{ role: 'asc' }, { order: 'asc' }],
      include: { player: true },
    });
    res.json(rows);
  } catch (e) {
    console.error('GET /matches/:id/participants', e);
    res.status(500).json({ error: 'Ошибка загрузки участников' });
  }
});

router.put('/:id(\\d+)/participants', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const items = Array.isArray(req.body)
      ? req.body
      : Array.isArray(req.body?.items)
        ? req.body.items
        : [];
    await prisma.$transaction(async (tx) => {
      await tx.playerMatch.deleteMany({ where: { matchId: id } });
      if (items.length) {
        await tx.playerMatch.createMany({
          data: items.map((p) => ({
            matchId: id,
            playerId: Number(p.playerId),
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
    const rows = await prisma.playerMatch.findMany({
      where: { matchId: id },
      include: { player: true },
    });
    try {
      getIO().to(`match:${id}`).emit('match:participants', rows);
    } catch {}
    res.json(rows);
  } catch (e) {
    console.error('PUT /matches/:id/participants', e);
    res.status(400).json({ error: 'Не удалось сохранить участников' });
  }
});

/* удобные выборки */
router.get('/league/:leagueId(\\d+)/upcoming', async (req, res) => {
  try {
    const leagueId = Number(req.params.leagueId);
    const limit = Math.max(1, Math.min(100, toInt(req.query.limit, 20)));
    const rows = await prisma.match.findMany({
      where: { leagueId, date: { gte: new Date() } },
      orderBy: [{ date: 'asc' }],
      take: limit,
      include: buildInclude('team1,team2,stadium'),
    });
    res.json(rows);
  } catch (e) {
    console.error('GET /matches/league/:leagueId/upcoming', e);
    res.status(500).json({ error: 'Ошибка загрузки ближайших матчей' });
  }
});

export default router;
