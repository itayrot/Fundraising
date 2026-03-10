import { Router, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../lib/db';
import { transactions } from '../db/schema';
import { parseHypWebhook, type HypRawParams } from '../lib/hyp';
import { upsertDonor } from '../lib/donor-service';

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

  let tx;
  try {
    tx = parseHypWebhook(params);
  } catch (err) {
    console.error('[webhook/hyp] Failed to parse payload:', err);
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
    return;
  }

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

  // Only update donor for successful charges
  if (tx.status === 'succeeded') {
    await upsertDonor(tx);
  } else {
    console.log(`[webhook/hyp] Transaction ${tx.transactionId} failed (CCode != 0) - donor not updated`);
  }

  console.log(`[webhook/hyp] Processed ${tx.transactionId} for ${tx.email} (${tx.isRecurring ? 'recurring' : 'one-time'})`);
}

export default router;
