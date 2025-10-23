// app/controllers/leagueStanding.js
import { Router } from 'express';
import { PrismaClient } from '@prisma/client';

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
const setRange = (res, name, start, count, total) => {
  res.setHeader(
    'Content-Range',
    `${name} ${start}-${start + count - 1}/${total}`
  );
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range');
};

/* =========================================================
   Пересчёт standings по матчам лиги (FINISHED)
   ========================================================= */
async function buildTableFromMatches(tx, leagueId) {
  const matches = await tx.match.findMany({
    where: { leagueId, status: 'FINISHED' },
    select: {
      id: true,
      team1Id: true,
      team2Id: true,
      team1Score: true,
      team2Score: true,
    },
  });

  const table = new Map();
  const ensure = (teamId) => {
    if (!table.has(teamId)) {
      table.set(teamId, {
        played: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        goals_for: 0,
        goals_against: 0,
        points: 0,
      });
    }
    return table.get(teamId);
  };

  for (const m of matches) {
    const a = ensure(m.team1Id);
    const b = ensure(m.team2Id);

    a.played += 1;
    b.played += 1;
    a.goals_for += m.team1Score;
    a.goals_against += m.team2Score;
    b.goals_for += m.team2Score;
    b.goals_against += m.team1Score;

    if (m.team1Score > m.team2Score) {
      a.wins += 1;
      a.points += 3;
      b.losses += 1;
    } else if (m.team1Score < m.team2Score) {
      b.wins += 1;
      b.points += 3;
      a.losses += 1;
    } else {
      a.draws += 1;
      b.draws += 1;
      a.points += 1;
      b.points += 1;
    }
  }

  return Array.from(table.entries()).map(([team_id, row]) => ({
    league_id: leagueId,
    team_id,
    ...row,
  }));
}

async function recalcStandings(leagueId) {
  return prisma.$transaction(async (tx) => {
    const data = await buildTableFromMatches(tx, leagueId);
    await tx.leagueStanding.deleteMany({ where: { league_id: leagueId } });
    if (data.length) await tx.leagueStanding.createMany({ data });
    return data.length;
  });
}

/* =========================================================
   LIST: GET /league-standings
   filter: id[], league_id, team_id, q (team.title), minPoints, minPlayed
   sort: ["id"|"points"|"played"|"wins"|"goals_for"|"goals_against"|"goalDiff"|"team.title","ASC"|"DESC"]
   ========================================================= */
router.get('/', async (req, res) => {
  try {
    const range = safeJSON(req.query.range, [0, 50]);
    const sort = safeJSON(req.query.sort, ['id', 'ASC']);
    const filter = safeJSON(req.query.filter, {});

    const [start, end] = range;
    const take = Math.max(0, end - start + 1);

    const sortField = String(sort[0] || 'id');
    const sortOrder =
      String(sort[1] || 'ASC').toLowerCase() === 'desc' ? 'desc' : 'asc';

    const AND = [];
    if (Array.isArray(filter.id) && filter.id.length) {
      AND.push({ id: { in: filter.id.map(Number).filter(Number.isFinite) } });
    }
    if (filter.league_id != null && Number.isFinite(Number(filter.league_id))) {
      AND.push({ league_id: Number(filter.league_id) });
    }
    if (filter.team_id != null && Number.isFinite(Number(filter.team_id))) {
      AND.push({ team_id: Number(filter.team_id) });
    }
    if (typeof filter.q === 'string' && filter.q.trim()) {
      AND.push({
        team: { title: { contains: filter.q.trim(), mode: 'insensitive' } },
      });
    }
    if (filter.minPoints != null && Number.isFinite(Number(filter.minPoints))) {
      AND.push({ points: { gte: Number(filter.minPoints) } });
    }
    if (filter.minPlayed != null && Number.isFinite(Number(filter.minPlayed))) {
      AND.push({ played: { gte: Number(filter.minPlayed) } });
    }

    const where = AND.length ? { AND } : undefined;

    const orderBy =
      sortField === 'team.title'
        ? { team: { title: sortOrder } }
        : ['goalDiff'].includes(sortField)
          ? undefined // отсортируем в памяти
          : { [sortField]: sortOrder };

    const [rows, total] = await Promise.all([
      prisma.leagueStanding.findMany({
        skip: start,
        take,
        where,
        orderBy,
        include: { league: true, team: true },
      }),
      prisma.leagueStanding.count({ where }),
    ]);

    // доп. поле goalDiff + ручная сортировка если надо
    const enhanced = rows.map((r) => ({
      ...r,
      goalDiff: r.goals_for - r.goals_against,
    }));
    if (!orderBy) {
      enhanced.sort((a, b) =>
        sortOrder === 'desc'
          ? b.goalDiff - a.goalDiff || b.points - a.points
          : a.goalDiff - b.goalDiff || a.points - b.points
      );
    }

    setRange(res, 'leagueStandings', start, enhanced.length, total);
    res.json(enhanced);
  } catch (err) {
    console.error('GET /league-standings', err);
    res.status(500).json({ error: 'Ошибка загрузки таблицы' });
  }
});

