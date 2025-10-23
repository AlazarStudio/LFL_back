// app/controllers/league.js
import { Router } from 'express';
import { PrismaClient, MatchStatus } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

/* ----------------------- utils ----------------------- */
const safeJSON = (v, fb) => {
  try {
    return v ? JSON.parse(String(v)) : fb;
  } catch {
    return fb;
  }
};
const toInt = (v) => (v === '' || v == null ? undefined : Number(v));
const toDate = (v) => (v ? new Date(v) : undefined);
const toEnum = (v, allowed, fb) => (allowed.includes(v) ? v : fb);

/* =====================================================
   LIST (для React-Admin): /api/leagues
   ===================================================== */
router.get('/', async (req, res) => {
  try {
    const range = safeJSON(req.query.range, [0, 49]);
    const sort = safeJSON(req.query.sort, ['id', 'ASC']);
    const filter = safeJSON(req.query.filter, {});

    const [start, end] = range;
    const take = Math.max(0, end - start + 1);
    const [sortField, sortOrderRaw] = sort;
    const sortOrder =
      String(sortOrderRaw).toLowerCase() === 'desc' ? 'desc' : 'asc';
    const orderBy = { [sortField]: sortOrder };

    const where = {};
    if (Array.isArray(filter.id))
      where.id = { in: filter.id.map(Number).filter(Number.isFinite) };
    if (filter.format) where.format = filter.format;
    if (filter.halves != null) where.halves = Number(filter.halves);
    if (filter.halfMinutes != null)
      where.halfMinutes = Number(filter.halfMinutes);
    if (filter.startDate_gte || filter.startDate_lte) {
      where.startDate = {
        gte: filter.startDate_gte ? new Date(filter.startDate_gte) : undefined,
        lte: filter.startDate_lte ? new Date(filter.startDate_lte) : undefined,
      };
    }
    if (typeof filter.title === 'string' && filter.title.trim())
      where.title = { contains: filter.title.trim(), mode: 'insensitive' };
    if (typeof filter.season === 'string' && filter.season.trim())
      where.season = { contains: filter.season.trim(), mode: 'insensitive' };
    if (typeof filter.city === 'string' && filter.city.trim())
      where.city = { contains: filter.city.trim(), mode: 'insensitive' };

    const [data, total] = await Promise.all([
      prisma.league.findMany({
        skip: start,
        take,
        where,
        orderBy,
        include: {
          _count: { select: { matches: true, teams: true, standings: true } },
        },
      }),
      prisma.league.count({ where }),
    ]);

    res.setHeader(
      'Content-Range',
      `leagues ${start}-${start + data.length - 1}/${total}`
    );
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range');
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка загрузки лиг' });
  }
});

/* ===================== ITEM(S) ===================== */
router.get('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const league = await prisma.league.findUnique({
      where: { id },
      include: {
        _count: { select: { matches: true, teams: true, standings: true } },
      },
    });
    if (!league) return res.status(404).json({ error: 'Лига не найдена' });
    res.json(league);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка получения лиги' });
  }
});

// Полная карточка лиги
router.get('/:id/full', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const league = await prisma.league.findUnique({ where: { id } });
    if (!league) return res.status(404).json({ error: 'Лига не найдена' });

    const [teams, rounds, matches, standings] = await Promise.all([
      prisma.leagueTeam.findMany({
        where: { leagueId: id },
        include: {
          team: { include: { _count: { select: { players: true } } } },
          roster: true,
          captainRosterItem: true,
        },
        orderBy: [{ team: { title: 'asc' } }],
      }),
      prisma.leagueRound.findMany({
        where: { leagueId: id },
        orderBy: [{ number: 'asc' }, { date: 'asc' }],
      }),
      prisma.match.findMany({
        where: { leagueId: id },
        orderBy: [{ date: 'desc' }, { id: 'desc' }],
        take: 50,
        include: {
          stadiumRel: true,
          team1: { select: { id: true, title: true } },
          team2: { select: { id: true, title: true } },
          matchReferees: { include: { referee: true } },
          _count: { select: { events: true, participants: true } },
        },
      }),
      prisma.leagueStanding.findMany({
        where: { league_id: id },
        orderBy: [
          { points: 'desc' },
          { goals_for: 'desc' },
          { goals_against: 'asc' },
        ],
        include: { team: { select: { id: true, title: true } } },
      }),
    ]);

    res.json({
      league,
      teams,
      rounds,
      matches,
      standings,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка загрузки данных лиги' });
  }
});

