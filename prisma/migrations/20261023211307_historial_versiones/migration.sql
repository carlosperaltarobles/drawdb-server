-- CreateEnum
CREATE TYPE "SnapshotKind" AS ENUM ('auto', 'named', 'pre_restore', 'pre_bulk_delete');

-- AlterTable
ALTER TABLE "project_snapshots" ADD COLUMN     "authors" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "created_by" UUID,
ADD COLUMN     "kind" "SnapshotKind" NOT NULL DEFAULT 'auto',
ADD COLUMN     "name" TEXT,
ADD COLUMN     "size_bytes" INTEGER;

-- CreateIndex
CREATE INDEX "project_snapshots_project_id_kind_idx" ON "project_snapshots"("project_id", "kind");

-- AddForeignKey
ALTER TABLE "project_snapshots" ADD CONSTRAINT "project_snapshots_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

