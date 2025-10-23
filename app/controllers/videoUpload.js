// routes/videoUploadRouter.ts
import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';

const router = Router();

const videoStorage = multer.diskStorage({
  destination(req, file, cb) {
    const folder = 'uploads/video';
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
    cb(null, folder);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname);
    const name = `${Date.now()}-${file.originalname.replace(/\.[^/.]+$/, '')}`;
    cb(null, `${name}${ext}`);
  },
});

const upload = multer({
  storage: videoStorage,
  limits: { fileSize: 1000 * 1024 * 1024 }, // 1000MB = 1GB
  fileFilter: (req, file, cb) => {
    const allowed = ['video/mp4', 'video/webm', 'video/ogg'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Недопустимый формат видео'), false);
  },
});

router.post('/', upload.array('videos'), (req, res) => {
  try {
    const filePaths = req.files.map(
      (file) => `/uploads/video/${file.filename}`
    );
    res.json({ filePaths });
  } catch (err) {
    console.error('Ошибка загрузки видео:', err);
    res.status(500).json({ error: 'Ошибка при загрузке видео' });
  }
});

export default router;
