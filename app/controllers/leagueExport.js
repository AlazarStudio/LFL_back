import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import {
  Document,
  Packer,
  Paragraph,
  Table,
  TableRow,
  TableCell,
  WidthType,
  HeadingLevel,
  TextRun,
} from 'docx';

const prisma = new PrismaClient();
const router = Router();

/* ========== helpers ========== */
const fmtDate = (d) => {
  const dt = new Date(d);
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const yyyy = dt.getFullYear();
  const hh = String(dt.getHours()).padStart(2, '0');
  const mi = String(dt.getMinutes()).padStart(2, '0');
  return `${dd}.${mm}.${yyyy} ${hh}:${mi}`;
};

const H = (text) =>
  new Paragraph({
    text,
    heading: HeadingLevel.HEADING_1,
    spacing: { after: 200 },
  });

const table = (headers, rows) => {
  const headerRow = new TableRow({
    children: headers.map(
      (h) =>
        new TableCell({
          children: [
            new Paragraph({ children: [new TextRun({ text: h, bold: true })] }),
          ],
        })
    ),
  });
  const bodyRows = rows.map(
    (r) =>
      new TableRow({
        children: r.map(
          (cell) =>
            new TableCell({
              children: [new Paragraph(String(cell ?? ''))],
            })
        ),
      })
  );
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...bodyRows],
  });
};

/* ========== сборщики секций ========== */
async function buildScheduleSection(leagueId) {
  const matches = await prisma.match.findMany({
    where: { leagueId },
    orderBy: [{ date: 'asc' }, { id: 'asc' }],
    include: {
      team1: { select: { title: true } },
      team2: { select: { title: true } },
      round: { select: { number: true, name: true } },
      stadiumRel: { select: { name: true } },
    },
  });

  const rows = matches.map((m) => {
    const rnd =
      m.round?.number != null
        ? `Тур ${m.round.number}${m.round?.name ? ` (${m.round.name})` : ''}`
        : m.round?.name || '—';
    const score =
      m.status === 'FINISHED' ? `${m.team1Score}:${m.team2Score}` : '-:-';
    return [
      fmtDate(m.date),
      rnd,
      m.team1?.title || '',
      score,
      m.team2?.title || '',
      m.stadiumRel?.name || '—',
    ];
  });

  return [
    H('Расписание матчей'),
    table(
      ['Дата/время', 'Тур', 'Хозяева', 'Счёт', 'Гости', 'Стадион'],
      rows.length ? rows : [['Нет данных', '', '', '', '', '']]
    ),
  ];
}

async function buildStandingsSection(leagueId) {
  const raw = await prisma.leagueStanding.findMany({
    where: { league_id: leagueId },
    include: { team: { select: { title: true } } },
  });
  const sorted = [...raw].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    const gdA = a.goals_for - a.goals_against;
    const gdB = b.goals_for - b.goals_against;
    if (gdB !== gdA) return gdB - gdA;
    return b.goals_for - a.goals_for;
  });
  const rows = sorted.map((r, i) => [
    i + 1,
    r.team?.title || r.team_id,
    r.played,
    r.wins,
    r.draws,
    r.losses,
    `${r.goals_for}:${r.goals_against}`,
    r.points,
  ]);

  return [
    H('Турнирная таблица'),
    table(
      ['#', 'Команда', 'И', 'В', 'Н', 'П', 'Мячи', 'Очки'],
      rows.length ? rows : [['', 'Нет данных', '', '', '', '', '', '']]
    ),
  ];
}

