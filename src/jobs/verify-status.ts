/**
 * Status verification job.
 *
 * Logic (per PDF spec):
 *   For every donor whose first_donation day-of-month equals today's day,
 *   check whether last_donation_date was updated today.
 *   If not → mark as Pending in DB and Monday.
 *
 * Open rule: Pending → Inactive transition not yet defined.
 * TODO: Add Inactive logic once business rules are confirmed.
 */

import { sql, eq, and, ne } from 'drizzle-orm';
import { db } from '../lib/db';
import { donorMap, syncState } from '../db/schema';
import { updateDonorItem } from '../lib/monday';

export interface VerifyStatusResult {
  checked: number;
  markedPending: number;
  errors: number;
}

export async function runVerifyStatus(): Promise<VerifyStatusResult> {
  const today = new Date();
  const todayDay = today.getDate(); // 1–31
  const todayStr = today.toISOString().split('T')[0]; // YYYY-MM-DD

  console.log(`[verify-status] Running for day=${todayDay} (${todayStr})`);

  // Find active/pending donors whose cycle day matches today AND haven't donated today
  const donorsToCheck = await db
    .select()
    .from(donorMap)
    .where(
      and(
        sql`EXTRACT(DAY FROM ${donorMap.firstDonationDate}::date) = ${todayDay}`,
        ne(donorMap.lastDonationDate, todayStr),
        ne(donorMap.status, 'inactive'),
      ),
    );

  console.log(`[verify-status] Found ${donorsToCheck.length} donor(s) to check`);

  let markedPending = 0;
  let errors = 0;

  for (const donor of donorsToCheck) {
    try {
      await updateDonorItem(String(donor.mondayItemId), { status: 'Pending' });

      await db
        .update(donorMap)
        .set({ status: 'pending', updatedAt: new Date() })
        .where(eq(donorMap.id, donor.id));

      console.log(`[verify-status] Marked pending: ${donor.email}`);
      markedPending++;
    } catch (err) {
      console.error(`[verify-status] Failed to update donor ${donor.email}:`, err);
      errors++;
    }
  }

  // Persist last run state
  await db
    .insert(syncState)
    .values({
      operation: 'verify-status',
      lastRun: new Date(),
      status: errors === 0 ? 'ok' : 'partial',
      details: { checked: donorsToCheck.length, markedPending, errors },
    })
    .onConflictDoUpdate({
      target: syncState.operation,
      set: {
        lastRun: new Date(),
        status: errors === 0 ? 'ok' : 'partial',
        details: { checked: donorsToCheck.length, markedPending, errors },
      },
    });

  return { checked: donorsToCheck.length, markedPending, errors };
}

// Allow running directly: `npm run job:verify-status`
if (require.main === module) {
  import('dotenv/config').then(async () => {
    try {
      const result = await runVerifyStatus();
      console.log('[verify-status] Done:', result);
      process.exit(0);
    } catch (err) {
      console.error('[verify-status] Fatal error:', err);
      process.exit(1);
    }
  });
}
