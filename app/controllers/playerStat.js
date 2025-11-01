// app/controllers/playerStat.js
import { Router } from 'express';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

/* ----------------- utils ----------------- */
const safeJSON = (v, fb) => {
  try {
    return v ? JSON.parse(String(v)) : fb;
  } catch {
    return fb;
  }
};
const toInt = (v, d = undefined) => (v === '' || v == null ? d : Number(v));
const toInt0 = (v) => (v === '' || v == null ? 0 : Number(v) || 0);

const setRange = (res, name, start, count, total) => {
  res.setHeader(
    'Content-Range',
    `${name} ${start}-${start + count - 1}/${total}`
  );
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range');
};

// Принимаем любые синонимы для «сыгранных матчей»
const pickMatchesPlayed = (b) =>
  toInt0(
    b?.matchesPlayed ??
      b?.matches_played ??
      b?.matches ??
      b?.games_played ??
      b?.games
  );

const normalizePayload = (body = {}) => ({
  playerId: Number(body.playerId),
  goals: toInt0(body.goals),
  assists: toInt0(body.assists),
  yellow_cards: toInt0(body.yellow_cards),
  red_cards: toInt0(body.red_cards),
  matchesPlayed: pickMatchesPlayed(body),
});

/* =========================================
   LIST  GET /player-stats
   filter: id[], playerId, teamId, leagueId, q, position, number,
           minGoals, minAssists, minMatches
   sort: ["id"|"goals"|"assists"|"matchesPlayed"|"player.name","ASC"|"DESC"]
   ========================================= */
router.get('/', async (req, res) => {
  try {
    const range = safeJSON(req.query.range, [0, 9999]);
    const sort = safeJSON(req.query.sort, ['id', 'ASC']);
    const filter = safeJSON(req.query.filter, {});

    const [start, end] = range;
    const take = Math.max(0, end - start + 1);

    const sortField = sort[0];
    const sortOrder = String(sort[1]).toLowerCase() === 'desc' ? 'desc' : 'asc';
    const orderBy =
      sortField === 'player.name'
        ? { player: { name: sortOrder } }
        : { [sortField]: sortOrder };

    const AND = [];

    if (Array.isArray(filter.id) && filter.id.length) {
      AND.push({ id: { in: filter.id.map(Number).filter(Number.isFinite) } });
    }
    if (filter.playerId != null && Number.isFinite(Number(filter.playerId))) {
      AND.push({ playerId: Number(filter.playerId) });
    }
    if (filter.teamId != null && Number.isFinite(Number(filter.teamId))) {
      AND.push({ player: { teamId: Number(filter.teamId) } });
    }
    if (filter.leagueId != null && Number.isFinite(Number(filter.leagueId))) {
      AND.push({
        OR: [
          {
            player: {
              LeagueTeamPlayer: {
                some: { leagueTeam: { leagueId: Number(filter.leagueId) } },
              },
            },
          },
          {
            player: {
              playerMatches: {
                some: { match: { leagueId: Number(filter.leagueId) } },
              },
            },
          },
        ],
      });
    }
    if (typeof filter.q === 'string' && filter.q.trim()) {
      AND.push({
        player: { name: { contains: filter.q.trim(), mode: 'insensitive' } },
      });
    }
    if (typeof filter.position === 'string' && filter.position.trim()) {
      AND.push({
        player: {
          position: { contains: filter.position.trim(), mode: 'insensitive' },
        },
      });
    }
    if (filter.number != null && Number.isFinite(Number(filter.number))) {
      AND.push({ player: { number: Number(filter.number) } });
    }
    if (filter.minGoals != null && Number.isFinite(Number(filter.minGoals))) {
      AND.push({ goals: { gte: Number(filter.minGoals) } });
    }
    if (
      filter.minAssists != null &&
      Number.isFinite(Number(filter.minAssists))
    ) {
      AND.push({ assists: { gte: Number(filter.minAssists) } });
    }
    if (
      filter.minMatches != null &&
      Number.isFinite(Number(filter.minMatches))
    ) {
      AND.push({ matchesPlayed: { gte: Number(filter.minMatches) } });
    }

    const where = AND.length ? { AND } : undefined;

    const [rows, total] = await Promise.all([
      prisma.playerStat.findMany({
        skip: start,
        take,
        where,
        orderBy,
        include: {
          player: {
            select: {
              id: true,
              name: true,
              number: true,
              position: true,
              team: { select: { id: true, title: true } },
            },
          },
        },
      }),
      prisma.playerStat.count({ where }),
    ]);

    setRange(res, 'playerStats', start, rows.length, total);
    res.json(rows);
  } catch (err) {
    console.error('Ошибка GET /player-stats:', err);
    res.status(500).json({ error: 'Ошибка загрузки статистики' });
  }
});

