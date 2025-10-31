/*
  Warnings:

  - You are about to drop the column `refereeId` on the `TournamentGroup` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "public"."TournamentGroup" DROP CONSTRAINT "TournamentGroup_refereeId_fkey";

-- AlterTable
ALTER TABLE "TournamentGroup" DROP COLUMN "refereeId",
ADD COLUMN     "defaultRefereeId" INTEGER;

-- CreateIndex
CREATE INDEX "TournamentGroup_defaultRefereeId_idx" ON "TournamentGroup"("defaultRefereeId");

-- AddForeignKey
ALTER TABLE "TournamentGroup" ADD CONSTRAINT "TournamentGroup_defaultRefereeId_fkey" FOREIGN KEY ("defaultRefereeId") REFERENCES "Referee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
