// app/controllers/commentator.js
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
const toInt = (v, d) => (v === '' || v == null ? d : Number(v));
const toDate = (v, d) => (v ? new Date(v) : d);
const bool = (v) =>
  ['true', '1', 'yes', 'on', true, 1].includes(String(v).toLowerCase());
const toStrArr = (val) =>
  (Array.isArray(val) ? val : [val])
    .filter(Boolean)
    .map((x) => (typeof x === 'string' ? x : x?.src || x?.url || x?.path || ''))
    .filter(Boolean);
const setRange = (res, name, start, count, total) => {
  const from = total === 0 ? 0 : start;
  const to = total === 0 ? 0 : start + Math.max(0, count - 1);
  res.setHeader('Content-Range', `${name} ${from}-${to}/${total}`);
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range');
};

/* =========================================================
   LIST  GET /commentators
========================================================= */
router.get('/', async (req, res) => {
  try {
    const safeJSON = (v, fb) => {
      try {
        return v ? JSON.parse(String(v)) : fb;
      } catch {
        return fb;
      }
    };
    const range = safeJSON(req.query.range, [0, 999]);
    const sort = safeJSON(req.query.sort, ['id', 'ASC']);
    const filter = safeJSON(req.query.filter, {});
    const [start, end] = range;
    const take = Math.max(0, end - start + 1);

    const sortField = String(sort[0] || 'id');
    const sortOrder =
      String(sort[1] || 'ASC').toLowerCase() === 'desc' ? 'desc' : 'asc';
    const orderBy =
      sortField === 'matches'
        ? { matchLinks: { _count: sortOrder } } // сортируем по количеству лиговых назначений
        : { [sortField]: sortOrder };

    const AND = [];

    if (Array.isArray(filter.id)) {
      const ids = filter.id.map(Number).filter(Number.isFinite);
      if (ids.length) AND.push({ id: { in: ids } });
    }
    if (typeof filter.q === 'string' && filter.q.trim()) {
      AND.push({ name: { contains: filter.q.trim(), mode: 'insensitive' } });
    }
    if (typeof filter.name === 'string' && filter.name.trim()) {
      AND.push({ name: { contains: filter.name.trim(), mode: 'insensitive' } });
    }

    // фильтр по лиге/датам — только для лиговых матчей
    const matchSubWhere = {};
    if (filter.leagueId != null && Number.isFinite(Number(filter.leagueId))) {
      matchSubWhere.match = {
        ...(matchSubWhere.match || {}),
        leagueId: Number(filter.leagueId),
      };
    }
    if (filter.date_gte || filter.date_lte) {
      matchSubWhere.match = {
        ...(matchSubWhere.match || {}),
        date: {
          gte: filter.date_gte ? new Date(filter.date_gte) : undefined,
          lte: filter.date_lte ? new Date(filter.date_lte) : undefined,
        },
      };
    }
    if (Object.keys(matchSubWhere).length) {
      AND.push({ matchLinks: { some: matchSubWhere } }); // << важное имя связи
    }

    // есть/нет назначений (хоть где-то)
    if (filter.hasMatches != null) {
      const want = ['true', '1', 'yes', 'on', true, 1].includes(
        String(filter.hasMatches).toLowerCase()
      );
      AND.push(
        want
          ? {
              OR: [{ matchLinks: { some: {} } }, { tmatchLinks: { some: {} } }],
            }
          : {
              AND: [
                { matchLinks: { none: {} } },
                { tmatchLinks: { none: {} } },
              ],
            }
      );
    }

    const where = AND.length ? { AND } : undefined;

    const [rows, total] = await Promise.all([
      prisma.commentator.findMany({
        skip: start,
        take,
        where,
        orderBy,
        include: {
          _count: { select: { matchLinks: true, tmatchLinks: true } },
        }, // << здесь тоже имена связей
      }),
      prisma.commentator.count({ where }),
    ]);

    // считаем итоги на базе _count
    const out = rows.map((r) => {
      const league = r._count?.matchLinks ?? 0;
      const tournament = r._count?.tmatchLinks ?? 0;
      return {
        ...r,
        _totals: { league, tournament, total: league + tournament },
      };
    });

    const setRange = (res, name, s, count, tot) => {
      const from = tot === 0 ? 0 : s;
      const to = tot === 0 ? 0 : s + Math.max(0, count - 1);
      res.setHeader('Content-Range', `${name} ${from}-${to}/${tot}`);
      res.setHeader('Access-Control-Expose-Headers', 'Content-Range');
    };
    setRange(res, 'commentators', start, rows.length, total);
    res.json(out);
  } catch (e) {
    console.error('GET /commentators', e);
    res.status(500).json({ error: 'Ошибка загрузки комментаторов' });
  }
});