/* ===================== C/U/D ===================== */
router.post('/', async (req, res) => {
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
    } = req.body;
    const created = await prisma.league.create({
      data: {
        title,
        season,
        city,
        images: Array.isArray(images) ? images : [images].filter(Boolean),
        format: format || undefined,
        halfMinutes: toInt(halfMinutes),
        halves: toInt(halves),
        startDate: toDate(startDate),
      },
    });
    res.status(201).json(created);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка создания лиги' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const league = await prisma.league.findUnique({ where: { id } });
    if (!league) return res.status(404).json({ error: 'Лига не найдена' });

    const {
      title,
      season,
      city,
      images,
      format,
      halfMinutes,
      halves,
      startDate,
    } = req.body;
    const updated = await prisma.league.update({
      where: { id },
      data: {
        title: title ?? league.title,
        season: season ?? league.season,
        city: city ?? league.city,
        images: Array.isArray(images)
          ? images
          : images != null
            ? [images]
            : league.images,
        format: format ?? league.format,
        halfMinutes:
          halfMinutes != null ? Number(halfMinutes) : league.halfMinutes,
        halves: halves != null ? Number(halves) : league.halves,
        startDate: startDate ? new Date(startDate) : league.startDate,
      },
    });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка обновления лиги' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    await prisma.league.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка удаления лиги' });
  }
});

/* =====================================================
   TEAMS in LEAGUE (через LeagueTeam)
   ===================================================== */
router.get('/:leagueId/teams', async (req, res) => {
  try {
    const leagueId = Number(req.params.leagueId);
    const range = safeJSON(req.query.range, [0, 9999]);
    const sort = safeJSON(req.query.sort, ['team.title', 'ASC']);

    const [start, end] = range;
    const take = Math.max(0, end - start + 1);
    const [sortField, sortOrderRaw] = sort;
    const sortOrder =
      String(sortOrderRaw).toLowerCase() === 'desc' ? 'desc' : 'asc';

    const [rows, total] = await Promise.all([
      prisma.leagueTeam.findMany({
        where: { leagueId },
        skip: start,
        take,
        orderBy:
          sortField === 'team.title'
            ? { team: { title: sortOrder } }
            : { [sortField]: sortOrder },
        include: {
          team: { include: { _count: { select: { players: true } } } },
          _count: { select: { roster: true } },
          captainRosterItem: true,
        },
      }),
      prisma.leagueTeam.count({ where: { leagueId } }),
    ]);

    res.setHeader(
      'Content-Range',
      `leagueTeams ${start}-${start + rows.length - 1}/${total}`
    );
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range');
    res.json(rows);
  } catch (e) {
    console.error('GET /leagues/:leagueId/teams', e);
    res.status(500).json({ error: 'Ошибка загрузки команд лиги' });
  }
});

router.post('/:leagueId/teams', async (req, res) => {
  try {
    const leagueId = Number(req.params.leagueId);
    const { title, city, logo = [], images = [] } = req.body;

    const result = await prisma.$transaction(async (tx) => {
      const team = await tx.team.create({
        data: {
          title,
          city,
          logo: Array.isArray(logo) ? logo : [logo].filter(Boolean),
          images: Array.isArray(images) ? images : [images].filter(Boolean),
        },
      });
      const lt = await tx.leagueTeam.create({
        data: { leagueId, teamId: team.id },
      });
      return { team, leagueTeam: lt };
    });

    res.status(201).json(result);
  } catch (e) {
    console.error('POST /leagues/:leagueId/teams', e);
    res.status(500).json({ error: 'Ошибка создания и привязки команды' });
  }
});

router.post('/:leagueId/teams/:teamId/attach', async (req, res) => {
  try {
    const leagueId = Number(req.params.leagueId);
    const teamId = Number(req.params.teamId);
    const lt = await prisma.leagueTeam.upsert({
      where: { leagueId_teamId: { leagueId, teamId } },
      update: {},
      create: { leagueId, teamId },
    });
    res.json(lt);
  } catch (e) {
    console.error('attach team', e);
    res.status(500).json({ error: 'Не удалось привязать команду' });
  }
});

