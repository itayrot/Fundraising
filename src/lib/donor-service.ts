import { eq } from 'drizzle-orm';
import { db } from './db';
import { donorMap } from '../db/schema';
import { createDonorItem, createOneTimeDonationItem, updateDonorItem } from './monday';
import type { NormalizedTransaction } from '../types';

function dateString(d: Date): string {
  return d.toISOString().split('T')[0]; // YYYY-MM-DD
}

export async function upsertDonor(tx: NormalizedTransaction): Promise<void> {
  const txDate = dateString(tx.transactionDate);

  // One-time donations go to a separate board, no donor record tracking
  if (!tx.isRecurring) {
    await createOneTimeDonationItem({
      email: tx.email,
      name: tx.name,
      amount: tx.amount,
      currency: tx.currency,
      platform: tx.platform,
      firstDonationDate: txDate,
      lastDonationDate: txDate,
      isRecurring: false,
      agreementId: null,
    });
    console.log(`[donor-service] Created one-time donation for ${tx.email}`);
    return;
  }

  const [existing] = await db
    .select()
    .from(donorMap)
    .where(eq(donorMap.email, tx.email))
    .limit(1);

  if (!existing) {
    await createNewDonor(tx, txDate);
  } else {
    await updateExistingDonor(existing.id, Number(existing.mondayItemId), tx, txDate);
  }
}

async function createNewDonor(
  tx: NormalizedTransaction,
  today: string,
): Promise<void> {
  const mondayItemId = await createDonorItem({
    email: tx.email,
    name: tx.name,
    amount: tx.amount,
    currency: tx.currency,
    platform: tx.platform,
    firstDonationDate: today,
    lastDonationDate: today,
    isRecurring: tx.isRecurring,
    agreementId: tx.agreementId,
  });

  await db.insert(donorMap).values({
    email: tx.email,
    name: tx.name || null,
    mondayItemId: Number(mondayItemId),
    firstDonationDate: today,
    lastDonationDate: today,
    amount: tx.amount,
    currency: tx.currency,
    platform: tx.platform,
    isRecurring: tx.isRecurring,
    agreementId: tx.agreementId,
    status: 'active',
  });

  console.log(`[donor-service] Created new donor: ${tx.email} (Monday item ${mondayItemId}, recurring=${tx.isRecurring})`);
}

async function updateExistingDonor(
  donorId: number,
  mondayItemId: number,
  tx: NormalizedTransaction,
  today: string,
): Promise<void> {
  await updateDonorItem(String(mondayItemId), {
    lastDonationDate: today,
    amount: tx.amount,
    status: 'Active',
  });

  await db
    .update(donorMap)
    .set({
      lastDonationDate: today,
      amount: tx.amount,
      status: 'active',
      updatedAt: new Date(),
    })
    .where(eq(donorMap.id, donorId));

  console.log(`[donor-service] Updated existing donor: ${tx.email}`);
}

/**
 * Marks a recurring donor as Pending when their charge fails.
 * Called from webhook handler when CCode != 0 on a recurring transaction.
 */
export async function markDonorPendingByEmail(email: string): Promise<void> {
  const [donor] = await db
    .select()
    .from(donorMap)
    .where(eq(donorMap.email, email))
    .limit(1);

  if (!donor) {
    console.log(`[donor-service] markDonorPending: no donor found for ${email}`);
    return;
  }

  if (donor.status === 'pending') {
    console.log(`[donor-service] Donor ${email} already Pending`);
    return;
  }

  await updateDonorItem(String(donor.mondayItemId), { status: 'Pending' });

  await db
    .update(donorMap)
    .set({ status: 'pending', updatedAt: new Date() })
    .where(eq(donorMap.id, donor.id));

  console.log(`[donor-service] Marked donor Pending: ${email}`);
}
