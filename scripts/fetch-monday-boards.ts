/**
 * Fetches board structure from Monday.com API.
 * Run: npx tsx scripts/fetch-monday-boards.ts
 */
import 'dotenv/config';

const MONDAY_API_URL = 'https://api.monday.com/v2';

async function mondayRequest(query: string, variables?: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: process.env.MONDAY_API_KEY!,
      'API-Version': '2024-01',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`Monday API HTTP error: ${response.status}`);
  }

  const data = (await response.json()) as { data: unknown; errors?: { message: string }[] };

  if (data.errors?.length) {
    throw new Error(`Monday API: ${data.errors.map((e) => e.message).join(', ')}`);
  }

  return data.data;
}

async function main() {
  const boardIds = [
    process.env.MONDAY_MASTER_BOARD_ID,
    process.env.MONDAY_BOARD_ONE_TIME,
  ].filter(Boolean) as string[];

  if (!process.env.MONDAY_API_KEY) {
    console.error('Missing MONDAY_API_KEY in .env');
    process.exit(1);
  }

  const query = `
    query ($ids: [ID!]!) {
      boards(ids: $ids) {
        id
        name
        columns {
          id
          title
          type
        }
        groups {
          id
          title
        }
      }
    }
  `;

  const data = (await mondayRequest(query, { ids: boardIds })) as {
    boards: Array<{
      id: string;
      name: string;
      columns: Array< { id: string; title: string; type: string }>;
      groups: Array<{ id: string; title: string }>;
    }>;
  };

  for (const board of data.boards || []) {
    console.log('\n' + '='.repeat(60));
    console.log(`Board: ${board.name}`);
    console.log(`ID: ${board.id}`);
    console.log('='.repeat(60));
    console.log('\nColumns:');
    for (const col of board.columns || []) {
      console.log(`  ${col.id.padEnd(20)} | ${col.type.padEnd(12)} | ${col.title}`);
    }
    console.log('\nGroups:');
    for (const grp of board.groups || []) {
      console.log(`  ${grp.id.padEnd(25)} | ${grp.title}`);
    }
    console.log('');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
