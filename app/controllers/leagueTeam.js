// app/controllers/leagueTeam.js
import { Router } from 'express';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

const safeJSON = (v, fb) => {
  try {
    return v ? JSON.parse(String(v)) : fb;
  } catch {
    return fb;
  }
};
const toInt = (v, d = undefined) => (v === '' || v == null ? d : Number(v));

/* ------------ helpers & guards ------------ */
async function assertLeagueTeam(leagueTeamId) {
  const lt = await prisma.leagueTeam.findUnique({
    where: { id: leagueTeamId },
    include: { team: true, league: true },
  });
  if (!lt) throw new Error('LeagueTeam не найден');
  return lt;
}
async function assertPlayerOfTeam(playerId, teamId) {
  const p = await prisma.player.findUnique({
    where: { id: playerId },
    select: { id: true, teamId: true },
  });
  if (!p) throw new Error('Игрок не найден');
  if (p.teamId !== teamId) throw new Error('Игрок не принадлежит этой команде');
}
async function assertMatchForLeagueAndTeam(matchId, leagueId, teamId) {
  const m = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      leagueId: true,
      team1Id: true,
      team2Id: true,
    },
  });
  if (!m) throw new Error('Матч не найден');
  if (m.leagueId !== leagueId) throw new Error('Матч из другой лиги');
  if (![m.team1Id, m.team2Id].includes(teamId))
    throw new Error('Команда не участвует в матче');
  return m;
}

/* =========================================================
   СВЯЗЬ ЛИГА—КОМАНДА (LeagueTeam)
   ========================================================= */

// список команд в лиге
// GET /leagues/:leagueId/teams  (?include=roster)
router.get('/leagues/:leagueId(\\d+)/teams', async (req, res) => {
  try {
    const leagueId = Number(req.params.leagueId);
    const includeRoster = String(req.query.include || '')
      .split(',')
      .includes('roster');
    const rows = await prisma.leagueTeam.findMany({
      where: { leagueId },
      orderBy: [{ seed: 'asc' }, { id: 'asc' }],
      include: {
        team: true,
        ...(includeRoster ? { roster: { include: { player: true } } } : {}),
        captainRosterItem: includeRoster,
      },
    });
    res.json(rows);
  } catch (e) {
    console.error('GET /leagues/:leagueId/teams', e);
    res.status(500).json({ error: 'Ошибка загрузки команд лиги' });
  }
});

// прикрепить команду к лиге
// POST /leagues/:leagueId/teams/:teamId/attach  { seed? }
router.post(
  '/leagues/:leagueId(\\d+)/teams/:teamId(\\d+)/attach',
  async (req, res) => {
    try {
      const leagueId = Number(req.params.leagueId);
      const teamId = Number(req.params.teamId);
      const seed = toInt(req.body?.seed, null);
      const lt = await prisma.leagueTeam.upsert({
        where: { leagueId_teamId: { leagueId, teamId } },
        update: { seed },
        create: { leagueId, teamId, seed },
      });
      res.status(201).json(lt);
    } catch (e) {
      console.error('attach leagueTeam', e);
      res.status(400).json({ error: 'Не удалось прикрепить команду' });
    }
  }
);

// открепить
// DELETE /leagues/:leagueId/teams/:teamId/detach
router.delete(
  '/leagues/:leagueId(\\d+)/teams/:teamId(\\d+)/detach',
  async (req, res) => {
    try {
      const leagueId = Number(req.params.leagueId);
      const teamId = Number(req.params.teamId);
      await prisma.leagueTeam.delete({
        where: { leagueId_teamId: { leagueId, teamId } },
      });
      res.json({ success: true });
    } catch (e) {
      console.error('detach leagueTeam', e);
      res.status(400).json({ error: 'Не удалось открепить команду' });
    }
  }
);

/* =========================================================
   РОСТЕР ЛИГИ (LeagueTeamPlayer)
   ========================================================= */

