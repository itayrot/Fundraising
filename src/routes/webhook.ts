import { Router, Request, Response } from 'express';
import { db } from '../lib/db';
import { webhookLog } from '../db/schema';
import { extractAgreementId, type HypRawParams } from '../lib/hyp';

const router = Router();

/**
 * Hyp sends webhooks as HTTP GET requests with all data as query parameters.
 * URL to register with Hyp: https://<domain>/api/webhook/hyp
 *
 * This handler only logs the raw request to webhook_log.
 * Transactions are saved by the poll-hyp CRON job.
 * Donor updates (donor_map + Monday) are handled by the reconcile-donors CRON job.
 */
router.get('/hyp', async (req: Request, res: Response) => {
  // Hyp requires a 200 response immediately
  res.status(200).send('OK');

  logHypWebhook(req.query as HypRawParams).catch((err) => {
    console.error('[webhook/hyp] Log error:', err);
  });
});

async function logHypWebhook(params: HypRawParams): Promise<void> {
  const transactionId = params.Id || params.id || null;
  // Fild2 = donor email. Check both casings (Hyp/HTTP may send fild2 or Fild2)
  const email = (params.Fild2 || params.fild2 || '')?.trim().toLowerCase() || null;
  // HKId = standing order ID on first recurring payment (most reliable)
  const agreementId = (params.HKId || params.hkId || '')?.trim() || extractAgreementId(params.Info) || null;
  // UserId = nationalId (teudat zehut), used to match CSV charges to donor
  const userId = (params.UserId || params.userId || '')?.trim() || null;

  if (!transactionId) {
    console.warn('[webhook/hyp] Received request without Id');
    await db.insert(webhookLog).values({
      rawQuery: params,
      status: 'error',
      errorMessage: 'Missing Id in payload',
    });
    return;
  }

  await db.insert(webhookLog).values({
    rawQuery: params,
    status: 'logged',
    transactionId,
    email,
    agreementId,
    userId,
  });

  console.log(`[webhook/hyp] Logged txId=${transactionId} email=${email ?? 'none'} userId=${userId ?? 'none'}`);
}

export default router;