/* =========================================================
   ITEM: GET /league-standings/:id
   ========================================================= */
router.get('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const standing = await prisma.leagueStanding.findUnique({
      where: { id },
      include: { league: true, team: true },
    });
    if (!standing) return res.status(404).json({ error: 'Не найдено' });
    res.json({
      ...standing,
      goalDiff: standing.goals_for - standing.goals_against,
    });
  } catch (err) {
    console.error('GET /league-standings/:id', err);
    res.status(500).json({ error: 'Ошибка загрузки записи' });
  }
});

/* =========================================================
   TABLE (отсортированная с ранками): GET /league-standings/table/:leagueId?recalc=true
   ========================================================= */
router.get('/table/:leagueId(\\d+)', async (req, res) => {
  try {
    const leagueId = Number(req.params.leagueId);
    const recalc = String(req.query.recalc || 'false').toLowerCase() === 'true';
    if (recalc) await recalcStandings(leagueId);

    const rows = await prisma.leagueStanding.findMany({
      where: { league_id: leagueId },
      include: { team: true },
    });

    const enriched = rows
      .map((r) => ({ ...r, goalDiff: r.goals_for - r.goals_against }))
      .sort(
        (a, b) =>
          b.points - a.points ||
          b.goalDiff - a.goalDiff ||
          b.goals_for - a.goals_for ||
          b.wins - a.wins ||
          (a.team.title || '').localeCompare(b.team.title || '')
      )
      .map((r, i) => ({ ...r, rank: i + 1 }));

    res.json(enriched);
  } catch (err) {
    console.error('GET /league-standings/table/:leagueId', err);
    res.status(500).json({ error: 'Ошибка загрузки таблицы' });
  }
});

/* =========================================================
   CREATE (upsert по уникальному составному ключу)
   body: { league_id, team_id, played?, wins?, ... }
   ========================================================= */
router.post('/', async (req, res) => {
  try {
    const {
      league_id,
      team_id,
      played = 0,
      wins = 0,
      draws = 0,
      losses = 0,
      goals_for = 0,
      goals_against = 0,
      points = 0,
    } = req.body;

    if (!league_id || !team_id)
      return res.status(400).json({ error: 'league_id и team_id обязательны' });

    const created = await prisma.leagueStanding.upsert({
      where: {
        league_id_team_id: {
          league_id: Number(league_id),
          team_id: Number(team_id),
        },
      },
      update: {
        played,
        wins,
        draws,
        losses,
        goals_for,
        goals_against,
        points,
      },
      create: {
        league_id: Number(league_id),
        team_id: Number(team_id),
        played,
        wins,
        draws,
        losses,
        goals_for,
        goals_against,
        points,
      },
    });

    res.status(201).json(created);
  } catch (err) {
    console.error('POST /league-standings', err);
    res.status(500).json({ error: 'Ошибка создания/обновления записи' });
  }
});

/* =========================================================
   BULK: POST /league-standings/bulk  { standings: [...] }
   ========================================================= */
router.post('/bulk', async (req, res) => {
  try {
    const items = Array.isArray(req.body?.standings) ? req.body.standings : [];
    if (!items.length)
      return res.status(400).json({ error: 'Неверные данные' });

    await prisma.$transaction(
      items.map((s) =>
        prisma.leagueStanding.upsert({
          where: {
            league_id_team_id: {
              league_id: Number(s.league_id),
              team_id: Number(s.team_id),
            },
          },
          update: {
            played: toInt(s.played, 0),
            wins: toInt(s.wins, 0),
            draws: toInt(s.draws, 0),
            losses: toInt(s.losses, 0),
            goals_for: toInt(s.goals_for, 0),
            goals_against: toInt(s.goals_against, 0),
            points: toInt(s.points, 0),
          },
          create: {
            league_id: Number(s.league_id),
            team_id: Number(s.team_id),
            played: toInt(s.played, 0),
            wins: toInt(s.wins, 0),
            draws: toInt(s.draws, 0),
            losses: toInt(s.losses, 0),
            goals_for: toInt(s.goals_for, 0),
            goals_against: toInt(s.goals_against, 0),
            points: toInt(s.points, 0),
          },
        })
      )
    );

    res.status(201).json({ success: true });
  } catch (err) {
    console.error('POST /league-standings/bulk', err);
    res.status(500).json({ error: 'Ошибка массового добавления' });
  }
});

