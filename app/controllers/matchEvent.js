// app/controllers/matchEvent.js
import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { getIO } from '../socket.js';

const router = Router();
const prisma = new PrismaClient();

/* ============ helpers ============ */
const safeJSON = (v, fb) => {
  try {
    return v ? JSON.parse(String(v)) : fb;
  } catch {
    return fb;
  }
};
const toInt = (v, d = undefined) => (v === '' || v == null ? d : Number(v));
const bool = (v) =>
  ['true', '1', 'yes', 'on'].includes(String(v).toLowerCase());

const GOAL_TYPES = new Set(['GOAL', 'PENALTY_SCORED']);
const isGoalType = (t) => GOAL_TYPES.has(String(t));

/** собрать include для Prisma. Поддерживаем алиасы referee|issued_by_referee → issuedByReferee */
const buildInclude = (includeParam) => {
  const parts = new Set(
    String(includeParam || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
  const has = (...keys) => keys.some((k) => parts.has(k));
  return {
    player: has('player'),
    assist_player: has('assist_player', 'assist'),
    team: has('team'),
    issuedByReferee: has('issuedbyreferee', 'referee', 'issued_by_referee'),
    match: has('match')
      ? {
          include: {
            league: true,
            team1: true,
            team2: true,
            stadiumRel: true,
          },
        }
      : false,
  };
};

/** вытащить id судьи из разных полей тела запроса */
const pickRefId = (body) => {
  const cand =
    toInt(body?.issuedByRefereeId) ??
    toInt(body?.refereeId) ??
    toInt(body?.issued_by_referee_id);
  return Number.isFinite(cand) ? cand : null;
};

/* ---------- stats helpers (tx-aware) ---------- */
async function incrementStat(tx, playerId, type) {
  if (!playerId) return;
  await tx.playerStat.upsert({
    where: { playerId },
    update: {
      ...(isGoalType(type) ? { goals: { increment: 1 } } : {}),
      ...(type === 'ASSIST' ? { assists: { increment: 1 } } : {}),
      ...(type === 'YELLOW_CARD' ? { yellow_cards: { increment: 1 } } : {}),
      ...(type === 'RED_CARD' ? { red_cards: { increment: 1 } } : {}),
    },
    create: {
      playerId,
      goals: isGoalType(type) ? 1 : 0,
      assists: type === 'ASSIST' ? 1 : 0,
      yellow_cards: type === 'YELLOW_CARD' ? 1 : 0,
      red_cards: type === 'RED_CARD' ? 1 : 0,
    },
  });
}

async function decrementStat(tx, playerId, type) {
  if (!playerId) return;
  await tx.playerStat.updateMany({
    where: { playerId },
    data: {
      ...(isGoalType(type) ? { goals: { decrement: 1 } } : {}),
      ...(type === 'ASSIST' ? { assists: { decrement: 1 } } : {}),
      ...(type === 'YELLOW_CARD' ? { yellow_cards: { decrement: 1 } } : {}),
      ...(type === 'RED_CARD' ? { red_cards: { decrement: 1 } } : {}),
    },
  });
}

/* ---------- validations ---------- */
async function assertTeamBelongsToMatch(tx, matchId, teamId) {
  const m = await tx.match.findUnique({
    where: { id: matchId },
    select: { id: true, team1Id: true, team2Id: true },
  });
  if (!m) throw new Error('Матч не найден');
  if (![m.team1Id, m.team2Id].includes(teamId))
    throw new Error('Команда не участвует в матче');
  return m;
}

async function assertPlayerBelongsToTeam(tx, playerId, teamId) {
  if (!playerId) return;
  const p = await tx.player.findUnique({
    where: { id: playerId },
    select: { id: true, teamId: true },
  });
  if (!p) throw new Error('Игрок не найден');
  if (p.teamId !== teamId)
    throw new Error('Игрок не принадлежит указанной команде');
}

/* ---------- score recompute (tx-aware) ---------- */
async function recomputeMatchScore(tx, matchId) {
  const grouped = await tx.matchEvent.groupBy({
    by: ['teamId'],
    where: { matchId, type: { in: ['GOAL', 'PENALTY_SCORED'] } },
    _count: { _all: true },
  });
  const m = await tx.match.findUnique({
    where: { id: matchId },
    select: { id: true, team1Id: true, team2Id: true },
  });
  if (!m) return;
  const map = new Map(grouped.map((g) => [g.teamId, g._count._all]));
  const team1Score = map.get(m.team1Id) || 0;
  const team2Score = map.get(m.team2Id) || 0;
  await tx.match.update({
    where: { id: matchId },
    data: { team1Score, team2Score },
  });
}

/* ================= LIST ================= */
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
      sortField === 'match.date'
        ? { match: { date: sortOrder } }
        : { [sortField]: sortOrder };

    const AND = [];
    if (Array.isArray(filter.id) && filter.id.length) {
      AND.push({ id: { in: filter.id.map(Number).filter(Number.isFinite) } });
    }
    if (filter.matchId != null && Number.isFinite(Number(filter.matchId))) {
      AND.push({ matchId: Number(filter.matchId) });
    }
    if (filter.teamId != null && Number.isFinite(Number(filter.teamId))) {
      AND.push({ teamId: Number(filter.teamId) });
    }
    if (filter.playerId != null && Number.isFinite(Number(filter.playerId))) {
      AND.push({ playerId: Number(filter.playerId) });
    }
    if (
      filter.assistPlayerId != null &&
      Number.isFinite(Number(filter.assistPlayerId))
    ) {
      AND.push({ assistPlayerId: Number(filter.assistPlayerId) });
    }
    if (typeof filter.type === 'string' && filter.type.trim()) {
      AND.push({ type: filter.type.trim() });
    }
    if (Array.isArray(filter.type) && filter.type.length) {
      AND.push({ type: { in: filter.type } });
    }
    if (filter.half != null && Number.isFinite(Number(filter.half))) {
      AND.push({ half: Number(filter.half) });
    }
    if (filter.minute_gte || filter.minute_lte) {
      AND.push({
        minute: {
          gte:
            filter.minute_gte != null ? Number(filter.minute_gte) : undefined,
          lte:
            filter.minute_lte != null ? Number(filter.minute_lte) : undefined,
        },
      });
    }
    if (filter.goalOnly != null && bool(filter.goalOnly)) {
      AND.push({ type: { in: ['GOAL', 'PENALTY_SCORED'] } });
    }

    const where = AND.length ? { AND } : undefined;
    const inc = buildInclude(req.query.include);

    const [rows, total] = await Promise.all([
      prisma.matchEvent.findMany({
        skip: start,
        take,
        where,
        orderBy,
        include: {
          player: inc.player,
          assist_player: inc.assist_player,
          team: inc.team,
          issuedByReferee: inc.issuedByReferee,
          match: inc.match,
        },
      }),
      prisma.matchEvent.count({ where }),
    ]);

    res.setHeader(
      'Content-Range',
      `matchEvents ${start}-${start + rows.length - 1}/${total}`
    );
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range');
    res.json(rows);
  } catch (err) {
    console.error('GET /match-events', err);
    res.status(500).json({ error: 'Ошибка загрузки событий' });
  }
});

