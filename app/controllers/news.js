// app/controllers/news.js
import { Router } from 'express';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

/* ----------------- helpers ----------------- */
const safeJSON = (val, fb) => {
  try {
    return val ? JSON.parse(String(val)) : fb;
  } catch {
    return fb;
  }
};
const toInt = (v, d = undefined) => (v === '' || v == null ? d : Number(v));
const toDate = (v, d = undefined) => (v ? new Date(v) : d);

// принимает строку или объект {src|url|path}, приводит к массиву строк
const toStringArray = (val) => {
  const arr = Array.isArray(val) ? val : [val];
  return arr
    .filter(Boolean)
    .map((x) => (typeof x === 'string' ? x : x?.src || x?.url || x?.path || ''))
    .filter((s) => typeof s === 'string' && s.length > 0);
};

const setRaRangeHeaders = (res, name, start, count, total) => {
  res.setHeader(
    'Content-Range',
    `${name} ${start}-${start + count - 1}/${total}`
  );
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range');
};

const buildInclude = (includeParam) => {
  const parts = String(includeParam || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return {
    league: !!parts.includes('league'),
    match: !!parts.includes('match'),
    tournament: !!parts.includes('tournament'),
  };
};

/* ----------------- GET /news -----------------
Поддержка:
  1) ?_start=0&_end=9&order=asc&q=term
  2) ?range=[0,9]&sort=["date","desc"]&filter={"q":"term","id":[1,2],"dateFrom":"2024-01-01","dateTo":"2024-12-31","leagueId":1,"matchId":2,"tournamentId":3,"hasImages":true,"hasVideos":true}
  3) ?include=league,match,tournament
------------------------------------------------ */
router.get('/', async (req, res) => {
  try {
    const range = safeJSON(req.query.range, null);
    const sort = safeJSON(req.query.sort, null);
    const filter = safeJSON(req.query.filter, {});

    // пагинация
    const start = range ? toInt(range[0], 0) : toInt(req.query._start, 0);
    const end = range
      ? toInt(range[1], start + 19)
      : toInt(req.query._end, start + 19);
    const take = Math.max(0, end - start + 1);

    // поиск
    const q = String(req.query.q ?? filter.q ?? '').trim();

    // сортировка
    const allowedSort = new Set(['id', 'date', 'createdAt', 'title']);
    let orderField = 'date';
    let orderDir = 'desc';
    if (Array.isArray(sort) && sort[0] && allowedSort.has(sort[0])) {
      orderField = sort[0];
      orderDir = (sort[1] || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
    } else if (req.query.order) {
      orderDir =
        (req.query.order || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
    }

    // where
    const AND = [];

    if (q) {
      AND.push({
        OR: [
          { title: { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } },
        ],
      });
    }

    if (Array.isArray(filter.id) && filter.id.length) {
      AND.push({ id: { in: filter.id.map(Number).filter(Number.isFinite) } });
    }

    // даты
    const dateFrom = filter.dateFrom || filter.date_gte;
    const dateTo = filter.dateTo || filter.date_lte;
    if (dateFrom || dateTo) {
      AND.push({
        date: {
          gte: dateFrom ? new Date(dateFrom) : undefined,
          lte: dateTo ? new Date(dateTo) : undefined,
        },
      });
    }

    // связи
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

    // медиа
    if (filter.hasImages === true || String(filter.hasImages) === 'true') {
      AND.push({ images: { isEmpty: false } });
    }
    if (filter.hasVideos === true || String(filter.hasVideos) === 'true') {
      AND.push({ videos: { isEmpty: false } });
    }

    const where = AND.length ? { AND } : undefined;
    const include = buildInclude(req.query.include);

    const [items, total] = await Promise.all([
      prisma.news.findMany({
        where,
        skip: start,
        take,
        orderBy: { [orderField]: orderDir },
        include,
      }),
      prisma.news.count({ where }),
    ]);

    setRaRangeHeaders(res, 'news', start, items.length, total);
    res.json(items);
  } catch (err) {
    console.error(
      '🔥 Ошибка News GET:',
      err?.code || '',
      err?.message || '',
      err?.meta || err
    );
    res.status(500).json({ error: 'Ошибка загрузки новостей' });
  }
});

/* ----------------- GET /news/latest -----------------
Быстрый выбор последних N (по date), с include
----------------------------------------------------- */
router.get('/latest', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(100, toInt(req.query.limit, 10)));
    const include = buildInclude(req.query.include);

    const items = await prisma.news.findMany({
      take: limit,
      orderBy: { date: 'desc' },
      include,
    });
    res.json(items);
  } catch (err) {
    console.error('🔥 Ошибка News GET /latest:', err);
    res.status(500).json({ error: 'Ошибка загрузки последних новостей' });
  }
});

