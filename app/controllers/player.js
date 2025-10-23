// app/controllers/player.js
import { Router } from 'express';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

/* ---------- utils ---------- */
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
  ['true', '1', true, 1, 'yes', 'on'].includes(String(v).toLowerCase());

const toStrArr = (val) => {
  const arr = Array.isArray(val) ? val : [val];
  return arr
    .filter(Boolean)
    .map((x) => (typeof x === 'string' ? x : x?.src || ''))
    .filter(Boolean);
};

const setRange = (res, name, start, count, total) => {
  res.setHeader(
    'Content-Range',
    `${name} ${start}-${start + count - 1}/${total}`
  );
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range');
};

/* =========================================================
   LIST: GET /players
   filter:
     - id: [1,2]
     - teamId
     - leagueId (через LeagueTeamPlayer -> LeagueTeam)
     - q (по имени)
     - position (contains)
     - number
     - hasUser = true|false
     - isCaptain = true (капитан в лиге ИЛИ капитан в каком-либо TeamLineup)
   ========================================================= */
router.get('/', async (req, res) => {
  try {
    const range = safeJSON(req.query.range, [0, 999]);
    const sort = safeJSON(req.query.sort, ['id', 'ASC']);
    const filter = safeJSON(req.query.filter, {});

    const [start, end] = range;
    const take = Math.max(0, end - start + 1);
    const orderBy = {
      [sort[0]]: String(sort[1]).toLowerCase() === 'desc' ? 'desc' : 'asc',
    };

    const AND = [];

    if (Array.isArray(filter.id)) {
      const ids = filter.id.map(Number).filter(Number.isFinite);
      if (ids.length) AND.push({ id: { in: ids } });
    }

    if (filter.teamId != null && Number.isFinite(Number(filter.teamId))) {
      AND.push({ teamId: Number(filter.teamId) });
    }

    if (typeof filter.q === 'string' && filter.q.trim()) {
      AND.push({ name: { contains: filter.q.trim(), mode: 'insensitive' } });
    }

    if (typeof filter.position === 'string' && filter.position.trim()) {
      AND.push({
        position: { contains: filter.position.trim(), mode: 'insensitive' },
      });
    }

    if (filter.number != null && Number.isFinite(Number(filter.number))) {
      AND.push({ number: Number(filter.number) });
    }

    // фильтр по лиге (игрок в ростере команды этой лиги)
    if (filter.leagueId != null && Number.isFinite(Number(filter.leagueId))) {
      AND.push({
        LeagueTeamPlayer: {
          some: { leagueTeam: { leagueId: Number(filter.leagueId) } },
        },
      });
    }

    // игрок привязан к пользователю?
    if (filter.hasUser != null) {
      AND.push({ userId: bool(filter.hasUser) ? { not: null } : null });
    }

    // капитаны: либо капитан лиги (captainOf != null), либо капитан в любом составе команды (TeamLineupItem.isCaptain = true)
    if (filter.isCaptain != null && bool(filter.isCaptain)) {
      AND.push({
        OR: [
          { LeagueTeamPlayer: { some: { captainOf: { isNot: null } } } },
          { TeamLineupItem: { some: { isCaptain: true } } },
        ],
      });
    }

    const where = AND.length ? { AND } : undefined;

    const [rows, total] = await Promise.all([
      prisma.player.findMany({
        skip: start,
        take,
        where,
        orderBy,
        include: {
          team: { select: { id: true, title: true } },
          stats: true,
          user: { select: { id: true, login: true, email: true } },
          _count: {
            select: {
              events: true,
              assists: true,
              playerMatches: true,
              TeamLineupItem: true,
              LeagueTeamPlayer: true,
            },
          },
        },
      }),
      prisma.player.count({ where }),
    ]);

    setRange(res, 'players', start, rows.length, total);
    res.json(rows);
  } catch (err) {
    console.error('GET /players error:', err);
    res.status(500).json({ error: 'Ошибка загрузки игроков' });
  }
});

/* =========================================================
   ITEM: GET /players/:id
   ========================================================= */
router.get('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = await prisma.player.findUnique({
      where: { id },
      include: {
        team: { select: { id: true, title: true } },
        stats: true,
        user: { select: { id: true, login: true, email: true } },
        LeagueTeamPlayer: {
          include: {
            leagueTeam: { include: { league: true } },
            captainOf: { select: { id: true, leagueId: true } },
          },
        },
        TeamLineupItem: {
          include: {
            lineup: { select: { id: true, title: true, isDefault: true } },
          },
        },
      },
    });
    if (!row) return res.status(404).json({ error: 'Игрок не найден' });
    res.json(row);
  } catch (err) {
    console.error('GET /players/:id error:', err);
    res.status(500).json({ error: 'Ошибка получения игрока' });
  }
});

/* =========================================================
   CREATE: POST /players
   body: { name, position, number?, birthDate?, teamId, images?, userId? }
   (⚠️ поля isCaptain в Player нет — капитан хранится в составах/лигах)
   ========================================================= */
router.post('/', async (req, res) => {
  try {
    const {
      name,
      position,
      number,
      birthDate,
      teamId,
      images = [],
      userId,
    } = req.body;

    if (!name || !teamId)
      return res.status(400).json({ error: 'name и teamId обязательны' });

    const created = await prisma.player.create({
      data: {
        name,
        position,
        number: toInt(number, null),
        birthDate: toDate(birthDate, new Date('2000-01-01')),
        images: toStrArr(images),
        team: { connect: { id: Number(teamId) } },
        ...(userId ? { user: { connect: { id: Number(userId) } } } : {}),
        stats: { create: {} },
      },
      include: { team: true, stats: true, user: true },
    });

    res.status(201).json(created);
  } catch (err) {
    if (err?.code === 'P2002') {
      return res
        .status(400)
        .json({ error: 'Этот пользователь уже связан с другим игроком' });
    }
    if (err?.code === 'P2003') {
      // FK violation
      return res
        .status(400)
        .json({ error: 'Некорректный teamId: команда не найдена' });
    }
    console.error('POST /players error:', err);
    res.status(500).json({ error: 'Ошибка создания игрока' });
  }
});

