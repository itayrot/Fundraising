-- Add email and agreement_id columns to webhook_log for fast email resolution
ALTER TABLE "webhook_log"
  ADD COLUMN IF NOT EXISTS "email" varchar(255),
  ADD COLUMN IF NOT EXISTS "agreement_id" varchar(100);

-- Index for looking up real emails by agreement_id during API polling
CREATE INDEX IF NOT EXISTS "webhook_log_agreement_id_idx"
  ON "webhook_log" ("agreement_id")
  WHERE "agreement_id" IS NOT NULL;
