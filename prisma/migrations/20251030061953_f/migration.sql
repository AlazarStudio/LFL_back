/*
  Warnings:

  - You are about to drop the column `created_at` on the `TournamentGroup` table. All the data in the column will be lost.
  - You are about to drop the column `refereeId` on the `TournamentGroup` table. All the data in the column will be lost.
  - You are about to drop the column `updated_at` on the `TournamentGroup` table. All the data in the column will be lost.
  - The primary key for the `TournamentMatchReferee` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `created_at` on the `TournamentMatchReferee` table. All the data in the column will be lost.
  - You are about to drop the column `id` on the `TournamentMatchReferee` table. All the data in the column will be lost.
  - You are about to drop the column `updated_at` on the `TournamentMatchReferee` table. All the data in the column will be lost.
  - The `role` column on the `TournamentMatchReferee` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- DropForeignKey
ALTER TABLE "public"."TournamentGroup" DROP CONSTRAINT "TournamentGroup_refereeId_fkey";

-- DropForeignKey
ALTER TABLE "public"."TournamentGroup" DROP CONSTRAINT "TournamentGroup_tournamentId_fkey";

-- DropIndex
DROP INDEX "public"."TournamentGroup_tournamentId_idx";

-- AlterTable
ALTER TABLE "TournamentGroup" DROP COLUMN "created_at",
DROP COLUMN "refereeId",
DROP COLUMN "updated_at",
ADD COLUMN     "defaultRefereeId" INTEGER,
ALTER COLUMN "name" DROP NOT NULL,
ALTER COLUMN "type" SET DEFAULT 'ROUND1';

-- AlterTable
ALTER TABLE "TournamentMatchReferee" DROP CONSTRAINT "TournamentMatchReferee_pkey",
DROP COLUMN "created_at",
DROP COLUMN "id",
DROP COLUMN "updated_at",
DROP COLUMN "role",
ADD COLUMN     "role" TEXT;

-- AddForeignKey
ALTER TABLE "TournamentGroup" ADD CONSTRAINT "TournamentGroup_defaultRefereeId_fkey" FOREIGN KEY ("defaultRefereeId") REFERENCES "Referee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TournamentGroup" ADD CONSTRAINT "TournamentGroup_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
