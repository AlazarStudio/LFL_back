// app/controllers/referee.js
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

/* ---------- roles helper ---------- */
const defaultMainRoles = ['MAIN', 'REFEREE', 'CHIEF', 'HEAD'];
const parseRoles = (req) => {
  const raw = req.query.roles;
  const parsed = safeJSON(raw, null);
  if (Array.isArray(parsed) && parsed.length) return parsed.map(String);
  if (typeof raw === 'string' && raw.trim()) {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const onlyMain = req.query.onlyMain == null ? true : bool(req.query.onlyMain);
  return onlyMain ? defaultMainRoles : undefined;
};

/* =========================================================
   LIST  GET /referees
========================================================= */
router.get('/', async (req, res) => {
  try {
    const range = safeJSON(req.query.range, [0, 9999]);
    const sort = safeJSON(req.query.sort, ['id', 'ASC']);
    const filter = safeJSON(req.query.filter, {});
    const [start, end] = range;
    const take = Math.max(0, end - start + 1);

    const sortField = String(sort[0] || 'id');
    const sortOrder =
      String(sort[1] || 'ASC').toLowerCase() === 'desc' ? 'desc' : 'asc';
    const orderBy =
      sortField === 'matches'
        ? { matchRefs: { _count: sortOrder } }
        : { [sortField]: sortOrder };

    const AND = [];
    if (Array.isArray(filter.id) && filter.id.length) {
      AND.push({ id: { in: filter.id.map(Number).filter(Number.isFinite) } });
    }
    if (typeof filter.q === 'string' && filter.q.trim()) {
      AND.push({ name: { contains: filter.q.trim(), mode: 'insensitive' } });
    }
    if (typeof filter.name === 'string' && filter.name.trim()) {
      AND.push({ name: { contains: filter.name.trim(), mode: 'insensitive' } });
    }

    const matchSubWhere = {};
    if (filter.leagueId != null && Number.isFinite(Number(filter.leagueId))) {
      matchSubWhere.match = {
        ...(matchSubWhere.match || {}),
        leagueId: Number(filter.leagueId),
      };
    }
    if (filter.role) matchSubWhere.role = filter.role;
    if (filter.date_gte || filter.date_lte) {
      matchSubWhere.match = {
        ...(matchSubWhere.match || {}),
        date: {
          gte: filter.date_gte ? new Date(filter.date_gte) : undefined,
          lte: filter.date_lte ? new Date(filter.date_lte) : undefined,
        },
      };
    }
    if (Object.keys(matchSubWhere).length)
      AND.push({ matchRefs: { some: matchSubWhere } });

    if (filter.hasMatches != null) {
      const tAgg = await prisma.tournamentMatchReferee.groupBy({
        by: ['refereeId'],
        _count: { _all: true },
      });
      const tAssignedIds = new Set(tAgg.map((r) => r.refereeId));
      if (bool(filter.hasMatches)) {
        AND.push({
          OR: [{ matchRefs: { some: {} } }, { id: { in: [...tAssignedIds] } }],
        });
      } else {
        AND.push({
          AND: [
            { matchRefs: { none: {} } },
            { id: { notIn: [...tAssignedIds] } },
          ],
        });
      }
    }

    const where = AND.length ? { AND } : undefined;

    const [rows, total] = await Promise.all([
      prisma.referee.findMany({
        skip: start,
        take,
        where,
        orderBy,
        include: { _count: { select: { matchRefs: true } } },
      }),
      prisma.referee.count({ where }),
    ]);

    const ids = rows.map((r) => r.id);
    const tCounts = ids.length
      ? await prisma.tournamentMatchReferee.groupBy({
          by: ['refereeId'],
          where: { refereeId: { in: ids } },
          _count: { _all: true },
        })
      : [];
    const tMap = new Map(tCounts.map((r) => [r.refereeId, r._count._all]));

    const out = rows.map((r) => {
      const league = r._count?.matchRefs ?? 0;
      const tournament = tMap.get(r.id) ?? 0;
      return {
        ...r,
        _totals: { league, tournament, total: league + tournament },
      };
    });

    setRange(res, 'referees', start, rows.length, total);
    res.json(out);
  } catch (e) {
    console.error('GET /referees', e);
    res.status(500).json({ error: 'Ошибка загрузки судей' });
  }
});

/* QUICK SEARCH */
router.get('/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json([]);
    const items = await prisma.referee.findMany({
      where: { name: { contains: q, mode: 'insensitive' } },
      take: 20,
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
    res.json(items);
  } catch (e) {
    console.error('GET /referees/search', e);
    res.status(500).json({ error: 'Ошибка поиска' });
  }
});

/* ITEM */
router.get('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const item = await prisma.referee.findUnique({
      where: { id },
      include: { _count: { select: { matchRefs: true } } },
    });
    if (!item) return res.status(404).json({ error: 'Not found' });
    const tCount = await prisma.tournamentMatchReferee.count({
      where: { refereeId: id },
    });
    const league = item._count?.matchRefs ?? 0;
    const tournament = tCount ?? 0;
    res.json({
      ...item,
      _totals: { league, tournament, total: league + tournament },
    });
  } catch (e) {
    console.error('GET /referees/:id', e);
    res.status(500).json({ error: 'Ошибка' });
  }
});

