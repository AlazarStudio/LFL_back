// scripts/seedAdmin.js
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { hash } from 'argon2';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Сидим администратора...');

  const passwordHash = await hash('!pjsd30jADSm2');

  const admin = await prisma.user.upsert({
    where: { login: 'adminMLF' }, // login уникален в схеме
    update: {
      password: passwordHash,
      email: 'admin@test.com',
      role: 'ADMIN',
      isActive: true,
      emailVerifiedAt: new Date(),
    },
    create: {
      email: 'admin@test.com',
      login: 'admin',
      password: passwordHash,
      role: 'ADMIN',
      isActive: true,
      emailVerifiedAt: new Date(),
    },
    select: {
      id: true,
      login: true,
      email: true,
      role: true,
      isActive: true,
    },
  });

  console.log('✅ Админ готов:', admin);
}

main()
  .catch((e) => {
    console.error('❌ Ошибка сида:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
