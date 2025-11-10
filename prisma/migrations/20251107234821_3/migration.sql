-- AlterTable
ALTER TABLE "Referee" ADD COLUMN     "images" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "TournamentGroup" ADD COLUMN     "defaultCommentatorId" INTEGER;

-- CreateTable
CREATE TABLE "Commentator" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "images" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "Commentator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchCommentator" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "matchId" INTEGER NOT NULL,
    "commentatorId" INTEGER NOT NULL,
    "role" TEXT,

    CONSTRAINT "MatchCommentator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TournamentMatchCommentator" (
    "id" SERIAL NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "matchId" INTEGER NOT NULL,
    "commentatorId" INTEGER NOT NULL,
    "role" TEXT,

    CONSTRAINT "TournamentMatchCommentator_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MatchCommentator_matchId_idx" ON "MatchCommentator"("matchId");

-- CreateIndex
CREATE UNIQUE INDEX "MatchCommentator_matchId_commentatorId_key" ON "MatchCommentator"("matchId", "commentatorId");

-- CreateIndex
CREATE INDEX "TournamentMatchCommentator_matchId_idx" ON "TournamentMatchCommentator"("matchId");

-- CreateIndex
CREATE UNIQUE INDEX "TournamentMatchCommentator_matchId_commentatorId_key" ON "TournamentMatchCommentator"("matchId", "commentatorId");

-- AddForeignKey
ALTER TABLE "MatchCommentator" ADD CONSTRAINT "MatchCommentator_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchCommentator" ADD CONSTRAINT "MatchCommentator_commentatorId_fkey" FOREIGN KEY ("commentatorId") REFERENCES "Commentator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentMatchCommentator" ADD CONSTRAINT "TournamentMatchCommentator_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "TournamentMatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentMatchCommentator" ADD CONSTRAINT "TournamentMatchCommentator_commentatorId_fkey" FOREIGN KEY ("commentatorId") REFERENCES "Commentator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentGroup" ADD CONSTRAINT "TournamentGroup_defaultCommentatorId_fkey" FOREIGN KEY ("defaultCommentatorId") REFERENCES "Commentator"("id") ON DELETE SET NULL ON UPDATE CASCADE;