/* QUICK SEARCH */
router.get('/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json([]);
    const items = await prisma.commentator.findMany({
      where: { name: { contains: q, mode: 'insensitive' } },
      take: 20,
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
    res.json(items);
  } catch (e) {
    console.error('GET /commentators/search', e);
    res.status(500).json({ error: 'Ошибка поиска' });
  }
});

/* ITEM */
router.get('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = await prisma.commentator.findUnique({
      where: { id },
      include: { _count: { select: { matchLinks: true, tmatchLinks: true } } },
    });
    if (!row) return res.status(404).json({ error: 'Комментатор не найден' });

    const league = row._count?.matchLinks ?? 0;
    const tournament = row._count?.tmatchLinks ?? 0;
    res.json({
      ...row,
      _totals: { league, tournament, total: league + tournament },
    });
  } catch (e) {
    console.error('GET /commentators/:id', e);
    res.status(500).json({ error: 'Ошибка получения комментатора' });
  }
});

/* =========================================================
   CREATE / UPDATE / DELETE
========================================================= */
router.post('/', async (req, res) => {
  try {
    const { name, images = [] } = req.body;
    if (!name || !name.trim())
      return res.status(400).json({ error: 'name обязателен' });
    const created = await prisma.commentator.create({
      data: { name: name.trim(), images: toStrArr(images) },
    });
    res.status(201).json(created);
  } catch (e) {
    console.error('POST /commentators', e);
    res.status(500).json({ error: 'Ошибка создания комментатора' });
  }
});

router.patch('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, images } = req.body;
    const updated = await prisma.commentator.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(images !== undefined ? { images: toStrArr(images) } : {}),
      },
    });
    res.json(updated);
  } catch (e) {
    console.error('PATCH /commentators/:id', e);
    res.status(500).json({ error: 'Ошибка обновления комментатора' });
  }
});

router.put('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, images = [] } = req.body;
    const updated = await prisma.commentator.update({
      where: { id },
      data: { name, images: toStrArr(images) },
    });
    res.json(updated);
  } catch (e) {
    console.error('PUT /commentators/:id', e);
    res.status(500).json({ error: 'Ошибка обновления комментатора' });
  }
});

router.delete('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    await prisma.commentator.delete({ where: { id } });
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /commentators/:id', e);
    res.status(500).json({ error: 'Ошибка удаления комментатора' });
  }
});

/* =========================================================
   IMAGES: append / remove / reorder
========================================================= */

// append images (добавить в конец)
router.post('/:id(\\d+)/images', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const add = toStrArr(req.body?.images || []);
    if (!add.length) return res.status(400).json({ error: 'Нечего добавлять' });

    const cur = await prisma.commentator.findUnique({
      where: { id },
      select: { images: true },
    });
    if (!cur) return res.status(404).json({ error: 'Commentator not found' });

    const next = [...(cur.images || []), ...add];
    const updated = await prisma.commentator.update({
      where: { id },
      data: { images: next },
      select: { id: true, images: true },
    });
    res.json(updated);
  } catch (e) {
    console.error('POST /commentators/:id/images', e);
    res.status(500).json({ error: 'Не удалось добавить фото' });
  }
});

// remove by path OR by index
router.delete('/:id(\\d+)/images', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const byPath = String(req.query.path || '').trim();
    const byIndex =
      req.query.index != null && Number.isFinite(Number(req.query.index))
        ? Number(req.query.index)
        : null;

    if (!byPath && byIndex == null)
      return res.status(400).json({ error: 'Нужен path или index' });

    const row = await prisma.commentator.findUnique({
      where: { id },
      select: { images: true },
    });
    if (!row) return res.status(404).json({ error: 'Commentator not found' });

    let next = [...(row.images || [])];
    if (byPath) next = next.filter((p) => p !== byPath);
    if (byIndex != null) next = next.filter((_, i) => i !== byIndex);

    const updated = await prisma.commentator.update({
      where: { id },
      data: { images: next },
      select: { id: true, images: true },
    });

    // опционально: здесь можно удалить файлы с диска, если есть deleteFiles([...])
    res.json(updated);
  } catch (e) {
    console.error('DELETE /commentators/:id/images', e);
    res.status(500).json({ error: 'Не удалось удалить фото' });
  }
});

