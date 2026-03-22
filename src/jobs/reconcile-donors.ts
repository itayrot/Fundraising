import 'dotenv/config';
import { eq, and, isNull, isNotNull } from 'drizzle-orm';
import { db } from '../lib/db';
import { transactions, webhookLog, donorMap, syncState, customerRegistry } from '../db/schema';
import { upsertDonor, markDonorPendingByEmail } from '../lib/donor-service';
import { checkWebhookHealth } from '../lib/alert';
import type { NormalizedTransaction, Currency, Platform } from '../types';

/**
 * Reconciles unprocessed transactions against webhook_log to build donor_map
 * and sync with Monday.com.
 *
 * For each transaction where monday_tx_item_id IS NULL:
 *   1. Resolve real email: check webhook_log by transaction_id, then by agreement_id
 *   2. Succeeded → upsert donor_map + Monday, mark transaction as reconciled
 *   3. Failed recurring → mark donor as Pending in Monday, mark as reconciled
 *   4. Failed one-time → create one-time row in Monday + mark as reconciled
 *
 * Uses mondayTxItemId as the "reconciled" marker:
 *   - NULL      = not yet reconciled
 *   - 0         = reconciled, no Monday item created (failed / one-time)
 *   - positive  = Monday item ID (recurring: donor item; one-time: N/A, stored as 0)
 */
export async function runReconcileDonors(): Promise<{
  processed: number;
  errors: number;
}> {
  let processed = 0;
  let errors = 0;

  // ── 1. Succeeded transactions ────────────────────────────────────────────────

  const succeeded = await db
    .select()
    .from(transactions)
    .where(
      and(
        isNull(transactions.mondayTxItemId),
        eq(transactions.status, 'succeeded'),
      ),
    );

  console.log(`[reconcile] Found ${succeeded.length} unreconciled succeeded transaction(s)`);

  for (const tx of succeeded) {
    try {
      // Extract nationalId from synthetic email (e.g. "L2533346317@noemail.hyp" → "L2533346317")
      const nationalId = tx.email.endsWith('@noemail.hyp')
        ? tx.email.replace('@noemail.hyp', '')
        : null;

      const resolvedEmail = await resolveEmail(tx.transactionId, tx.agreementId ?? null, nationalId);

      if (!resolvedEmail) {
        // No real email found yet - skip until webhook arrives with donor's real email
        console.log(`[reconcile] Skipping ${tx.transactionId} - no real email found yet (nationalId: ${nationalId})`);
        continue;
      }

      const normalized: NormalizedTransaction = {
        transactionId: tx.transactionId,
        email: resolvedEmail,
        name: tx.name ?? '',
        amount: tx.amount,
        currency: tx.currency as Currency,
        platform: tx.platform as Platform,
        status: 'succeeded',
        isRecurring: tx.isRecurring,
        agreementId: tx.agreementId ?? null,
        transactionDate: tx.transactionDate,
        rawPayload: tx.rawPayload,
      };

      await upsertDonor(normalized);

      // Find the donor's Monday item ID from donor_map
      const [donor] = await db
        .select({ mondayItemId: donorMap.mondayItemId })
        .from(donorMap)
        .where(eq(donorMap.email, resolvedEmail))
        .limit(1);
      const mondayItemId = donor ? Number(donor.mondayItemId) : 0;

      await db
        .update(transactions)
        .set({ mondayTxItemId: mondayItemId, email: resolvedEmail })
        .where(eq(transactions.id, tx.id));

      console.log(`[reconcile] Processed ${tx.transactionId} for ${resolvedEmail} (${tx.isRecurring ? 'recurring' : 'one-time'})`);
      processed++;
    } catch (err) {
      console.error(`[reconcile] Error processing ${tx.transactionId}:`, err);
      errors++;
    }
  }

  // ── 2. Failed recurring → mark donor as Pending ──────────────────────────────

  const failedRecurring = await db
    .select()
    .from(transactions)
    .where(
      and(
        isNull(transactions.mondayTxItemId),
        eq(transactions.status, 'failed'),
        eq(transactions.isRecurring, true),
      ),
    );

  console.log(`[reconcile] Found ${failedRecurring.length} unreconciled failed recurring transaction(s)`);

  for (const tx of failedRecurring) {
    try {
      const nationalId = tx.email.endsWith('@noemail.hyp')
        ? tx.email.replace('@noemail.hyp', '')
        : null;

      const resolvedEmail = await resolveEmail(tx.transactionId, tx.agreementId ?? null, nationalId);

      if (!resolvedEmail) {
        console.log(`[reconcile] Skipping failed recurring ${tx.transactionId} - no real email found yet`);
        continue;
      }

      const txDate = tx.transactionDate.toISOString().split('T')[0];
      await markDonorPendingByEmail(resolvedEmail, {
        date: txDate,
        amount: tx.amount,
        currency: tx.currency,
      });

      await db
        .update(transactions)
        .set({ mondayTxItemId: 0, email: resolvedEmail })
        .where(eq(transactions.id, tx.id));

      console.log(`[reconcile] Marked Pending: ${resolvedEmail} (tx: ${tx.transactionId})`);
      processed++;
    } catch (err) {
      console.error(`[reconcile] Error on failed recurring ${tx.transactionId}:`, err);
      errors++;
    }
  }

  // ── 3. Failed one-time → create row in one-time Monday board ─────────────────

  const failedOneTime = await db
    .select()
    .from(transactions)
    .where(
      and(
        isNull(transactions.mondayTxItemId),
        eq(transactions.status, 'failed'),
        eq(transactions.isRecurring, false),
      ),
    );

  console.log(`[reconcile] Found ${failedOneTime.length} unreconciled failed one-time transaction(s)`);

  for (const tx of failedOneTime) {
    try {
      const nationalId = tx.email.endsWith('@noemail.hyp')
        ? tx.email.replace('@noemail.hyp', '')
        : null;

      const resolvedEmail = await resolveEmail(tx.transactionId, tx.agreementId ?? null, nationalId);

      if (!resolvedEmail) {
        console.log(`[reconcile] Skipping failed one-time ${tx.transactionId} - no real email found yet`);
        continue;
      }

      const normalized: NormalizedTransaction = {
        transactionId: tx.transactionId,
        email: resolvedEmail,
        name: tx.name ?? '',
        amount: tx.amount,
        currency: tx.currency as Currency,
        platform: tx.platform as Platform,
        status: 'failed',
        isRecurring: false,
        agreementId: tx.agreementId ?? null,
        transactionDate: tx.transactionDate,
        rawPayload: tx.rawPayload,
      };

      await upsertDonor(normalized);

      await db
        .update(transactions)
        .set({ mondayTxItemId: 0, email: resolvedEmail })
        .where(eq(transactions.id, tx.id));

      console.log(`[reconcile] Logged failed one-time in Monday: ${resolvedEmail} (tx: ${tx.transactionId})`);
      processed++;
    } catch (err) {
      console.error(`[reconcile] Error on failed one-time ${tx.transactionId}:`, err);
      errors++;
    }
  }

  // ── 4. Webhook health check ──────────────────────────────────────────────────

  try {
    await checkWebhookHealth();
  } catch (err) {
    console.error('[reconcile] Webhook health check failed:', err);
  }

  // ── 5. Persist run state ─────────────────────────────────────────────────────

  await db
    .insert(syncState)
    .values({
      operation: 'reconcile-donors',
      lastRun: new Date(),
      status: errors === 0 ? 'ok' : 'partial',
      details: { processed, errors },
    })
    .onConflictDoUpdate({
      target: syncState.operation,
      set: {
        lastRun: new Date(),
        status: errors === 0 ? 'ok' : 'partial',
        details: { processed, errors },
      },
    });

  console.log(`[reconcile] Done - processed: ${processed}, errors: ${errors}`);
  return { processed, errors };
}

