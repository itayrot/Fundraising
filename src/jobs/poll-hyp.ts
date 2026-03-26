import 'dotenv/config';
import { eq, and, isNotNull } from 'drizzle-orm';
import { db } from '../lib/db';
import { transactions, syncState, webhookLog, customerRegistry } from '../db/schema';
import { fetchHypTransactions, csvRowToTransaction } from '../lib/hyp-poll';

/**
 * Polls Hyp API for today's transactions and saves them to the transactions table.
 * Runs every 10 minutes via cron.
 *
 * For each CSV row, we attempt to resolve the real donor email by cross-referencing
 * with webhook_log using the transaction_id. If found, the real email is stored
 * directly - no synthetic email needed. If not found, a synthetic email is used
 * as placeholder until a webhook arrives.
 */
export async function runPollHyp(): Promise<{ fetched: number; saved: number; skipped: number; errors: number }> {
  const now = new Date();

  // Fetch today's date in YYYYMMDD format (Israel time = UTC+2/+3)
  const israelOffset = 2 * 60 * 60 * 1000; // UTC+2 (adjust to +3 in summer if needed)
  const israelNow = new Date(now.getTime() + israelOffset);
  const dateStr = israelNow.toISOString().slice(0, 10).replace(/-/g, '');

  console.log(`[poll-hyp] Running for date ${dateStr}`);

  let rows;
  try {
    rows = await fetchHypTransactions(dateStr, dateStr);
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

      // Resolve real email from webhook_log using three fallback strategies
      let resolvedEmail: string | null = null;

      // 1. Exact match by transaction ID (one-time donations + first recurring charge)
      const [byTxId] = await db
        .select({ email: webhookLog.email })
        .from(webhookLog)
        .where(and(eq(webhookLog.transactionId, row.transactionId), isNotNull(webhookLog.email)))
        .limit(1);
      if (byTxId?.email) resolvedEmail = byTxId.email;

      // 2. Match by agreement ID (recurring monthly charges — email from the original signup webhook)
      if (!resolvedEmail && tx.agreementId) {
        const [byAgreement] = await db
          .select({ email: webhookLog.email })
          .from(webhookLog)
          .where(and(eq(webhookLog.agreementId, tx.agreementId), isNotNull(webhookLog.email)))
          .orderBy(webhookLog.receivedAt)
          .limit(1);
        if (byAgreement?.email) resolvedEmail = byAgreement.email;
      }

      // 3. Match by national ID / UserId (CSV nationalId = webhook UserId)
      if (!resolvedEmail && row.nationalId) {
        const [byUserId] = await db
          .select({ email: webhookLog.email })
          .from(webhookLog)
          .where(and(eq(webhookLog.userId, row.nationalId), isNotNull(webhookLog.email)))
          .orderBy(webhookLog.receivedAt)
          .limit(1);
        if (byUserId?.email) resolvedEmail = byUserId.email;
      }

      // 4. Fallback: customer_registry (manually imported CRM / spreadsheet)
      if (!resolvedEmail && row.nationalId) {
        const [fromRegistry] = await db
          .select({ email: customerRegistry.email })
          .from(customerRegistry)
          .where(eq(customerRegistry.nationalId, row.nationalId))
          .limit(1);
        if (fromRegistry?.email) {
          resolvedEmail = fromRegistry.email;
          console.log(`[poll-hyp] Resolved email from customer_registry for ${tx.transactionId}: ${resolvedEmail}`);
        }
      }

      if (resolvedEmail) {
        tx.email = resolvedEmail;
        console.log(`[poll-hyp] Resolved email for ${tx.transactionId}: ${tx.email}`);
      } else {
        tx.email = `${row.nationalId || tx.transactionId}@noemail.hyp`;
        console.log(`[poll-hyp] No real email for ${tx.transactionId}, saving with synthetic: ${tx.email}`);
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
      });

      console.log(`[poll-hyp] Saved ${tx.transactionId} (${tx.isRecurring ? 'recurring' : 'one-time'}, ${tx.currency} ${tx.amount}, status=${tx.status}, email=${tx.email})`);
      saved++;
    } catch (err) {
      console.error(`[poll-hyp] Error saving transaction ${row.transactionId}:`, err);
      errors++;
    }
  }

  // Also ingest any webhook-only transactions (not in CSV) that have real emails
  const webhookOnlyResult = await ingestWebhookOnlyTransactions();
  saved += webhookOnlyResult.saved;
  errors += webhookOnlyResult.errors;

  await updateSyncState('poll-hyp', errors === 0 ? 'ok' : 'partial', {
    date: dateStr,
    fetched: rows.length,
    saved,
    skipped,
    errors,
  });

  console.log(`[poll-hyp] Done - saved: ${saved}, skipped: ${skipped}, errors: ${errors}`);
  return { fetched: rows.length, saved, skipped, errors };
}

