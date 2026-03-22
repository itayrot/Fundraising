/**
 * Tests createOneTimeDonationItem against Monday One-time Donations board.
 * Run: npx tsx scripts/test-one-time-monday.ts
 *
 * Uses test data - creates a single item. Delete manually from Monday if needed.
 */
import 'dotenv/config';
import { createOneTimeDonationItem } from '../src/lib/monday';

async function main() {
  if (!process.env.MONDAY_API_KEY || !process.env.MONDAY_BOARD_ONE_TIME) {
    console.error('Missing MONDAY_API_KEY or MONDAY_BOARD_ONE_TIME in .env');
    process.exit(1);
  }

  const testDonor = {
    email: 'test@example.com',
    name: 'Test Donor',
    amount: '1',
    currency: 'ILS' as const,
    platform: 'hyp' as const,
    firstDonationDate: new Date().toISOString().split('T')[0],
    lastDonationDate: new Date().toISOString().split('T')[0],
    isRecurring: false,
    agreementId: null,
  };

  console.log('Creating test one-time donation item...');
  try {
    const itemId = await createOneTimeDonationItem(testDonor);
    console.log('SUCCESS! Item created:', itemId);
    console.log('Check your Monday One-time Donations board - you can delete the test item.');
  } catch (err) {
    console.error('FAILED:', err);
    process.exit(1);
  }
}

main();
