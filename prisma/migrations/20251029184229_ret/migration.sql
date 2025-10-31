-- AlterTable
ALTER TABLE "TournamentMatch" ADD COLUMN     "seriesKey" TEXT,
ADD COLUMN     "team1From" TEXT,
ADD COLUMN     "team2From" TEXT;

-- CreateIndex
CREATE INDEX "TournamentMatch_date_idx" ON "TournamentMatch"("date");

-- CreateIndex
CREATE INDEX "TournamentMatch_status_idx" ON "TournamentMatch"("status");
