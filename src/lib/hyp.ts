import crypto from 'crypto';
import type { NormalizedTransaction, TransactionStatus, Currency } from '../types';

// TODO: Confirm the exact signature header name with Hyp documentation
const HYP_SIGNATURE_HEADER = 'x-hyp-signature';

/**
 * Validates the HMAC-SHA256 signature sent by Hyp on each webhook request.
 * The raw request body (Buffer) must be used — parsed JSON won't match.
 *
 * TODO: Confirm with Hyp:
 *   1. Exact header name
 *   2. Signature format (hex? base64? prefixed with "sha256="?)
 */
export function validateHypSignature(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean {
  const secret = process.env.HYP_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error('HYP_WEBHOOK_SECRET is not configured');
  }

  const receivedSig = headers[HYP_SIGNATURE_HEADER] as string | undefined;
  if (!receivedSig) return false;

  // Strip optional "sha256=" prefix (common pattern)
  const cleanSig = receivedSig.replace(/^sha256=/, '');

  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(cleanSig, 'hex'),
      Buffer.from(expectedSig, 'hex'),
    );
  } catch {
    return false;
  }
}

/**
 * Parses the raw Hyp webhook payload into a normalized transaction object.
 *
 * TODO: Update field mappings once the actual Hyp payload structure is confirmed.
 * The fields below are reasonable assumptions for Israeli payment providers.
 */
export function parseHypWebhook(payload: Record<string, unknown>): NormalizedTransaction {
  const transactionId = payload['transaction_id'] as string | undefined;
  if (!transactionId) {
    throw new Error('Missing transaction_id in Hyp payload');
  }

  const email = payload['email'] as string | undefined;
  if (!email) {
    throw new Error('Missing email in Hyp payload');
  }

  return {
    transactionId,
    email: email.toLowerCase().trim(),
    name: (payload['name'] as string | undefined) ?? '',
    amount: String(payload['amount'] ?? '0'),
    currency: normaliseCurrency(payload['currency'] as string | undefined),
    platform: 'hyp',
    status: mapHypStatus(payload['status'] as string | undefined),
    transactionDate: payload['created_at']
      ? new Date(payload['created_at'] as string)
      : new Date(),
    rawPayload: payload,
  };
}

function normaliseCurrency(raw: string | undefined): Currency {
  const upper = (raw ?? 'ILS').toUpperCase();
  const valid: Currency[] = ['ILS', 'USD', 'EUR', 'GBP'];
  return valid.includes(upper as Currency) ? (upper as Currency) : 'ILS';
}

/**
 * Maps Hyp-specific status strings to our internal TransactionStatus.
 * TODO: Confirm exact status values from Hyp documentation.
 */
function mapHypStatus(raw: string | undefined): TransactionStatus {
  const map: Record<string, TransactionStatus> = {
    success: 'succeeded',
    approved: 'succeeded',
    completed: 'succeeded',
    failed: 'failed',
    declined: 'failed',
    error: 'failed',
    refund: 'refunded',
    refunded: 'refunded',
    chargeback: 'refunded',
  };
  return map[(raw ?? '').toLowerCase()] ?? 'succeeded';
}