router.delete('/:leagueId/teams/:teamId/attach', async (req, res) => {
  try {
    const leagueId = Number(req.params.leagueId);
    const teamId = Number(req.params.teamId);
    await prisma.leagueTeam.delete({
      where: { leagueId_teamId: { leagueId, teamId } },
    });
    res.json({ success: true });
  } catch (e) {
    console.error('detach team', e);
    res.status(500).json({ error: 'Не удалось отвязать команду' });
  }
});

/* =====================================================
   ROUNDS (туры)
   ===================================================== */
router.get('/:leagueId/rounds', async (req, res) => {
  try {
    const leagueId = Number(req.params.leagueId);
    const rows = await prisma.leagueRound.findMany({
      where: { leagueId },
      orderBy: [{ number: 'asc' }, { date: 'asc' }],
    });
    res.json(rows);
  } catch (e) {
    console.error('GET /leagues/:leagueId/rounds', e);
    res.status(500).json({ error: 'Ошибка загрузки туров' });
  }
});

router.post('/:leagueId/rounds', async (req, res) => {
  try {
    const leagueId = Number(req.params.leagueId);
    const { name, number, date } = req.body;
    const created = await prisma.leagueRound.create({
      data: {
        leagueId,
        name: name ?? null,
        number: toInt(number),
        date: toDate(date),
      },
    });
    res.status(201).json(created);
  } catch (e) {
    console.error('POST /leagues/:leagueId/rounds', e);
    res.status(400).json({ error: 'Ошибка создания тура' });
  }
});

/* =====================================================
   MATCHES
   ===================================================== */
async function assertTeamsInLeague(leagueId, team1Id, team2Id) {
  if (!Number.isFinite(team1Id) || !Number.isFinite(team2Id))
    throw new Error('Некорректные команды');
  if (team1Id === team2Id) throw new Error('Команды не могут совпадать');
  const ok = await prisma.leagueTeam.count({
    where: { leagueId, teamId: { in: [team1Id, team2Id] } },
  });
  if (ok !== 2) throw new Error('Обе команды должны быть привязаны к лиге');
}

async function assertRoundBelongsToLeague(leagueId, roundId) {
  if (!roundId) return;
  const r = await prisma.leagueRound.findFirst({
    where: { id: roundId, leagueId },
  });
  if (!r) throw new Error('Указанный тур не принадлежит лиге');
}

router.get('/:leagueId/matches', async (req, res) => {
  try {
    const leagueId = Number(req.params.leagueId);
    const range = safeJSON(req.query.range, [0, 49]);
    const sort = safeJSON(req.query.sort, ['date', 'DESC']);
    const filter = safeJSON(req.query.filter, {});

    const [start, end] = range;
    const take = Math.max(0, end - start + 1);
    const [sortField, sortOrderRaw] = sort;
    const sortOrder =
      String(sortOrderRaw).toLowerCase() === 'desc' ? 'desc' : 'asc';
    const orderBy = { [sortField]: sortOrder };

    const where = { leagueId };
    if (filter.status)
      where.status = toEnum(
        filter.status,
        Object.values(MatchStatus),
        MatchStatus.SCHEDULED
      );
    if (filter.teamId)
      where.OR = [
        { team1Id: Number(filter.teamId) },
        { team2Id: Number(filter.teamId) },
      ];
    if (filter.date_gte || filter.date_lte) {
      where.date = {
        gte: filter.date_gte ? new Date(filter.date_gte) : undefined,
        lte: filter.date_lte ? new Date(filter.date_lte) : undefined,
      };
    }
    if (filter.roundId) where.roundId = Number(filter.roundId);

    const [rows, total] = await Promise.all([
      prisma.match.findMany({
        where,
        skip: start,
        take,
        orderBy,
        include: {
          league: { select: { id: true, title: true } },
          stadiumRel: true,
          team1: { select: { id: true, title: true } },
          team2: { select: { id: true, title: true } },
          matchReferees: { include: { referee: true } },
          _count: { select: { events: true, participants: true } },
        },
      }),
      prisma.match.count({ where }),
    ]);

    res.setHeader(
      'Content-Range',
      `matches ${start}-${start + rows.length - 1}/${total}`
    );
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range');
    res.json(rows);
  } catch (e) {
    console.error('GET /leagues/:leagueId/matches', e);
    res.status(500).json({ error: 'Ошибка загрузки матчей лиги' });
  }
});

