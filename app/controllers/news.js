// app/controllers/news.js
import { Router } from 'express';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

/* --------------- helpers --------------- */
const safeJSON = (v, fb) => {
  try {
    return v ? JSON.parse(String(v)) : fb;
  } catch {
    return fb;
  }
};
const toInt = (v, d = undefined) => (v === '' || v == null ? d : Number(v));
const toIntArr = (val) =>
  (Array.isArray(val) ? val : [val])
    .filter((x) => x !== '' && x != null)
    .map((x) => Number(x))
    .filter(Number.isFinite);

const toDate = (v, d = undefined) => (v ? new Date(v) : d);

const setRange = (res, name, start, count, total) => {
  res.setHeader(
    'Content-Range',
    `${name} ${start}-${start + count - 1}/${total}`
  );
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range');
};

const toStrArr = (val) => {
  const arr = Array.isArray(val) ? val : [val];
  return arr
    .filter(Boolean)
    .map((x) => (typeof x === 'string' ? x : x?.src || x?.url || x?.path || ''))
    .filter(Boolean);
};

/** include parser: supports nested keys like:
 * league, match, match.team1, match.team2, tmatch, tmatch.team1TT.team, tmatch.team2TT.team, tournament, teams, team
 */
/** include parser: supports nested keys like:
 * league, match, match.team1, match.team2,
 * tmatch, tmatch.team1, tmatch.team2,
 * tmatch.team1TT.team, tmatch.team2TT.team, tournament, teams, team
 */
function buildIncludeFromQuery(param) {
  const parts = String(param || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const has = (p) => parts.includes(p);

  const include = {};
  if (has('league')) include.league = true;
  if (has('tournament')) include.tournament = true;
  if (has('teams')) include.teams = true; // M2M
  if (has('team')) include.team = true; // legacy single

  // match (лиг. матч)
  if (has('match') || has('match.team1') || has('match.team2')) {
    include.match = {
      include: {
        team1: has('match.team1') || has('match'),
        team2: has('match.team2') || has('match'),
      },
    };
  }

  // tournament match (tMatch):
  // поддерживаем и прямые team1/team2, и team1TT/team2TT.team
  const hasTMatch =
    has('tmatch') ||
    has('tournamentmatch') ||
    has('tmatch.team1') ||
    has('tmatch.team2') ||
    has('tmatch.team1tt') ||
    has('tmatch.team2tt') ||
    has('tmatch.team1tt.team') ||
    has('tmatch.team2tt.team');

  if (hasTMatch) {
    const tInclude = {};

    // прямые связи на Team
    if (has('tmatch.team1') || has('tmatch')) tInclude.team1 = true;
    if (has('tmatch.team2') || has('tmatch')) tInclude.team2 = true;

    // TT + team
    if (has('tmatch.team1tt') || has('tmatch.team1tt.team') || has('tmatch')) {
      tInclude.team1TT = {
        include: {
          team: has('tmatch.team1tt.team') || has('tmatch'),
        },
      };
    }
    if (has('tmatch.team2tt') || has('tmatch.team2tt.team') || has('tmatch')) {
      tInclude.team2TT = {
        include: {
          team: has('tmatch.team2tt.team') || has('tmatch'),
        },
      };
    }

    include.tMatch = { include: tInclude };
  }

  return include;
}

/* auto-fill parents */
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
   LIST: GET /news
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
    const include = buildIncludeFromQuery(req.query.include);

    const AND = [];

    if (Array.isArray(filter.id) && filter.id.length) {
      AND.push({ id: { in: filter.id.map(Number).filter(Number.isFinite) } });
    }

    const q = (req.query.q ?? filter.q ?? '').toString().trim();
    if (q) {
      AND.push({
        OR: [
          { title: { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } },
        ],
      });
    }

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

    // parents
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

    // team filters
    if (filter.teamId != null && Number.isFinite(Number(filter.teamId))) {
      const tId = Number(filter.teamId);
      AND.push({
        OR: [{ teamId: tId }, { teams: { some: { id: tId } } }],
      });
    }
    if (Array.isArray(filter.teamIds) && filter.teamIds.length) {
      const ids = filter.teamIds.map(Number).filter(Number.isFinite);
      AND.push({
        OR: [{ teamId: { in: ids } }, { teams: { some: { id: { in: ids } } } }],
      });
    }

    // media presence
    if (filter.hasImages === true || String(filter.hasImages) === 'true') {
      AND.push({ images: { isEmpty: false } });
    }
    if (filter.hasVideos === true || String(filter.hasVideos) === 'true') {
      AND.push({ videos: { isEmpty: false } });
    }
    if (filter.hasAny === true || String(filter.hasAny) === 'true') {
      AND.push({
        OR: [
          { url: { not: null } },
          { images: { isEmpty: false } },
          { videos: { isEmpty: false } },
        ],
      });
    }

    const where = AND.length ? { AND } : undefined;

    const [rows, total] = await Promise.all([
      prisma.news.findMany({
        skip: start,
        take,
        where,
        orderBy: { [sortField]: sortOrder },
        include,
      }),
      prisma.news.count({ where }),
    ]);

    setRange(res, 'news', start, rows.length, total);
    res.json(rows);
  } catch (e) {
    console.error('GET /news', e);
    res.status(500).json({ error: 'Ошибка загрузки новостей' });
  }
});

