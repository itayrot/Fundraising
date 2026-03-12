import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db } from '../lib/db';
import { transactions, donorMap, syncState } from '../db/schema';
import { fetchHypTransactions, csvRowToTransaction } from '../lib/hyp-poll';
import { upsertDonor, markDonorPendingByEmail } from '../lib/donor-service';

/**
 * Polls Hyp API for transactions in the last 20 minutes (with overlap to avoid gaps).
 * Runs every 10 minutes via cron.
 *
 * Note: Hyp CSV does not include email. We look up the donor's email from donor_map
 * using their name. If not found, we use a synthetic email from their national ID
 * so the transaction is still recorded.
 */
export async function runPollHyp(): Promise<{ fetched: number; processed: number; skipped: number; errors: number }> {
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
    return { fetched: 0, processed: 0, skipped: 0, errors: 1 };
  }

  console.log(`[poll-hyp] Fetched ${rows.length} rows from Hyp`);

  let processed = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of rows) {
    try {
      // Handle failed transactions - record them and mark donor Pending if recurring
      if (!row.approved) {
        const tx = csvRowToTransaction(row);
        const email = await resolveEmail(row.firstName, row.lastName, row.nationalId);
        tx.email = email;

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

        if (tx.isRecurring) {
          await markDonorPendingByEmail(tx.email);
          console.log(`[poll-hyp] Failed recurring ${tx.transactionId} for ${tx.email} - marked Pending`);
        } else {
          console.log(`[poll-hyp] Failed one-time ${tx.transactionId} for ${tx.email} - recorded only`);
        }
        processed++;
        continue;
      }

      // Idempotency - skip already processed
      const [existing] = await db
        .select({ id: transactions.id })
        .from(transactions)
        .where(eq(transactions.transactionId, row.transactionId))
        .limit(1);

      if (existing) {
        skipped++;
        continue;
      }

      // Resolve email from donor_map by name, or use synthetic
      const email = await resolveEmail(row.firstName, row.lastName, row.nationalId);

      const tx = csvRowToTransaction(row);
      tx.email = email;

      // Persist transaction
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

      // Update donor in DB + Monday
      await upsertDonor(tx);

      console.log(`[poll-hyp] Processed ${tx.transactionId} for ${tx.email} (${tx.isRecurring ? 'recurring' : 'one-time'}, ${tx.currency} ${tx.amount})`);
      processed++;
    } catch (err) {
      console.error(`[poll-hyp] Error processing transaction ${row.transactionId}:`, err);
      errors++;
    }
  }

  await updateSyncState('poll-hyp', errors === 0 ? 'ok' : 'partial', {
    date: dateStr,
    fetched: rows.length,
    processed,
    skipped,
    errors,
  });

  console.log(`[poll-hyp] Done - processed: ${processed}, skipped: ${skipped}, errors: ${errors}`);
  return { fetched: rows.length, processed, skipped, errors };
}

/**
 * Tries to find an existing donor email by matching first+last name in donor_map.
 * Falls back to a synthetic email using national ID.
 */
async function resolveEmail(firstName: string, lastName: string, nationalId: string): Promise<string> {
  const fullName = `${firstName} ${lastName}`.trim();

  const [donor] = await db
    .select({ email: donorMap.email })
    .from(donorMap)
    .where(eq(donorMap.name, fullName))
    .limit(1);

  if (donor) return donor.email;

  // Synthetic fallback - still records the transaction
  const id = nationalId || fullName.replace(/\s+/g, '.').toLowerCase();
  console.warn(`[poll-hyp] No email found for "${fullName}" - using synthetic: ${id}@noemail.hyp`);
  return `${id}@noemail.hyp`;
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
