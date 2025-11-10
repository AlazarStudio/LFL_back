-- AlterTable
ALTER TABLE "News" ADD COLUMN     "teamId" INTEGER,
ADD COLUMN     "url" TEXT;

-- AlterTable
ALTER TABLE "Photo" ADD COLUMN     "teamId" INTEGER;

-- AlterTable
ALTER TABLE "Video" ADD COLUMN     "teamId" INTEGER;

-- AddForeignKey
ALTER TABLE "News" ADD CONSTRAINT "News_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Video" ADD CONSTRAINT "Video_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;
