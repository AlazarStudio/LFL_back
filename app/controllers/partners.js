import { Router } from 'express';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

// 🔹 Список партнёров
router.get('/', async (req, res) => {
  try {
    const partners = await prisma.partner.findMany();
    res.json(partners);
  } catch {
    res.status(500).json({ error: 'Ошибка загрузки партнёров' });
  }
});

// 🔹 Один партнёр
router.get('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const partner = await prisma.partner.findUnique({ where: { id } });
    if (!partner) return res.status(404).json({ error: 'Партнёр не найден' });
    res.json(partner);
  } catch {
    res.status(500).json({ error: 'Ошибка получения партнёра' });
  }
});

// 🔹 Создать партнёра
router.post('/', async (req, res) => {
  try {
    const { name, link, images = [] } = req.body;
    const created = await prisma.partner.create({
      data: { name, link, images },
    });
    res.status(201).json(created);
  } catch {
    res.status(500).json({ error: 'Ошибка создания партнёра' });
  }
});

// 🔹 Обновить партнёра
router.put('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, link, images = [] } = req.body;
    const updated = await prisma.partner.update({
      where: { id },
      data: { name, link, images },
    });
    res.json(updated);
  } catch {
    res.status(500).json({ error: 'Ошибка обновления партнёра' });
  }
});

// 🔹 Удалить партнёра
router.delete('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    await prisma.partner.delete({ where: { id } });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Ошибка удаления партнёра' });
  }
});

export default router;
