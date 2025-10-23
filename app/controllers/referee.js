// app/controllers/referee.js
import { Router } from 'express';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

/* ------------ utils ------------ */
const safeJSON = (v, fb) => {
  try {
    return v ? JSON.parse(String(v)) : fb;
  } catch {
    return fb;
  }
};
const toInt = (v, d = undefined) => (v === '' || v == null ? d : Number(v));
const toDate = (v) => (v ? new Date(v) : undefined);
const bool = (v) =>
  ['true', '1', 'yes', 'on'].includes(String(v).toLowerCase());
const setRange = (res, name, start, count, total) => {
  res.setHeader(
    'Content-Range',
    `${name} ${start}-${start + count - 1}/${total}`
  );
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range');
};

/* ------------ roles helper (для отбора главных и т.п.) ------------ */
// Подстрой под реальные значения ролей "главного" у тебя в базе
const defaultMainRoles = ['MAIN', 'REFEREE', 'CHIEF', 'HEAD'];
const parseRoles = (req) => {
  // допускаем JSON-массив в roles или строку "MAIN,FOURTH"
  const raw = req.query.roles;
  const parsed = safeJSON(raw, null);
  if (Array.isArray(parsed) && parsed.length) return parsed.map(String);
  if (typeof raw === 'string' && raw.trim().length) {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const onlyMain = req.query.onlyMain == null ? true : bool(req.query.onlyMain);
  return onlyMain ? defaultMainRoles : undefined; // undefined = любые роли
};

/* =========================================================
   LIST  GET /referees
   filter:
     id: [1,2] | q | name | leagueId | role | date_gte/lte | hasMatches
   sort:
     ["id"|"name"|"createdAt"|"matches","ASC"|"DESC"]
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
      const q = filter.q.trim();
      AND.push({ name: { contains: q, mode: 'insensitive' } });
    }
    if (typeof filter.name === 'string' && filter.name.trim()) {
      AND.push({ name: { contains: filter.name.trim(), mode: 'insensitive' } });
    }

    // фильтры по назначенным матчам
    const matchSubWhere = {};
    if (filter.leagueId != null && Number.isFinite(Number(filter.leagueId))) {
      matchSubWhere.match = {
        ...(matchSubWhere.match || {}),
        leagueId: Number(filter.leagueId),
      };
    }
    if (filter.role) {
      matchSubWhere.role = filter.role;
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
      AND.push({ matchRefs: { some: matchSubWhere } });
    }
    if (filter.hasMatches != null) {
      AND.push(
        bool(filter.hasMatches)
          ? { matchRefs: { some: {} } }
          : { matchRefs: { none: {} } }
      );
    }

    const where = AND.length ? { AND } : undefined;

    const [rows, total] = await Promise.all([
      prisma.referee.findMany({
        skip: start,
        take,
        where,
        orderBy,
        include: {
          _count: { select: { matchRefs: true } },
        },
      }),
      prisma.referee.count({ where }),
    ]);

    setRange(res, 'referees', start, rows.length, total);
    res.json(rows);
  } catch (e) {
    console.error('GET /referees', e);
    res.status(500).json({ error: 'Ошибка загрузки судей' });
  }
});

/* =========================================================
   QUICK SEARCH  GET /referees/search?q=...
   ========================================================= */
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

/* =========================================================
   ITEM  GET /referees/:id
   ========================================================= */
router.get('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const item = await prisma.referee.findUnique({
      where: { id },
      include: {
        _count: { select: { matchRefs: true } },
      },
    });
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  } catch (e) {
    console.error('GET /referees/:id', e);
    res.status(500).json({ error: 'Ошибка' });
  }
});

/* =========================================================
   STATS  GET /referees/:id/stats
   + карточки (yellow/red), опциональные фильтры: onlyMain=true (по умолчанию),
     roles=["MAIN","FOURTH"], date_gte/lte, leagueId, tournamentId
   ========================================================= */
