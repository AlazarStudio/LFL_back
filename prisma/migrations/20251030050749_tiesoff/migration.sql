/*
  Warnings:

  - You are about to drop the column `roundId` on the `TournamentGroup` table. All the data in the column will be lost.
  - You are about to drop the column `roundId` on the `TournamentMatch` table. All the data in the column will be lost.
  - You are about to drop the column `tieId` on the `TournamentMatch` table. All the data in the column will be lost.
  - You are about to drop the `TournamentRound` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `TournamentTie` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "public"."TournamentGroup" DROP CONSTRAINT "TournamentGroup_roundId_fkey";

-- DropForeignKey
ALTER TABLE "public"."TournamentMatch" DROP CONSTRAINT "TournamentMatch_roundId_fkey";

-- DropForeignKey
ALTER TABLE "public"."TournamentMatch" DROP CONSTRAINT "TournamentMatch_tieId_fkey";

-- DropForeignKey
ALTER TABLE "public"."TournamentRound" DROP CONSTRAINT "TournamentRound_tournamentId_fkey";

-- DropForeignKey
ALTER TABLE "public"."TournamentTie" DROP CONSTRAINT "TournamentTie_roundId_fkey";

-- DropForeignKey
ALTER TABLE "public"."TournamentTie" DROP CONSTRAINT "TournamentTie_team1TTId_fkey";

-- DropForeignKey
ALTER TABLE "public"."TournamentTie" DROP CONSTRAINT "TournamentTie_team2TTId_fkey";

-- DropForeignKey
ALTER TABLE "public"."TournamentTie" DROP CONSTRAINT "TournamentTie_tournamentId_fkey";

-- DropForeignKey
ALTER TABLE "public"."TournamentTie" DROP CONSTRAINT "TournamentTie_winnerTTId_fkey";

-- DropIndex
DROP INDEX "public"."TournamentGroup_tournamentId_roundId_idx";

-- DropIndex
DROP INDEX "public"."TournamentMatch_tournamentId_roundId_tieId_groupId_idx";

-- AlterTable
ALTER TABLE "TournamentGroup" DROP COLUMN "roundId",
ADD COLUMN     "defaultRefereeId" INTEGER;

-- AlterTable
ALTER TABLE "TournamentMatch" DROP COLUMN "roundId",
DROP COLUMN "tieId";

-- DropTable
DROP TABLE "public"."TournamentRound";

-- DropTable
DROP TABLE "public"."TournamentTie";

-- CreateIndex
CREATE INDEX "TournamentGroup_tournamentId_idx" ON "TournamentGroup"("tournamentId");

-- CreateIndex
CREATE INDEX "TournamentGroup_defaultRefereeId_idx" ON "TournamentGroup"("defaultRefereeId");

-- CreateIndex
CREATE INDEX "TournamentMatch_tournamentId_groupId_idx" ON "TournamentMatch"("tournamentId", "groupId");

-- AddForeignKey
ALTER TABLE "TournamentGroup" ADD CONSTRAINT "TournamentGroup_defaultRefereeId_fkey" FOREIGN KEY ("defaultRefereeId") REFERENCES "Referee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
