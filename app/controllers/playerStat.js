// app/controllers/playerStat.js
import { Router } from 'express';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

/* --------------- utils --------------- */
const safeJSON = (v, fb) => {
  try {
    return v ? JSON.parse(String(v)) : fb;
  } catch {
    return fb;
  }
};
const toInt = (v, d = undefined) => (v === '' || v == null ? d : Number(v));
const setRange = (res, name, start, count, total) => {
  res.setHeader(
    'Content-Range',
    `${name} ${start}-${start + count - 1}/${total}`
  );
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range');
};

/* =========================================
   LIST  GET /player-stats
   filter supports:
     id: [1,2] | playerId | teamId | leagueId
     q (player.name contains, case-insens)
     position, number
     minGoals/minAssists/minMatches
   sort supports:
     ["id"|"goals"|"assists"|"matchesPlayed"|"player.name", "ASC"|"DESC"]
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
      // есть в матчах этой лиги?
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

/* ================ CREATE (upsert по playerId) ================ */
router.post('/', async (req, res) => {
  try {
    const {
      playerId,
      goals = 0,
      assists = 0,
      yellow_cards = 0,
      red_cards = 0,
      matchesPlayed = 0,
    } = req.body;
    if (!playerId)
      return res.status(400).json({ error: 'playerId обязателен' });

    // из-за @unique на playerId — делаем upsert
    const result = await prisma.playerStat.upsert({
      where: { playerId: Number(playerId) },
      create: {
        playerId: Number(playerId),
        goals,
        assists,
        yellow_cards,
        red_cards,
        matchesPlayed,
      },
      update: {
        goals,
        assists,
        yellow_cards,
        red_cards,
        matchesPlayed,
      },
    });
    res.status(201).json(result);
  } catch (err) {
    console.error('Ошибка POST /player-stats:', err);
    res.status(500).json({ error: 'Ошибка сохранения статистики' });
  }
});

/* ================ PATCH (частичное) ================ */
router.patch('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const patch = {};
    ['goals', 'assists', 'yellow_cards', 'red_cards', 'matchesPlayed'].forEach(
      (k) => {
        if (req.body[k] !== undefined) patch[k] = Number(req.body[k]) || 0;
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

/* ================ PUT (полная замена) ================ */
router.put('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const {
      goals = 0,
      assists = 0,
      yellow_cards = 0,
      red_cards = 0,
      matchesPlayed = 0,
    } = req.body;
    const updated = await prisma.playerStat.update({
      where: { id },
      data: {
        goals,
        assists,
        yellow_cards,
        red_cards,
        matchesPlayed,
      },
    });
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
     - MatchEvent: type IN (GOAL, ASSIST, YELLOW_CARD, RED_CARD)
     - PlayerMatch: distinct по matchId => matchesPlayed
   фильтры (body/query): playerId?, teamId?, leagueId?
   ========================================================= */
async function computeStatsForPlayer(playerId, { leagueId } = {}) {
  // goals/assists/cards
  const whereEvent = {
    OR: [{ playerId }, { assistPlayerId: playerId }],
    ...(leagueId ? { match: { leagueId } } : {}),
  };

  const events = await prisma.matchEvent.groupBy({
    by: ['type'],
    where: whereEvent,
    _count: { _all: true },
  });

  const countBy = (t) => events.find((e) => e.type === t)?._count._all || 0;
  const goals = countBy('GOAL') + countBy('PENALTY_SCORED'); // по желанию учитываем пенальти как гол
  const assists = countBy('ASSIST');
  const yellow = countBy('YELLOW_CARD');
  const red = countBy('RED_CARD');

  // matchesPlayed — участие в матче хотя бы 1 раз
  const pmWhere = { playerId, ...(leagueId ? { match: { leagueId } } : {}) };
  const distinctMatches = await prisma.playerMatch.findMany({
    where: pmWhere,
    distinct: ['matchId'],
    select: { matchId: true },
  });
  const matchesPlayed = distinctMatches.length;

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
      // Все игроки, которые появлялись в матчах лиги
      const rows = await prisma.playerMatch.findMany({
        where: { match: { leagueId } },
        distinct: ['playerId'],
        select: { playerId: true },
      });
      playerIds = rows.map((r) => r.playerId);
    } else {
      // все игроки у кого уже есть stats
      const rows = await prisma.playerStat.findMany({
        select: { playerId: true },
      });
      playerIds = rows.map((r) => r.playerId);
    }

    const updates = [];
    for (const pid of playerIds) {
      const computed = await computeStatsForPlayer(pid, { leagueId });
      updates.push({ playerId: pid, ...computed });
    }

    if (dry)
      return res.json({ count: updates.length, preview: updates.slice(0, 10) });

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
   Лидерборд: GET /player-stats/leaderboard?leagueId=&metric=goals|assists|cards&limit=20
   cards = (yellow_cards + 2*red_cards) сортируем по убыванию
   ========================================================= */
router.get('/leaderboard', async (req, res) => {
  try {
    const leagueId = toInt(req.query.leagueId);
    const metric = String(req.query.metric || 'goals');
    const limit = Math.max(1, Math.min(100, toInt(req.query.limit, 20)));

    // если задана лига — сперва делаем пересчёт (без записи) и сортируем в памяти
    if (leagueId != null) {
      const rows = await prisma.player.findMany({
        select: {
          id: true,
          name: true,
          number: true,
          team: { select: { id: true, title: true } },
        },
      });
      const computed = [];
      for (const p of rows) {
        const s = await computeStatsForPlayer(p.id, { leagueId });
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

    // иначе — по aggregated таблице
    const orderBy =
      metric === 'assists'
        ? { assists: 'desc' }
        : metric === 'cards'
          ? { yellow_cards: 'desc' } // грубо; можно добавить ORDER BY (yellow+2*red) в памяти
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