// reorder (установить полный массив)
router.patch('/:id(\\d+)/images/reorder', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const ordered = toStrArr(req.body?.images || []);
    const updated = await prisma.commentator.update({
      where: { id },
      data: { images: ordered },
      select: { id: true, images: true },
    });
    res.json(updated);
  } catch (e) {
    console.error('PATCH /commentators/:id/images/reorder', e);
    res.status(500).json({ error: 'Не удалось переупорядочить фото' });
  }
});

/* =========================================================
   MATCHES (league)
========================================================= */
router.get('/:id(\\d+)/matches', async (req, res) => {
  try {
    const commentatorId = Number(req.params.id);
    const range = safeJSON(req.query.range, [0, 49]);
    const [start, end] = range;

    const AND = [{ commentatorId }];
    if (req.query.leagueId != null)
      AND.push({ match: { leagueId: Number(req.query.leagueId) } });
    if (req.query.date_gte || req.query.date_lte) {
      AND.push({
        match: {
          date: {
            gte: req.query.date_gte ? new Date(req.query.date_gte) : undefined,
            lte: req.query.date_lte ? new Date(req.query.date_lte) : undefined,
          },
        },
      });
    }

    const where = { AND };
    const [rows, total] = await Promise.all([
      prisma.matchCommentator.findMany({
        where,
        skip: start,
        take: Math.max(0, end - start + 1),
        orderBy: [{ match: { date: 'desc' } }],
        include: {
          match: {
            include: {
              league: { select: { id: true, title: true } },
              team1: { select: { id: true, title: true } },
              team2: { select: { id: true, title: true } },
            },
          },
        },
      }),
      prisma.matchCommentator.count({ where }),
    ]);

    setRange(res, 'commMatches', start, rows.length, total);
    res.json(rows);
  } catch (e) {
    console.error('GET /commentators/:id/matches', e);
    res.status(500).json({ error: 'Ошибка загрузки матчей комментатора' });
  }
});

/* =========================================================
   TOURNAMENT matches
========================================================= */
router.get('/:id(\\d+)/tournament-matches', async (req, res) => {
  try {
    const commentatorId = Number(req.params.id);
    const range = safeJSON(req.query.range, [0, 49]);
    const [start, end] = range;

    const AND = [{ commentatorId }];
    if (req.query.tournamentId != null)
      AND.push({ match: { tournamentId: Number(req.query.tournamentId) } });
    if (req.query.date_gte || req.query.date_lte) {
      AND.push({
        match: {
          date: {
            gte: req.query.date_gte ? new Date(req.query.date_gte) : undefined,
            lte: req.query.date_lte ? new Date(req.query.date_lte) : undefined,
          },
        },
      });
    }

    const where = { AND };
    const [rows, total] = await Promise.all([
      prisma.tournamentMatchCommentator.findMany({
        where,
        skip: start,
        take: Math.max(0, end - start + 1),
        orderBy: [{ match: { date: 'desc' } }],
        include: {
          match: {
            include: {
              tournament: { select: { id: true, title: true } },
              team1TT: {
                include: { team: { select: { id: true, title: true } } },
              },
              team2TT: {
                include: { team: { select: { id: true, title: true } } },
              },
            },
          },
        },
      }),
      prisma.tournamentMatchCommentator.count({ where }),
    ]);

    setRange(res, 'tCommMatches', start, rows.length, total);
    res.json(rows);
  } catch (e) {
    console.error('GET /commentators/:id/tournament-matches', e);
    res
      .status(500)
      .json({ error: 'Ошибка загрузки турнирных матчей комментатора' });
  }
});

/* =========================================================
   ASSIGN / DETACH
========================================================= */
router.post('/:id(\\d+)/assign', async (req, res) => {
  try {
    const commentatorId = Number(req.params.id);
    const matchId = toInt(req.body.matchId);
    const tMatchId = toInt(req.body.tournamentMatchId);
    if (matchId == null && tMatchId == null) {
      return res
        .status(400)
        .json({ error: 'Нужно matchId или tournamentMatchId' });
    }

    const result =
      matchId != null
        ? await prisma.matchCommentator.upsert({
            where: { matchId_commentatorId: { matchId, commentatorId } },
            update: {},
            create: { matchId, commentatorId },
          })
        : await prisma.tournamentMatchCommentator.upsert({
            where: {
              matchId_commentatorId: { matchId: tMatchId, commentatorId },
            },
            update: {},
            create: { matchId: tMatchId, commentatorId },
          });

    res.json(result);
  } catch (e) {
    console.error('POST /commentators/:id/assign', e);
    res.status(400).json({ error: 'Не удалось назначить комментатора' });
  }
});