/* STATS */
router.get('/:id(\\d+)/stats', async (req, res) => {
  try {
    const id = Number(req.params.id);

    const byLeague = await prisma.matchReferee.groupBy({
      by: ['role', 'matchId'],
      where: { refereeId: id },
      _count: { _all: true },
    });
    const matchIds = [...new Set(byLeague.map((r) => r.matchId))].filter(
      Boolean
    );
    const matches = matchIds.length
      ? await prisma.match.findMany({
          where: { id: { in: matchIds } },
          select: { id: true, leagueId: true },
        })
      : [];
    const leagueMap = new Map(matches.map((m) => [m.id, m.leagueId]));
    const leagueAgg = {};
    byLeague.forEach((r) => {
      const lid = leagueMap.get(r.matchId);
      if (!lid) return;
      leagueAgg[lid] ||= { leagueId: lid, total: 0, byRole: {} };
      leagueAgg[lid].total += 1;
      leagueAgg[lid].byRole[r.role || 'UNKNOWN'] =
        (leagueAgg[lid].byRole[r.role || 'UNKNOWN'] || 0) + 1;
    });

    const byTournamentMatch = await prisma.tournamentMatchReferee.groupBy({
      by: ['role', 'matchId'],
      where: { refereeId: id },
      _count: { _all: true },
    });
    const tMatchIds = [
      ...new Set(byTournamentMatch.map((r) => r.matchId)),
    ].filter(Boolean);
    const tMatches = tMatchIds.length
      ? await prisma.tournamentMatch.findMany({
          where: { id: { in: tMatchIds } },
          select: { id: true, tournamentId: true },
        })
      : [];
    const tMap = new Map(tMatches.map((m) => [m.id, m.tournamentId]));
    const tournAgg = {};
    byTournamentMatch.forEach((r) => {
      const tid = tMap.get(r.matchId);
      if (!tid) return;
      tournAgg[tid] ||= { tournamentId: tid, total: 0, byRole: {} };
      tournAgg[tid].total += 1;
      tournAgg[tid].byRole[r.role || 'UNKNOWN'] =
        (tournAgg[tid].byRole[r.role || 'UNKNOWN'] || 0) + 1;
    });

    const roles = parseRoles(req);
    const date_gte = req.query.date_gte
      ? new Date(req.query.date_gte)
      : undefined;
    const date_lte = req.query.date_lte
      ? new Date(req.query.date_lte)
      : undefined;
    const leagueId = toInt(req.query.leagueId, undefined);
    const tournamentId = toInt(req.query.tournamentId, undefined);

    const leagueMatchFilter = {
      match: {
        ...(leagueId != null ? { leagueId } : {}),
        date: { gte: date_gte, lte: date_lte },
        matchReferees: {
          some: { refereeId: id, ...(roles ? { role: { in: roles } } : {}) },
        },
      },
    };
    const [leagueYellow, leagueRed] = await Promise.all([
      prisma.matchEvent.count({
        where: { type: 'YELLOW_CARD', ...leagueMatchFilter },
      }),
      prisma.matchEvent.count({
        where: { type: 'RED_CARD', ...leagueMatchFilter },
      }),
    ]);

    const tMatchFilter = {
      match: {
        ...(tournamentId != null ? { tournamentId } : {}),
        date: { gte: date_gte, lte: date_lte },
        referees: {
          some: { refereeId: id, ...(roles ? { role: { in: roles } } : {}) },
        },
      },
    };
    const [tournamentYellow, tournamentRed] = await Promise.all([
      prisma.tournamentMatchEvent.count({
        where: { type: 'YELLOW_CARD', ...tMatchFilter },
      }),
      prisma.tournamentMatchEvent.count({
        where: { type: 'RED_CARD', ...tMatchFilter },
      }),
    ]);

    res.json({
      leagues: Object.values(leagueAgg),
      tournaments: Object.values(tournAgg),
      totals: {
        leagueMatches: matchIds.length,
        tournamentMatches: tMatchIds.length,
      },
      cards: {
        league: {
          yellow: leagueYellow,
          red: leagueRed,
          total: leagueYellow + leagueRed,
        },
        tournament: {
          yellow: tournamentYellow,
          red: tournamentRed,
          total: tournamentYellow + tournamentRed,
        },
        total: {
          yellow: leagueYellow + tournamentYellow,
          red: leagueRed + tournamentRed,
          total: leagueYellow + tournamentYellow + leagueRed + tournamentRed,
        },
        _filters: {
          roles: roles || 'ANY',
          date_gte: date_gte || null,
          date_lte: date_lte || null,
          leagueId: leagueId ?? null,
          tournamentId: tournamentId ?? null,
        },
      },
    });
  } catch (e) {
    console.error('GET /referees/:id/stats', e);
    res.status(500).json({ error: 'Ошибка статистики судьи' });
  }
});

