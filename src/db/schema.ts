import {
  pgTable,
  serial,
  varchar,
  numeric,
  timestamp,
  date,
  jsonb,
  bigint,
} from 'drizzle-orm/pg-core';

export const transactions = pgTable('transactions', {
  id: serial('id').primaryKey(),
  transactionId: varchar('transaction_id', { length: 255 }).unique().notNull(),
  email: varchar('email', { length: 255 }).notNull(),
  name: varchar('name', { length: 255 }),
  amount: numeric('amount', { precision: 10, scale: 2 }).notNull(),
  currency: varchar('currency', { length: 3 }).notNull(),
  platform: varchar('platform', { length: 20 }).notNull().default('hyp'),
  // 'succeeded' | 'failed' | 'refunded'
  status: varchar('status', { length: 20 }).notNull(),
  transactionDate: timestamp('transaction_date').notNull(),
  rawPayload: jsonb('raw_payload'),
  mondayTxItemId: bigint('monday_tx_item_id', { mode: 'number' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const donorMap = pgTable('donor_map', {
  id: serial('id').primaryKey(),
  email: varchar('email', { length: 255 }).unique().notNull(),
  name: varchar('name', { length: 255 }),
  mondayItemId: bigint('monday_item_id', { mode: 'number' }).notNull(),
  firstDonationDate: date('first_donation_date').notNull(),
  lastDonationDate: date('last_donation_date').notNull(),
  amount: numeric('amount', { precision: 10, scale: 2 }).notNull(),
  currency: varchar('currency', { length: 3 }).notNull(),
  platform: varchar('platform', { length: 20 }).notNull(),
  // 'active' | 'pending' | 'inactive'
  status: varchar('status', { length: 20 }).notNull().default('active'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const syncState = pgTable('sync_state', {
  id: serial('id').primaryKey(),
  operation: varchar('operation', { length: 50 }).unique().notNull(),
  lastRun: timestamp('last_run'),
  status: varchar('status', { length: 20 }),
  details: jsonb('details'),
});