/* -------- удобный список по матчу -------- */
router.get('/by-match/:matchId(\\d+)', async (req, res) => {
  try {
    const matchId = Number(req.params.matchId);
    const inc = buildInclude(
      req.query.include || 'player,assist_player,team,issuedByReferee'
    );
    const rows = await prisma.matchEvent.findMany({
      where: { matchId },
      orderBy: [{ half: 'asc' }, { minute: 'asc' }, { id: 'asc' }],
      include: {
        player: inc.player,
        assist_player: inc.assist_player,
        team: inc.team,
        issuedByReferee: inc.issuedByReferee,
      },
    });
    res.json(rows);
  } catch (e) {
    console.error('GET /match-events/by-match/:matchId', e);
    res.status(500).json({ error: 'Ошибка загрузки событий матча' });
  }
});

/* ================= ITEM ================= */
router.get('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const inc = buildInclude(
      req.query.include || 'player,assist_player,team,issuedByReferee,match'
    );
    const event = await prisma.matchEvent.findUnique({
      where: { id },
      include: {
        player: inc.player,
        assist_player: inc.assist_player,
        team: inc.team,
        issuedByReferee: inc.issuedByReferee,
        match: inc.match,
      },
    });
    if (!event) return res.status(404).json({ error: 'Not found' });
    res.json(event);
  } catch (err) {
    console.error('GET /match-events/:id', err);
    res.status(500).json({ error: 'Ошибка загрузки события' });
  }
});

