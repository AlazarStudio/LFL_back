-- CreateEnum
CREATE TYPE "CardPeriod" AS ENUM ('TOURNAMENT', 'ROUND', 'GROUP');

-- CreateEnum
CREATE TYPE "GroupType" AS ENUM ('ROUND1', 'ROUND2', 'PLAYOFF');

-- CreateEnum
CREATE TYPE "SuspensionReason" AS ENUM ('YELLOWS', 'RED');

-- DropIndex
DROP INDEX "public"."TournamentMatch_tournamentId_roundId_tieId_idx";

-- AlterTable
ALTER TABLE "Tournament" ADD COLUMN     "autoPublishParticipants" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "disciplineEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "disciplinePeriod" "CardPeriod" NOT NULL DEFAULT 'TOURNAMENT',
ADD COLUMN     "endDate" TIMESTAMP(3),
ADD COLUMN     "format" "LeagueFormat" NOT NULL DEFAULT '11x11',
ADD COLUMN     "redToSuspend" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "suspendGames" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "yellowToSuspend" INTEGER NOT NULL DEFAULT 2;

-- AlterTable
ALTER TABLE "TournamentMatch" ADD COLUMN     "groupId" INTEGER;

-- CreateTable
CREATE TABLE "TournamentGroup" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "tournamentId" INTEGER NOT NULL,
    "roundId" INTEGER,
    "name" TEXT NOT NULL,
    "type" "GroupType" NOT NULL,

    CONSTRAINT "TournamentGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TournamentGroupTeam" (
    "id" SERIAL NOT NULL,
    "tournamentId" INTEGER NOT NULL,
    "groupId" INTEGER NOT NULL,
    "tournamentTeamId" INTEGER NOT NULL,

    CONSTRAINT "TournamentGroupTeam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TournamentSuspension" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "tournamentId" INTEGER NOT NULL,
    "tournamentTeamPlayerId" INTEGER NOT NULL,
    "reason" "SuspensionReason" NOT NULL,
    "startsAfter" TIMESTAMP(3),
    "remainingGames" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "triggerMatchId" INTEGER,

    CONSTRAINT "TournamentSuspension_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TournamentGroup_tournamentId_roundId_idx" ON "TournamentGroup"("tournamentId", "roundId");

-- CreateIndex
CREATE INDEX "TournamentGroupTeam_tournamentId_groupId_idx" ON "TournamentGroupTeam"("tournamentId", "groupId");

-- CreateIndex
CREATE UNIQUE INDEX "TournamentGroupTeam_groupId_tournamentTeamId_key" ON "TournamentGroupTeam"("groupId", "tournamentTeamId");

-- CreateIndex
CREATE INDEX "TournamentSuspension_tournamentId_isActive_idx" ON "TournamentSuspension"("tournamentId", "isActive");

-- CreateIndex
CREATE INDEX "TournamentSuspension_tournamentTeamPlayerId_isActive_idx" ON "TournamentSuspension"("tournamentTeamPlayerId", "isActive");

-- CreateIndex
CREATE INDEX "TournamentMatch_tournamentId_roundId_tieId_groupId_idx" ON "TournamentMatch"("tournamentId", "roundId", "tieId", "groupId");

-- AddForeignKey
ALTER TABLE "TournamentGroup" ADD CONSTRAINT "TournamentGroup_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentGroup" ADD CONSTRAINT "TournamentGroup_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "TournamentRound"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentGroupTeam" ADD CONSTRAINT "TournamentGroupTeam_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentGroupTeam" ADD CONSTRAINT "TournamentGroupTeam_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "TournamentGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentGroupTeam" ADD CONSTRAINT "TournamentGroupTeam_tournamentTeamId_fkey" FOREIGN KEY ("tournamentTeamId") REFERENCES "TournamentTeam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentMatch" ADD CONSTRAINT "TournamentMatch_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "TournamentGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentSuspension" ADD CONSTRAINT "TournamentSuspension_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentSuspension" ADD CONSTRAINT "TournamentSuspension_tournamentTeamPlayerId_fkey" FOREIGN KEY ("tournamentTeamPlayerId") REFERENCES "TournamentTeamPlayer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentSuspension" ADD CONSTRAINT "TournamentSuspension_triggerMatchId_fkey" FOREIGN KEY ("triggerMatchId") REFERENCES "TournamentMatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
