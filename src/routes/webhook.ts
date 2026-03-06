import { Router, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../lib/db';
import { transactions } from '../db/schema';
import { validateHypSignature, parseHypWebhook } from '../lib/hyp';
import { upsertDonor } from '../lib/donor-service';

const router = Router();

router.post('/hyp', async (req: Request, res: Response) => {
  const rawBody = req.body as Buffer;

  // 1. Validate Hyp signature
  if (!validateHypSignature(rawBody, req.headers as Record<string, string | undefined>)) {
    console.warn('[webhook/hyp] Invalid signature — request rejected');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody.toString('utf-8')) as Record<string, unknown>;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  try {
    // 2. Parse & normalise payload
    const tx = parseHypWebhook(payload);

    // 3. Idempotency check — silently succeed if already processed
    const [existing] = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.transactionId, tx.transactionId))
      .limit(1);

    if (existing) {
      console.log(`[webhook/hyp] Duplicate transaction ${tx.transactionId} — skipping`);
      return res.status(200).json({ status: 'duplicate' });
    }

    // 4. Persist transaction
    await db.insert(transactions).values({
      transactionId: tx.transactionId,
      email: tx.email,
      name: tx.name || null,
      amount: tx.amount,
      currency: tx.currency,
      platform: tx.platform,
      status: tx.status,
      transactionDate: tx.transactionDate,
      rawPayload: tx.rawPayload,
    });

    // 5. Upsert donor in DB + Monday (only for successful charges)
    if (tx.status === 'succeeded') {
      await upsertDonor(tx);
    } else {
      console.log(`[webhook/hyp] Transaction ${tx.transactionId} status=${tx.status} — donor not updated`);
    }

    return res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('[webhook/hyp] Unhandled error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