/* ================= CREATE ================= */
router.post('/', async (req, res) => {
  try {
    const {
      minute = 0,
      half = 1,
      type,
      description = '',
      playerId,
      assistPlayerId,
      teamId,
      matchId,
    } = req.body;

    if (!matchId || !teamId || !type) {
      return res
        .status(400)
        .json({ error: 'matchId, teamId и type обязательны' });
    }

    const issuedByRefereeId = pickRefId(req.body);

    const created = await prisma.$transaction(async (tx) => {
      // валидации
      const m = await assertTeamBelongsToMatch(
        tx,
        Number(matchId),
        Number(teamId)
      );
      if (playerId)
        await assertPlayerBelongsToTeam(tx, Number(playerId), Number(teamId));
      if (assistPlayerId)
        await assertPlayerBelongsToTeam(
          tx,
          Number(assistPlayerId),
          Number(teamId)
        );

      // создать событие
      const ev = await tx.matchEvent.create({
        data: {
          minute: Number(minute) || 0,
          half: Number(half) || 1,
          type,
          description: String(description || ''),
          playerId: playerId != null ? Number(playerId) : null,
          assistPlayerId:
            assistPlayerId != null ? Number(assistPlayerId) : null,
          issuedByRefereeId,
          teamId: Number(teamId),
          matchId: Number(matchId),
        },
      });

      // обновить стату
      if (playerId) await incrementStat(tx, Number(playerId), type);
      if (assistPlayerId && type === 'GOAL') {
        await incrementStat(tx, Number(assistPlayerId), 'ASSIST');
      }

      // пересчёт счета
      if (isGoalType(type)) await recomputeMatchScore(tx, m.id);

      // вернуть с инклюдами (включая судью)
      return tx.matchEvent.findUnique({
        where: { id: ev.id },
        include: {
          player: true,
          assist_player: true,
          team: true,
          issuedByReferee: true,
          match: true,
        },
      });
    });

    // 🔔 Socket: событие
    const io = getIO();
    io.to(`match:${created.matchId}`).emit('event:created', created);

    // 🔔 Socket: актуальный счёт
    const m = await prisma.match.findUnique({
      where: { id: created.matchId },
      select: {
        id: true,
        leagueId: true,
        team1Score: true,
        team2Score: true,
      },
    });
    if (m) {
      io.to(`match:${m.id}`).emit('match:score', {
        matchId: m.id,
        team1Score: m.team1Score,
        team2Score: m.team2Score,
      });
      io.to(`league:${m.leagueId}`).emit('match:update', m);
    }

    res.status(201).json(created);
  } catch (err) {
    console.error('POST /match-events', err);
    res
      .status(500)
      .json({ error: 'Ошибка создания события', details: err.message });
  }
});

