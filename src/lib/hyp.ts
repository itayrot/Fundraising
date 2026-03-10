import type { NormalizedTransaction, TransactionStatus, Currency } from '../types';

/**
 * Hyp sends webhooks as HTTP GET requests with all data as query parameters.
 *
 * Field mapping (confirmed):
 *   Fild1 = full name of the donor
 *   Fild2 = email of the donor
 *   UserId = national ID (teudat zehut) - not used as identifier
 *   Id = transaction ID (unique per charge)
 *   CCode = 0 means success, anything else is failure
 *   Amount = amount charged
 *   Coin = currency: 1=ILS, 2=USD, 3=EUR, 4=GBP
 *   Info = "הוראת קבע - 513093" for recurring, other text for one-time
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
 * Info field example: "הוראת קבע - 513093"
 */
export function isRecurringDonation(info: string | undefined): boolean {
  if (!info) return false;
  return info.trim().startsWith('הוראת קבע');
}

/**
 * Extracts the agreement ID from the Info field.
 * "הוראת קבע - 513093" → "513093"
 */
export function extractAgreementId(info: string | undefined): string | null {
  if (!info) return null;
  const match = info.match(/הוראת קבע\s*-\s*(\d+)/);
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
 */
export function parseHypWebhook(params: HypRawParams): NormalizedTransaction {
  const transactionId = params.Id;
  if (!transactionId) {
    throw new Error('Missing Id in Hyp payload');
  }

  const email = params.Fild2?.trim().toLowerCase();
  if (!email) {
    throw new Error(`Missing email (Fild2) in Hyp payload for transaction ${transactionId}`);
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
