-- Donations integration schema
-- Run with: psql -U donations -d donations -f migrations/001_init.sql

CREATE TABLE IF NOT EXISTS transactions (
    id                SERIAL PRIMARY KEY,
    transaction_id    VARCHAR(255) UNIQUE NOT NULL,
    email             VARCHAR(255) NOT NULL,
    name              VARCHAR(255),
    amount            NUMERIC(10, 2) NOT NULL,
    currency          VARCHAR(3) NOT NULL,
    platform          VARCHAR(20) NOT NULL DEFAULT 'hyp',
    status            VARCHAR(20) NOT NULL,             -- succeeded | failed | refunded
    is_recurring      BOOLEAN NOT NULL DEFAULT FALSE,
    agreement_id      VARCHAR(100),                     -- Hyp standing-order agreement ID
    transaction_date  TIMESTAMP NOT NULL,
    raw_payload       JSONB,
    monday_tx_item_id BIGINT,
    created_at        TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS donor_map (
    id                  SERIAL PRIMARY KEY,
    email               VARCHAR(255) UNIQUE NOT NULL,
    name                VARCHAR(255),
    monday_item_id      BIGINT NOT NULL,
    first_donation_date DATE NOT NULL,
    last_donation_date  DATE NOT NULL,
    amount              NUMERIC(10, 2) NOT NULL,
    currency            VARCHAR(3) NOT NULL,
    platform            VARCHAR(20) NOT NULL,
    is_recurring        BOOLEAN NOT NULL DEFAULT FALSE,
    agreement_id        VARCHAR(100),
    status              VARCHAR(20) NOT NULL DEFAULT 'active',  -- active | pending | inactive
    created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sync_state (
    id        SERIAL PRIMARY KEY,
    operation VARCHAR(50) UNIQUE NOT NULL,
    last_run  TIMESTAMP,
    status    VARCHAR(20),
    details   JSONB
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_transactions_email ON transactions(email);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_donor_map_status ON donor_map(status);
CREATE INDEX IF NOT EXISTS idx_donor_map_first_date_day ON donor_map(EXTRACT(DAY FROM first_donation_date));
