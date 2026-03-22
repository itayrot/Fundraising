/**
 * One-time cleanup script: resolves @noemail.hyp emails in the transactions
 * and donor_map tables by looking up real emails from webhook_log.
 *
 * Run with: npx ts-node scripts/fix-noemail-transactions.ts
 */

import 'dotenv/config';
import { eq, and, isNotNull, like } from 'drizzle-orm';
import { db } from '../src/lib/db';
import { transactions, webhookLog, donorMap } from '../src/db/schema';

async function resolveEmail(
  transactionId: string,
  agreementId: string | null,
  nationalId: string | null,
): Promise<string | null> {
  const [byTxId] = await db
    .select({ email: webhookLog.email })
    .from(webhookLog)
    .where(and(eq(webhookLog.transactionId, transactionId), isNotNull(webhookLog.email)))
    .limit(1);
  if (byTxId?.email) return byTxId.email;

  if (agreementId) {
    const [byAgreement] = await db
      .select({ email: webhookLog.email })
      .from(webhookLog)
      .where(and(eq(webhookLog.agreementId, agreementId), isNotNull(webhookLog.email)))
      .orderBy(webhookLog.receivedAt)
      .limit(1);
    if (byAgreement?.email) return byAgreement.email;
  }

  if (nationalId) {
    const [byUserId] = await db
      .select({ email: webhookLog.email })
      .from(webhookLog)
      .where(and(eq(webhookLog.userId, nationalId), isNotNull(webhookLog.email)))
      .orderBy(webhookLog.receivedAt)
      .limit(1);
    if (byUserId?.email) return byUserId.email;
  }

  return null;
}

async function main() {
  console.log('[fix-noemail] Starting cleanup...');

  // ── Fix transactions table ────────────────────────────────────────────────

  const badTransactions = await db
    .select()
    .from(transactions)
    .where(like(transactions.email, '%@noemail.hyp'));

  console.log(`[fix-noemail] Found ${badTransactions.length} transaction(s) with @noemail.hyp email`);

  let txFixed = 0;
  let txUnresolved = 0;

  for (const tx of badTransactions) {
    const nationalId = tx.email.endsWith('@noemail.hyp')
      ? tx.email.replace('@noemail.hyp', '')
      : null;

    const realEmail = await resolveEmail(tx.transactionId, tx.agreementId ?? null, nationalId);

    if (realEmail) {
      await db
        .update(transactions)
        .set({ email: realEmail })
        .where(eq(transactions.id, tx.id));
      console.log(`[fix-noemail] tx ${tx.transactionId}: ${tx.email} → ${realEmail}`);
      txFixed++;
    } else {
      console.log(`[fix-noemail] tx ${tx.transactionId}: could not resolve (${tx.email})`);
      txUnresolved++;
    }
  }

  // ── Fix donor_map table ───────────────────────────────────────────────────

  const badDonors = await db
    .select()
    .from(donorMap)
    .where(like(donorMap.email, '%@noemail.hyp'));

  console.log(`[fix-noemail] Found ${badDonors.length} donor_map row(s) with @noemail.hyp email`);

  let donorFixed = 0;
  let donorUnresolved = 0;

  for (const donor of badDonors) {
    const nationalId = donor.email.endsWith('@noemail.hyp')
      ? donor.email.replace('@noemail.hyp', '')
      : null;

    const realEmail = await resolveEmail('', donor.agreementId ?? null, nationalId);

    if (realEmail) {
      await db
        .update(donorMap)
        .set({ email: realEmail, updatedAt: new Date() })
        .where(eq(donorMap.id, donor.id));
      console.log(`[fix-noemail] donor ${donor.id}: ${donor.email} → ${realEmail}`);
      donorFixed++;
    } else {
      console.log(`[fix-noemail] donor ${donor.id}: could not resolve (${donor.email})`);
      donorUnresolved++;
    }
  }

  console.log(`
[fix-noemail] Done.
  Transactions: ${txFixed} fixed, ${txUnresolved} unresolved
  Donors:       ${donorFixed} fixed, ${donorUnresolved} unresolved
  `);

  process.exit(0);
}

main().catch(err => {
  console.error('[fix-noemail] Fatal:', err);
  process.exit(1);
});