/* ================= PATCH ================= */
router.patch('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const {
      minute,
      half,
      type,
      description,
      playerId,
      assistPlayerId,
      teamId,
    } = req.body;

    const newRefId =
      Object.prototype.hasOwnProperty.call(req.body, 'issuedByRefereeId') ||
      Object.prototype.hasOwnProperty.call(req.body, 'refereeId') ||
      Object.prototype.hasOwnProperty.call(req.body, 'issued_by_referee_id')
        ? pickRefId(req.body)
        : undefined;

    const updated = await prisma.$transaction(async (tx) => {
      const old = await tx.matchEvent.findUnique({ where: { id } });
      if (!old) throw new Error('Событие не найдено');

      const newType = type ?? old.type;
      const newTeamId = teamId != null ? Number(teamId) : old.teamId;
      const newPlayerId =
        playerId !== undefined
          ? playerId == null
            ? null
            : Number(playerId)
          : old.playerId;
      const newAssistId =
        assistPlayerId !== undefined
          ? assistPlayerId == null
            ? null
            : Number(assistPlayerId)
          : old.assistPlayerId;

      // валидации
      const m = await assertTeamBelongsToMatch(tx, old.matchId, newTeamId);
      if (newPlayerId)
        await assertPlayerBelongsToTeam(tx, newPlayerId, newTeamId);
      if (newAssistId)
        await assertPlayerBelongsToTeam(tx, newAssistId, newTeamId);

      // снять старые вклады
      if (old.playerId) await decrementStat(tx, old.playerId, old.type);
      if (old.assistPlayerId && old.type === 'GOAL') {
        await decrementStat(tx, old.assistPlayerId, 'ASSIST');
      }

      // апдейт события (+ судья если передан)
      const ev = await tx.matchEvent.update({
        where: { id },
        data: {
          minute: minute !== undefined ? Number(minute) : undefined,
          half: half !== undefined ? Number(half) : undefined,
          type: type !== undefined ? type : undefined,
          description:
            description !== undefined ? String(description) : undefined,
          playerId: newPlayerId,
          assistPlayerId: newAssistId,
          teamId: newTeamId,
          ...(newRefId !== undefined ? { issuedByRefereeId: newRefId } : {}),
        },
      });

      // применить новые вклады
      if (newPlayerId) await incrementStat(tx, newPlayerId, newType);
      if (newAssistId && newType === 'GOAL') {
        await incrementStat(tx, newAssistId, 'ASSIST');
      }

      // если тип/команда/гол — пересчитать счёт
      if (
        isGoalType(newType) ||
        isGoalType(old.type) ||
        newTeamId !== old.teamId
      ) {
        await recomputeMatchScore(tx, m.id);
      }

      return tx.matchEvent.findUnique({
        where: { id: ev.id },
        include: {
          player: true,
          assist_player: true,
          team: true,
          issuedByReferee: true,
          match: true,
        },
      });
    });

    // 🔔 Socket
    const io = getIO();
    io.to(`match:${updated.matchId}`).emit('event:updated', updated);

    const m = await prisma.match.findUnique({
      where: { id: updated.matchId },
      select: {
        id: true,
        leagueId: true,
        team1Score: true,
        team2Score: true,
      },
    });
    if (m) {
      io.to(`match:${m.id}`).emit('match:score', {
        matchId: m.id,
        team1Score: m.team1Score,
        team2Score: m.team2Score,
      });
      io.to(`league:${m.leagueId}`).emit('match:update', m);
    }

    res.json(updated);
  } catch (err) {
    console.error('PATCH /match-events/:id', err);
    res
      .status(500)
      .json({ error: 'Ошибка обновления события', details: err.message });
  }
});

/* ================= PUT -> PATCH ================= */
router.put('/:id(\\d+)', async (req, res) => {
  req.params.id = String(req.params.id);
  return router.handle({ ...req, method: 'PATCH', url: req.url }, res);
});

/* ================= DELETE ================= */
router.delete('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);

    const deletedInfo = await prisma.$transaction(async (tx) => {
      const old = await tx.matchEvent.findUnique({ where: { id } });
      if (!old) throw new Error('Событие не найдено');

      await tx.matchEvent.delete({ where: { id } });

      if (old.playerId) await decrementStat(tx, old.playerId, old.type);
      if (old.assistPlayerId && old.type === 'GOAL') {
        await decrementStat(tx, old.assistPlayerId, 'ASSIST');
      }
      if (isGoalType(old.type)) await recomputeMatchScore(tx, old.matchId);

      return { oldMatchId: old.matchId };
    });

    // 🔔 Socket
    const io = getIO();
    io.to(`match:${deletedInfo.oldMatchId}`).emit('event:deleted', {
      id,
      matchId: deletedInfo.oldMatchId,
    });

    const m = await prisma.match.findUnique({
      where: { id: deletedInfo.oldMatchId },
      select: {
        id: true,
        leagueId: true,
        team1Score: true,
        team2Score: true,
      },
    });
    if (m) {
      io.to(`match:${m.id}`).emit('match:score', {
        matchId: m.id,
        team1Score: m.team1Score,
        team2Score: m.team2Score,
      });
      io.to(`league:${m.leagueId}`).emit('match:update', m);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /match-events/:id', err);
    res
      .status(500)
      .json({ error: 'Ошибка удаления события', details: err.message });
  }
});

