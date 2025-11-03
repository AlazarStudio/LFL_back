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

const buildIncludeFlags = (includeParam) => {
  const parts = String(includeParam || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return {
    league: parts.includes('league'),
    match: parts.includes('match'),
    tmatch: parts.includes('tmatch') || parts.includes('tournamentmatch'),
    tournament: parts.includes('tournament'),
  };
};
const makeInclude = (flags) => {
  const inc = {};
  if (flags?.league) inc.league = true;
  if (flags?.match) inc.match = true;
  if (flags?.tmatch) inc.tMatch = true;
  if (flags?.tournament) inc.tournament = true;
  return inc;
};

async function deriveLeagueIdFromMatchId(matchId) {
  const id = toInt(matchId, null);
  if (!id) return undefined;
  const m = await prisma.match.findUnique({
    where: { id },
    select: { leagueId: true },
  });
  return m?.leagueId ?? undefined;
}
async function deriveTournamentIdFromTMatchId(tMatchId) {
  const id = toInt(tMatchId, null);
  if (!id) return undefined;
  const m = await prisma.tournamentMatch.findUnique({
    where: { id },
    select: { tournamentId: true },
  });
  return m?.tournamentId ?? undefined;
}

/* ----------------- GET /news ----------------- */
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
    if (filter.tMatchId != null && Number.isFinite(Number(filter.tMatchId))) {
      AND.push({ tMatchId: Number(filter.tMatchId) });
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
    const incFlags = buildIncludeFlags(req.query.include);

    const [items, total] = await Promise.all([
      prisma.news.findMany({
        where,
        skip: start,
        take,
        orderBy: { [orderField]: orderDir },
        include: makeInclude(incFlags),
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

/* ----------------- GET /news/latest ----------------- */
router.get('/latest', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(100, toInt(req.query.limit, 10)));
    const incFlags = buildIncludeFlags(req.query.include);

    const items = await prisma.news.findMany({
      take: limit,
      orderBy: { date: 'desc' },
      include: makeInclude(incFlags),
    });
    res.json(items);
  } catch (err) {
    console.error('🔥 Ошибка News GET /latest:', err);
    res.status(500).json({ error: 'Ошибка загрузки последних новостей' });
  }
});

/* quick by-ids */
router.get('/by-tmatch/:tMatchId(\\d+)', async (req, res) => {
  try {
    const tMatchId = Number(req.params.tMatchId);
    const rows = await prisma.news.findMany({
      where: { tMatchId },
      orderBy: { date: 'desc' },
    });
    res.json(rows);
  } catch (err) {
    console.error('🔥 Ошибка News GET /by-tmatch:', err);
    res
      .status(500)
      .json({ error: 'Ошибка загрузки новостей по турнирному матчу' });
  }
});

/* ----------------- GET /news/:id ----------------- */
router.get('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const incFlags = buildIncludeFlags(req.query.include);
    const news = await prisma.news.findUnique({
      where: { id },
      include: makeInclude(incFlags),
    });
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

/* ----------------- POST /news ----------------- */
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
      tMatchId,
      tournamentMatchId,
    } = req.body;

    if (!title || typeof title !== 'string') {
      return res.status(400).json({ error: 'title обязателен' });
    }

    const parsedDate = toDate(date, new Date());
    if (isNaN(parsedDate))
      return res.status(400).json({ error: 'Некорректная дата' });

    const _matchId = toInt(matchId, null);
    const _tMatchId = toInt(tMatchId ?? tournamentMatchId, null);
    let _leagueId = toInt(leagueId, null);
    let _tournamentId = toInt(tournamentId, null);

    if (_matchId && _leagueId == null) {
      _leagueId = await deriveLeagueIdFromMatchId(_matchId);
    }
    if (_tMatchId && _tournamentId == null) {
      _tournamentId = await deriveTournamentIdFromTMatchId(_tMatchId);
    }

    const imagesFinal = toStringArray([...images, ...imagesRaw]);
    const videosFinal = toStringArray([...videos, ...videosRaw]);

    const created = await prisma.news.create({
      data: {
        title,
        description,
        date: parsedDate,
        images: imagesFinal,
        videos: videosFinal,
        leagueId: _leagueId ?? null,
        matchId: _matchId ?? null,
        tMatchId: _tMatchId ?? null,
        tournamentId: _tournamentId ?? null,
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

/* ----------------- PATCH /news/:id ----------------- */
router.patch('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
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
      tMatchId,
      tournamentMatchId,
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

    let _matchId;
    let _tMatchId;
    let _leagueId;
    let _tournamentId;

    if (leagueId !== undefined) {
      _leagueId = toInt(leagueId, null);
      patch.leagueId = _leagueId;
    }
    if (matchId !== undefined) {
      _matchId = toInt(matchId, null);
      patch.matchId = _matchId;
    }
    if (tournamentId !== undefined) {
      _tournamentId = toInt(tournamentId, null);
      patch.tournamentId = _tournamentId;
    }
    if (tMatchId !== undefined || tournamentMatchId !== undefined) {
      _tMatchId = toInt(tMatchId ?? tournamentMatchId, null);
      patch.tMatchId = _tMatchId;
    }

    if (_matchId != null && leagueId === undefined) {
      const derived = await deriveLeagueIdFromMatchId(_matchId);
      if (derived != null) patch.leagueId = derived;
    }
    if (_tMatchId != null && tournamentId === undefined) {
      const derived = await deriveTournamentIdFromTMatchId(_tMatchId);
      if (derived != null) patch.tournamentId = derived;
    }

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

/* ----------------- PUT /news/:id ----------------- */
router.put('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);

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
      tMatchId,
      tournamentMatchId,
    } = req.body;

    const parsedDate = toDate(date, exists.date);
    if (parsedDate && isNaN(parsedDate))
      return res.status(400).json({ error: 'Некорректная дата' });

    const _matchId = toInt(matchId, null);
    const _tMatchId = toInt(tMatchId ?? tournamentMatchId, null);
    let _leagueId = toInt(leagueId, null);
    let _tournamentId = toInt(tournamentId, null);

    if (_matchId && _leagueId == null) {
      _leagueId = await deriveLeagueIdFromMatchId(_matchId);
    }
    if (_tMatchId && _tournamentId == null) {
      _tournamentId = await deriveTournamentIdFromTMatchId(_tMatchId);
    }

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
        leagueId: _leagueId ?? null,
        matchId: _matchId ?? null,
        tMatchId: _tMatchId ?? null,
        tournamentId: _tournamentId ?? null,
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

/* ----------------- POST /news/:id/attach ----------------- */
router.post('/:id(\\d+)/attach', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { leagueId, matchId, tournamentId, tMatchId, tournamentMatchId } =
      req.body;

    const data = {
      leagueId: leagueId !== undefined ? toInt(leagueId, null) : undefined,
      matchId: matchId !== undefined ? toInt(matchId, null) : undefined,
      tMatchId:
        tMatchId !== undefined || tournamentMatchId !== undefined
          ? toInt(tMatchId ?? tournamentMatchId, null)
          : undefined,
      tournamentId:
        tournamentId !== undefined ? toInt(tournamentId, null) : undefined,
    };

    if (data.matchId != null && leagueId === undefined) {
      const derived = await deriveLeagueIdFromMatchId(data.matchId);
      if (derived != null) data.leagueId = derived;
    }
    if (data.tMatchId != null && tournamentId === undefined) {
      const derived = await deriveTournamentIdFromTMatchId(data.tMatchId);
      if (derived != null) data.tournamentId = derived;
    }

    const updated = await prisma.news.update({ where: { id }, data });
    res.json(updated);
  } catch (err) {
    console.error('🔥 Ошибка News attach:', err);
    res.status(400).json({ error: 'Не удалось привязать сущности' });
  }
});

/* ----------------- POST /news/:id/detach ----------------- */
router.post('/:id(\\d+)/detach', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const {
      league = false,
      match = false,
      tmatch = false,
      tournament = false,
    } = req.body || {};
    const updated = await prisma.news.update({
      where: { id },
      data: {
        leagueId: league ? null : undefined,
        matchId: match ? null : undefined,
        tMatchId: tmatch ? null : undefined,
        tournamentId: tournament ? null : undefined,
      },
    });
    res.json(updated);
  } catch (err) {
    console.error('🔥 Ошибка News detach:', err);
    res.status(400).json({ error: 'Не удалось снять привязку' });
  }
});

/* ----------------- BULK create ----------------- */
router.post('/bulk', async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: 'Пустой список' });

    const data = [];
    for (const n of items) {
      const _matchId = toInt(n.matchId, null);
      const _tMatchId = toInt(n.tMatchId ?? n.tournamentMatchId, null);
      let _leagueId = toInt(n.leagueId, null);
      let _tournamentId = toInt(n.tournamentId, null);

      if (_matchId && _leagueId == null) {
        _leagueId = await deriveLeagueIdFromMatchId(_matchId);
      }
      if (_tMatchId && _tournamentId == null) {
        _tournamentId = await deriveTournamentIdFromTMatchId(_tMatchId);
      }

      data.push({
        title: n.title,
        description: n.description,
        date: toDate(n.date, new Date()),
        images: toStringArray([...(n.images || []), ...(n.imagesRaw || [])]),
        videos: toStringArray([...(n.videos || []), ...(n.videosRaw || [])]),
        leagueId: _leagueId ?? null,
        matchId: _matchId ?? null,
        tMatchId: _tMatchId ?? null,
        tournamentId: _tournamentId ?? null,
      });
    }

    const result = await prisma.news.createMany({ data, skipDuplicates: true });
    res.status(201).json({ count: result.count });
  } catch (err) {
    console.error('🔥 Ошибка News BULK POST:', err);
    res.status(500).json({ error: 'Ошибка пакетного создания' });
  }
});

/* ----------------- BULK delete ----------------- */
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
router.delete('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
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