// получить LeagueTeam (c заявкой)
// GET /league-teams/:id
router.get('/league-teams/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const item = await prisma.leagueTeam.findUnique({
      where: { id },
      include: {
        league: true,
        team: true,
        roster: { include: { player: true } },
        captainRosterItem: true,
      },
    });
    if (!item) return res.status(404).json({ error: 'Не найдено' });
    res.json(item);
  } catch (e) {
    console.error('GET /league-teams/:id', e);
    res.status(500).json({ error: 'Ошибка загрузки' });
  }
});

// получить заявку
// GET /league-teams/:id/roster
router.get('/league-teams/:id(\\d+)/roster', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const roster = await prisma.leagueTeamPlayer.findMany({
      where: { leagueTeamId: id },
      orderBy: [{ role: 'asc' }, { number: 'asc' }, { id: 'asc' }],
      include: { player: true },
    });
    res.json(roster);
  } catch (e) {
    console.error('GET /league-teams/:id/roster', e);
    res.status(500).json({ error: 'Ошибка загрузки заявки' });
  }
});

// полная замена заявки (idempotent)
// PUT /league-teams/:id/roster  { items: [{playerId, number?, position?, role?, notes?}], captainPlayerId? }
router.put('/league-teams/:id(\\d+)/roster', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const captainPlayerId = toInt(req.body?.captainPlayerId, null);

    const lt = await assertLeagueTeam(id);

    // валидация принадлежности игроков команде
    for (const it of items) {
      const pid = Number(it.playerId);
      if (Number.isFinite(pid)) await assertPlayerOfTeam(pid, lt.team.id);
    }
    if (captainPlayerId) await assertPlayerOfTeam(captainPlayerId, lt.team.id);

    const result = await prisma.$transaction(async (tx) => {
      await tx.leagueTeamPlayer.deleteMany({ where: { leagueTeamId: id } });
      let created = [];
      if (items.length) {
        created = await Promise.all(
          items.map((it) =>
            tx.leagueTeamPlayer.create({
              data: {
                leagueTeamId: id,
                playerId: Number(it.playerId),
                number: toInt(it.number, null),
                position: it.position ?? null,
                role: it.role ?? null, // STARTER/SUBSTITUTE/RESERVE
                notes: it.notes ?? null,
              },
            })
          )
        );
      }
      // капитан
      if (captainPlayerId) {
        const cap =
          created.find((r) => r.playerId === captainPlayerId) ||
          (await tx.leagueTeamPlayer.findFirst({
            where: { leagueTeamId: id, playerId: captainPlayerId },
          }));
        if (cap) {
          await tx.leagueTeam.update({
            where: { id },
            data: { captainRosterItemId: cap.id },
          });
        }
      } else {
        await tx.leagueTeam.update({
          where: { id },
          data: { captainRosterItemId: null },
        });
      }

      return tx.leagueTeam.findUnique({
        where: { id },
        include: {
          roster: { include: { player: true } },
          captainRosterItem: true,
        },
      });
    });

    res.json(result);
  } catch (e) {
    console.error('PUT /league-teams/:id/roster', e);
    res.status(400).json({ error: e.message || 'Ошибка сохранения заявки' });
  }
});

// добавить одного в заявку
// POST /league-teams/:id/roster  { playerId, number?, position?, role?, notes? }
router.post('/league-teams/:id(\\d+)/roster', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const lt = await assertLeagueTeam(id);
    const playerId = toInt(req.body.playerId);
    if (!playerId)
      return res.status(400).json({ error: 'playerId обязателен' });
    await assertPlayerOfTeam(playerId, lt.team.id);

    const item = await prisma.leagueTeamPlayer.upsert({
      where: { leagueTeamId_playerId: { leagueTeamId: id, playerId } },
      update: {
        number: toInt(req.body.number, undefined),
        position: req.body.position ?? undefined,
        role: req.body.role ?? undefined,
        notes: req.body.notes ?? undefined,
      },
      create: {
        leagueTeamId: id,
        playerId,
        number: toInt(req.body.number, null),
        position: req.body.position ?? null,
        role: req.body.role ?? null,
        notes: req.body.notes ?? null,
      },
    });
    res.status(201).json(item);
  } catch (e) {
    console.error('POST /league-teams/:id/roster', e);
    res.status(400).json({ error: e.message || 'Не удалось добавить игрока' });
  }
});

