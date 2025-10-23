import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import sharp from 'sharp';
import fs from 'fs';

const router = Router();
const upload = multer({ dest: 'temp/' });

router.post('/', upload.array('files'), async (req, res) => {
  try {
    if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

    const filePaths = [];

    for (const file of req.files) {
      const ext = '.webp';
      const outputFilename = `${Date.now()}-${file.originalname.replace(/\.[^/.]+$/, '')}${ext}`;
      const outputPath = path.join('uploads', outputFilename);

      await sharp(file.path).webp({ quality: 80 }).toFile(outputPath);

      fs.unlinkSync(file.path); // удалить временный файл
      filePaths.push(`/uploads/${outputFilename}`);
    }

    res.json({ filePaths });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка при обработке изображений' });
  }
});

export default router;