/* быстрые выборки */
router.get('/latest', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(100, toInt(req.query.limit, 12)));
    const include = buildIncludeFromQuery(req.query.include);
    const rows = await prisma.news.findMany({
      take: limit,
      orderBy: { date: 'desc' },
      include,
    });
    res.json(rows);
  } catch (e) {
    console.error('GET /news/latest', e);
    res.status(500).json({ error: 'Ошибка загрузки последних новостей' });
  }
});
router.get('/by-league/:leagueId(\\d+)', async (req, res) => {
  try {
    const leagueId = Number(req.params.leagueId);
    const rows = await prisma.news.findMany({
      where: { leagueId },
      orderBy: { date: 'desc' },
    });
    res.json(rows);
  } catch (e) {
    console.error('GET /news/by-league', e);
    res.status(500).json({ error: 'Ошибка загрузки' });
  }
});
router.get('/by-match/:matchId(\\d+)', async (req, res) => {
  try {
    const matchId = Number(req.params.matchId);
    const rows = await prisma.news.findMany({
      where: { matchId },
      orderBy: { date: 'desc' },
    });
    res.json(rows);
  } catch (e) {
    console.error('GET /news/by-match', e);
    res.status(500).json({ error: 'Ошибка загрузки' });
  }
});
router.get('/by-tmatch/:tMatchId(\\d+)', async (req, res) => {
  try {
    const tMatchId = Number(req.params.tMatchId);
    const rows = await prisma.news.findMany({
      where: { tMatchId },
      orderBy: { date: 'desc' },
    });
    res.json(rows);
  } catch (e) {
    console.error('GET /news/by-tmatch', e);
    res.status(500).json({ error: 'Ошибка загрузки' });
  }
});
router.get('/by-tournament/:tournamentId(\\d+)', async (req, res) => {
  try {
    const tournamentId = Number(req.params.tournamentId);
    const rows = await prisma.news.findMany({
      where: { tournamentId },
      orderBy: { date: 'desc' },
    });
    res.json(rows);
  } catch (e) {
    console.error('GET /news/by-tournament', e);
    res.status(500).json({ error: 'Ошибка загрузки' });
  }
});
router.get('/by-team/:teamId(\\d+)', async (req, res) => {
  try {
    const teamId = Number(req.params.teamId);
    const rows = await prisma.news.findMany({
      where: { OR: [{ teamId }, { teams: { some: { id: teamId } } }] },
      orderBy: { date: 'desc' },
    });
    res.json(rows);
  } catch (e) {
    console.error('GET /news/by-team', e);
    res.status(500).json({ error: 'Ошибка загрузки' });
  }
});

/* ITEM */
router.get('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const include = buildIncludeFromQuery(req.query.include);
    const item = await prisma.news.findUnique({ where: { id }, include });
    if (!item) return res.status(404).json({ error: 'Не найдено' });
    res.json(item);
  } catch (e) {
    console.error('GET /news/:id', e);
    res.status(500).json({ error: 'Ошибка получения новости' });
  }
});

/* CREATE */
router.post('/', async (req, res) => {
  try {
    const {
      title,
      description = '',
      date,
      url,
      images = [],
      imagesRaw = [],
      videos = [],
      videosRaw = [],
      leagueId,
      matchId,
      tournamentId,
      tMatchId,
      tmatchId,
      tournamentMatchId,
      teamId,
      teamIds,
    } = req.body;

    const _matchId = toInt(matchId, null);
    const _tMatchId = toInt(tMatchId ?? tmatchId ?? tournamentMatchId, null);
    let _leagueId = toInt(leagueId, null);
    let _tournamentId = toInt(tournamentId, null);
    const _teamId = toInt(teamId, null);
    const _teamIds = toIntArr(teamIds);

    if (_matchId && _leagueId == null)
      _leagueId = await deriveLeagueIdFromMatchId(_matchId);
    if (_tMatchId && _tournamentId == null)
      _tournamentId = await deriveTournamentIdFromTMatchId(_tMatchId);

    const created = await prisma.news.create({
      data: {
        title: title ?? '',
        description: String(description), // ВАЖНО
        date: toDate(date, new Date()),
        url: url ? String(url) : null,
        images: toStrArr([...images, ...imagesRaw]),
        videos: toStrArr([...videos, ...videosRaw]),
        leagueId: _leagueId ?? null,
        matchId: _matchId ?? null,
        tMatchId: _tMatchId ?? null,
        tournamentId: _tournamentId ?? null,
        teamId: _teamId ?? null,
        ...(Array.isArray(_teamIds) && _teamIds.length
          ? { teams: { connect: _teamIds.map((id) => ({ id })) } }
          : {}),
      },
    });
    res.status(201).json(created);
  } catch (e) {
    console.error('POST /news', e);
    res.status(500).json({ error: 'Ошибка создания новости' });
  }
});