/**
 * Ingests transactions that arrived via webhook but were never picked up by CSV polling
 * (e.g. transactions from previous days, or one-time donations).
 * Only processes webhooks with a real email and CCode=0 (success).
 */
async function ingestWebhookOnlyTransactions(): Promise<{ saved: number; errors: number }> {
  // Find webhook_log entries with real email that are not yet in transactions
  const unprocessed = await db
    .select()
    .from(webhookLog)
    .where(
      and(
        eq(webhookLog.status, 'logged'),
        isNotNull(webhookLog.email),
        isNotNull(webhookLog.transactionId),
      ),
    );

  let saved = 0;
  let errors = 0;

  for (const entry of unprocessed) {
    try {
      if (!entry.transactionId || !entry.email) continue;

      // Check if already in transactions
      const [existing] = await db
        .select({ id: transactions.id })
        .from(transactions)
        .where(eq(transactions.transactionId, entry.transactionId))
        .limit(1);

      if (existing) {
        // Mark as processed even if already in transactions
        await db.update(webhookLog).set({ status: 'processed' }).where(eq(webhookLog.id, entry.id));
        continue;
      }

      // raw_query may be stored as a nested JSON string in jsonb - parse it
      const rawStored = entry.rawQuery;
      const raw: Record<string, string> = typeof rawStored === 'string'
        ? JSON.parse(rawStored)
        : rawStored as Record<string, string>;
      const ccode = raw.CCode ?? '';
      const status = ccode === '0' ? 'succeeded' : 'failed';
      const amount = raw.Amount ?? '0';
      const coinMap: Record<string, string> = { '1': 'ILS', '2': 'USD', '3': 'EUR', '4': 'GBP' };
      const currency = coinMap[raw.Coin ?? '1'] ?? 'ILS';
      const name = `${raw.Fild1 ?? ''}`.trim();
      // Recurring if: has agreement_id (from HKId), or HKId in raw, or Payments > 1
      const isRecurring = !!(entry.agreementId || raw.HKId || (raw.Payments && raw.Payments !== '1'));
      // Use webhook received_at as the transaction date (most accurate available)
      const transactionDate = entry.receivedAt ?? new Date();

      const agreementId = entry.agreementId || raw.HKId || null;

      await db.insert(transactions).values({
        transactionId: entry.transactionId,
        email: entry.email,
        name: name || null,
        amount,
        currency,
        platform: 'hyp',
        status,
        isRecurring,
        agreementId,
        transactionDate,
        rawPayload: raw,
      });

      await db.update(webhookLog).set({ status: 'processed' }).where(eq(webhookLog.id, entry.id));

      console.log(`[poll-hyp] Ingested webhook-only tx ${entry.transactionId} for ${entry.email} (${isRecurring ? 'recurring' : 'one-time'}, status=${status})`);
      saved++;
    } catch (err) {
      console.error(`[poll-hyp] Error ingesting webhook tx ${entry.transactionId}:`, err);
      errors++;
    }
  }

  if (saved > 0) console.log(`[poll-hyp] Ingested ${saved} webhook-only transaction(s)`);
  return { saved, errors };
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
