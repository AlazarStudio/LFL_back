// app/controllers/stadium.js
import { Router } from 'express';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

/* utils */
const safeJSON = (v, fb) => {
  try {
    return v ? JSON.parse(String(v)) : fb;
  } catch {
    return fb;
  }
};
const setRange = (res, name, start, count, total) => {
  res.setHeader(
    'Content-Range',
    `${name} ${start}-${start + count - 1}/${total}`
  );
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range');
};

/* LIST */
router.get('/', async (req, res) => {
  try {
    const range = safeJSON(req.query.range, [0, 999]);
    const sort = safeJSON(req.query.sort, ['id', 'ASC']);
    const filter = safeJSON(req.query.filter, {});

    const start = Number(range[0]) || 0;
    const end = Number(range[1]) || start + 999;
    const take = Math.max(0, end - start + 1);

    const allowedSort = new Set([
      'id',
      'name',
      'location',
      'createdAt',
      'updatedAt',
    ]);
    const sortField = allowedSort.has(String(sort[0])) ? String(sort[0]) : 'id';
    const sortOrder =
      String(sort[1] || 'ASC').toLowerCase() === 'desc' ? 'desc' : 'asc';
    const orderBy = { [sortField]: sortOrder };

    // id array — быстрый ранний выход (чтобы не смешивать с q/прочими)
    if (Array.isArray(filter.id)) {
      const ids = filter.id.map(Number).filter(Number.isFinite);
      if (!ids.length) {
        setRange(res, 'stadiums', start, 0, 0);
        return res.json([]);
      }
      const [data, total] = await Promise.all([
        prisma.stadium.findMany({
          where: { id: { in: ids } },
          skip: start,
          take,
          orderBy,
        }),
        prisma.stadium.count({ where: { id: { in: ids } } }),
      ]);
      setRange(res, 'stadiums', start, data.length, total);
      return res.json(data);
    }

    // остальные фильтры собираем через AND
    const AND = [];

    // id (single)
    if (filter.id != null) {
      const id = Number(filter.id);
      if (Number.isFinite(id)) AND.push({ id });
    }

    // q-поиск по имени/локации
    if (filter.q) {
      const q = String(filter.q).trim();
      if (q) {
        AND.push({
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { location: { contains: q, mode: 'insensitive' } },
          ],
        });
      }
    }

    // прямые фильтры
    if (filter.name) {
      AND.push({
        name: { contains: String(filter.name), mode: 'insensitive' },
      });
    }
    if (filter.location) {
      AND.push({
        location: { contains: String(filter.location), mode: 'insensitive' },
      });
    }

    const where = AND.length ? { AND } : undefined;

    const [data, total] = await Promise.all([
      prisma.stadium.findMany({
        skip: start,
        take,
        where,
        orderBy,
      }),
      prisma.stadium.count({ where }),
    ]);

    setRange(res, 'stadiums', start, data.length, total);
    res.json(data);
  } catch (e) {
    console.error('Ошибка загрузки стадионов:', e);
    res.status(500).json({ error: 'Ошибка загрузки стадионов' });
  }
});

/* ITEM */
router.get('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id))
      return res.status(400).json({ error: 'Некорректный id' });

    const item = await prisma.stadium.findUnique({ where: { id } });
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  } catch (e) {
    console.error('Ошибка получения стадиона:', e);
    res.status(500).json({ error: 'Ошибка' });
  }
});

/* CREATE */
router.post('/', async (req, res) => {
  try {
    const { name, location } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'name обязателен' });
    }
    const created = await prisma.stadium.create({
      data: { name: String(name).trim(), location: location ?? null },
    });
    res.status(201).json(created);
  } catch (e) {
    console.error('Ошибка создания стадиона:', e);
    res.status(500).json({ error: 'Ошибка создания' });
  }
});

/* UPDATE */
router.put('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id))
      return res.status(400).json({ error: 'Некорректный id' });

    const { name, location } = req.body;
    const updated = await prisma.stadium.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(location !== undefined ? { location: location ?? null } : {}),
      },
    });
    res.json(updated);
  } catch (e) {
    console.error('Ошибка обновления стадиона:', e);
    res.status(500).json({ error: 'Ошибка обновления' });
  }
});

/* DELETE */
router.delete('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id))
      return res.status(400).json({ error: 'Некорректный id' });

    await prisma.stadium.delete({ where: { id } });
    res.json({ success: true });
  } catch (e) {
    console.error('Ошибка удаления стадиона:', e);
    res.status(500).json({ error: 'Ошибка удаления' });
  }
});

export default router;
