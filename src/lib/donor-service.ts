import { eq } from 'drizzle-orm';
import { db } from './db';
import { donorMap } from '../db/schema';
import {
  createDonorItem,
  updateDonorItem,
  createDonationSubitem,
  findOneTimeDonorByEmail,
  createOneTimeDonorParentItem,
} from './monday';
import type { NormalizedTransaction } from '../types';

function dateString(d: Date): string {
  return d.toISOString().split('T')[0]; // YYYY-MM-DD
}

export async function upsertDonor(tx: NormalizedTransaction): Promise<void> {
  const txDate = dateString(tx.transactionDate);

  // One-time donations: one parent item per donor, each donation is a subitem
  if (!tx.isRecurring) {
    let parentItemId = await findOneTimeDonorByEmail(tx.email);

    if (!parentItemId) {
      parentItemId = await createOneTimeDonorParentItem({ email: tx.email, name: tx.name });
      console.log(`[donor-service] Created one-time donor item for ${tx.email} (Monday item ${parentItemId})`);
    }

    await createDonationSubitem(parentItemId, {
      date: txDate,
      amount: tx.amount,
      currency: tx.currency,
      status: tx.status === 'succeeded' ? 'Succeeded' : tx.status === 'failed' ? 'Failed' : 'Refunded',
    });

    console.log(`[donor-service] Added donation subitem for one-time donor ${tx.email}`);
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

  // Log first donation as a subitem in the donor's history
  await createDonationSubitem(mondayItemId, {
    date: today,
    amount: tx.amount,
    currency: tx.currency,
    status: 'Succeeded',
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

  // Log this donation as a new subitem in the donor's history
  await createDonationSubitem(String(mondayItemId), {
    date: today,
    amount: tx.amount,
    currency: tx.currency,
    status: 'Succeeded',
  });

  console.log(`[donor-service] Updated existing donor: ${tx.email}`);
}

/**
 * Marks a recurring donor as Pending when their charge fails.
 * Also logs the failed donation as a subitem in the donor's history.
 */
export async function markDonorPendingByEmail(
  email: string,
  failedDonation?: { date: string; amount: string | number; currency: string },
): Promise<void> {
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

  // Log the failed charge as a subitem in the donor's history
  if (failedDonation) {
    await createDonationSubitem(String(donor.mondayItemId), {
      date: failedDonation.date,
      amount: failedDonation.amount,
      currency: failedDonation.currency,
      status: 'Failed',
    });
  }

  console.log(`[donor-service] Marked donor Pending: ${email}`);
}
