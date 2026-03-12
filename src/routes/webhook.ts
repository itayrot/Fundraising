import { Router, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../lib/db';
import { transactions, webhookLog } from '../db/schema';
import { parseHypWebhook, type HypRawParams } from '../lib/hyp';
import { upsertDonor, markDonorPendingByEmail } from '../lib/donor-service';

const router = Router();

/**
 * Hyp sends webhooks as HTTP GET requests with all data as query parameters.
 * URL to register with Hyp: https://<domain>/api/webhook/hyp
 */
router.get('/hyp', async (req: Request, res: Response) => {
  // Hyp requires a 200 response immediately
  res.status(200).send('OK');

  // Process async after responding
  processHypWebhook(req.query as HypRawParams).catch((err) => {
    console.error('[webhook/hyp] Async processing error:', err);
  });
});

async function processHypWebhook(params: HypRawParams): Promise<void> {
  console.log('[webhook/hyp] Received:', JSON.stringify(params));

  // Log every incoming request to webhook_log
  const [logEntry] = await db
    .insert(webhookLog)
    .values({ rawQuery: params, status: 'received' })
    .returning({ id: webhookLog.id });

  let tx;
  try {
    tx = parseHypWebhook(params);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[webhook/hyp] Failed to parse payload:', err);
    await db.update(webhookLog)
      .set({ status: 'error', errorMessage: msg })
      .where(eq(webhookLog.id, logEntry.id));
    return;
  }

  // Idempotency - skip duplicates
  const [existing] = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.transactionId, tx.transactionId))
    .limit(1);

  if (existing) {
    console.log(`[webhook/hyp] Duplicate transaction ${tx.transactionId} - skipping`);
    await db.update(webhookLog)
      .set({ status: 'duplicate', transactionId: tx.transactionId })
      .where(eq(webhookLog.id, logEntry.id));
    return;
  }

  // Persist transaction - always, regardless of success or failure
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

  // Mark log entry as processed
  await db.update(webhookLog)
    .set({ status: 'processed', transactionId: tx.transactionId })
    .where(eq(webhookLog.id, logEntry.id));

  if (tx.status === 'succeeded') {
    // Successful charge - upsert donor (create or update last donation date)
    await upsertDonor(tx);
    console.log(`[webhook/hyp] Processed ${tx.transactionId} for ${tx.email} (${tx.isRecurring ? 'recurring' : 'one-time'})`);
  } else {
    // Failed charge - if recurring donor exists, mark as Pending
    if (tx.isRecurring) {
      await markDonorPendingByEmail(tx.email);
      console.log(`[webhook/hyp] Failed recurring transaction ${tx.transactionId} for ${tx.email} - marked Pending`);
    } else {
      console.log(`[webhook/hyp] Failed one-time transaction ${tx.transactionId} for ${tx.email} - recorded only`);
    }
  }
}

export default router;
