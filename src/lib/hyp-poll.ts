import type { NormalizedTransaction, Currency } from '../types';

/**
 * Hyp exportXLS CSV column mapping (Hebrew headers):
 * 0  - מספר עסקה       → transaction ID
 * 1  - תשובת חברת אשראי → approval response ("אושרה" = success)
 * 2  - תאריך            → date (YYYY-MM-DD)
 * 3  - שעה              → time (HH:MM:SS)
 * 4  - שם פרטי          → first name
 * 5  - שם משפחה         → last name
 * 6  - תיאור עסקה       → Info / description ("הוראת קבע - 513093" or other)
 * 7  - סוג              → type
 * 8  - 4 ספרות אחרונות  → last 4 digits
 * 9  - סכום             → amount
 * 13 - ת.ז              → national ID (UserId)
 * 14 - מספר אישור       → approval code
 * 22 - מטבע             → currency: 1=ILS, 2=USD, 3=EUR, 4=GBP
 * 25 - UID              → unique transaction UID
 */

export interface HypCsvRow {
  transactionId: string;
  approved: boolean;
  date: string;
  time: string;
  firstName: string;
  lastName: string;
  info: string;
  amount: string;
  nationalId: string;
  currency: string;
  uid: string;
}

function coinToCurrency(coin: string): Currency {
  const map: Record<string, Currency> = {
    '1': 'ILS',
    '2': 'USD',
    '3': 'EUR',
    '4': 'GBP',
  };
  return map[coin.trim()] ?? 'ILS';
}

function isRecurring(info: string): boolean {
  return info.trim().startsWith('הוראת קבע');
}

function extractAgreementId(info: string): string | null {
  const match = info.match(/הוראת קבע\s*-\s*(\d+)/);
  return match ? match[1] : null;
}

/**
 * Parses the CSV text returned by Hyp exportXLS API.
 * Skips the header row and empty lines.
 */
export function parseHypCsv(csvText: string): HypCsvRow[] {
  const lines = csvText.split('\n').filter(l => l.trim());
  // Skip header row
  const dataLines = lines.slice(1);

  return dataLines.map(line => {
    // Handle quoted fields (e.g. "האם כרטיס חו""ל")
    const cols = parseCSVLine(line);

    return {
      transactionId: cols[0]?.trim() ?? '',
      approved: cols[1]?.trim() === 'אושרה',
      date: cols[2]?.trim() ?? '',
      time: cols[3]?.trim() ?? '',
      firstName: cols[4]?.trim() ?? '',
      lastName: cols[5]?.trim() ?? '',
      info: cols[6]?.trim() ?? '',
      amount: cols[9]?.trim() ?? '0',
      nationalId: cols[13]?.trim() ?? '',
      currency: cols[22]?.trim() ?? '1',
      uid: cols[25]?.trim() ?? '',
    };
  }).filter(row => row.transactionId !== '');
}

/**
 * Converts a parsed CSV row to our NormalizedTransaction format.
 * Note: Hyp CSV does not include email - email lookup must be done separately
 * using the donor's national ID or name against the existing donor_map.
 */
export function csvRowToTransaction(row: HypCsvRow): Omit<NormalizedTransaction, 'email'> & { email: string } {
  const fullName = `${row.firstName} ${row.lastName}`.trim();
  const transactionDate = new Date(`${row.date}T${row.time}`);

  return {
    transactionId: row.transactionId,
    email: '', // will be filled by poll job from donor_map lookup
    name: fullName,
    amount: row.amount,
    currency: coinToCurrency(row.currency),
    platform: 'hyp',
    status: row.approved ? 'succeeded' : 'failed',
    isRecurring: isRecurring(row.info),
    agreementId: extractAgreementId(row.info),
    transactionDate,
    rawPayload: row,
  };
}

/**
 * Fetches transactions from Hyp API for a given date range.
 * dateFrom / dateTo format: YYYYMMDD
 */
export async function fetchHypTransactions(dateFrom: string, dateTo: string): Promise<HypCsvRow[]> {
  const params = new URLSearchParams({
    action: 'exportXLS',
    from: 'UserPage',
    dateF: dateFrom,
    dateT: dateTo,
    Masof: process.env.HYP_MASOF!,
    User: process.env.HYP_USER!,
    Pass: process.env.HYP_PASS!,
  });

  const response = await fetch(process.env.HYP_API_URL!, {
    method: 'POST',
    body: params,
  });

  if (!response.ok) {
    throw new Error(`Hyp API HTTP error: ${response.status}`);
  }

  const text = await response.text();

  // HTML response means no transactions for the date range (HYP returns a page instead of empty CSV)
  if (text.trimStart().startsWith('<!DOCTYPE') || text.trimStart().startsWith('<html')) {
    return [];
  }

  // Any other non-CSV response is an unexpected error
  if (!text.includes('מספר עסקה')) {
    throw new Error(`Hyp API unexpected response: ${text.slice(0, 200)}`);
  }

  return parseHypCsv(text);
}

/**
 * Simple CSV line parser that handles quoted fields.
 */
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      // Handle escaped quotes ("")
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}
