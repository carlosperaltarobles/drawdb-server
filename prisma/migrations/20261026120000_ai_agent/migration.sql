-- AlterEnum
ALTER TYPE "SnapshotKind" ADD VALUE IF NOT EXISTS 'pre_ai_apply';

-- CreateEnum
CREATE TYPE "AiMessageRole" AS ENUM ('user', 'assistant');

-- CreateEnum
CREATE TYPE "AiMessageStatus" AS ENUM ('pending', 'complete', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "AiGenerationStatus" AS ENUM ('pending', 'running', 'complete', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "AiProposalStatus" AS ENUM ('pending', 'superseded', 'discarded', 'applied', 'expired');

-- CreateTable
CREATE TABLE "ai_conversations" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "selected_model" TEXT,
    "title" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "role" "AiMessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "status" "AiMessageStatus" NOT NULL DEFAULT 'pending',
    "requested_model" TEXT,
    "reported_model" TEXT,
    "usage" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_proposals" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "requested_model" TEXT NOT NULL,
    "reported_model" TEXT,
    "base_diagram" JSONB NOT NULL,
    "after_diagram" JSONB NOT NULL,
    "ops" JSONB NOT NULL,
    "base_version" BIGINT NOT NULL,
    "base_hash" TEXT NOT NULL,
    "status" "AiProposalStatus" NOT NULL DEFAULT 'pending',
    "summary" JSONB NOT NULL,
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "expires_at" TIMESTAMPTZ NOT NULL,
    "applied_version" BIGINT,
    "snapshot_id" UUID,
    "applied_result" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_generations" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "status" "AiGenerationStatus" NOT NULL DEFAULT 'pending',
    "requested_model" TEXT NOT NULL,
    "reported_model" TEXT,
    "assistant_message_id" UUID NOT NULL,
    "proposal_id" UUID,
    "error_code" TEXT,
    "continuation" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_generations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_conversations_project_id_user_id_updated_at_idx" ON "ai_conversations"("project_id", "user_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "ai_conversations_updated_at_idx" ON "ai_conversations"("updated_at");

-- CreateIndex
CREATE INDEX "ai_messages_conversation_id_created_at_id_idx" ON "ai_messages"("conversation_id", "created_at" ASC, "id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "ai_proposals_conversation_id_revision_key" ON "ai_proposals"("conversation_id", "revision");

-- CreateIndex
CREATE INDEX "ai_proposals_conversation_id_status_idx" ON "ai_proposals"("conversation_id", "status");

-- CreateIndex
CREATE INDEX "ai_proposals_status_expires_at_idx" ON "ai_proposals"("status", "expires_at");

-- CreateIndex
CREATE INDEX "ai_proposals_project_id_user_id_created_at_idx" ON "ai_proposals"("project_id", "user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ai_generations_conversation_id_user_id_request_id_key" ON "ai_generations"("conversation_id", "user_id", "request_id");

-- CreateIndex
CREATE INDEX "ai_generations_project_id_user_id_status_idx" ON "ai_generations"("project_id", "user_id", "status");

-- CreateIndex
CREATE INDEX "ai_generations_conversation_id_status_idx" ON "ai_generations"("conversation_id", "status");

-- AddForeignKey
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_proposals" ADD CONSTRAINT "ai_proposals_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_proposals" ADD CONSTRAINT "ai_proposals_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_proposals" ADD CONSTRAINT "ai_proposals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_proposals" ADD CONSTRAINT "ai_proposals_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "project_snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_generations" ADD CONSTRAINT "ai_generations_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_generations" ADD CONSTRAINT "ai_generations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_generations" ADD CONSTRAINT "ai_generations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_generations" ADD CONSTRAINT "ai_generations_assistant_message_id_fkey" FOREIGN KEY ("assistant_message_id") REFERENCES "ai_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_generations" ADD CONSTRAINT "ai_generations_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "ai_proposals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

