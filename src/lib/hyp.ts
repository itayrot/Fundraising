import type { NormalizedTransaction, TransactionStatus, Currency } from '../types';

/**
 * Hyp sends webhooks as HTTP GET requests with all data as query parameters.
 *
 * Field mapping (confirmed):
 *   Fild1 = full name of the donor
 *   Fild2 = email of the donor
 *   UserId = national ID (teudat zehut)
 *   Id = transaction ID (unique per charge)
 *   CCode = 0 means success, anything else is failure
 *   Amount = amount charged
 *   Coin = currency: 1=ILS, 2=USD, 3=EUR, 4=GBP
 *   Info = "הוראת קבע - 513093" for recurring, other text for one-time
 *
 * Note: Info field sometimes arrives as ISO-8859-8 encoded (mojibake).
 * We detect recurring both by Hebrew text and by the pattern "??? ??? - NNNNNN".
 */

export interface HypRawParams {
  Id?: string;
  CCode?: string;
  Amount?: string;
  ACode?: string;
  Order?: string;
  Fild1?: string;
  Fild2?: string;
  Fild3?: string;
  Sign?: string;
  Bank?: string;
  Payments?: string;
  UserId?: string;
  Brand?: string;
  Issuer?: string;
  L4digit?: string;
  Coin?: string;
  Tmonth?: string;
  Tyear?: string;
  Info?: string;
  errMsg?: string;
  Hesh?: string;
  TransType?: string;
  UID?: string;
  SpType?: string;
  BinCard?: string;
  [key: string]: string | undefined;
}

/**
 * Detects whether this is a recurring (standing order / הוראת קבע) payment.
 * Handles both proper UTF-8 and ISO-8859-8 encoded (mojibake) strings.
 * The agreement ID pattern "- NNNNNN" is encoding-independent.
 */
export function isRecurringDonation(info: string | undefined): boolean {
  if (!info) return false;
  const trimmed = info.trim();
  // Proper UTF-8
  if (trimmed.startsWith('הוראת קבע')) return true;
  // ISO-8859-8 mojibake: "äåøàú ÷áò" or similar - detect by trailing "- digits" pattern
  // which is always ASCII and encoding-independent
  if (/^.{5,20}\s*-\s*\d{4,8}$/.test(trimmed) && !trimmed.includes(' ')) return false;
  if (/^[^\x00-\x7F]{4,}\s*-\s*\d{4,8}$/.test(trimmed)) return true;
  return false;
}

/**
 * Extracts the agreement ID from the Info field.
 * Works for both UTF-8 and encoded strings since the ID is always digits.
 * "הוראת קבע - 513093" → "513093"
 */
export function extractAgreementId(info: string | undefined): string | null {
  if (!info) return null;
  // Match "- NNNNNN" anywhere in the string (encoding-independent)
  const match = info.match(/-\s*(\d{4,8})\s*$/);
  return match ? match[1] : null;
}

/**
 * Coin field → Currency type.
 * 1=ILS, 2=USD, 3=EUR, 4=GBP
 */
function coinToCurrency(coin: string | undefined): Currency {
  const map: Record<string, Currency> = {
    '1': 'ILS',
    '2': 'USD',
    '3': 'EUR',
    '4': 'GBP',
  };
  return map[coin ?? '1'] ?? 'ILS';
}

/**
 * CCode=0 → success, anything else → failed
 */
function mapCCode(ccode: string | undefined): TransactionStatus {
  return ccode === '0' ? 'succeeded' : 'failed';
}

/**
 * Parses Hyp GET query parameters into a normalized transaction object.
 * If email (Fild2) is missing, uses a synthetic email from UserId
 * so the transaction is still recorded.
 */
export function parseHypWebhook(params: HypRawParams): NormalizedTransaction {
  const transactionId = params.Id;
  if (!transactionId) {
    throw new Error('Missing Id in Hyp payload');
  }

  // Use email if present, otherwise fall back to synthetic from UserId
  let email = params.Fild2?.trim().toLowerCase();
  if (!email) {
    const fallbackId = params.UserId ?? params.UID ?? transactionId;
    console.warn(`[hyp] No email (Fild2) for transaction ${transactionId} - using synthetic: ${fallbackId}@noemail.hyp`);
    email = `${fallbackId}@noemail.hyp`;
  }

  return {
    transactionId,
    email,
    name: params.Fild1?.trim() ?? '',
    amount: params.Amount ?? '0',
    currency: coinToCurrency(params.Coin),
    platform: 'hyp',
    status: mapCCode(params.CCode),
    isRecurring: isRecurringDonation(params.Info),
    agreementId: extractAgreementId(params.Info),
    transactionDate: new Date(),
    rawPayload: params,
  };
}