/* =========================================================
   PATCH: частичное обновление
   ========================================================= */
router.patch('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, position, number, birthDate, teamId, images, userId } =
      req.body;

    const patch = {};
    if (name !== undefined) patch.name = name;
    if (position !== undefined) patch.position = position;
    if (number !== undefined) patch.number = toInt(number, null);
    if (birthDate !== undefined) patch.birthDate = toDate(birthDate);
    if (images !== undefined) patch.images = toStrArr(images);
    if (teamId !== undefined) patch.team = { connect: { id: Number(teamId) } };
    if (userId !== undefined) {
      patch.user =
        userId === null
          ? { disconnect: true }
          : { connect: { id: Number(userId) } };
    }

    const updated = await prisma.player.update({
      where: { id },
      data: patch,
      include: { team: true, stats: true, user: true },
    });
    res.json(updated);
  } catch (err) {
    if (err?.code === 'P2002') {
      return res
        .status(400)
        .json({ error: 'Этот пользователь уже связан с другим игроком' });
    }
    console.error('PATCH /players/:id error:', err);
    res.status(500).json({ error: 'Ошибка обновления игрока' });
  }
});

/* =========================================================
   PUT: полная замена (для совместимости)
   ========================================================= */
router.put('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const {
      name,
      position,
      number,
      birthDate,
      teamId,
      images = [],
      userId,
    } = req.body;
    const data = {
      name,
      position,
      number: toInt(number, null),
      birthDate: toDate(birthDate, new Date('2000-01-01')),
      images: toStrArr(images),
      team: teamId != null ? { connect: { id: Number(teamId) } } : undefined,
      user: userId == null ? undefined : { connect: { id: Number(userId) } },
    };
    const updated = await prisma.player.update({
      where: { id },
      data,
      include: { team: true, stats: true, user: true },
    });
    res.json(updated);
  } catch (err) {
    console.error('PUT /players/:id error:', err);
    res.status(500).json({ error: 'Ошибка обновления игрока' });
  }
});

/* =========================================================
   DELETE
   ========================================================= */
router.delete('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    await prisma.player.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /players/:id error:', err);
    res.status(500).json({ error: 'Ошибка удаления игрока' });
  }
});

/* =========================================================
   QUICK SEARCH: GET /players/search?q=...
   ========================================================= */
router.get('/search/q', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json([]);
    const items = await prisma.player.findMany({
      where: { name: { contains: q, mode: 'insensitive' } },
      take: 20,
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        number: true,
        team: { select: { id: true, title: true } },
      },
    });
    res.json(items);
  } catch (e) {
    console.error('GET /players/search/q', e);
    res.status(500).json({ error: 'Ошибка поиска' });
  }
});

/* =========================================================
   MATCHES OF PLAYER: GET /players/:id/matches?status=...&leagueId=...
   ========================================================= */
router.get('/:id(\\d+)/matches', async (req, res) => {
  try {
    const playerId = Number(req.params.id);
    const { status } = req.query;
    const leagueId = toInt(req.query.leagueId);

    const AND = [{ playerId }];
    if (status) AND.push({ match: { status } });
    if (leagueId != null) AND.push({ match: { leagueId } });

    const rows = await prisma.playerMatch.findMany({
      where: { AND },
      orderBy: [{ match: { date: 'desc' } }, { role: 'asc' }, { order: 'asc' }],
      include: {
        match: {
          include: {
            league: { select: { id: true, title: true } },
            team1: { select: { id: true, title: true } },
            team2: { select: { id: true, title: true } },
          },
        },
      },
    });
    res.json(rows);
  } catch (e) {
    console.error('GET /players/:id/matches', e);
    res.status(500).json({ error: 'Ошибка загрузки матчей игрока' });
  }
});

/* =========================================================
   EVENTS OF PLAYER: GET /players/:id/events
   (и как автор гола, и как ассистент)
   ========================================================= */
router.get('/:id(\\d+)/events', async (req, res) => {
  try {
    const playerId = Number(req.params.id);
    const rows = await prisma.matchEvent.findMany({
      where: { OR: [{ playerId }, { assistPlayerId: playerId }] },
      orderBy: [{ match: { date: 'desc' } }, { minute: 'asc' }],
      include: {
        match: {
          select: {
            id: true,
            date: true,
            team1Id: true,
            team2Id: true,
            team1Score: true,
            team2Score: true,
          },
        },
        team: { select: { id: true, title: true } },
      },
    });
    res.json(rows);
  } catch (e) {
    console.error('GET /players/:id/events', e);
    res.status(500).json({ error: 'Ошибка загрузки событий игрока' });
  }
});

/* =========================================================
   TRANSFER: POST /players/:id/transfer  { toTeamId }
   ========================================================= */
router.post('/:id(\\d+)/transfer', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const toTeamId = Number(req.body?.toTeamId);
    if (!Number.isFinite(toTeamId))
      return res.status(400).json({ error: 'Некорректный toTeamId' });

    const updated = await prisma.player.update({
      where: { id },
      data: { team: { connect: { id: toTeamId } } },
      include: { team: true },
    });
    res.json(updated);
  } catch (e) {
    console.error('POST /players/:id/transfer', e);
    res.status(500).json({ error: 'Не удалось выполнить трансфер' });
  }
});

export default router;
