ALTER TYPE "AuditEventType" ADD VALUE 'viewing_granted';
ALTER TYPE "AuditEventType" ADD VALUE 'viewing_revoked';

ALTER TABLE "support_sessions"
    ADD COLUMN "screen_viewing_granted" BOOLEAN NOT NULL DEFAULT FALSE;