/* CARDS-ONLY */
router.get('/:id(\\d+)/cards', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const roles = parseRoles(req);
    const date_gte = req.query.date_gte
      ? new Date(req.query.date_gte)
      : undefined;
    const date_lte = req.query.date_lte
      ? new Date(req.query.date_lte)
      : undefined;
    const leagueId = toInt(req.query.leagueId, undefined);
    const tournamentId = toInt(req.query.tournamentId, undefined);

    const leagueMatchFilter = {
      match: {
        ...(leagueId != null ? { leagueId } : {}),
        date: { gte: date_gte, lte: date_lte },
        matchReferees: {
          some: { refereeId: id, ...(roles ? { role: { in: roles } } : {}) },
        },
      },
    };
    const tMatchFilter = {
      match: {
        ...(tournamentId != null ? { tournamentId } : {}),
        date: { gte: date_gte, lte: date_lte },
        referees: {
          some: { refereeId: id, ...(roles ? { role: { in: roles } } : {}) },
        },
      },
    };

    const [leagueYellow, leagueRed, tournamentYellow, tournamentRed] =
      await Promise.all([
        prisma.matchEvent.count({
          where: { type: 'YELLOW_CARD', ...leagueMatchFilter },
        }),
        prisma.matchEvent.count({
          where: { type: 'RED_CARD', ...leagueMatchFilter },
        }),
        prisma.tournamentMatchEvent.count({
          where: { type: 'YELLOW_CARD', ...tMatchFilter },
        }),
        prisma.tournamentMatchEvent.count({
          where: { type: 'RED_CARD', ...tMatchFilter },
        }),
      ]);

    res.json({
      league: {
        yellow: leagueYellow,
        red: leagueRed,
        total: leagueYellow + leagueRed,
      },
      tournament: {
        yellow: tournamentYellow,
        red: tournamentRed,
        total: tournamentYellow + tournamentRed,
      },
      total: {
        yellow: leagueYellow + tournamentYellow,
        red: leagueRed + tournamentRed,
        total: leagueYellow + tournamentYellow + leagueRed + tournamentRed,
      },
      _filters: {
        roles: roles || 'ANY',
        date_gte: date_gte || null,
        date_lte: date_lte || null,
        leagueId: leagueId ?? null,
        tournamentId: tournamentId ?? null,
      },
    });
  } catch (e) {
    console.error('GET /referees/:id/cards', e);
    res.status(500).json({ error: 'Ошибка подсчёта карточек' });
  }
});

