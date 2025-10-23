// app/controllers/images.js
import { Router } from 'express';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

/* ---------------- helpers ---------------- */
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
// принимает строку или объект {src|url|path} -> массив строк
const toStrArr = (val) => {
  const arr = Array.isArray(val) ? val : [val];
  return arr
    .filter(Boolean)
    .map((x) => (typeof x === 'string' ? x : x?.src || x?.url || x?.path || ''))
    .filter(Boolean);
};
const buildInclude = (p) => {
  const parts = String(p || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return {
    league: !!parts.includes('league'),
    match: !!parts.includes('match'),
    tournament: !!parts.includes('tournament'),
  };
};

/* =========================================================
   LIST: GET /images
   filter: id[], q(title), title, date_gte/lte,
           leagueId, matchId, tournamentId, hasImages
   sort: ["id"|"date"|"createdAt"|"title","ASC"|"DESC"]
   include=league,match,tournament
   ========================================================= */
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
    const q = (req.query.q ?? filter.q ?? '').toString().trim();
    if (q) AND.push({ OR: [{ title: { contains: q, mode: 'insensitive' } }] });
    if (typeof filter.title === 'string' && filter.title.trim()) {
      AND.push({
        title: { contains: filter.title.trim(), mode: 'insensitive' },
      });
    }
    if (filter.date_gte || filter.date_lte) {
      AND.push({
        date: {
          gte: filter.date_gte ? new Date(filter.date_gte) : undefined,
          lte: filter.date_lte ? new Date(filter.date_lte) : undefined,
        },
      });
    }
    if (filter.leagueId != null && Number.isFinite(Number(filter.leagueId))) {
      AND.push({ leagueId: Number(filter.leagueId) });
    }
    if (filter.matchId != null && Number.isFinite(Number(filter.matchId))) {
      AND.push({ matchId: Number(filter.matchId) });
    }
    if (
      filter.tournamentId != null &&
      Number.isFinite(Number(filter.tournamentId))
    ) {
      AND.push({ tournamentId: Number(filter.tournamentId) });
    }
    if (filter.hasImages === true || String(filter.hasImages) === 'true') {
      AND.push({ images: { isEmpty: false } });
    }

    const where = AND.length ? { AND } : undefined;

    const [rows, total] = await Promise.all([
      prisma.photo.findMany({
        skip: start,
        take,
        where,
        orderBy: { [sortField]: sortOrder },
        include,
      }),
      prisma.photo.count({ where }),
    ]);

    setRange(res, 'images', start, rows.length, total);
    res.json(rows);
  } catch (e) {
    console.error('GET /images', e);
    res.status(500).json({ error: 'Ошибка загрузки фото' });
  }
});

/* быстрые выборки */
router.get('/latest', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(100, toInt(req.query.limit, 12)));
    const include = buildInclude(req.query.include);
    const rows = await prisma.photo.findMany({
      take: limit,
      orderBy: { date: 'desc' },
      include,
    });
    res.json(rows);
  } catch (e) {
    console.error('GET /images/latest', e);
    res.status(500).json({ error: 'Ошибка загрузки последних фото' });
  }
});
router.get('/by-league/:leagueId(\\d+)', async (req, res) => {
  try {
    const leagueId = Number(req.params.leagueId);
    const rows = await prisma.photo.findMany({
      where: { leagueId },
      orderBy: { date: 'desc' },
    });
    res.json(rows);
  } catch (e) {
    console.error('GET /images/by-league', e);
    res.status(500).json({ error: 'Ошибка загрузки фото лиги' });
  }
});
router.get('/by-match/:matchId(\\d+)', async (req, res) => {
  try {
    const matchId = Number(req.params.matchId);
    const rows = await prisma.photo.findMany({
      where: { matchId },
      orderBy: { date: 'desc' },
    });
    res.json(rows);
  } catch (e) {
    console.error('GET /images/by-match', e);
    res.status(500).json({ error: 'Ошибка загрузки фото матча' });
  }
});
router.get('/by-tournament/:tournamentId(\\d+)', async (req, res) => {
  try {
    const tournamentId = Number(req.params.tournamentId);
    const rows = await prisma.photo.findMany({
      where: { tournamentId },
      orderBy: { date: 'desc' },
    });
    res.json(rows);
  } catch (e) {
    console.error('GET /images/by-tournament', e);
    res.status(500).json({ error: 'Ошибка загрузки фото турнира' });
  }
});

/* ITEM */
router.get('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const include = buildInclude(req.query.include);
    const item = await prisma.photo.findUnique({ where: { id }, include });
    if (!item) return res.status(404).json({ error: 'Не найдено' });
    res.json(item);
  } catch (e) {
    console.error('GET /images/:id', e);
    res.status(500).json({ error: 'Ошибка получения фото' });
  }
});