router.post('/:leagueId/matches', async (req, res) => {
  try {
    const leagueId = Number(req.params.leagueId);
    const {
      stadiumId,
      date,
      status,
      team1Id,
      team2Id,
      team1Score = 0,
      team2Score = 0,
      roundId,
      matchReferees = [],
      events = [],
      homeFormation,
      guestFormation,
      homeCoach,
      guestCoach,
    } = req.body;

    const t1 = Number(team1Id);
    const t2 = Number(team2Id);
    await assertTeamsInLeague(leagueId, t1, t2);
    await assertRoundBelongsToLeague(leagueId, toInt(roundId) ?? null);

    const created = await prisma.match.create({
      data: {
        leagueId,
        stadiumId: stadiumId != null ? Number(stadiumId) : null,
        date: date ? new Date(date) : new Date(),
        status: toEnum(
          status,
          Object.values(MatchStatus),
          MatchStatus.SCHEDULED
        ),
        team1Id: t1,
        team2Id: t2,
        team1Score: Number(team1Score) || 0,
        team2Score: Number(team2Score) || 0,
        roundId: toInt(roundId) ?? null,
        homeFormation: homeFormation ?? null,
        guestFormation: guestFormation ?? null,
        homeCoach: homeCoach ?? null,
        guestCoach: guestCoach ?? null,
        matchReferees: {
          create: (matchReferees || [])
            .filter((x) => x && x.refereeId)
            .map((mr) => ({
              refereeId: Number(mr.refereeId),
              role: mr.role ?? null,
            })),
        },
        events: {
          create: (events || []).map((e) => ({
            minute: Number(e.minute) || 0,
            half: Number(e.half) || 1,
            type: e.type,
            description: e.description ?? null,
            teamId: Number(e.teamId),
            playerId: e.playerId != null ? Number(e.playerId) : null,
            assistPlayerId:
              e.assistPlayerId != null ? Number(e.assistPlayerId) : null,
          })),
        },
      },
      include: {
        stadiumRel: true,
        team1: true,
        team2: true,
        matchReferees: { include: { referee: true } },
        events: true,
      },
    });

    res.status(201).json(created);
  } catch (e) {
    console.error('POST /leagues/:leagueId/matches', e);
    res.status(400).json({ error: e.message || 'Ошибка создания матча' });
  }
});

/* =====================================================
   STANDINGS
   ===================================================== */
router.get('/:leagueId/standings', async (req, res) => {
  try {
    const leagueId = Number(req.params.leagueId);
    const rows = await prisma.leagueStanding.findMany({
      where: { league_id: leagueId },
      orderBy: [
        { points: 'desc' },
        { goals_for: 'desc' },
        { goals_against: 'asc' },
      ],
      include: { team: { select: { id: true, title: true } } },
    });
    res.json(rows);
  } catch (e) {
    console.error('GET /leagues/:leagueId/standings', e);
    res.status(500).json({ error: 'Ошибка загрузки таблицы' });
  }
});

router.post('/:leagueId/standings/recompute', async (req, res) => {
  try {
    const leagueId = Number(req.params.leagueId);
    const matches = await prisma.match.findMany({
      where: { leagueId, status: 'FINISHED' },
      select: {
        team1Id: true,
        team2Id: true,
        team1Score: true,
        team2Score: true,
      },
    });

    const table = new Map();
    const ensureRow = (teamId) => {
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
      const a = ensureRow(m.team1Id);
      const b = ensureRow(m.team2Id);
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

    const payload = Array.from(table.entries()).map(([teamId, r]) => ({
      league_id: leagueId,
      team_id: teamId,
      played: r.played,
      wins: r.wins,
      draws: r.draws,
      losses: r.losses,
      goals_for: r.goals_for,
      goals_against: r.goals_against,
      points: r.points,
    }));

    await prisma.$transaction([
      prisma.leagueStanding.deleteMany({ where: { league_id: leagueId } }),
      prisma.leagueStanding.createMany({ data: payload, skipDuplicates: true }),
    ]);

    const rows = await prisma.leagueStanding.findMany({
      where: { league_id: leagueId },
      orderBy: [
        { points: 'desc' },
        { goals_for: 'desc' },
        { goals_against: 'asc' },
      ],
      include: { team: { select: { id: true, title: true } } },
    });
    res.json(rows);
  } catch (e) {
    console.error('recompute standings', e);
    res.status(500).json({ error: 'Не удалось пересчитать таблицу' });
  }
});

export default router;