async function groupCount(items, keyName, nameGetter) {
  const map = new Map();
  for (const it of items) {
    const key = it[keyName];
    if (!key) continue;
    const name = nameGetter(it) || `ID ${key}`;
    const prev = map.get(key) || { name, team: '', count: 0 };
    prev.count += 1;
    // команда из игрока если есть
    if (!prev.team) prev.team = it.player?.team?.title || it.team?.title || '';
    map.set(key, prev);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

async function buildScorersSection(leagueId) {
  const ev = await prisma.matchEvent.findMany({
    where: {
      match: { leagueId },
      type: { in: ['GOAL', 'PENALTY_SCORED'] },
      playerId: { not: null },
    },
    select: {
      playerId: true,
      team: { select: { title: true } },
      player: { select: { name: true, team: { select: { title: true } } } },
    },
  });
  const rows = await groupCount(ev, 'playerId', (it) => it.player?.name);
  const asTableRows = rows.map((r, i) => [
    i + 1,
    r.name,
    r.team || '',
    r.count,
  ]);
  return [
    H('Бомбардиры'),
    table(
      ['#', 'Игрок', 'Команда', 'Голы'],
      asTableRows.length ? asTableRows : [['', 'Нет данных', '', '']]
    ),
  ];
}

async function buildAssistantsSection(leagueId) {
  const ev = await prisma.matchEvent.findMany({
    where: {
      match: { leagueId },
      type: 'ASSIST',
      assistPlayerId: { not: null },
    },
    select: {
      assistPlayerId: true,
      team: { select: { title: true } },
      assist_player: {
        select: { name: true, team: { select: { title: true } } },
      },
    },
  });
  // переименуем под общий агрегатор
  const normalized = ev.map((e) => ({
    playerId: e.assistPlayerId,
    team: e.assist_player?.team || e.team,
    player: { name: e.assist_player?.name, team: e.assist_player?.team },
  }));
  const rows = await groupCount(
    normalized,
    'playerId',
    (it) => it.player?.name
  );
  const asTableRows = rows.map((r, i) => [
    i + 1,
    r.name,
    r.team || '',
    r.count,
  ]);
  return [
    H('Ассистенты'),
    table(
      ['#', 'Игрок', 'Команда', 'Пасы'],
      asTableRows.length ? asTableRows : [['', 'Нет данных', '', '']]
    ),
  ];
}

async function buildYellowsSection(leagueId) {
  const ev = await prisma.matchEvent.findMany({
    where: {
      match: { leagueId },
      type: 'YELLOW_CARD',
      playerId: { not: null },
    },
    select: {
      playerId: true,
      team: { select: { title: true } },
      player: { select: { name: true, team: { select: { title: true } } } },
    },
  });
  const rows = await groupCount(ev, 'playerId', (it) => it.player?.name);
  const asTableRows = rows.map((r, i) => [
    i + 1,
    r.name,
    r.team || '',
    r.count,
  ]);
  return [
    H('Жёлтые карточки'),
    table(
      ['#', 'Игрок', 'Команда', 'ЖК'],
      asTableRows.length ? asTableRows : [['', 'Нет данных', '', '']]
    ),
  ];
}

async function buildRedsSection(leagueId) {
  const ev = await prisma.matchEvent.findMany({
    where: {
      match: { leagueId },
      type: 'RED_CARD',
      playerId: { not: null },
    },
    select: {
      playerId: true,
      team: { select: { title: true } },
      player: { select: { name: true, team: { select: { title: true } } } },
    },
  });
  const rows = await groupCount(ev, 'playerId', (it) => it.player?.name);
  const asTableRows = rows.map((r, i) => [
    i + 1,
    r.name,
    r.team || '',
    r.count,
  ]);
  return [
    H('Красные карточки'),
    table(
      ['#', 'Игрок', 'Команда', 'КК'],
      asTableRows.length ? asTableRows : [['', 'Нет данных', '', '']]
    ),
  ];
}

/* ========== Единичный экспорт: /leagues/:id/export/docx?kind=... ========== */
/* kind: schedule | standings | scorers | assistants | yellows | reds */
router.get('/:id(\\d+)/export/docx', async (req, res) => {
  try {
    const leagueId = Number(req.params.id);
    const kind = String(req.query.kind || 'schedule');

    const builders = {
      schedule: buildScheduleSection,
      standings: buildStandingsSection,
      scorers: buildScorersSection,
      assistants: buildAssistantsSection,
      yellows: buildYellowsSection,
      reds: buildRedsSection,
    };
    const build = builders[kind];
    if (!build) return res.status(400).json({ error: 'Неизвестный kind' });

    const section = await build(leagueId);
    const doc = new Document({ sections: [{ children: section }] });
    const buffer = await Packer.toBuffer(doc);

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="league-${leagueId}-${kind}.docx"`
    );
    return res.send(buffer);
  } catch (e) {
    console.error('export single docx error', e);
    res.status(500).json({ error: 'Не удалось сформировать DOCX' });
  }
});

/* ========== Комбинированный экспорт: /leagues/:id/export/docx/bundle?sections=a,b,c ========== */
router.get('/:id(\\d+)/export/docx/bundle', async (req, res) => {
  try {
    const leagueId = Number(req.params.id);
    const sections = String(req.query.sections || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (!sections.length) {
      return res.status(400).json({ error: 'Передай ?sections=...' });
    }

    const blocks = [];
    for (const s of sections) {
      if (s === 'schedule')
        blocks.push(...(await buildScheduleSection(leagueId)));
      else if (s === 'standings')
        blocks.push(...(await buildStandingsSection(leagueId)));
      else if (s === 'scorers')
        blocks.push(...(await buildScorersSection(leagueId)));
      else if (s === 'assistants')
        blocks.push(...(await buildAssistantsSection(leagueId)));
      else if (s === 'yellows')
        blocks.push(...(await buildYellowsSection(leagueId)));
      else if (s === 'reds') blocks.push(...(await buildRedsSection(leagueId)));
    }

    const doc = new Document({ sections: [{ children: blocks }] });
    const buffer = await Packer.toBuffer(doc);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="league-${leagueId}-bundle.docx"`
    );
    return res.send(buffer);
  } catch (e) {
    console.error('export bundle docx error', e);
    res.status(500).json({ error: 'Не удалось сформировать DOCX' });
  }
});

export default router;
