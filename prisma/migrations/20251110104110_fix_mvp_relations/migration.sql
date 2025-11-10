-- AlterTable
ALTER TABLE "TournamentMatch" ADD COLUMN     "mvpPlayerId" INTEGER,
ADD COLUMN     "mvpRosterItemId" INTEGER,
ADD COLUMN     "playerId" INTEGER,
ADD COLUMN     "tournamentTeamPlayerId" INTEGER;

-- AddForeignKey
ALTER TABLE "TournamentMatch" ADD CONSTRAINT "TournamentMatch_mvpRosterItemId_fkey" FOREIGN KEY ("mvpRosterItemId") REFERENCES "TournamentTeamPlayer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentMatch" ADD CONSTRAINT "TournamentMatch_mvpPlayerId_fkey" FOREIGN KEY ("mvpPlayerId") REFERENCES "Player"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentMatch" ADD CONSTRAINT "TournamentMatch_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentMatch" ADD CONSTRAINT "TournamentMatch_tournamentTeamPlayerId_fkey" FOREIGN KEY ("tournamentTeamPlayerId") REFERENCES "TournamentTeamPlayer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
