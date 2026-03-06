import { eq } from 'drizzle-orm';
import { db } from './db';
import { donorMap } from '../db/schema';
import { createDonorItem, updateDonorItem } from './monday';
import type { NormalizedTransaction } from '../types';

function todayString(): string {
  return new Date().toISOString().split('T')[0]; // YYYY-MM-DD
}

export async function upsertDonor(tx: NormalizedTransaction): Promise<void> {
  const today = todayString();

  const [existing] = await db
    .select()
    .from(donorMap)
    .where(eq(donorMap.email, tx.email))
    .limit(1);

  if (!existing) {
    await createNewDonor(tx, today);
  } else {
    await updateExistingDonor(existing.id, Number(existing.mondayItemId), tx, today);
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
    status: 'active',
  });

  console.log(`[donor-service] Created new donor: ${tx.email} (Monday item ${mondayItemId})`);
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