router.delete('/:id(\\d+)/assign', async (req, res) => {
  try {
    const commentatorId = Number(req.params.id);
    const matchId = toInt(req.query.matchId);
    const tMatchId = toInt(req.query.tournamentMatchId);
    if (matchId == null && tMatchId == null) {
      return res
        .status(400)
        .json({ error: 'Нужно matchId или tournamentMatchId' });
    }

    if (matchId != null) {
      await prisma.matchCommentator.delete({
        where: { matchId_commentatorId: { matchId, commentatorId } },
      });
    } else {
      await prisma.tournamentMatchCommentator.delete({
        where: { matchId_commentatorId: { matchId: tMatchId, commentatorId } },
      });
    }
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /commentators/:id/assign', e);
    res.status(400).json({ error: 'Не удалось снять назначение' });
  }
});

/* =========================================================
   LEADERBOARD
========================================================= */
router.get('/leaderboard/top', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(100, toInt(req.query.limit, 20)));
    const leagueId = toInt(req.query.leagueId);
    const date_gte = toDate(req.query.date_gte);
    const date_lte = toDate(req.query.date_lte);

    const leagueAgg = await prisma.matchCommentator.groupBy({
      by: ['commentatorId'],
      where: {
        match: {
          leagueId: leagueId ?? undefined,
          date: { gte: date_gte, lte: date_lte },
        },
      },
      _count: { _all: true },
    });
    const tournAgg = await prisma.tournamentMatchCommentator.groupBy({
      by: ['commentatorId'],
      where: { match: { date: { gte: date_gte, lte: date_lte } } },
      _count: { _all: true },
    });

    const map = new Map();
    for (const r of leagueAgg)
      map.set(r.commentatorId, { league: r._count._all, tournament: 0 });
    for (const r of tournAgg) {
      map.set(r.commentatorId, {
        ...(map.get(r.commentatorId) || { league: 0, tournament: 0 }),
        tournament: r._count._all,
      });
    }

    const items = [...map.entries()]
      .map(([id, c]) => ({
        id,
        league: c.league,
        tournament: c.tournament,
        total: c.league + c.tournament,
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, limit);

    const comms = await prisma.commentator.findMany({
      where: { id: { in: items.map((i) => i.id) } },
      select: { id: true, name: true, images: true },
    });
    const commMap = new Map(comms.map((r) => [r.id, r]));
    res.json(
      items.map((i) => ({
        id: i.id,
        name: commMap.get(i.id)?.name || `#${i.id}`,
        images: commMap.get(i.id)?.images || [],
        _count: { matchRefs: i.league, tournamentMatchRefs: i.tournament },
        _totals: { league: i.league, tournament: i.tournament, total: i.total },
      }))
    );
  } catch (e) {
    console.error('GET /commentators/leaderboard/top', e);
    res.status(500).json({ error: 'Ошибка загрузки топа комментаторов' });
  }
});

/* =========================================================
   BULK
========================================================= */
router.post('/bulk', async (req, res) => {
  try {
    const names = Array.isArray(req.body?.names)
      ? req.body.names.filter(Boolean)
      : [];
    if (!names.length) return res.status(400).json({ error: 'Пустой список' });
    const data = names
      .map((n) => ({ name: String(n).trim(), images: [] }))
      .filter((n) => n.name.length);
    const result = await prisma.commentator.createMany({
      data,
      skipDuplicates: true,
    });
    res.status(201).json({ count: result.count });
  } catch (e) {
    console.error('POST /commentators/bulk', e);
    res.status(500).json({ error: 'Ошибка пакетного создания' });
  }
});

router.delete('/bulk', async (req, res) => {
  try {
    const ids = safeJSON(req.query.ids, []).map(Number).filter(Number.isFinite);
    if (!ids.length) return res.status(400).json({ error: 'Нужно ids' });
    const result = await prisma.commentator.deleteMany({
      where: { id: { in: ids } },
    });
    res.json({ count: result.count });
  } catch (e) {
    console.error('DELETE /commentators/bulk', e);
    res.status(500).json({ error: 'Ошибка пакетного удаления' });
  }
});

export default router;