/* ================ ITEM ================ */
router.get('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const stat = await prisma.playerStat.findUnique({
      where: { id },
      include: { player: { include: { team: true } } },
    });
    if (!stat) return res.status(404).json({ message: 'Not found' });
    res.json(stat);
  } catch (err) {
    console.error('Ошибка GET /player-stats/:id:', err);
    res.status(500).json({ error: 'Ошибка загрузки статистики' });
  }
});

/* ================ CREATE/UPSERT по playerId ================ */
router.post('/', async (req, res) => {
  try {
    const data = normalizePayload(req.body);
    if (!data.playerId) {
      return res.status(400).json({ error: 'playerId обязателен' });
    }

    const result = await prisma.playerStat.upsert({
      where: { playerId: data.playerId },
      create: data,
      update: {
        goals: data.goals,
        assists: data.assists,
        yellow_cards: data.yellow_cards,
        red_cards: data.red_cards,
        matchesPlayed: data.matchesPlayed,
      },
    });
    res.status(201).json(result);
  } catch (err) {
    console.error('Ошибка POST /player-stats:', err);
    res.status(500).json({ error: 'Ошибка сохранения статистики' });
  }
});

/* ================ PATCH (частично) ================ */
router.patch('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const patch = {};
    ['goals', 'assists', 'yellow_cards', 'red_cards', 'matchesPlayed'].forEach(
      (k) => {
        if (req.body[k] !== undefined) patch[k] = toInt0(req.body[k]);
      }
    );
    const updated = await prisma.playerStat.update({
      where: { id },
      data: patch,
    });
    res.json(updated);
  } catch (err) {
    console.error('Ошибка PATCH /player-stats/:id:', err);
    res.status(500).json({ error: 'Ошибка обновления статистики' });
  }
});

/* ================ PUT (полностью) ================ */
router.put('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const data = normalizePayload(req.body);
    // playerId при апдейте не меняем
    delete data.playerId;
    const updated = await prisma.playerStat.update({ where: { id }, data });
    res.json(updated);
  } catch (err) {
    console.error('Ошибка PUT /player-stats/:id:', err);
    res.status(500).json({ error: 'Ошибка обновления статистики' });
  }
});

/* ================ DELETE ================ */
router.delete('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    await prisma.playerStat.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    console.error('Ошибка DELETE /player-stats/:id:', err);
    res.status(500).json({ error: 'Ошибка удаления статистики' });
  }
});

/* =========================================================
   Пересчёт статистики из событий и участий
   источники:
     - MatchEvent: type ∈ {GOAL, ASSIST, YELLOW_CARD, RED_CARD, PENALTY_SCORED}
     - PlayerMatch / TournamentPlayerMatch: distinct matchId => matchesPlayed
   фильтры: playerId?, teamId?, leagueId?, tournamentId?, onlyFinished?(true|false)
   ========================================================= */
async function computeStatsForPlayer(
  playerId,
  { leagueId, tournamentId, onlyFinished = false } = {}
) {
  // События по ЛИГОВЫМ матчам (если leagueId задан, фильтруем по нему)
  const whereEvent = {
    OR: [{ playerId }, { assistPlayerId: playerId }],
    ...(leagueId != null ? { match: { leagueId } } : {}),
  };

  const events = await prisma.matchEvent.groupBy({
    by: ['type'],
    where: whereEvent,
    _count: { _all: true },
  });

  const countBy = (t) => events.find((e) => e.type === t)?._count._all || 0;
  const goals = countBy('GOAL') + countBy('PENALTY_SCORED');
  const assists = countBy('ASSIST');
  const yellow = countBy('YELLOW_CARD');
  const red = countBy('RED_CARD');

  const statusFilter = onlyFinished ? { status: 'FINISHED' } : {};

  // 1) ЛИГИ: участие из заявки (PlayerMatch)
  const leaguePM = await prisma.playerMatch.findMany({
    where: {
      playerId,
      match: {
        ...(leagueId != null ? { leagueId } : {}),
        ...statusFilter,
      },
    },
    select: { matchId: true },
    distinct: ['matchId'],
  });

  // 2) ТУРНИРЫ: участие из заявки (TournamentPlayerMatch -> tournamentTeamPlayer.playerId)
  const tourPM = await prisma.tournamentPlayerMatch.findMany({
    where: {
      tournamentTeamPlayer: { playerId },
      match: {
        ...(tournamentId != null ? { tournamentId } : {}),
        ...statusFilter,
      },
    },
    select: { matchId: true },
    distinct: ['matchId'],
  });

  const matchesPlayed = new Set([
    ...leaguePM.map((r) => `L-${r.matchId}`),
    ...tourPM.map((r) => `T-${r.matchId}`),
  ]).size;

  return {
    goals,
    assists,
    yellow_cards: yellow,
    red_cards: red,
    matchesPlayed,
  };
}

