import { faker } from '@faker-js/faker';
import { hash, verify } from 'argon2';
import asyncHandler from 'express-async-handler';

import { prisma } from '../prisma.js';
import { UserFields } from '../utils/user.utils.js';

import { generateToken } from './generate-token.js';

// @desc    Auth user
// @route   POST /api/auth/login
// @access  Public
// controllers/auth.controller.js
export const authUser = asyncHandler(async (req, res) => {
  const { login, password } = req.body;

  const user = await prisma.user.findUnique({ where: { login } });

  // единый ответ при неверных данных
  const invalid = () => {
    res.status(401);
    // Лучше отдать КЛЮЧ, а на фронте дать фоллбэк
    throw new Error('auth.invalid_credentials');
  };

  if (!user) return invalid();

  const isValidPassword = await verify(user.password, password).catch(
    () => false
  );
  if (!isValidPassword) return invalid();

  const token = generateToken(user.id);
  res.json({ user, token });
});

// @desc    Register user
// @route   POST /api/auth/register
// @access  Public
export const registerUser = asyncHandler(async (req, res) => {
  const { login, email, password } = req.body;

  const isHaveUser = await prisma.user.findUnique({
    where: {
      login,
    },
  });

  if (isHaveUser) {
    res.status(400);
    throw new Error('User already exists');
  }

  const user = await prisma.user.create({
    data: {
      login,
      email,
      password: await hash(password),
      name: faker.name.fullName(),
    },
    select: UserFields,
  });

  const token = generateToken(user.id);

  res.json({ user, token });
});