/* ----------------- GET /news/:id ----------------- */
router.get('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id))
      return res.status(400).json({ error: 'Некорректный ID' });

    const include = buildInclude(req.query.include);
    const news = await prisma.news.findUnique({ where: { id }, include });
    if (!news) return res.status(404).json({ error: 'Новость не найдена' });
    res.json(news);
  } catch (err) {
    console.error(
      '🔥 Ошибка News GET by ID:',
      err?.code || '',
      err?.message || '',
      err?.meta || err
    );
    res.status(500).json({ error: 'Ошибка получения новости' });
  }
});

/* ----------------- POST /news -----------------
Принимает:
  title, description, date,
  images / imagesRaw,
  videos / videosRaw
  leagueId?, matchId?, tournamentId?
------------------------------------------------ */
router.post('/', async (req, res) => {
  try {
    const {
      title,
      description,
      images = [],
      imagesRaw = [],
      videos = [],
      videosRaw = [],
      date,
      leagueId,
      matchId,
      tournamentId,
    } = req.body;

    if (!title || typeof title !== 'string') {
      return res.status(400).json({ error: 'title обязателен' });
    }

    const parsedDate = toDate(date, new Date());
    if (isNaN(parsedDate))
      return res.status(400).json({ error: 'Некорректная дата' });

    const imagesFinal = toStringArray([...images, ...imagesRaw]);
    const videosFinal = toStringArray([...videos, ...videosRaw]);

    const created = await prisma.news.create({
      data: {
        title,
        description,
        date: parsedDate,
        images: imagesFinal,
        videos: videosFinal,
        leagueId: toInt(leagueId, null),
        matchId: toInt(matchId, null),
        tournamentId: toInt(tournamentId, null),
      },
    });

    res.status(201).json(created);
  } catch (err) {
    console.error(
      '🔥 Ошибка News POST:',
      err?.code || '',
      err?.message || '',
      err?.meta || err,
      { body: req.body }
    );
    res.status(500).json({ error: 'Ошибка создания новости' });
  }
});

/* ----------------- PATCH /news/:id -----------------
Частичное обновление (удобно для RA Edit)
--------------------------------------------------- */
router.patch('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id))
      return res.status(400).json({ error: 'Некорректный ID' });

    const {
      title,
      description,
      date,
      images,
      imagesRaw,
      videos,
      videosRaw,
      leagueId,
      matchId,
      tournamentId,
    } = req.body;

    const patch = {};
    if (title !== undefined) patch.title = title;
    if (description !== undefined) patch.description = description;
    if (date !== undefined) patch.date = toDate(date);

    if (images !== undefined || imagesRaw !== undefined) {
      patch.images = toStringArray([...(images || []), ...(imagesRaw || [])]);
    }
    if (videos !== undefined || videosRaw !== undefined) {
      patch.videos = toStringArray([...(videos || []), ...(videosRaw || [])]);
    }

    if (leagueId !== undefined) patch.leagueId = toInt(leagueId, null);
    if (matchId !== undefined) patch.matchId = toInt(matchId, null);
    if (tournamentId !== undefined)
      patch.tournamentId = toInt(tournamentId, null);

    const updated = await prisma.news.update({ where: { id }, data: patch });
    res.json(updated);
  } catch (err) {
    console.error(
      '🔥 Ошибка News PATCH:',
      err?.code || '',
      err?.message || '',
      err?.meta || err,
      { body: req.body }
    );
    res.status(500).json({ error: 'Ошибка обновления новости' });
  }
});