/**
 * Resolves the real donor email from webhook_log.
 *
 * Priority:
 *  1. Exact match by transaction_id (payment-page donation captured in real time)
 *  2. Match by agreement_id (first payment of a recurring agreement)
 *  3. Match by user_id / national_id (recurring monthly charge - nationalId in CSV = UserId in webhook)
 */
async function resolveEmail(
  transactionId: string,
  agreementId: string | null,
  nationalId: string | null,
): Promise<string | null> {
  // 1. Exact match by transaction ID
  const [byTxId] = await db
    .select({ email: webhookLog.email })
    .from(webhookLog)
    .where(
      and(
        eq(webhookLog.transactionId, transactionId),
        isNotNull(webhookLog.email),
      ),
    )
    .limit(1);

  if (byTxId?.email) return byTxId.email;

  // 2. Match by agreement ID
  if (agreementId) {
    const [byAgreement] = await db
      .select({ email: webhookLog.email })
      .from(webhookLog)
      .where(
        and(
          eq(webhookLog.agreementId, agreementId),
          isNotNull(webhookLog.email),
        ),
      )
      .orderBy(webhookLog.receivedAt)
      .limit(1);

    if (byAgreement?.email) return byAgreement.email;
  }

  // 3. Match by UserId (nationalId in CSV = UserId sent in webhook)
  if (nationalId) {
    const [byUserId] = await db
      .select({ email: webhookLog.email })
      .from(webhookLog)
      .where(
        and(
          eq(webhookLog.userId, nationalId),
          isNotNull(webhookLog.email),
        ),
      )
      .orderBy(webhookLog.receivedAt)
      .limit(1);

    if (byUserId?.email) return byUserId.email;
  }

  // 4. Fallback: customer_registry (manually imported CRM / spreadsheet)
  if (nationalId) {
    const [fromRegistry] = await db
      .select({ email: customerRegistry.email })
      .from(customerRegistry)
      .where(eq(customerRegistry.nationalId, nationalId))
      .limit(1);

    if (fromRegistry?.email) {
      console.log(`[reconcile] Resolved email from customer_registry for nationalId ${nationalId}`);
      return fromRegistry.email;
    }
  }

  return null;
}

// Allow running directly: `npm run job:reconcile`
if (require.main === module) {
  runReconcileDonors()
    .then(result => {
      console.log('[reconcile] Result:', result);
      process.exit(0);
    })
    .catch(err => {
      console.error('[reconcile] Fatal:', err);
      process.exit(1);
    });
}
