import dotenv from 'dotenv';
import express from 'express';
import morgan from 'morgan';
import cors from 'cors';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import https from 'https';

import http from 'http';
import { errorHandler, notFound } from './app/middleware/error.middleware.js';
import { prisma } from './app/prisma.js';

import authRoutes from './app/auth/auth.routes.js';
import userRoutes from './app/user/user.controller.js';
import teamController from './app/controllers/team.js';
import leagueController from './app/controllers/league.js';
import leagueStandingController from './app/controllers/leagueStanding.js';
import matchController from './app/controllers/match.js';
import matchEventController from './app/controllers/matchEvent.js';
import partnersController from './app/controllers/partners.js';
import newsController from './app/controllers/news.js';
import playerController from './app/controllers/player.js';
import playerStatController from './app/controllers/playerStat.js';
import uploadsController from './app/controllers/uploads.js';
import videoUploadsController from './app/controllers/videoUpload.js';
import refereeRoutes from './app/controllers/referee.js';
import stadiumRoutes from './app/controllers/stadium.js';
import lineupRoutes from './app/controllers/leagueTeam.js';
import imagesRouter from './app/controllers/images.js';
import videosRouter from './app/controllers/videos.js';
import leagueTeamRouter from './app/controllers/leagueTeam.js';
import tournamentRouter from './app/controllers/tourtament.js';
import leagueExportRouter from './app/controllers/leagueExport.js';

import { initSocket } from './app/socket.js';

dotenv.config();

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

app.use(cors());
// Чтобы React Admin видел Content-Range
app.use((req, res, next) => {
  res.header('Access-Control-Expose-Headers', 'Content-Range');
  next();
});
if (process.env.NODE_ENV === 'development') app.use(morgan('dev'));
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, '/uploads')));

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/teams', teamController);
app.use('/api/leagues', leagueController);
app.use('/api/leagueStandings', leagueStandingController);
app.use('/api/matches', matchController);
app.use('/api/matchEvents', matchEventController);
app.use('/api/players', playerController);
app.use('/api/playerStats', playerStatController);
app.use('/api/partners', partnersController);
app.use('/api/news', newsController);
app.use('/api/upload', uploadsController);
app.use('/api/upload-videos', videoUploadsController);
app.use('/api/referees', refereeRoutes);
app.use('/api/stadiums', stadiumRoutes);
app.use('/api', lineupRoutes);
app.use('/api/images', imagesRouter);
app.use('/api/videos', videosRouter);
app.use('/api', leagueTeamRouter);
app.use('/api', tournamentRouter);
app.use('/api/leagues', leagueExportRouter);

app.use(notFound);
app.use(errorHandler);

// --- HTTP + Socket.IO ---
const PORT = process.env.PORT ? Number(process.env.PORT) : 5000;
const server = http.createServer(app);
initSocket(server);
server.listen(PORT, () => console.log(`🚀 HTTP + WS server on :${PORT}`));

// const sslOptions = {
//   key: fs.readFileSync('/etc/letsencrypt/live/backend.mlf09.ru/privkey.pem'),
//   cert: fs.readFileSync('/etc/letsencrypt/live/backend.mlf09.ru/cert.pem'),
//   ca: fs.readFileSync('/etc/letsencrypt/live/backend.mlf09.ru/chain.pem'),
// };
// const httpsServer = https.createServer(sslOptions, app);
// initSocket(httpsServer);
// httpsServer.listen(443, () =>
//   console.log('Server is now running on https 443')
// );