router.get('/:id(\\d+)/stats', async (req, res) => {
  try {
    const id = Number(req.params.id);

    // ---- существующие агрегаты по лигам ----
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
      const lid = leagueMap.get(r.matchId) ?? null;
      if (!lid) return;
      leagueAgg[lid] ||= { leagueId: lid, total: 0, byRole: {} };
      leagueAgg[lid].total += 1;
      leagueAgg[lid].byRole[r.role || 'UNKNOWN'] =
        (leagueAgg[lid].byRole[r.role || 'UNKNOWN'] || 0) + 1;
    });

    // ---- существующие агрегаты по турнирам ----
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
      const tid = tMap.get(r.matchId) ?? null;
      if (!tid) return;
      tournAgg[tid] ||= { tournamentId: tid, total: 0, byRole: {} };
      tournAgg[tid].total += 1;
      tournAgg[tid].byRole[r.role || 'UNKNOWN'] =
        (tournAgg[tid].byRole[r.role || 'UNKNOWN'] || 0) + 1;
    });

    // ---- карточки с фильтрами ----
    const roles = parseRoles(req); // по умолчанию — главные
    const date_gte = req.query.date_gte
      ? new Date(req.query.date_gte)
      : undefined;
    const date_lte = req.query.date_lte
      ? new Date(req.query.date_lte)
      : undefined;
    const leagueId = toInt(req.query.leagueId, undefined);
    const tournamentId = toInt(req.query.tournamentId, undefined);

    // ЛИГОВЫЕ карточки (MatchEvent → match)
    const leagueMatchFilter = {
      match: {
        ...(leagueId != null ? { leagueId } : {}),
        date: { gte: date_gte, lte: date_lte },
        matchReferees: {
          some: {
            refereeId: id,
            ...(roles ? { role: { in: roles } } : {}),
          },
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

    // ТУРНИРНЫЕ карточки (TournamentMatchEvent → match)
    const tMatchFilter = {
      match: {
        ...(tournamentId != null ? { tournamentId } : {}),
        date: { gte: date_gte, lte: date_lte },
        referees: {
          some: {
            refereeId: id,
            ...(roles ? { role: { in: roles } } : {}),
          },
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

    const cards = {
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
    };

    res.json({
      leagues: Object.values(leagueAgg),
      tournaments: Object.values(tournAgg),
      totals: {
        leagueMatches: matchIds.length,
        tournamentMatches: tMatchIds.length,
      },
      cards,
    });
  } catch (e) {
    console.error('GET /referees/:id/stats', e);
    res.status(500).json({ error: 'Ошибка статистики судьи' });
  }
});

/* =========================================================
   CARDS-ONLY  GET /referees/:id/cards
   Параметры: onlyMain (true по умолчанию), roles, date_gte/lte, leagueId, tournamentId
   ========================================================= */
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

/* =========================================================
   MATCHES of referee (лиговые): GET /referees/:id/matches
   ========================================================= */
router.get('/:id(\\d+)/matches', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const range = safeJSON(req.query.range, [0, 49]);
    const [start, end] = range;
    const take = Math.max(0, end - start + 1);

    const AND = [{ refereeId: id }];
    if (req.query.leagueId != null) {
      AND.push({ match: { leagueId: Number(req.query.leagueId) } });
    }
    if (req.query.role) {
      AND.push({ role: req.query.role });
    }
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
        take,
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

/* =========================================================
   TOURNAMENT matches of referee: GET /referees/:id/tournament-matches
   ========================================================= */
router.get('/:id(\\d+)/tournament-matches', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const range = safeJSON(req.query.range, [0, 49]);
    const [start, end] = range;
    const take = Math.max(0, end - start + 1);

    const AND = [{ refereeId: id }];
    if (req.query.tournamentId != null) {
      AND.push({ match: { tournamentId: Number(req.query.tournamentId) } });
    }
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
        take,
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
   CREATE  POST /referees
   ========================================================= */
router.post('/', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim())
      return res.status(400).json({ error: 'name обязателен' });
    const created = await prisma.referee.create({
      data: { name: name.trim() },
    });
    res.status(201).json(created);
  } catch (e) {
    console.error('POST /referees', e);
    res.status(500).json({ error: 'Ошибка создания' });
  }
});

/* =========================================================
   PATCH  /referees/:id  (частичное)
   ========================================================= */
router.patch('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const patch = {};
    if (req.body.name !== undefined) patch.name = req.body.name;
    const updated = await prisma.referee.update({ where: { id }, data: patch });
    res.json(updated);
  } catch (e) {
    console.error('PATCH /referees/:id', e);
    res.status(500).json({ error: 'Ошибка обновления' });
  }
});

/* =========================================================
   PUT  /referees/:id  (полная замена)
   ========================================================= */
router.put('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name } = req.body;
    const updated = await prisma.referee.update({
      where: { id },
      data: { name },
    });
    res.json(updated);
  } catch (e) {
    console.error('PUT /referees/:id', e);
    res.status(500).json({ error: 'Ошибка обновления' });
  }
});

/* =========================================================
   DELETE  /referees/:id
   ========================================================= */
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
   ASSIGN / DETACH к матчу/турматчу
   POST /referees/:id/assign   { matchId?, tournamentMatchId?, role? }
   DELETE /referees/:id/assign?matchId=... | ?tournamentMatchId=...
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

    let result;
    if (matchId != null) {
      result = await prisma.matchReferee.upsert({
        where: { matchId_refereeId: { matchId, refereeId } },
        update: { role },
        create: { matchId, refereeId, role },
      });
    } else {
      result = await prisma.tournamentMatchReferee.upsert({
        where: { matchId_refereeId: { matchId: tMatchId, refereeId } },
        update: { role },
        create: { matchId: tMatchId, refereeId, role },
      });
    }
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
   LEADERBOARD: топ судей по числу матчей (с учётом фильтров)
   GET /referees/leaderboard/top?leagueId=&date_gte=&date_lte=&limit=20
   ========================================================= */
router.get('/leaderboard/top', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(100, toInt(req.query.limit, 20)));
    const leagueId = toInt(req.query.leagueId);
    const date_gte = toDate(req.query.date_gte);
    const date_lte = toDate(req.query.date_lte);

    const whereRef = {};
    if (leagueId != null || date_gte || date_lte) {
      whereRef.matchRefs = {
        some: {
          match: {
            leagueId: leagueId ?? undefined,
            date: { gte: date_gte, lte: date_lte },
          },
        },
      };
    }

    const rows = await prisma.referee.findMany({
      where: Object.keys(whereRef).length ? whereRef : undefined,
      orderBy: { matchRefs: { _count: 'desc' } },
      take: limit,
      include: { _count: { select: { matchRefs: true } } },
    });
    res.json(rows);
  } catch (e) {
    console.error('GET /referees/leaderboard/top', e);
    res.status(500).json({ error: 'Ошибка загрузки топа судей' });
  }
});

/* =========================================================
   BULK: create/delete
   POST /referees/bulk  { names: ["A","B",...] }
   DELETE /referees/bulk?ids=[1,2,3]
   ========================================================= */
router.post('/bulk', async (req, res) => {
  try {
    const names = Array.isArray(req.body?.names)
      ? req.body.names.filter(Boolean)
      : [];
    if (!names.length) return res.status(400).json({ error: 'Пустой список' });
    const data = names
      .map((n) => ({ name: String(n).trim() }))
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
