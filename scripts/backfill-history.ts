/**
 * One-time backfill script: pulls the last N months of transactions from Hyp CSV API,
 * inserts them into the transactions table, and optionally runs reconcile-donors
 * to sync donor_map and Monday.com.
 *
 * Rules enforced:
 *  - Transactions without a resolvable email are SKIPPED (never inserted).
 *  - Already-existing transaction IDs are skipped (fully idempotent).
 *  - Monday.com is only updated when --reconcile flag is passed.
 *
 * Usage:
 *   npm run script:backfill                          # last 6 months, insert only
 *   npm run script:backfill -- --months=3            # last 3 months
 *   npm run script:backfill -- --from=20240901 --to=20250301
 *   npm run script:backfill -- --dry-run             # print only, no DB writes
 *   npm run script:backfill -- --reconcile           # also run reconcile-donors after insert
 */

import 'dotenv/config';
import { eq, and, isNotNull } from 'drizzle-orm';
import { db } from '../src/lib/db';
import { transactions, webhookLog, customerRegistry } from '../src/db/schema';
import { fetchHypTransactions, csvRowToTransaction } from '../src/lib/hyp-poll';
import { runReconcileDonors } from '../src/jobs/reconcile-donors';

// ── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const entry = args.find(a => a.startsWith(`--${name}=`));
  return entry ? entry.split('=')[1] : undefined;
}

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

const DRY_RUN = hasFlag('dry-run');
const RUN_RECONCILE = hasFlag('reconcile');
const MONTHS = parseInt(getArg('months') ?? '6', 10);
const ARG_FROM = getArg('from');
const ARG_TO = getArg('to');

// ── Date helpers ─────────────────────────────────────────────────────────────

