import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db } from '../lib/db';
import { transactions, syncState } from '../db/schema';
import { fetchHypTransactions, csvRowToTransaction } from '../lib/hyp-poll';

/**
 * Polls Hyp API for today's transactions and saves them to the transactions table.
 * Runs every 10 minutes via cron.
 *
 * Note: Email is not available in the Hyp CSV export. A synthetic email
 * (nationalId@noemail.hyp) is stored as placeholder. The reconcile-donors job
 * resolves real emails from webhook_log and updates donor_map + Monday.com.
 */
export async function runPollHyp(): Promise<{ fetched: number; saved: number; skipped: number; errors: number }> {
  const now = new Date();

  // Fetch date range in YYYYMMDD format (Israel time = UTC+2/+3)
  const israelOffset = 2 * 60 * 60 * 1000; // UTC+2 (adjust to +3 in summer if needed)
  const israelNow = new Date(now.getTime() + israelOffset);
  const todayStr = israelNow.toISOString().slice(0, 10).replace(/-/g, '');

  // TODO: revert to single-day fetch after initial backfill is confirmed
  const sevenDaysAgo = new Date(israelNow.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fromStr = sevenDaysAgo.toISOString().slice(0, 10).replace(/-/g, '');

  console.log(`[poll-hyp] Running for date range ${fromStr} → ${todayStr}`);

  let rows;
  try {
    rows = await fetchHypTransactions(fromStr, todayStr);
  } catch (err) {
    console.error('[poll-hyp] Failed to fetch from Hyp API:', err);
    await updateSyncState('poll-hyp', 'error', { error: String(err) });
    return { fetched: 0, saved: 0, skipped: 0, errors: 1 };
  }

  console.log(`[poll-hyp] Fetched ${rows.length} rows from Hyp`);

  let saved = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of rows) {
    try {
      // Idempotency - skip already saved transactions
      const [existing] = await db
        .select({ id: transactions.id })
        .from(transactions)
        .where(eq(transactions.transactionId, row.transactionId))
        .limit(1);

      if (existing) {
        skipped++;
        continue;
      }

      const tx = csvRowToTransaction(row);

      // Use synthetic email as placeholder - reconcile job resolves real email later
      const syntheticEmail = `${row.nationalId || row.firstName.replace(/\s+/g, '.')}@noemail.hyp`;
      tx.email = syntheticEmail;

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
      });

      console.log(`[poll-hyp] Saved ${tx.transactionId} (${tx.isRecurring ? 'recurring' : 'one-time'}, ${tx.currency} ${tx.amount}, status=${tx.status})`);
      saved++;
    } catch (err) {
      console.error(`[poll-hyp] Error saving transaction ${row.transactionId}:`, err);
      errors++;
    }
  }

  await updateSyncState('poll-hyp', errors === 0 ? 'ok' : 'partial', {
    dateFrom: fromStr,
    dateTo: todayStr,
    fetched: rows.length,
    saved,
    skipped,
    errors,
  });

  console.log(`[poll-hyp] Done - saved: ${saved}, skipped: ${skipped}, errors: ${errors}`);
  return { fetched: rows.length, saved, skipped, errors };
}

async function updateSyncState(operation: string, status: string, details: object): Promise<void> {
  await db
    .insert(syncState)
    .values({ operation, lastRun: new Date(), status, details })
    .onConflictDoUpdate({
      target: syncState.operation,
      set: { lastRun: new Date(), status, details },
    });
}

// Allow running directly: `npm run job:poll-hyp`
if (require.main === module) {
  runPollHyp()
    .then(result => {
      console.log('[poll-hyp] Result:', result);
      process.exit(0);
    })
    .catch(err => {
      console.error('[poll-hyp] Fatal:', err);
      process.exit(1);
    });
}