/* ----------------- PUT /news/:id -----------------
Полная замена полей; images/videos собираются из базовых и *Raw
--------------------------------------------------- */
router.put('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id))
      return res.status(400).json({ error: 'Некорректный ID' });

    const exists = await prisma.news.findUnique({ where: { id } });
    if (!exists) return res.status(404).json({ error: 'Новость не найдена' });

    const {
      title,
      description,
      images = [],
      imagesRaw = [],
      videos = [],
      videosRaw = [],
      date,
      leagueId,
      matchId,
      tournamentId,
    } = req.body;

    const parsedDate = toDate(date, exists.date);
    if (parsedDate && isNaN(parsedDate))
      return res.status(400).json({ error: 'Некорректная дата' });

    const updatedImages = toStringArray([...images, ...imagesRaw]);
    const updatedVideos = toStringArray([...videos, ...videosRaw]);

    const updated = await prisma.news.update({
      where: { id },
      data: {
        title,
        description,
        date: parsedDate,
        images: updatedImages,
        videos: updatedVideos,
        leagueId: toInt(leagueId, null),
        matchId: toInt(matchId, null),
        tournamentId: toInt(tournamentId, null),
      },
    });

    res.json(updated);
  } catch (err) {
    console.error(
      '🔥 Ошибка News PUT:',
      err?.code || '',
      err?.message || '',
      err?.meta || err,
      { body: req.body }
    );
    res.status(500).json({ error: 'Ошибка обновления новости' });
  }
});

/* ----------------- POST /news/:id/attach -----------------
Быстрая привязка к лиге/матчу/турниру (любые можно указать)
----------------------------------------------------------- */
router.post('/:id/attach', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { leagueId, matchId, tournamentId } = req.body;
    const updated = await prisma.news.update({
      where: { id },
      data: {
        leagueId: leagueId !== undefined ? toInt(leagueId, null) : undefined,
        matchId: matchId !== undefined ? toInt(matchId, null) : undefined,
        tournamentId:
          tournamentId !== undefined ? toInt(tournamentId, null) : undefined,
      },
    });
    res.json(updated);
  } catch (err) {
    console.error('🔥 Ошибка News attach:', err);
    res.status(400).json({ error: 'Не удалось привязать сущности' });
  }
});

/* ----------------- POST /news/:id/detach -----------------
Снять привязку (по ключам в body)
----------------------------------------------------------- */
router.post('/:id/detach', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const {
      league = false,
      match = false,
      tournament = false,
    } = req.body || {};
    const updated = await prisma.news.update({
      where: { id },
      data: {
        leagueId: league ? null : undefined,
        matchId: match ? null : undefined,
        tournamentId: tournament ? null : undefined,
      },
    });
    res.json(updated);
  } catch (err) {
    console.error('🔥 Ошибка News detach:', err);
    res.status(400).json({ error: 'Не удалось снять привязку' });
  }
});

/* ----------------- BULK create -----------------
POST /news/bulk  body: { items: [ { ... как в POST /news } ] }
-------------------------------------------------- */
router.post('/bulk', async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: 'Пустой список' });

    const payload = items.map((n) => ({
      title: n.title,
      description: n.description,
      date: toDate(n.date, new Date()),
      images: toStringArray([...(n.images || []), ...(n.imagesRaw || [])]),
      videos: toStringArray([...(n.videos || []), ...(n.videosRaw || [])]),
      leagueId: toInt(n.leagueId, null),
      matchId: toInt(n.matchId, null),
      tournamentId: toInt(n.tournamentId, null),
    }));

    // createMany не возвращает записи; вернём count
    const result = await prisma.news.createMany({
      data: payload,
      skipDuplicates: true,
    });
    res.status(201).json({ count: result.count });
  } catch (err) {
    console.error('🔥 Ошибка News BULK POST:', err);
    res.status(500).json({ error: 'Ошибка пакетного создания' });
  }
});

/* ----------------- BULK delete -----------------
DELETE /news/bulk?ids=[1,2,3]
-------------------------------------------------- */
router.delete('/bulk', async (req, res) => {
  try {
    const ids = safeJSON(req.query.ids, []).map(Number).filter(Number.isFinite);
    if (!ids.length) return res.status(400).json({ error: 'Нужно ids' });
    const result = await prisma.news.deleteMany({ where: { id: { in: ids } } });
    res.json({ count: result.count });
  } catch (err) {
    console.error('🔥 Ошибка News BULK DELETE:', err);
    res.status(500).json({ error: 'Ошибка пакетного удаления' });
  }
});

/* ----------------- DELETE /news/:id ----------------- */
router.delete('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id))
      return res.status(400).json({ error: 'Некорректный ID' });
    await prisma.news.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    console.error(
      '🔥 Ошибка News DELETE:',
      err?.code || '',
      err?.message || '',
      err?.meta || err
    );
    res.status(500).json({ error: 'Ошибка удаления новости' });
  }
});

export default router;
