-- Add user_id column to webhook_log for matching recurring CSV charges to donor emails
ALTER TABLE webhook_log ADD COLUMN IF NOT EXISTS user_id VARCHAR(100);
CREATE INDEX IF NOT EXISTS idx_webhook_log_user_id ON webhook_log(user_id) WHERE user_id IS NOT NULL;