/* PATCH */
router.patch('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const {
      title,
      description,
      date,
      url,
      images,
      imagesRaw,
      videos,
      videosRaw,
      leagueId,
      matchId,
      tournamentId,
      tMatchId,
      tmatchId,
      tournamentMatchId,
      teamId,
      teamIds, // полная замена M2M
      teamIdsAdd, // частичное подключение
      teamIdsRemove, // частичное отключение
    } = req.body;

    const patch = {};
    if (title !== undefined) patch.title = title ?? '';
    if (description !== undefined) patch.description = String(description);
    if (date !== undefined) patch.date = toDate(date);
    if (url !== undefined) patch.url = url ? String(url) : null;
    if (images !== undefined || imagesRaw !== undefined) {
      patch.images = toStrArr([...(images || []), ...(imagesRaw || [])]);
    }
    if (videos !== undefined || videosRaw !== undefined) {
      patch.videos = toStrArr([...(videos || []), ...(videosRaw || [])]);
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
    if (
      tMatchId !== undefined ||
      tmatchId !== undefined ||
      tournamentMatchId !== undefined
    ) {
      _tMatchId = toInt(tMatchId ?? tmatchId ?? tournamentMatchId, null);
      patch.tMatchId = _tMatchId;
    }
    if (teamId !== undefined) {
      patch.teamId = toInt(teamId, null);
    }

    // auto-fill
    if (_matchId != null && leagueId === undefined) {
      const derived = await deriveLeagueIdFromMatchId(_matchId);
      if (derived != null) patch.leagueId = derived;
    }
    if (_tMatchId != null && tournamentId === undefined) {
      const derived = await deriveTournamentIdFromTMatchId(_tMatchId);
      if (derived != null) patch.tournamentId = derived;
    }

    // relation ops
    const relationOps = {};
    if (teamIds !== undefined) {
      const ids = toIntArr(teamIds);
      relationOps.teams = { set: ids.map((id) => ({ id })) };
    } else {
      const add = toIntArr(teamIdsAdd);
      const remove = toIntArr(teamIdsRemove);
      if (add.length || remove.length) {
        relationOps.teams = {
          ...(add.length ? { connect: add.map((id) => ({ id })) } : {}),
          ...(remove.length
            ? { disconnect: remove.map((id) => ({ id })) }
            : {}),
        };
      }
    }

    const updated = await prisma.news.update({
      where: { id },
      data: { ...patch, ...relationOps },
    });
    res.json(updated);
  } catch (e) {
    console.error('PATCH /news/:id', e);
    res.status(500).json({ error: 'Ошибка обновления новости' });
  }
});

/* PUT (полная замена основных полей + M2M set) */
router.put('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const {
      title,
      description = '',
      date,
      url,
      images = [],
      imagesRaw = [],
      videos = [],
      videosRaw = [],
      leagueId,
      matchId,
      tournamentId,
      tMatchId,
      tmatchId,
      tournamentMatchId,
      teamId,
      teamIds = [],
    } = req.body;

    const _matchId = toInt(matchId, null);
    const _tMatchId = toInt(tMatchId ?? tmatchId ?? tournamentMatchId, null);
    let _leagueId = toInt(leagueId, null);
    let _tournamentId = toInt(tournamentId, null);
    const _teamId = toInt(teamId, null);
    const _teamIds = toIntArr(teamIds);

    if (_matchId && _leagueId == null)
      _leagueId = await deriveLeagueIdFromMatchId(_matchId);
    if (_tMatchId && _tournamentId == null)
      _tournamentId = await deriveTournamentIdFromTMatchId(_tMatchId);

    const updated = await prisma.news.update({
      where: { id },
      data: {
        title: title ?? '',
        description: String(description),
        date: toDate(date),
        url: url ? String(url) : null,
        images: toStrArr([...images, ...imagesRaw]),
        videos: toStrArr([...videos, ...videosRaw]),
        leagueId: _leagueId ?? null,
        matchId: _matchId ?? null,
        tMatchId: _tMatchId ?? null,
        tournamentId: _tournamentId ?? null,
        teamId: _teamId ?? null,
        teams: { set: _teamIds.map((tid) => ({ id: tid })) },
      },
    });
    res.json(updated);
  } catch (e) {
    console.error('PUT /news/:id', e);
    res.status(500).json({ error: 'Ошибка обновления новости' });
  }
});