function toHypDate(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function israelNow(): Date {
  const israelOffset = 2 * 60 * 60 * 1000; // UTC+2 (conservative; +3 in summer)
  return new Date(Date.now() + israelOffset);
}

/**
 * Returns an array of { from, to } month-level date ranges covering the full period.
 * Each range is at most one calendar month so we don't hit Hyp API size limits.
 */
function buildMonthRanges(fromDate: Date, toDate: Date): Array<{ from: string; to: string }> {
  const ranges: Array<{ from: string; to: string }> = [];
  const cursor = new Date(fromDate);
  cursor.setDate(1); // start from 1st of the month

  while (cursor <= toDate) {
    const monthStart = new Date(cursor);
    // Last day of this month
    const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    const rangeEnd = monthEnd < toDate ? monthEnd : toDate;

    ranges.push({ from: toHypDate(monthStart), to: toHypDate(rangeEnd) });

    // Advance to 1st of next month
    cursor.setMonth(cursor.getMonth() + 1);
    cursor.setDate(1);
  }

  return ranges;
}

// ── Email resolution (mirrors poll-hyp.ts + reconcile-donors.ts logic) ──────

async function resolveEmail(
  transactionId: string,
  agreementId: string | null,
  nationalId: string | null,
): Promise<string | null> {
  // 1. Exact match by transaction ID
  const [byTxId] = await db
    .select({ email: webhookLog.email })
    .from(webhookLog)
    .where(and(eq(webhookLog.transactionId, transactionId), isNotNull(webhookLog.email)))
    .limit(1);
  if (byTxId?.email) return byTxId.email;

  // 2. Match by agreement ID (recurring monthly charges)
  if (agreementId) {
    const [byAgreement] = await db
      .select({ email: webhookLog.email })
      .from(webhookLog)
      .where(and(eq(webhookLog.agreementId, agreementId), isNotNull(webhookLog.email)))
      .orderBy(webhookLog.receivedAt)
      .limit(1);
    if (byAgreement?.email) return byAgreement.email;
  }

  // 3. Match by national ID / UserId
  if (nationalId) {
    const [byUserId] = await db
      .select({ email: webhookLog.email })
      .from(webhookLog)
      .where(and(eq(webhookLog.userId, nationalId), isNotNull(webhookLog.email)))
      .orderBy(webhookLog.receivedAt)
      .limit(1);
    if (byUserId?.email) return byUserId.email;
  }

  // 4. Fallback: customer_registry (manually imported CRM)
  if (nationalId) {
    const [fromRegistry] = await db
      .select({ email: customerRegistry.email })
      .from(customerRegistry)
      .where(eq(customerRegistry.nationalId, nationalId))
      .limit(1);
    if (fromRegistry?.email) {
      console.log(`[backfill] Resolved from customer_registry: nationalId=${nationalId} → ${fromRegistry.email}`);
      return fromRegistry.email;
    }
  }

  return null;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const now = israelNow();

  let dateFrom: Date;
  let dateTo: Date;

  if (ARG_FROM && ARG_TO) {
    dateFrom = new Date(
      `${ARG_FROM.slice(0, 4)}-${ARG_FROM.slice(4, 6)}-${ARG_FROM.slice(6, 8)}`,
    );
    dateTo = new Date(`${ARG_TO.slice(0, 4)}-${ARG_TO.slice(4, 6)}-${ARG_TO.slice(6, 8)}`);
  } else {
    dateTo = now;
    dateFrom = new Date(now);
    dateFrom.setMonth(dateFrom.getMonth() - MONTHS);
  }

  const ranges = buildMonthRanges(dateFrom, dateTo);

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`[backfill] Starting historical backfill`);
  console.log(`[backfill] Period : ${toHypDate(dateFrom)} → ${toHypDate(dateTo)}`);
  console.log(`[backfill] Chunks : ${ranges.length} month(s)`);
  console.log(`[backfill] Dry run: ${DRY_RUN}`);
  console.log(`[backfill] Reconcile after: ${RUN_RECONCILE}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  let totalFetched = 0;
  let totalInserted = 0;
  let totalSkippedExisting = 0;
  let totalSkippedNoEmail = 0;
  let totalErrors = 0;

  for (const range of ranges) {
    console.log(`\n[backfill] ── Fetching ${range.from} → ${range.to} ──`);

    let rows;
    try {
      rows = await fetchHypTransactions(range.from, range.to);
    } catch (err) {
      console.error(`[backfill] Failed to fetch ${range.from}–${range.to}:`, err);
      totalErrors++;
      continue;
    }

    console.log(`[backfill] Fetched ${rows.length} row(s) from Hyp`);
    totalFetched += rows.length;

    for (const row of rows) {
      try {
        // Skip already-persisted transactions (idempotency)
        const [existing] = await db
          .select({ id: transactions.id })
          .from(transactions)
          .where(eq(transactions.transactionId, row.transactionId))
          .limit(1);

        if (existing) {
          totalSkippedExisting++;
          continue;
        }

        const tx = csvRowToTransaction(row);

        const resolvedEmail = await resolveEmail(
          tx.transactionId,
          tx.agreementId ?? null,
          row.nationalId || null,
        );

        if (!resolvedEmail) {
          console.log(
            `[backfill] SKIP (no email) ${tx.transactionId} | ${tx.name} | nationalId=${row.nationalId || 'none'}`,
          );
          totalSkippedNoEmail++;
          continue;
        }

        tx.email = resolvedEmail;

        if (DRY_RUN) {
          console.log(
            `[backfill] DRY-RUN would insert ${tx.transactionId} | ${tx.email} | ${tx.currency} ${tx.amount} | ${tx.status} | ${tx.isRecurring ? 'recurring' : 'one-time'}`,
          );
          totalInserted++;
          continue;
        }

        await db.insert(transactions).values({
          transactionId: tx.transactionId,
          email: tx.email,
          name: tx.name || null,
          amount: tx.amount,
          currency: tx.currency,
          platform: tx.platform,
          status: tx.status,
          isRecurring: tx.isRecurring,
          agreementId: tx.agreementId,
          transactionDate: tx.transactionDate,
          rawPayload: tx.rawPayload,
          // monday_tx_item_id intentionally left NULL → reconcile job will process
        });

        console.log(
          `[backfill] Inserted ${tx.transactionId} | ${tx.email} | ${tx.currency} ${tx.amount} | ${tx.status} | ${tx.isRecurring ? 'recurring' : 'one-time'}`,
        );
        totalInserted++;
      } catch (err) {
        console.error(`[backfill] Error on ${row.transactionId}:`, err);
        totalErrors++;
      }
    }
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('[backfill] Phase 1 Summary:');
  console.log(`  Fetched from Hyp : ${totalFetched}`);
  console.log(`  Inserted         : ${totalInserted}${DRY_RUN ? ' (dry-run)' : ''}`);
  console.log(`  Skipped (exists) : ${totalSkippedExisting}`);
  console.log(`  Skipped (no email): ${totalSkippedNoEmail}`);
  console.log(`  Errors           : ${totalErrors}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (RUN_RECONCILE && !DRY_RUN) {
    if (totalInserted === 0) {
      console.log('\n[backfill] No new transactions inserted — skipping reconcile.');
    } else {
      console.log(`\n[backfill] Starting Phase 2: reconcile-donors (${totalInserted} new transaction(s))...`);
      try {
        const reconcileResult = await runReconcileDonors();
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('[backfill] Phase 2 Summary (reconcile-donors):');
        console.log(`  Processed: ${reconcileResult.processed}`);
        console.log(`  Errors   : ${reconcileResult.errors}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      } catch (err) {
        console.error('[backfill] Reconcile failed:', err);
        process.exit(1);
      }
    }
  } else if (RUN_RECONCILE && DRY_RUN) {
    console.log('\n[backfill] --reconcile ignored in dry-run mode.');
  } else if (!RUN_RECONCILE && totalInserted > 0) {
    console.log(
      `\n[backfill] ${totalInserted} transaction(s) inserted with monday_tx_item_id=NULL.`,
    );
    console.log('[backfill] Run  npm run job:reconcile  to sync donor_map and Monday.com,');
    console.log('[backfill] or re-run with --reconcile to do it automatically.');
  }

  process.exit(totalErrors > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('[backfill] Fatal:', err);
  process.exit(1);
});
