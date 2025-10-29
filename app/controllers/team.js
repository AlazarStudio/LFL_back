// app/controllers/team.js
import { Router } from 'express';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

const safeJSON = (v, fb) => {
  try {
    return v ? JSON.parse(v) : fb;
  } catch {
    return fb;
  }
};
const toInt = (v) =>
  v === '' || v === null || v === undefined ? undefined : Number(v);

const normStr = (v) => (typeof v === 'string' ? v.trim() : undefined);

/* ===================== LIST ===================== */
router.get('/', async (req, res) => {
  try {
    const range = safeJSON(req.query.range, [0, 9999]);
    const sort = safeJSON(req.query.sort, ['id', 'ASC']);
    const filter = safeJSON(req.query.filter, {});

    const [start, end] = range;
    const take = Math.max(0, end - start + 1);

    const [sortField, sortOrderRaw] = sort;
    const sortOrder =
      String(sortOrderRaw).toLowerCase() === 'desc' ? 'desc' : 'asc';
    const orderBy = { [sortField]: sortOrder };

    const AND = [];
    if (Array.isArray(filter.id)) {
      const ids = filter.id.map(Number).filter(Number.isFinite);
      if (ids.length) AND.push({ id: { in: ids } });
    }
    if (typeof filter.title === 'string' && filter.title.trim()) {
      AND.push({
        title: { contains: filter.title.trim(), mode: 'insensitive' },
      });
    }
    // фильтр по короткому названию
    if (typeof filter.smallTitle === 'string' && filter.smallTitle.trim()) {
      AND.push({
        smallTitle: { contains: filter.smallTitle.trim(), mode: 'insensitive' },
      });
    }
    if (typeof filter.q === 'string' && filter.q.trim()) {
      const q = filter.q.trim();
      AND.push({
        OR: [
          { title: { contains: q, mode: 'insensitive' } },
          { smallTitle: { contains: q, mode: 'insensitive' } },
          { city: { contains: q, mode: 'insensitive' } },
        ],
      });
    }
    if (typeof filter.city === 'string' && filter.city.trim()) {
      AND.push({ city: { contains: filter.city.trim(), mode: 'insensitive' } });
    }
    // ✅ фильтр по лиге через join-таблицу LeagueTeam
    if (filter.leagueId != null && Number.isFinite(Number(filter.leagueId))) {
      const leagueId = Number(filter.leagueId);
      AND.push({ leagues: { some: { leagueId } } });
    }

    const where = AND.length ? { AND } : undefined;

    const [data, total] = await Promise.all([
      prisma.team.findMany({
        skip: start,
        take,
        where,
        orderBy,
        include: {
          _count: {
            select: {
              players: true,
              matchesAsTeam1: true,
              matchesAsTeam2: true,
              leagues: true,
            },
          },
        },
      }),
      prisma.team.count({ where }),
    ]);

    res.setHeader(
      'Content-Range',
      `teams ${start}-${start + data.length - 1}/${total}`
    );
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range');
    res.json(data);
  } catch (err) {
    console.error('Ошибка GET /teams:', err);
    res.status(500).json({ error: 'Ошибка загрузки команд' });
  }
});

/* ===== удобные доп. роуты (ВАЖНО: до "/:id") ===== */

// поиск по точному названию (title ИЛИ smallTitle, без учёта регистра)
router.get('/by-title/:title', async (req, res) => {
  try {
    const { title } = req.params;
    const team = await prisma.team.findFirst({
      where: {
        OR: [
          { title: { equals: title, mode: 'insensitive' } },
          { smallTitle: { equals: title, mode: 'insensitive' } },
        ],
      },
    });
    if (!team) return res.status(404).json({ error: 'Команда не найдена' });
    res.json(team);
  } catch (err) {
    console.error('Ошибка GET /teams/by-title/:title:', err);
    res.status(500).json({ error: 'Ошибка поиска команды' });
  }
});

// агрегированная статистика (из standings, иначе — поля Team)
router.get('/:id/stats', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const team = await prisma.team.findUnique({ where: { id } });
    if (!team) return res.status(404).json({ error: 'Команда не найдена' });

    const rows = await prisma.leagueStanding.findMany({
      where: { team_id: id },
    });
    if (rows.length) {
      const sum = (f) => rows.reduce((s, r) => s + (r[f] ?? 0), 0);
      return res.json({
        games: sum('played'),
        wins: sum('wins'),
        goals: sum('goals_for'),
        tournaments: new Set(rows.map((r) => r.league_id)).size,
        source: 'standings',
      });
    }
    return res.json({
      games: team.games ?? 0,
      wins: team.wins ?? 0,
      goals: team.goals ?? 0,
      tournaments: team.tournaments ?? 0,
      source: 'team',
    });
  } catch (err) {
    console.error('Ошибка GET /teams/:id/stats:', err);
    res.status(500).json({ error: 'Ошибка получения статистики' });
  }
});

