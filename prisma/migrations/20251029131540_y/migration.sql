/*
  Warnings:

  - The values [RB,CB,LB,RWB,LWB,DM,CM,AM,RW,LW,SS,ST] on the enum `FieldPosition` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "FieldPosition_new" AS ENUM ('GK', 'DEF', 'MID', 'FW');
ALTER TABLE "LeagueTeamPlayer" ALTER COLUMN "position" TYPE "FieldPosition_new" USING ("position"::text::"FieldPosition_new");
ALTER TABLE "TeamLineupItem" ALTER COLUMN "position" TYPE "FieldPosition_new" USING ("position"::text::"FieldPosition_new");
ALTER TABLE "PlayerMatch" ALTER COLUMN "position" TYPE "FieldPosition_new" USING ("position"::text::"FieldPosition_new");
ALTER TABLE "TournamentTeamPlayer" ALTER COLUMN "position" TYPE "FieldPosition_new" USING ("position"::text::"FieldPosition_new");
ALTER TABLE "TournamentPlayerMatch" ALTER COLUMN "position" TYPE "FieldPosition_new" USING ("position"::text::"FieldPosition_new");
ALTER TABLE "TeamInvite" ALTER COLUMN "desiredPosition" TYPE "FieldPosition_new" USING ("desiredPosition"::text::"FieldPosition_new");
ALTER TYPE "FieldPosition" RENAME TO "FieldPosition_old";
ALTER TYPE "FieldPosition_new" RENAME TO "FieldPosition";
DROP TYPE "public"."FieldPosition_old";
COMMIT;

-- AlterTable
ALTER TABLE "Team" ADD COLUMN     "smallTitle" TEXT;

-- AlterTable
ALTER TABLE "Tournament" ALTER COLUMN "format" DROP NOT NULL;