/* MATCHES (league) */
router.get('/:id(\\d+)/matches', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const range = safeJSON(req.query.range, [0, 49]);
    const [start, end] = range;
    const AND = [{ refereeId: id }];
    if (req.query.leagueId != null)
      AND.push({ match: { leagueId: Number(req.query.leagueId) } });
    if (req.query.role) AND.push({ role: req.query.role });
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
      prisma.matchReferee.findMany({
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
      prisma.matchReferee.count({ where }),
    ]);

    setRange(res, 'refMatches', start, rows.length, total);
    res.json(rows);
  } catch (e) {
    console.error('GET /referees/:id/matches', e);
    res.status(500).json({ error: 'Ошибка загрузки матчей судьи' });
  }
});

/* TOURNAMENT matches */
router.get('/:id(\\d+)/tournament-matches', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const range = safeJSON(req.query.range, [0, 49]);
    const [start, end] = range;
    const AND = [{ refereeId: id }];
    if (req.query.tournamentId != null)
      AND.push({ match: { tournamentId: Number(req.query.tournamentId) } });
    if (req.query.role) AND.push({ role: req.query.role });
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
      prisma.tournamentMatchReferee.findMany({
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
      prisma.tournamentMatchReferee.count({ where }),
    ]);

    setRange(res, 'tRefMatches', start, rows.length, total);
    res.json(rows);
  } catch (e) {
    console.error('GET /referees/:id/tournament-matches', e);
    res.status(500).json({ error: 'Ошибка загрузки матчей турнира' });
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
    const created = await prisma.referee.create({
      data: { name: name.trim(), images: toStrArr(images) },
    });
    res.status(201).json(created);
  } catch (e) {
    console.error('POST /referees', e);
    res.status(500).json({ error: 'Ошибка создания' });
  }
});

router.patch('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const patch = {};
    if (req.body.name !== undefined) patch.name = req.body.name;
    if (req.body.images !== undefined) patch.images = toStrArr(req.body.images);
    const updated = await prisma.referee.update({ where: { id }, data: patch });
    res.json(updated);
  } catch (e) {
    console.error('PATCH /referees/:id', e);
    res.status(500).json({ error: 'Ошибка обновления' });
  }
});

router.put('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, images = [] } = req.body;
    const updated = await prisma.referee.update({
      where: { id },
      data: { name, images: toStrArr(images) },
    });
    res.json(updated);
  } catch (e) {
    console.error('PUT /referees/:id', e);
    res.status(500).json({ error: 'Ошибка обновления' });
  }
});

router.delete('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    await prisma.referee.delete({ where: { id } });
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /referees/:id', e);
    res.status(500).json({ error: 'Ошибка удаления' });
  }
});

/* =========================================================
   IMAGES: append / remove / reorder (как у игрока)
========================================================= */

// append images (добавить в конец массива)
router.post('/:id(\\d+)/images', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const add = toStrArr(req.body?.images || []);
    if (!add.length) return res.status(400).json({ error: 'Нечего добавлять' });

    const cur = await prisma.referee.findUnique({
      where: { id },
      select: { images: true },
    });
    if (!cur) return res.status(404).json({ error: 'Referee not found' });

    const next = [...(cur.images || []), ...add];
    const updated = await prisma.referee.update({
      where: { id },
      data: { images: next },
      select: { id: true, images: true },
    });
    res.json(updated);
  } catch (e) {
    console.error('POST /referees/:id/images', e);
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

    const row = await prisma.referee.findUnique({
      where: { id },
      select: { images: true },
    });
    if (!row) return res.status(404).json({ error: 'Referee not found' });

    let next = [...(row.images || [])];
    if (byPath) next = next.filter((p) => p !== byPath);
    if (byIndex != null) next = next.filter((_, i) => i !== byIndex);

    const updated = await prisma.referee.update({
      where: { id },
      data: { images: next },
      select: { id: true, images: true },
    });

    // опционально: удалить файл(ы) с диска, если есть утилита deleteFiles([...])
    res.json(updated);
  } catch (e) {
    console.error('DELETE /referees/:id/images', e);
    res.status(500).json({ error: 'Не удалось удалить фото' });
  }
});

// reorder (set full array)
router.patch('/:id(\\d+)/images/reorder', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const ordered = toStrArr(req.body?.images || []);
    const updated = await prisma.referee.update({
      where: { id },
      data: { images: ordered },
      select: { id: true, images: true },
    });
    res.json(updated);
  } catch (e) {
    console.error('PATCH /referees/:id/images/reorder', e);
    res.status(500).json({ error: 'Не удалось переупорядочить фото' });
  }
});