// удалить из заявки
// DELETE /league-teams/:id/roster/:playerId
router.delete(
  '/league-teams/:id(\\d+)/roster/:playerId(\\d+)',
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      const playerId = Number(req.params.playerId);
      await prisma.leagueTeamPlayer.delete({
        where: { leagueTeamId_playerId: { leagueTeamId: id, playerId } },
      });
      res.json({ success: true });
    } catch (e) {
      console.error('DELETE /league-teams/:id/roster/:playerId', e);
      res.status(400).json({ error: 'Не удалось удалить игрока' });
    }
  }
);

// капитан заявки
// POST /league-teams/:id/captain  { rosterItemId? | playerId? }
router.post('/league-teams/:id(\\d+)/captain', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const rosterItemId = toInt(req.body?.rosterItemId);
    const playerId = toInt(req.body?.playerId);

    let setId = null;
    if (rosterItemId) {
      const exists = await prisma.leagueTeamPlayer.findUnique({
        where: { id: rosterItemId },
      });
      if (!exists || exists.leagueTeamId !== id)
        return res.status(400).json({ error: 'Неверный rosterItemId' });
      setId = rosterItemId;
    } else if (playerId) {
      const item = await prisma.leagueTeamPlayer.findFirst({
        where: { leagueTeamId: id, playerId },
      });
      if (!item) return res.status(400).json({ error: 'Игрок не в заявке' });
      setId = item.id;
    }

    const updated = await prisma.leagueTeam.update({
      where: { id },
      data: { captainRosterItemId: setId },
      include: { captainRosterItem: true },
    });
    res.json(updated);
  } catch (e) {
    console.error('POST /league-teams/:id/captain', e);
    res.status(400).json({ error: 'Не удалось обновить капитана' });
  }
});

/* =========================================================
   ПУБЛИКАЦИЯ ЗАЯВКИ В МАТЧ ЛИГИ → PlayerMatch
   ========================================================= */
// POST /league-teams/:id/publish
// body: { matchId, reset?:true, roleFilter?: "STARTER"|"ALL" }
router.post('/league-teams/:id(\\d+)/publish', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { matchId, reset = true, roleFilter = 'ALL' } = req.body || {};
    if (!matchId) return res.status(400).json({ error: 'matchId обязателен' });

    const lt = await assertLeagueTeam(id);
    await assertMatchForLeagueAndTeam(Number(matchId), lt.leagueId, lt.teamId);

    const roster = await prisma.leagueTeamPlayer.findMany({
      where: {
        leagueTeamId: id,
        ...(roleFilter === 'STARTER' ? { role: 'STARTER' } : {}),
      },
      orderBy: [{ role: 'asc' }, { number: 'asc' }, { id: 'asc' }],
    });

    const result = await prisma.$transaction(async (tx) => {
      if (reset) {
        // удаляем участников ЭТОЙ команды из матча
        const playerIds = roster.map((r) => r.playerId);
        await tx.playerMatch.deleteMany({
          where: { matchId: Number(matchId), playerId: { in: playerIds } },
        });
      }
      if (roster.length) {
        await tx.playerMatch.createMany({
          data: roster.map((r) => ({
            matchId: Number(matchId),
            playerId: r.playerId,
            role: r.role ?? 'STARTER',
            position: r.position ?? null,
            isCaptain: lt.captainRosterItemId
              ? r.id === lt.captainRosterItemId
              : false,
            order: r.number != null ? r.number : 0,
          })),
          skipDuplicates: true,
        });
      }
      return tx.playerMatch.findMany({
        where: { matchId: Number(matchId) },
        orderBy: [{ role: 'asc' }, { order: 'asc' }],
        include: { player: true },
      });
    });

    res.json(result);
  } catch (e) {
    console.error('POST /league-teams/:id/publish', e);
    res
      .status(400)
      .json({ error: e.message || 'Не удалось опубликовать заявку в матч' });
  }
});

export default router;
