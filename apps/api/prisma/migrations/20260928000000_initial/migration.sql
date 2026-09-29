CREATE TYPE "SessionStatus" AS ENUM (
    'waiting_for_customer',
    'awaiting_approval',
    'approved',
    'rejected',
    'ended',
    'expired'
);

CREATE TYPE "ActorType" AS ENUM ('technician', 'customer', 'system');
CREATE TYPE "AuditEventType" AS ENUM ('created', 'customer_joined', 'approved', 'rejected', 'ended', 'expired');

CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "technicians" (
    "id" VARCHAR(255) NOT NULL,
    "organization_id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "role" VARCHAR(32) NOT NULL DEFAULT 'technician',
    CONSTRAINT "technicians_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "support_sessions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "technician_id" VARCHAR(255) NOT NULL,
    "code_hash" VARCHAR(64),
    "decision_token_hash" VARCHAR(64),
    "customer_access_token_hash" VARCHAR(64),
    "status" "SessionStatus" NOT NULL DEFAULT 'waiting_for_customer',
    "purpose" VARCHAR(240) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "customer_label" VARCHAR(120),
    "ended_at" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "support_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "actor_type" "ActorType" NOT NULL,
    "actor_id" VARCHAR(255),
    "event_type" "AuditEventType" NOT NULL,
    "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "support_sessions_organization_id_created_at_idx" ON "support_sessions"("organization_id", "created_at");
CREATE INDEX "support_sessions_technician_id_created_at_idx" ON "support_sessions"("technician_id", "created_at");
CREATE INDEX "support_sessions_status_expires_at_idx" ON "support_sessions"("status", "expires_at");
CREATE INDEX "audit_events_session_id_occurred_at_idx" ON "audit_events"("session_id", "occurred_at");
CREATE UNIQUE INDEX "support_sessions_active_code_hash_key" ON "support_sessions"("code_hash")
    WHERE "code_hash" IS NOT NULL AND "status" IN ('waiting_for_customer', 'awaiting_approval', 'approved');

ALTER TABLE "technicians" ADD CONSTRAINT "technicians_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_technician_id_fkey"
    FOREIGN KEY ("technician_id") REFERENCES "technicians"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "support_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