/* CREATE */
router.post('/', async (req, res) => {
  try {
    const {
      title,
      date,
      images = [],
      imagesRaw = [],
      leagueId,
      matchId,
      tournamentId,
    } = req.body;
    const created = await prisma.photo.create({
      data: {
        title: title ?? null,
        date: toDate(date, new Date()),
        images: toStrArr([...images, ...imagesRaw]),
        leagueId: toInt(leagueId, null),
        matchId: toInt(matchId, null),
        tournamentId: toInt(tournamentId, null),
      },
    });
    res.status(201).json(created);
  } catch (e) {
    console.error('POST /images', e);
    res.status(500).json({ error: 'Ошибка создания фото' });
  }
});

/* PATCH */
router.patch('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { title, date, images, imagesRaw, leagueId, matchId, tournamentId } =
      req.body;
    const patch = {};
    if (title !== undefined) patch.title = title;
    if (date !== undefined) patch.date = toDate(date);
    if (images !== undefined || imagesRaw !== undefined) {
      patch.images = toStrArr([...(images || []), ...(imagesRaw || [])]);
    }
    if (leagueId !== undefined) patch.leagueId = toInt(leagueId, null);
    if (matchId !== undefined) patch.matchId = toInt(matchId, null);
    if (tournamentId !== undefined)
      patch.tournamentId = toInt(tournamentId, null);

    const updated = await prisma.photo.update({ where: { id }, data: patch });
    res.json(updated);
  } catch (e) {
    console.error('PATCH /images/:id', e);
    res.status(500).json({ error: 'Ошибка обновления фото' });
  }
});

/* PUT (полная замена) */
router.put('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const {
      title,
      date,
      images = [],
      imagesRaw = [],
      leagueId,
      matchId,
      tournamentId,
    } = req.body;
    const updated = await prisma.photo.update({
      where: { id },
      data: {
        title: title ?? null,
        date: toDate(date),
        images: toStrArr([...images, ...imagesRaw]),
        leagueId: toInt(leagueId, null),
        matchId: toInt(matchId, null),
        tournamentId: toInt(tournamentId, null),
      },
    });
    res.json(updated);
  } catch (e) {
    console.error('PUT /images/:id', e);
    res.status(500).json({ error: 'Ошибка обновления фото' });
  }
});

/* attach/detach связей */
router.post('/:id(\\d+)/attach', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { leagueId, matchId, tournamentId } = req.body || {};
    const updated = await prisma.photo.update({
      where: { id },
      data: {
        leagueId: leagueId !== undefined ? toInt(leagueId, null) : undefined,
        matchId: matchId !== undefined ? toInt(matchId, null) : undefined,
        tournamentId:
          tournamentId !== undefined ? toInt(tournamentId, null) : undefined,
      },
    });
    res.json(updated);
  } catch (e) {
    console.error('POST /images/:id/attach', e);
    res.status(400).json({ error: 'Не удалось привязать' });
  }
});
router.post('/:id(\\d+)/detach', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const {
      league = false,
      match = false,
      tournament = false,
    } = req.body || {};
    const updated = await prisma.photo.update({
      where: { id },
      data: {
        leagueId: league ? null : undefined,
        matchId: match ? null : undefined,
        tournamentId: tournament ? null : undefined,
      },
    });
    res.json(updated);
  } catch (e) {
    console.error('POST /images/:id/detach', e);
    res.status(400).json({ error: 'Не удалось снять привязку' });
  }
});

/* BULK */
router.post('/bulk', async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: 'Пустой список' });
    const data = items.map((n) => ({
      title: n.title ?? null,
      date: toDate(n.date, new Date()),
      images: toStrArr([...(n.images || []), ...(n.imagesRaw || [])]),
      leagueId: toInt(n.leagueId, null),
      matchId: toInt(n.matchId, null),
      tournamentId: toInt(n.tournamentId, null),
    }));
    const r = await prisma.photo.createMany({ data, skipDuplicates: false });
    res.status(201).json({ count: r.count });
  } catch (e) {
    console.error('POST /images/bulk', e);
    res.status(500).json({ error: 'Ошибка пакетного создания' });
  }
});
router.delete('/bulk', async (req, res) => {
  try {
    const ids = safeJSON(req.query.ids, []).map(Number).filter(Number.isFinite);
    if (!ids.length) return res.status(400).json({ error: 'Нужно ids' });
    const r = await prisma.photo.deleteMany({ where: { id: { in: ids } } });
    res.json({ count: r.count });
  } catch (e) {
    console.error('DELETE /images/bulk', e);
    res.status(500).json({ error: 'Ошибка пакетного удаления' });
  }
});

/* DELETE */
router.delete('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    await prisma.photo.delete({ where: { id } });
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /images/:id', e);
    res.status(500).json({ error: 'Ошибка удаления фото' });
  }
});

export default router;
