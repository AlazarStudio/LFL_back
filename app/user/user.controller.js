// app/user/user.controller.js
import { Router } from 'express';
// РЕКОМЕНДУЕТСЯ общий клиент (как у тебя в index.js):
import { prisma } from '../prisma.js';
// Если хочется локально:
// import { PrismaClient } from '@prisma/client';
// const prisma = new PrismaClient();

const router = Router();

/* ---------- utils ---------- */
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
const setRange = (res, name, start, count, total) => {
  res.setHeader(
    'Content-Range',
    `${name} ${start}-${start + count - 1}/${total}`
  );
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range');
};

// Какую проекцию пользователя возвращаем наружу (без password)
const userSelect = {
  id: true,
  email: true,
  login: true,
  role: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  emailVerifiedAt: true,
  lastLoginAt: true,
};

/* =========================================================
   LIST  GET /users
   ?range=[0,49]&sort=["createdAt","DESC"]&filter={"q":"ad","role":"ADMIN","isActive":true,"id":[1,2]}
   ========================================================= */
router.get('/', async (req, res) => {
  try {
    const range = safeJSON(req.query.range, [0, 49]);
    const sort = safeJSON(req.query.sort, ['createdAt', 'DESC']);
    const filter = safeJSON(req.query.filter, {});

    const [start, end] = range;
    const take = Math.max(0, end - start + 1);
    const sortField = String(sort[0] || 'createdAt');
    const sortOrder =
      String(sort[1] || 'DESC').toLowerCase() === 'desc' ? 'desc' : 'asc';

    const AND = [];

    if (Array.isArray(filter.id) && filter.id.length) {
      AND.push({ id: { in: filter.id.map(Number).filter(Number.isFinite) } });
    } else if (filter.id != null && Number.isFinite(Number(filter.id))) {
      AND.push({ id: Number(filter.id) });
    }

    if (typeof filter.q === 'string' && filter.q.trim()) {
      const q = filter.q.trim();
      AND.push({
        OR: [
          { email: { contains: q, mode: 'insensitive' } },
          { login: { contains: q, mode: 'insensitive' } },
        ],
      });
    }

    if (typeof filter.role === 'string' && filter.role.trim()) {
      AND.push({ role: filter.role.trim() });
    }
    if (filter.isActive != null) {
      AND.push({ isActive: bool(filter.isActive) });
    }

    const where = AND.length ? { AND } : undefined;

    const [rows, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip: start,
        take,
        orderBy: { [sortField]: sortOrder },
        select: userSelect,
      }),
      prisma.user.count({ where }),
    ]);

    setRange(res, 'users', start, rows.length, total);
    res.json(rows);
  } catch (err) {
    console.error('GET /users', err);
    res.status(500).json({ error: 'Ошибка загрузки пользователей' });
  }
});

/* =========================================================
   ITEM  GET /users/:id
   ========================================================= */
router.get('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const user = await prisma.user.findUnique({
      where: { id },
      select: userSelect,
    });
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json(user);
  } catch (err) {
    console.error('GET /users/:id', err);
    res.status(500).json({ error: 'Ошибка получения пользователя' });
  }
});

/* =========================================================
   CREATE  POST /users
   body: { email, login, password, role?, isActive? }
   ========================================================= */
router.post('/', async (req, res) => {
  try {
    const { email, login, password, role, isActive } = req.body;

    if (!email || !login || !password) {
      return res
        .status(400)
        .json({ error: 'email, login и password обязательны' });
    }

    // TODO: в проде ХЕШИРОВАТЬ пароль (например, bcrypt)
    const created = await prisma.user.create({
      data: {
        email,
        login,
        password,
        role: role ?? undefined,
        isActive: typeof isActive === 'boolean' ? isActive : undefined,
      },
      select: userSelect,
    });

    res.status(201).json(created);
  } catch (err) {
    // ловим конфликты уникальности email/login
    if (err?.code === 'P2002') {
      const target = Array.isArray(err.meta?.target)
        ? err.meta.target.join(', ')
        : 'уникальные поля';
      return res
        .status(409)
        .json({ error: `Нарушение уникальности (${target})` });
    }
    console.error('POST /users', err);
    res.status(500).json({ error: 'Ошибка создания пользователя' });
  }
});

/* =========================================================
   PATCH  /users/:id
   Позволяем частичные обновления
   ========================================================= */
router.patch('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const {
      email,
      login,
      password,
      role,
      isActive,
      emailVerifiedAt,
      lastLoginAt,
    } = req.body;

    const data = {};
    if (email !== undefined) data.email = email;
    if (login !== undefined) data.login = login;
    if (password !== undefined) data.password = password; // TODO: хешировать
    if (role !== undefined) data.role = role;
    if (isActive !== undefined) data.isActive = !!isActive;
    if (emailVerifiedAt !== undefined)
      data.emailVerifiedAt = emailVerifiedAt ? new Date(emailVerifiedAt) : null;
    if (lastLoginAt !== undefined)
      data.lastLoginAt = lastLoginAt ? new Date(lastLoginAt) : null;

    const updated = await prisma.user.update({
      where: { id },
      data,
      select: userSelect,
    });

    res.json(updated);
  } catch (err) {
    if (err?.code === 'P2002') {
      const target = Array.isArray(err.meta?.target)
        ? err.meta.target.join(', ')
        : 'уникальные поля';
      return res
        .status(409)
        .json({ error: `Нарушение уникальности (${target})` });
    }
    console.error('PATCH /users/:id', err);
    res.status(500).json({ error: 'Ошибка обновления пользователя' });
  }
});

/* =========================================================
   PUT  /users/:id
   Полная замена допустимых полей
   ========================================================= */
router.put('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const {
      email,
      login,
      password,
      role,
      isActive,
      emailVerifiedAt,
      lastLoginAt,
    } = req.body;

    if (!email || !login || !password) {
      return res
        .status(400)
        .json({ error: 'email, login и password обязательны' });
    }

    const updated = await prisma.user.update({
      where: { id },
      data: {
        email,
        login,
        password, // TODO: хешировать
        role: role ?? null,
        isActive: typeof isActive === 'boolean' ? isActive : true,
        emailVerifiedAt: emailVerifiedAt ? new Date(emailVerifiedAt) : null,
        lastLoginAt: lastLoginAt ? new Date(lastLoginAt) : null,
      },
      select: userSelect,
    });

    res.json(updated);
  } catch (err) {
    if (err?.code === 'P2002') {
      const target = Array.isArray(err.meta?.target)
        ? err.meta.target.join(', ')
        : 'уникальные поля';
      return res
        .status(409)
        .json({ error: `Нарушение уникальности (${target})` });
    }
    console.error('PUT /users/:id', err);
    res.status(500).json({ error: 'Ошибка обновления пользователя' });
  }
});

/* =========================================================
   DELETE  /users/:id
   ========================================================= */
router.delete('/:id(\\d+)', async (req, res) => {
  try {
    const id = Number(req.params.id);
    await prisma.user.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    // конфликт внешнего ключа (если на пользователя есть ссылки)
    if (err?.code === 'P2003') {
      return res
        .status(409)
        .json({ error: 'Нельзя удалить: есть связанные записи' });
    }
    console.error('DELETE /users/:id', err);
    res.status(500).json({ error: 'Ошибка удаления пользователя' });
  }
});

export default router;
