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
const buildIncludeFlags = (p) => {
  const parts = String(p || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return {
    league: parts.includes('league'),
    match: parts.includes('match'),
    tmatch: parts.includes('tmatch') || parts.includes('tournamentmatch'),
    tournament: parts.includes('tournament'),
    team: parts.includes('team'),
  };
};
const makeInclude = (flags) => {
  const inc = {};
  if (flags?.league) inc.league = true;
  if (flags?.match) inc.match = true;
  if (flags?.tmatch) inc.tMatch = true;
  if (flags?.tournament) inc.tournament = true;
  if (flags?.team) inc.team = true;
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

/* =========================================================
   LIST: GET /images
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
    const incFlags = buildIncludeFlags(req.query.include);

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
    if (filter.tMatchId != null && Number.isFinite(Number(filter.tMatchId))) {
      AND.push({ tMatchId: Number(filter.tMatchId) });
    }
    if (
      filter.tournamentId != null &&
      Number.isFinite(Number(filter.tournamentId))
    ) {
      AND.push({ tournamentId: Number(filter.tournamentId) });
    }
    if (filter.teamId != null && Number.isFinite(Number(filter.teamId))) {
      AND.push({ teamId: Number(filter.teamId) });
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
        include: makeInclude(incFlags),
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
    const incFlags = buildIncludeFlags(req.query.include);
    const rows = await prisma.photo.findMany({
      take: limit,
      orderBy: { date: 'desc' },
      include: makeInclude(incFlags),
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
router.get('/by-tmatch/:tMatchId(\\d+)', async (req, res) => {
  try {
    const tMatchId = Number(req.params.tMatchId);
    const rows = await prisma.photo.findMany({
      where: { tMatchId },
      orderBy: { date: 'desc' },
    });
    res.json(rows);
  } catch (e) {
    console.error('GET /images/by-tmatch', e);
    res.status(500).json({ error: 'Ошибка загрузки фото турнирного матча' });
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
router.get('/by-team/:teamId(\\d+)', async (req, res) => {
  try {
    const teamId = Number(req.params.teamId);
    const rows = await prisma.photo.findMany({
      where: { teamId },
      orderBy: { date: 'desc' },
    });
    res.json(rows);
  } catch (e) {
    console.error('GET /images/by-team', e);
    res.status(500).json({ error: 'Ошибка загрузки фото команды' });
  }
});

/* ITEM */
router.get('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const incFlags = buildIncludeFlags(req.query.include);
    const item = await prisma.photo.findUnique({
      where: { id },
      include: makeInclude(incFlags),
    });
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
      tMatchId,
      tournamentMatchId,
      teamId,
    } = req.body;

    const _matchId = toInt(matchId, null);
    const _tMatchId = toInt(tMatchId ?? tournamentMatchId, null);
    let _leagueId = toInt(leagueId, null);
    let _tournamentId = toInt(tournamentId, null);
    const _teamId = toInt(teamId, null);

    if (_matchId && _leagueId == null)
      _leagueId = await deriveLeagueIdFromMatchId(_matchId);
    if (_tMatchId && _tournamentId == null)
      _tournamentId = await deriveTournamentIdFromTMatchId(_tMatchId);

    const created = await prisma.photo.create({
      data: {
        title: title ?? null,
        date: toDate(date, new Date()),
        images: toStrArr([...images, ...imagesRaw]),
        leagueId: _leagueId ?? null,
        matchId: _matchId ?? null,
        tMatchId: _tMatchId ?? null,
        tournamentId: _tournamentId ?? null,
        teamId: _teamId ?? null,
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
    const {
      title,
      date,
      images,
      imagesRaw,
      leagueId,
      matchId,
      tournamentId,
      tMatchId,
      tournamentMatchId,
      teamId,
    } = req.body;

    const patch = {};
    if (title !== undefined) patch.title = title;
    if (date !== undefined) patch.date = toDate(date);
    if (images !== undefined || imagesRaw !== undefined) {
      patch.images = toStrArr([...(images || []), ...(imagesRaw || [])]);
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
    if (teamId !== undefined) {
      patch.teamId = toInt(teamId, null);
    }

    if (_matchId != null && leagueId === undefined) {
      const derived = await deriveLeagueIdFromMatchId(_matchId);
      if (derived != null) patch.leagueId = derived;
    }
    if (_tMatchId != null && tournamentId === undefined) {
      const derived = await deriveTournamentIdFromTMatchId(_tMatchId);
      if (derived != null) patch.tournamentId = derived;
    }

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
      tMatchId,
      tournamentMatchId,
      teamId,
    } = req.body;

    const _matchId = toInt(matchId, null);
    const _tMatchId = toInt(tMatchId ?? tournamentMatchId, null);
    let _leagueId = toInt(leagueId, null);
    let _tournamentId = toInt(tournamentId, null);
    const _teamId = toInt(teamId, null);

    if (_matchId && _leagueId == null)
      _leagueId = await deriveLeagueIdFromMatchId(_matchId);
    if (_tMatchId && _tournamentId == null)
      _tournamentId = await deriveTournamentIdFromTMatchId(_tMatchId);

    const updated = await prisma.photo.update({
      where: { id },
      data: {
        title: title ?? null,
        date: toDate(date),
        images: toStrArr([...images, ...imagesRaw]),
        leagueId: _leagueId ?? null,
        matchId: _matchId ?? null,
        tMatchId: _tMatchId ?? null,
        tournamentId: _tournamentId ?? null,
        teamId: _teamId ?? null,
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
    const {
      leagueId,
      matchId,
      tournamentId,
      tMatchId,
      tournamentMatchId,
      teamId,
    } = req.body || {};
    const data = {
      leagueId: leagueId !== undefined ? toInt(leagueId, null) : undefined,
      matchId: matchId !== undefined ? toInt(matchId, null) : undefined,
      tMatchId:
        tMatchId !== undefined || tournamentMatchId !== undefined
          ? toInt(tMatchId ?? tournamentMatchId, null)
          : undefined,
      tournamentId:
        tournamentId !== undefined ? toInt(tournamentId, null) : undefined,
      teamId: teamId !== undefined ? toInt(teamId, null) : undefined,
    };

    if (data.matchId != null && leagueId === undefined) {
      const derived = await deriveLeagueIdFromMatchId(data.matchId);
      if (derived != null) data.leagueId = derived;
    }
    if (data.tMatchId != null && tournamentId === undefined) {
      const derived = await deriveTournamentIdFromTMatchId(data.tMatchId);
      if (derived != null) data.tournamentId = derived;
    }

    const updated = await prisma.photo.update({ where: { id }, data });
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
      tmatch = false,
      tournament = false,
      team = false,
    } = req.body || {};
    const updated = await prisma.photo.update({
      where: { id },
      data: {
        leagueId: league ? null : undefined,
        matchId: match ? null : undefined,
        tMatchId: tmatch ? null : undefined,
        tournamentId: tournament ? null : undefined,
        teamId: team ? null : undefined,
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

    const data = [];
    for (const n of items) {
      const _matchId = toInt(n.matchId, null);
      const _tMatchId = toInt(n.tMatchId ?? n.tournamentMatchId, null);
      let _leagueId = toInt(n.leagueId, null);
      let _tournamentId = toInt(n.tournamentId, null);
      const _teamId = toInt(n.teamId, null);

      if (_matchId && _leagueId == null)
        _leagueId = await deriveLeagueIdFromMatchId(_matchId);
      if (_tMatchId && _tournamentId == null)
        _tournamentId = await deriveTournamentIdFromTMatchId(_tMatchId);

      data.push({
        title: n.title ?? null,
        date: toDate(n.date, new Date()),
        images: toStrArr([...(n.images || []), ...(n.imagesRaw || [])]),
        leagueId: _leagueId ?? null,
        matchId: _matchId ?? null,
        tMatchId: _tMatchId ?? null,
        tournamentId: _tournamentId ?? null,
        teamId: _teamId ?? null,
      });
    }

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