/* ================= RECOMPUTE SCORE ================= */
router.post('/recompute-score/:matchId(\\d+)', async (req, res) => {
  try {
    const matchId = Number(req.params.matchId);
    await prisma.$transaction((tx) => recomputeMatchScore(tx, matchId));
    const m = await prisma.match.findUnique({
      where: { id: matchId },
      select: {
        id: true,
        leagueId: true,
        team1Score: true,
        team2Score: true,
      },
    });

    // 🔔 Socket
    const io = getIO();
    if (m) {
      io.to(`match:${m.id}`).emit('match:score', {
        matchId: m.id,
        team1Score: m.team1Score,
        team2Score: m.team2Score,
      });
      io.to(`league:${m.leagueId}`).emit('match:update', m);
    }

    res.json(m);
  } catch (e) {
    console.error('POST /match-events/recompute-score/:matchId', e);
    res.status(500).json({ error: 'Не удалось пересчитать счёт' });
  }
});

/* ================= BULK CREATE ================= */
router.post('/bulk', async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: 'Пустой список' });

    const results = await prisma.$transaction(async (tx) => {
      const created = [];
      for (const raw of items) {
        const {
          minute = 0,
          half = 1,
          type,
          description = '',
          playerId,
          assistPlayerId,
          teamId,
          matchId,
        } = raw;
        if (!matchId || !teamId || !type)
          throw new Error('matchId, teamId и type обязательны');

        const m = await assertTeamBelongsToMatch(
          tx,
          Number(matchId),
          Number(teamId)
        );
        if (playerId)
          await assertPlayerBelongsToTeam(tx, Number(playerId), Number(teamId));
        if (assistPlayerId)
          await assertPlayerBelongsToTeam(
            tx,
            Number(assistPlayerId),
            Number(teamId)
          );

        const issuedByRefereeId = pickRefId(raw);

        const ev = await tx.matchEvent.create({
          data: {
            minute: Number(minute) || 0,
            half: Number(half) || 1,
            type,
            description: String(description || ''),
            playerId: playerId != null ? Number(playerId) : null,
            assistPlayerId:
              assistPlayerId != null ? Number(assistPlayerId) : null,
            issuedByRefereeId,
            teamId: Number(teamId),
            matchId: Number(matchId),
          },
        });

        if (playerId) await incrementStat(tx, Number(playerId), type);
        if (assistPlayerId && type === 'GOAL')
          await incrementStat(tx, Number(assistPlayerId), 'ASSIST');

        if (isGoalType(type)) await recomputeMatchScore(tx, m.id);

        created.push(ev);
      }
      return created;
    });

    // 🔔 Socket
    const io = getIO();
    const matchId = results[0]?.matchId;
    if (matchId) {
      // подтянем объекты с инклюдами для фронта
      const detailed = await prisma.matchEvent.findMany({
        where: { id: { in: results.map((r) => r.id) } },
        include: {
          player: true,
          assist_player: true,
          team: true,
          issuedByReferee: true,
          match: true,
        },
        orderBy: [{ half: 'asc' }, { minute: 'asc' }, { id: 'asc' }],
      });
      io.to(`match:${matchId}`).emit('events:bulkCreated', detailed);

      const m = await prisma.match.findUnique({
        where: { id: matchId },
        select: {
          id: true,
          leagueId: true,
          team1Score: true,
          team2Score: true,
        },
      });
      if (m) {
        io.to(`match:${m.id}`).emit('match:score', {
          matchId: m.id,
          team1Score: m.team1Score,
          team2Score: m.team2Score,
        });
        io.to(`league:${m.leagueId}`).emit('match:update', m);
      }
    }

    res.status(201).json({ count: results.length, items: results });
  } catch (e) {
    console.error('POST /match-events/bulk', e);
    res
      .status(500)
      .json({ error: 'Ошибка пакетного создания', details: e.message });
  }
});

export default router;