router.post('/recompute', async (req, res) => {
  try {
    const playerId = toInt(req.body.playerId);
    const teamId = toInt(req.body.teamId);
    const leagueId = toInt(req.body.leagueId);
    const tournamentId = toInt(req.body.tournamentId);
    const onlyFinished =
      String(req.body.onlyFinished || 'false').toLowerCase() === 'true';
    const dry = String(req.body.dry || 'false').toLowerCase() === 'true';

    let playerIds = [];

    if (playerId != null) {
      playerIds = [playerId];
    } else if (teamId != null) {
      const rows = await prisma.player.findMany({
        where: { teamId },
        select: { id: true },
      });
      playerIds = rows.map((r) => r.id);
    } else if (leagueId != null) {
      // игроки, попадавшие в заявки лиговых матчей
      const rows = await prisma.playerMatch.findMany({
        where: { match: { leagueId } },
        distinct: ['playerId'],
        select: { playerId: true },
      });
      playerIds = rows.map((r) => r.playerId);
    } else if (tournamentId != null) {
      // игроки, попадавшие в заявки турнирных матчей
      const rows = await prisma.tournamentPlayerMatch.findMany({
        where: { match: { tournamentId } },
        select: { tournamentTeamPlayer: { select: { playerId: true } } },
      });
      playerIds = [
        ...new Set(rows.map((r) => r.tournamentTeamPlayer.playerId)),
      ];
    } else {
      // все, у кого уже есть агрегированная статистика
      const rows = await prisma.playerStat.findMany({
        select: { playerId: true },
      });
      playerIds = rows.map((r) => r.playerId);
    }

    const updates = [];
    for (const pid of playerIds) {
      const computed = await computeStatsForPlayer(pid, {
        leagueId,
        tournamentId,
        onlyFinished,
      });
      updates.push({ playerId: pid, ...computed });
    }

    if (dry) {
      return res.json({ count: updates.length, preview: updates.slice(0, 10) });
    }

    await prisma.$transaction(
      updates.map((u) =>
        prisma.playerStat.upsert({
          where: { playerId: u.playerId },
          create: { playerId: u.playerId, ...u },
          update: {
            goals: u.goals,
            assists: u.assists,
            yellow_cards: u.yellow_cards,
            red_cards: u.red_cards,
            matchesPlayed: u.matchesPlayed,
          },
        })
      )
    );

    res.json({ count: updates.length });
  } catch (err) {
    console.error('Ошибка POST /player-stats/recompute:', err);
    res.status(500).json({ error: 'Не удалось пересчитать статистику' });
  }
});

/* =========================================================
   Лидерборд: GET /player-stats/leaderboard
   query:
     leagueId?       — пересчитать «налету» по лиге
     tournamentId?   — пересчитать «налету» по турниру
     metric=goals|assists|cards
     limit=1..100 (default 20)
   cards = (yellow_cards + 2*red_cards)
   ========================================================= */
router.get('/leaderboard', async (req, res) => {
  try {
    const leagueId = toInt(req.query.leagueId);
    const tournamentId = toInt(req.query.tournamentId);
    const metric = String(req.query.metric || 'goals');
    const limit = Math.max(1, Math.min(100, toInt(req.query.limit, 20)));

    // Если задана лига/турнир — считаем налету по событиям/участиям
    if (leagueId != null || tournamentId != null) {
      const players = await prisma.player.findMany({
        select: {
          id: true,
          name: true,
          number: true,
          team: { select: { id: true, title: true } },
        },
      });
      const computed = [];
      for (const p of players) {
        const s = await computeStatsForPlayer(p.id, { leagueId, tournamentId });
        computed.push({ playerId: p.id, player: p, ...s });
      }
      const score = (r) =>
        metric === 'assists'
          ? r.assists
          : metric === 'cards'
            ? r.yellow_cards + 2 * r.red_cards
            : r.goals;
      computed.sort((a, b) => score(b) - score(a));
      return res.json(computed.slice(0, limit));
    }

    // Иначе — по агрегированной таблице
    const orderBy =
      metric === 'assists'
        ? { assists: 'desc' }
        : metric === 'cards'
          ? { yellow_cards: 'desc' } // затем вручную учтём 2*red
          : { goals: 'desc' };

    const rows = await prisma.playerStat.findMany({
      take: limit,
      orderBy,
      include: {
        player: {
          select: {
            id: true,
            name: true,
            number: true,
            team: { select: { id: true, title: true } },
          },
        },
      },
    });

    if (metric === 'cards') {
      rows.sort(
        (a, b) =>
          b.yellow_cards + 2 * b.red_cards - (a.yellow_cards + 2 * a.red_cards)
      );
      return res.json(rows.slice(0, limit));
    }

    res.json(rows);
  } catch (err) {
    console.error('GET /player-stats/leaderboard:', err);
    res.status(500).json({ error: 'Ошибка загрузки лидерборда' });
  }
});

export default router;
