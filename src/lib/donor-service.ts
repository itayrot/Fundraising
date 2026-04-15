import { eq, min, max, and, sum } from 'drizzle-orm';
import { db } from './db';
import { donorMap, transactions } from '../db/schema';
import {
  createDonorItem,
  updateDonorItem,
  updateOneTimeParentItem,
  createDonationSubitem,
  findOneTimeDonorByEmail,
  createOneTimeDonorParentItem,
} from './monday';
import type { NormalizedTransaction } from '../types';

function dateString(d: Date): string {
  // Use Israel timezone so dates match Hyp's local transaction date
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }); // YYYY-MM-DD
}

/** Get first/last succeeded dates and total donated amount for a donor from DB */
async function getDonorStats(email: string): Promise<{ first: string | null; last: string | null; totalDonated: number }> {
  const [result] = await db
    .select({
      first: min(transactions.transactionDate),
      last: max(transactions.transactionDate),
      total: sum(transactions.amount),
    })
    .from(transactions)
    .where(and(eq(transactions.email, email), eq(transactions.status, 'succeeded')));
  return {
    first: result?.first ? dateString(result.first) : null,
    last: result?.last ? dateString(result.last) : null,
    totalDonated: result?.total ? Number(result.total) : 0,
  };
}

export async function upsertDonor(tx: NormalizedTransaction): Promise<number> {
  const txDate = dateString(tx.transactionDate);

  // One-time donations: one parent item per donor, each donation is a subitem
  if (!tx.isRecurring) {
    let parentItemId = await findOneTimeDonorByEmail(tx.email);

    if (!parentItemId) {
      parentItemId = await createOneTimeDonorParentItem({
        email: tx.email,
        name: tx.name,
        date: txDate,
        amount: tx.amount,
        currency: tx.currency,
      });
      console.log(`[donor-service] Created one-time donor item for ${tx.email} (Monday item ${parentItemId})`);
    }

    await updateOneTimeParentItem(parentItemId, {
      date: txDate,
      amount: tx.amount,
      currency: tx.currency,
    });

    await createDonationSubitem(parentItemId, {
      date: txDate,
      amount: tx.amount,
      currency: tx.currency,
      status: tx.status === 'succeeded' ? 'Succeeded' : tx.status === 'failed' ? 'Failed' : 'Refunded',
    });

    console.log(`[donor-service] Added donation subitem for one-time donor ${tx.email}`);
    return Number(parentItemId);
  }

  const [existing] = await db
    .select()
    .from(donorMap)
    .where(eq(donorMap.email, tx.email))
    .limit(1);

  let mondayItemId: number;

  if (!existing) {
    mondayItemId = await createNewDonor(tx, txDate);
  } else {
    mondayItemId = Number(existing.mondayItemId);
    try {
      await updateExistingDonor(existing.id, mondayItemId, tx, txDate);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('inactive') || msg.includes('inactiveItems')) {
        console.log(
          `[donor-service] Monday item ${existing.mondayItemId} is deleted/archived, recreating for ${tx.email}`,
        );
        mondayItemId = await recreateDonor(existing.id, tx, txDate);
        await updateExistingDonor(existing.id, mondayItemId, tx, txDate);
      } else {
        throw err;
      }
    }
  }

  return mondayItemId;
}

async function createNewDonor(
  tx: NormalizedTransaction,
  today: string,
  mondayBoardStatus: 'Active' | 'Pending' = 'Active',
): Promise<number> {
  // Use the actual first/last donation dates and total from DB
  const stats = await getDonorStats(tx.email);
  const firstDate = stats.first ?? today;
  const lastDate = stats.last ?? today;

  const mondayItemId = await createDonorItem({
    email: tx.email,
    name: tx.name,
    amount: tx.amount,
    currency: tx.currency,
    platform: tx.platform,
    firstDonationDate: firstDate,
    lastDonationDate: lastDate,
    isRecurring: tx.isRecurring,
    agreementId: tx.agreementId,
    mondayBoardStatus,
    totalDonated: stats.totalDonated,
  });

  await db.insert(donorMap).values({
    email: tx.email,
    name: tx.name || null,
    mondayItemId: Number(mondayItemId),
    firstDonationDate: firstDate,
    lastDonationDate: lastDate,
    amount: tx.amount,
    currency: tx.currency,
    platform: tx.platform,
    isRecurring: tx.isRecurring,
    agreementId: tx.agreementId,
    status: mondayBoardStatus === 'Pending' ? 'pending' : 'active',
  });

  // Log first donation as a subitem in the donor's history
  await createDonationSubitem(mondayItemId, {
    date: today,
    amount: tx.amount,
    currency: tx.currency,
    status: mondayBoardStatus === 'Pending' ? 'Failed' : 'Succeeded',
  });

  console.log(`[donor-service] Created new donor: ${tx.email} (Monday item ${mondayItemId}, recurring=${tx.isRecurring})`);
  return Number(mondayItemId);
}

async function recreateDonor(existingDonorId: number, tx: NormalizedTransaction, today: string): Promise<number> {
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

  await db
    .update(donorMap)
    .set({
      mondayItemId: Number(mondayItemId),
      lastDonationDate: today,
      amount: tx.amount,
      status: 'active',
      updatedAt: new Date(),
    })
    .where(eq(donorMap.id, existingDonorId));

  console.log(`[donor-service] Recreated donor: ${tx.email} (new Monday item ${mondayItemId})`);
  return Number(mondayItemId);
}

async function updateExistingDonor(
  donorId: number,
  mondayItemId: number,
  tx: NormalizedTransaction,
  today: string,
): Promise<void> {
  const stats = await getDonorStats(tx.email);

  await updateDonorItem(String(mondayItemId), {
    lastDonationDate: today,
    amount: tx.amount,
    status: 'Active',
    totalDonated: stats.totalDonated,
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

  if (donor.status !== 'pending') {
    try {
      await updateDonorItem(String(donor.mondayItemId), { status: 'Pending' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('inactive') || msg.includes('inactiveItems')) {
        console.log(`[donor-service] Monday item ${donor.mondayItemId} deleted, skipping Pending update for ${email}`);
        return;
      }
      throw err;
    }

    await db
      .update(donorMap)
      .set({ status: 'pending', updatedAt: new Date() })
      .where(eq(donorMap.id, donor.id));

    console.log(`[donor-service] Marked donor Pending: ${email}`);
  } else {
    console.log(`[donor-service] Donor ${email} already Pending - logging failed charge only`);
  }

  // Always log the failed charge as a subitem
  if (failedDonation) {
    await createDonationSubitem(String(donor.mondayItemId), {
      date: failedDonation.date,
      amount: failedDonation.amount,
      currency: failedDonation.currency,
      status: 'Failed',
    });
  }
}

/**
 * Ensures a donor is marked Pending for a failed recurring charge.
 * If no donor row exists (e.g. email only resolved after system went live), creates a Pending donor in Monday.
 */
export async function ensureDonorPending(email: string, tx: NormalizedTransaction): Promise<void> {
  const [donor] = await db
    .select()
    .from(donorMap)
    .where(eq(donorMap.email, email))
    .limit(1);

  if (donor) {
    await markDonorPendingByEmail(email, {
      date: dateString(tx.transactionDate),
      amount: tx.amount,
      currency: tx.currency,
    });
    return;
  }

  const today = dateString(tx.transactionDate);
  await createNewDonor({ ...tx, email }, today, 'Pending');
  console.log(`[donor-service] Created new donor with Pending status: ${email}`);
}