/* ===================== CRUD ===================== */
router.post('/', async (req, res) => {
  try {
    const {
      title,
      smallTitle,
      city,
      logo = [],
      logoRaw = [],
      images = [],
      imagesRaw = [],
    } = req.body;

    const finalLogo = [
      ...(Array.isArray(logo) ? logo : [logo]),
      ...(Array.isArray(logoRaw) ? logoRaw : [logoRaw]),
    ]
      .map((l) => (typeof l === 'string' ? l : l?.src || ''))
      .filter(Boolean);

    const finalImages = [
      ...(Array.isArray(images) ? images : [images]),
      ...(Array.isArray(imagesRaw) ? imagesRaw : [imagesRaw]),
    ]
      .map((i) => (typeof i === 'string' ? i : i?.src || ''))
      .filter(Boolean);

    const data = {
      title,
      city,
      logo: finalLogo,
      images: finalImages,
    };

    const st = normStr(smallTitle);
    if (st) data.smallTitle = st;

    const games = toInt(req.body.games);
    const wins = toInt(req.body.wins);
    const goals = toInt(req.body.goals);
    const tournaments = toInt(req.body.tournaments);
    if (games !== undefined) data.games = games;
    if (wins !== undefined) data.wins = wins;
    if (goals !== undefined) data.goals = goals;
    if (tournaments !== undefined) data.tournaments = tournaments;

    const created = await prisma.team.create({ data });
    res.status(201).json(created);
  } catch (err) {
    console.error('Ошибка создания команды:', err);
    res.status(500).json({ error: 'Ошибка создания команды' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const {
      title,
      smallTitle,
      city,
      logo = [],
      logoRaw = [],
      images = [],
      imagesRaw = [],
    } = req.body;

    const finalLogo = [
      ...(Array.isArray(logo) ? logo : [logo]),
      ...(Array.isArray(logoRaw) ? logoRaw : [logoRaw]),
    ]
      .map((l) => (typeof l === 'string' ? l : l?.src || ''))
      .filter(Boolean);

    const finalImages = [
      ...(Array.isArray(images) ? images : [images]),
      ...(Array.isArray(imagesRaw) ? imagesRaw : [imagesRaw]),
    ]
      .map((i) => (typeof i === 'string' ? i : i?.src || ''))
      .filter(Boolean);

    const patch = {};
    if (title !== undefined) patch.title = title;
    if (city !== undefined) patch.city = city;
    if (logo.length || logoRaw.length) patch.logo = finalLogo;
    if (images.length || imagesRaw.length) patch.images = finalImages;

    // позволяем и обновить, и очистить short name
    if (smallTitle !== undefined) {
      const st = normStr(smallTitle);
      patch.smallTitle = st ?? null; // пустая строка → null
    }

    const games = toInt(req.body.games);
    const wins = toInt(req.body.wins);
    const goals = toInt(req.body.goals);
    const tournaments = toInt(req.body.tournaments);
    if (games !== undefined) patch.games = games;
    if (wins !== undefined) patch.wins = wins;
    if (goals !== undefined) patch.goals = goals;
    if (tournaments !== undefined) patch.tournaments = tournaments;

    const updated = await prisma.team.update({ where: { id }, data: patch });
    res.json(updated);
  } catch (err) {
    console.error('Ошибка обновления команды:', err);
    res.status(500).json({ error: 'Ошибка обновления команды' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    await prisma.team.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    console.error('Ошибка удаления команды:', err);
    res.status(500).json({ error: 'Ошибка удаления команды' });
  }
});

/* ===================== ПРИВЯЗКА К ЛИГАМ (LeagueTeam) ===================== */
// Список лиг команды
router.get('/:id/leagues', async (req, res) => {
  try {
    const teamId = Number(req.params.id);
    const rows = await prisma.leagueTeam.findMany({
      where: { teamId },
      include: { league: true },
      orderBy: [{ league: { title: 'asc' } }],
    });
    res.json(rows);
  } catch (e) {
    console.error('GET /teams/:id/leagues', e);
    res.status(500).json({ error: 'Ошибка загрузки лиг команды' });
  }
});

// Привязать к лиге
router.post('/:id/attach-league/:leagueId', async (req, res) => {
  try {
    const teamId = Number(req.params.id);
    const leagueId = Number(req.params.leagueId);
    const lt = await prisma.leagueTeam.upsert({
      where: { leagueId_teamId: { leagueId, teamId } },
      update: {},
      create: { leagueId, teamId },
    });
    res.json(lt);
  } catch (e) {
    console.error('POST /teams/:id/attach-league/:leagueId', e);
    res.status(400).json({ error: 'Не удалось привязать команду к лиге' });
  }
});

// Отвязать от лиги
router.delete('/:id/attach-league/:leagueId', async (req, res) => {
  try {
    const teamId = Number(req.params.id);
    const leagueId = Number(req.params.leagueId);
    await prisma.leagueTeam.delete({
      where: { leagueId_teamId: { leagueId, teamId } },
    });
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /teams/:id/attach-league/:leagueId', e);
    res.status(400).json({ error: 'Не удалось отвязать команду от лиги' });
  }
});

/* ===================== СОСТАВЫ КОМАНДЫ ===================== */
// GET /teams/:id/lineups?include=items
router.get('/:id/lineups', async (req, res) => {
  try {
    const teamId = Number(req.params.id);
    const includeItems = String(req.query.include || '')
      .split(',')
      .includes('items');
    const lineups = await prisma.teamLineup.findMany({
      where: { teamId },
      orderBy: [{ isDefault: 'desc' }, { id: 'asc' }],
      include: includeItems
        ? { items: { include: { player: true } } }
        : undefined,
    });
    res.json(lineups);
  } catch (e) {
    console.error('GET /teams/:id/lineups', e);
    res.status(500).json({ error: 'Ошибка получения составов' });
  }
});

// GET /teams/:id/lineups/:lineupId
router.get('/:id/lineups/:lineupId', async (req, res) => {
  try {
    const lineupId = Number(req.params.lineupId);
    const lineup = await prisma.teamLineup.findUnique({
      where: { id: lineupId },
      include: { items: { include: { player: true } } },
    });
    if (!lineup) return res.status(404).json({ error: 'Состав не найден' });
    res.json(lineup);
  } catch (e) {
    console.error('GET /teams/:id/lineups/:lineupId', e);
    res.status(500).json({ error: 'Ошибка получения состава' });
  }
});

// POST /teams/:id/lineups  { title?, formation?, isDefault?, players:[{playerId, role?, position?, order?, isCaptain?}] }
router.post('/:id/lineups', async (req, res) => {
  try {
    const teamId = Number(req.params.id);
    const { title, formation, isDefault = false, players = [] } = req.body;

    const ids = players.map((p) => Number(p.playerId)).filter(Number.isFinite);
    if (ids.length) {
      const count = await prisma.player.count({
        where: { id: { in: ids }, teamId },
      });
      if (count !== ids.length) {
        return res
          .status(400)
          .json({ error: 'Есть игроки не из этой команды' });
      }
    }

    const created = await prisma.$transaction(async (tx) => {
      if (isDefault) {
        await tx.teamLineup.updateMany({
          where: { teamId, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.teamLineup.create({
        data: {
          teamId,
          title,
          formation,
          isDefault: Boolean(isDefault),
          items: {
            create: players.map((p) => ({
              playerId: Number(p.playerId),
              role: p.role ?? 'STARTER',
              position: p.position ?? null,
              order: Number.isFinite(Number(p.order)) ? Number(p.order) : 0,
              isCaptain: Boolean(p.isCaptain),
            })),
          },
        },
        include: { items: { include: { player: true } } },
      });
    });

    res.status(201).json(created);
  } catch (e) {
    console.error('POST /teams/:id/lineups', e);
    res.status(500).json({ error: 'Ошибка создания состава' });
  }
});

// PUT /teams/:id/lineups/:lineupId  — полная замена + replace items
router.put('/:id/lineups/:lineupId', async (req, res) => {
  try {
    const teamId = Number(req.params.id);
    const lineupId = Number(req.params.lineupId);
    const { title, formation, isDefault, players = [] } = req.body;

    const lineup = await prisma.teamLineup.findUnique({
      where: { id: lineupId },
    });
    if (!lineup || lineup.teamId !== teamId)
      return res.status(404).json({ error: 'Состав не найден' });

    const ids = players.map((p) => Number(p.playerId)).filter(Number.isFinite);
    if (ids.length) {
      const count = await prisma.player.count({
        where: { id: { in: ids }, teamId },
      });
      if (count !== ids.length) {
        return res
          .status(400)
          .json({ error: 'Есть игроки не из этой команды' });
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      if (isDefault === true) {
        await tx.teamLineup.updateMany({
          where: { teamId, isDefault: true, NOT: { id: lineupId } },
          data: { isDefault: false },
        });
      }
      await tx.teamLineup.update({
        where: { id: lineupId },
        data: { title, formation, isDefault: isDefault ?? undefined },
      });
      await tx.teamLineupItem.deleteMany({ where: { lineupId } });
      await tx.teamLineupItem.createMany({
        data: players.map((p) => ({
          lineupId,
          playerId: Number(p.playerId),
          role: p.role ?? 'STARTER',
          position: p.position ?? null,
          order: Number.isFinite(Number(p.order)) ? Number(p.order) : 0,
          isCaptain: Boolean(p.isCaptain),
        })),
      });
      return tx.teamLineup.findUnique({
        where: { id: lineupId },
        include: { items: { include: { player: true } } },
      });
    });

    res.json(updated);
  } catch (e) {
    console.error('PUT /teams/:id/lineups/:lineupId', e);
    res.status(500).json({ error: 'Ошибка обновления состава' });
  }
});

// DELETE /teams/:id/lineups/:lineupId
router.delete('/:id/lineups/:lineupId', async (req, res) => {
  try {
    const teamId = Number(req.params.id);
    const lineupId = Number(req.params.lineupId);
    const lineup = await prisma.teamLineup.findUnique({
      where: { id: lineupId },
    });
    if (!lineup || lineup.teamId !== teamId)
      return res.status(404).json({ error: 'Состав не найден' });
    await prisma.teamLineup.delete({ where: { id: lineupId } });
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /teams/:id/lineups/:lineupId', e);
    res.status(500).json({ error: 'Ошибка удаления состава' });
  }
});

// Публикация состава в матч (копируем в PlayerMatch)
router.post('/:id/lineups/:lineupId/publish', async (req, res) => {
  try {
    const teamId = Number(req.params.id);
    const lineupId = Number(req.params.lineupId);
    const { matchId, reset = true } = req.body;

    const lineup = await prisma.teamLineup.findUnique({
      where: { id: lineupId },
      include: { items: true },
    });
    if (!lineup || lineup.teamId !== teamId)
      return res.status(404).json({ error: 'Состав не найден' });

    const match = await prisma.match.findUnique({
      where: { id: Number(matchId) },
      select: { id: true, team1Id: true, team2Id: true },
    });
    if (!match) return res.status(404).json({ error: 'Матч не найден' });
    if (![match.team1Id, match.team2Id].includes(teamId)) {
      return res
        .status(400)
        .json({ error: 'Команда не участвует в этом матче' });
    }

    const result = await prisma.$transaction(async (tx) => {
      if (reset) {
        await tx.playerMatch.deleteMany({
          where: {
            matchId: match.id,
            playerId: { in: lineup.items.map((i) => i.playerId) },
          },
        });
      }
      await tx.playerMatch.createMany({
        data: lineup.items.map((i) => ({
          matchId: match.id,
          playerId: i.playerId,
          role: i.role,
          position: i.position,
          isCaptain: i.isCaptain,
          order: i.order,
        })),
        skipDuplicates: true,
      });
      return tx.playerMatch.findMany({
        where: { matchId: match.id },
        orderBy: [{ role: 'asc' }, { order: 'asc' }],
      });
    });

    res.json(result);
  } catch (e) {
    console.error('POST /teams/:id/lineups/:lineupId/publish', e);
    res.status(500).json({ error: 'Ошибка публикации состава в матч' });
  }
});

router.get('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const team = await prisma.team.findUnique({
      where: { id },
      include: {
        leagues: { include: { league: true } },
        _count: { select: { players: true, leagues: true } },
      },
    });
    if (!team) return res.status(404).json({ error: 'Команда не найдена' });
    res.json(team);
  } catch (err) {
    console.error('Ошибка GET /teams/:id:', err);
    res.status(500).json({ error: 'Ошибка получения команды' });
  }
});

export default router;