/* =========================================================
   RECALC: POST /league-standings/recalc/:leagueId
   ========================================================= */
router.post('/recalc/:leagueId(\\d+)', async (req, res) => {
  try {
    const leagueId = Number(req.params.leagueId);
    await recalcStandings(leagueId);
    const updated = await prisma.leagueStanding.findMany({
      where: { league_id: leagueId },
      include: { league: true, team: true },
    });
    res.json({ success: true, standings: updated });
  } catch (err) {
    console.error('POST /league-standings/recalc/:leagueId', err);
    res.status(500).json({ error: 'Ошибка пересчёта' });
  }
});

/* =========================================================
   RECALC ALL: POST /league-standings/recalc-all
   ========================================================= */
router.post('/recalc-all', async (req, res) => {
  try {
    const leagues = await prisma.league.findMany({ select: { id: true } });
    for (const l of leagues) await recalcStandings(l.id);
    res.json({ success: true, leagues: leagues.length });
  } catch (err) {
    console.error('POST /league-standings/recalc-all', err);
    res.status(500).json({ error: 'Ошибка массового пересчёта' });
  }
});

/* =========================================================
   HOOK: после завершения матча — пересчитать только его лигу
   POST /league-standings/on-match-finished/:matchId
   ========================================================= */
router.post('/on-match-finished/:matchId(\\d+)', async (req, res) => {
  try {
    const matchId = Number(req.params.matchId);
    const m = await prisma.match.findUnique({
      where: { id: matchId },
      select: { id: true, leagueId: true, status: true },
    });
    if (!m) return res.status(404).json({ error: 'Матч не найден' });
    await recalcStandings(m.leagueId);
    res.json({ success: true });
  } catch (err) {
    console.error('POST /league-standings/on-match-finished/:matchId', err);
    res.status(500).json({ error: 'Ошибка пересчёта после матча' });
  }
});

/* =========================================================
   PUT /league-standings/:id — аккуратная замена разрешённых полей
   ========================================================= */
router.put('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const allowed = [
      'league_id',
      'team_id',
      'played',
      'wins',
      'draws',
      'losses',
      'goals_for',
      'goals_against',
      'points',
    ];
    const data = {};
    for (const k of allowed) {
      if (Object.prototype.hasOwnProperty.call(req.body, k)) {
        const v = req.body[k];
        if (v === '' || v == null) continue;
        const n = Number(v);
        if (Number.isNaN(n))
          return res
            .status(400)
            .json({ error: `Поле ${k} должно быть числом` });
        data[k] = n;
      }
    }
    const updated = await prisma.leagueStanding.update({ where: { id }, data });
    res.json(updated);
  } catch (err) {
    console.error('PUT /league-standings/:id', err);
    res.status(500).json({
      error: 'Ошибка обновления записи',
      message: err.message,
      code: err.code,
      meta: err.meta,
    });
  }
});

/* =========================================================
   DELETE /league-standings/:id
   ========================================================= */
router.delete('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    await prisma.leagueStanding.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /league-standings/:id', err);
    res.status(500).json({ error: 'Ошибка удаления записи' });
  }
});

/* =========================================================
   BULK DELETE: POST /league-standings/bulk-delete { ids: [...] }
   ========================================================= */
router.post('/bulk-delete', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids.map(Number).filter(Number.isFinite)
      : [];
    if (!ids.length) return res.status(400).json({ error: 'Неверные данные' });
    const r = await prisma.leagueStanding.deleteMany({
      where: { id: { in: ids } },
    });
    res.json({ success: true, count: r.count });
  } catch (err) {
    console.error('POST /league-standings/bulk-delete', err);
    res.status(500).json({ error: 'Ошибка массового удаления' });
  }
});

export default router;
