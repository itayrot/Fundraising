export type TransactionStatus = 'succeeded' | 'failed' | 'refunded';
export type DonorStatus = 'active' | 'pending' | 'inactive';
export type Currency = 'ILS' | 'USD' | 'EUR' | 'GBP';
export type Platform = 'hyp' | 'paypal' | 'cardcom';

export interface NormalizedTransaction {
  transactionId: string;
  email: string;
  name: string;
  amount: string;
  currency: Currency;
  platform: Platform;
  status: TransactionStatus;
  isRecurring: boolean;
  agreementId: string | null;
  transactionDate: Date;
  rawPayload: unknown;
}

export interface CreateDonorInput {
  email: string;
  name: string;
  amount: string;
  currency: Currency;
  platform: Platform;
  /** Payment outcome (used for one-time board labels, item names, etc.) */
  status?: TransactionStatus;
  firstDonationDate: string;
  lastDonationDate: string;
  isRecurring: boolean;
  agreementId: string | null;
  /** Master recurring board status column */
  mondayBoardStatus?: 'Active' | 'Pending';
}

export interface UpdateDonorInput {
  lastDonationDate?: string;
  amount?: string;
  status?: 'Active' | 'Pending' | 'Inactive';
}