/* =========================================================
   ASSIGN / DETACH
========================================================= */
router.post('/:id(\\d+)/assign', async (req, res) => {
  try {
    const refereeId = Number(req.params.id);
    const matchId = toInt(req.body.matchId);
    const tMatchId = toInt(req.body.tournamentMatchId);
    const role = req.body.role ?? null;
    if (matchId == null && tMatchId == null) {
      return res
        .status(400)
        .json({ error: 'Нужно matchId или tournamentMatchId' });
    }

    const result =
      matchId != null
        ? await prisma.matchReferee.upsert({
            where: { matchId_refereeId: { matchId, refereeId } },
            update: { role },
            create: { matchId, refereeId, role },
          })
        : await prisma.tournamentMatchReferee.upsert({
            where: { matchId_refereeId: { matchId: tMatchId, refereeId } },
            update: { role },
            create: { matchId: tMatchId, refereeId, role },
          });

    res.json(result);
  } catch (e) {
    console.error('POST /referees/:id/assign', e);
    res.status(400).json({ error: 'Не удалось назначить судью' });
  }
});

router.delete('/:id(\\d+)/assign', async (req, res) => {
  try {
    const refereeId = Number(req.params.id);
    const matchId = toInt(req.query.matchId);
    const tMatchId = toInt(req.query.tournamentMatchId);
    if (matchId == null && tMatchId == null) {
      return res
        .status(400)
        .json({ error: 'Нужно matchId или tournamentMatchId' });
    }

    if (matchId != null) {
      await prisma.matchReferee.delete({
        where: { matchId_refereeId: { matchId, refereeId } },
      });
    } else {
      await prisma.tournamentMatchReferee.delete({
        where: { matchId_refereeId: { matchId: tMatchId, refereeId } },
      });
    }
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /referees/:id/assign', e);
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

    const leagueAgg = await prisma.matchReferee.groupBy({
      by: ['refereeId'],
      where: {
        match: {
          leagueId: leagueId ?? undefined,
          date: { gte: date_gte, lte: date_lte },
        },
      },
      _count: { _all: true },
    });
    const tournAgg = await prisma.tournamentMatchReferee.groupBy({
      by: ['refereeId'],
      where: { match: { date: { gte: date_gte, lte: date_lte } } },
      _count: { _all: true },
    });

    const map = new Map();
    for (const r of leagueAgg)
      map.set(r.refereeId, { league: r._count._all, tournament: 0 });
    for (const r of tournAgg) {
      map.set(r.refereeId, {
        ...(map.get(r.refereeId) || { league: 0, tournament: 0 }),
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

    const refs = await prisma.referee.findMany({
      where: { id: { in: items.map((i) => i.id) } },
      select: { id: true, name: true, images: true },
    });
    const refMap = new Map(refs.map((r) => [r.id, r]));
    res.json(
      items.map((i) => ({
        id: i.id,
        name: refMap.get(i.id)?.name || `#${i.id}`,
        images: refMap.get(i.id)?.images || [],
        _count: { matchRefs: i.league, tournamentMatchRefs: i.tournament },
        _totals: { league: i.league, tournament: i.tournament, total: i.total },
      }))
    );
  } catch (e) {
    console.error('GET /referees/leaderboard/top', e);
    res.status(500).json({ error: 'Ошибка загрузки топа судей' });
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
    const result = await prisma.referee.createMany({
      data,
      skipDuplicates: true,
    });
    res.status(201).json({ count: result.count });
  } catch (e) {
    console.error('POST /referees/bulk', e);
    res.status(500).json({ error: 'Ошибка пакетного создания' });
  }
});

router.delete('/bulk', async (req, res) => {
  try {
    const ids = safeJSON(req.query.ids, []).map(Number).filter(Number.isFinite);
    if (!ids.length) return res.status(400).json({ error: 'Нужно ids' });
    const result = await prisma.referee.deleteMany({
      where: { id: { in: ids } },
    });
    res.json({ count: result.count });
  } catch (e) {
    console.error('DELETE /referees/bulk', e);
    res.status(500).json({ error: 'Ошибка пакетного удаления' });
  }
});

export default router;
