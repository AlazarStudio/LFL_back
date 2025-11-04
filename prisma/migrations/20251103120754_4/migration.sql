-- AlterTable
ALTER TABLE "News" ADD COLUMN     "tMatchId" INTEGER;

-- AlterTable
ALTER TABLE "Photo" ADD COLUMN     "tMatchId" INTEGER;

-- AlterTable
ALTER TABLE "Video" ADD COLUMN     "tMatchId" INTEGER;

-- CreateIndex
CREATE INDEX "News_tMatchId_idx" ON "News"("tMatchId");

-- CreateIndex
CREATE INDEX "Photo_tMatchId_idx" ON "Photo"("tMatchId");

-- CreateIndex
CREATE INDEX "Video_tMatchId_idx" ON "Video"("tMatchId");

-- AddForeignKey
ALTER TABLE "News" ADD CONSTRAINT "News_tMatchId_fkey" FOREIGN KEY ("tMatchId") REFERENCES "TournamentMatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_tMatchId_fkey" FOREIGN KEY ("tMatchId") REFERENCES "TournamentMatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Video" ADD CONSTRAINT "Video_tMatchId_fkey" FOREIGN KEY ("tMatchId") REFERENCES "TournamentMatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
