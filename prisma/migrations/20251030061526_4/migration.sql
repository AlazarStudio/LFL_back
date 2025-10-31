/*
  Warnings:

  - You are about to drop the column `defaultRefereeId` on the `TournamentGroup` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "public"."TournamentGroup" DROP CONSTRAINT "TournamentGroup_defaultRefereeId_fkey";

-- DropIndex
DROP INDEX "public"."TournamentGroup_defaultRefereeId_idx";

-- AlterTable
ALTER TABLE "TournamentGroup" DROP COLUMN "defaultRefereeId",
ADD COLUMN     "refereeId" INTEGER;

-- AddForeignKey
ALTER TABLE "TournamentGroup" ADD CONSTRAINT "TournamentGroup_refereeId_fkey" FOREIGN KEY ("refereeId") REFERENCES "Referee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
