CREATE TABLE IF NOT EXISTS "webhook_log" (
  "id" serial PRIMARY KEY NOT NULL,
  "received_at" timestamp DEFAULT now() NOT NULL,
  "raw_query" jsonb NOT NULL,
  "status" varchar(20) DEFAULT 'received' NOT NULL,
  "error_message" varchar(500),
  "transaction_id" varchar(255)
);