/* attach/detach parents + teams */
router.post('/:id(\\d+)/attach', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const {
      leagueId,
      matchId,
      tournamentId,
      tMatchId,
      tmatchId,
      tournamentMatchId,
      teamId,
      teamIds, // connect many
    } = req.body || {};

    const data = {
      leagueId: leagueId !== undefined ? toInt(leagueId, null) : undefined,
      matchId: matchId !== undefined ? toInt(matchId, null) : undefined,
      tMatchId:
        tMatchId !== undefined ||
        tmatchId !== undefined ||
        tournamentMatchId !== undefined
          ? toInt(tMatchId ?? tmatchId ?? tournamentMatchId, null)
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

    const ops = { ...data };
    const _teamIds = toIntArr(teamIds);
    if (_teamIds.length)
      ops.teams = { connect: _teamIds.map((tid) => ({ id: tid })) };

    const updated = await prisma.news.update({ where: { id }, data: ops });
    res.json(updated);
  } catch (e) {
    console.error('POST /news/:id/attach', e);
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
      team = false, // single scalar
      teamIds = [], // disconnect many
      teamsAll = false, // clear all m2m
    } = req.body || {};

    const ops = {
      leagueId: league ? null : undefined,
      matchId: match ? null : undefined,
      tMatchId: tmatch ? null : undefined,
      tournamentId: tournament ? null : undefined,
      teamId: team ? null : undefined,
    };

    const _teamIds = toIntArr(teamIds);
    if (teamsAll) {
      ops.teams = { set: [] };
    } else if (_teamIds.length) {
      ops.teams = { disconnect: _teamIds.map((tid) => ({ id: tid })) };
    }

    const updated = await prisma.news.update({ where: { id }, data: ops });
    res.json(updated);
  } catch (e) {
    console.error('POST /news/:id/detach', e);
    res.status(400).json({ error: 'Не удалось снять привязку' });
  }
});

/* BULK (без M2M teams, так как createMany не поддерживает связи) */
router.post('/bulk', async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: 'Пустой список' });

    const data = [];
    for (const n of items) {
      const _matchId = toInt(n.matchId, null);
      const _tMatchId = toInt(
        n.tMatchId ?? n.tmatchId ?? n.tournamentMatchId,
        null
      );
      let _leagueId = toInt(n.leagueId, null);
      let _tournamentId = toInt(n.tournamentId, null);
      const _teamId = toInt(n.teamId, null);

      if (_matchId && _leagueId == null)
        _leagueId = await deriveLeagueIdFromMatchId(_matchId);
      if (_tMatchId && _tournamentId == null)
        _tournamentId = await deriveTournamentIdFromTMatchId(_tMatchId);

      data.push({
        title: n.title ?? '',
        description: String(n.description ?? ''),
        date: toDate(n.date, new Date()),
        url: n.url ? String(n.url) : null,
        images: toStrArr([...(n.images || []), ...(n.imagesRaw || [])]),
        videos: toStrArr([...(n.videos || []), ...(n.videosRaw || [])]),
        leagueId: _leagueId ?? null,
        matchId: _matchId ?? null,
        tMatchId: _tMatchId ?? null,
        tournamentId: _tournamentId ?? null,
        teamId: _teamId ?? null,
      });
    }

    const r = await prisma.news.createMany({ data, skipDuplicates: false });
    res.status(201).json({ count: r.count });
  } catch (e) {
    console.error('POST /news/bulk', e);
    res.status(500).json({ error: 'Ошибка пакетного создания' });
  }
});
router.delete('/bulk', async (req, res) => {
  try {
    const ids = safeJSON(req.query.ids, []).map(Number).filter(Number.isFinite);
    if (!ids.length) return res.status(400).json({ error: 'Нужно ids' });
    const r = await prisma.news.deleteMany({ where: { id: { in: ids } } });
    res.json({ count: r.count });
  } catch (e) {
    console.error('DELETE /news/bulk', e);
    res.status(500).json({ error: 'Ошибка пакетного удаления' });
  }
});

/* DELETE */
router.delete('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    await prisma.news.delete({ where: { id } });
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /news/:id', e);
    res.status(500).json({ error: 'Ошибка удаления новости' });
  }
});

export default router;
