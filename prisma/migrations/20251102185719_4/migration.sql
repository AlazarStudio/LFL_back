/*
  Warnings:

  - The `tour_number` column on the `TournamentMatch` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
ALTER TABLE "TournamentMatch" DROP COLUMN "tour_number",
ADD COLUMN     "tour_number" INTEGER;
