import type { CreateDonorInput, UpdateDonorInput } from '../types';

const MONDAY_API_URL = 'https://api.monday.com/v2';

// Column IDs are set via env vars — fill them in after creating the Monday board.
// To find a column ID: right-click any column header in Monday → "Column Settings" → the ID is shown.
const cols = {
  email: () => process.env.MONDAY_COL_EMAIL!,
  firstDate: () => process.env.MONDAY_COL_FIRST_DATE!,
  lastDate: () => process.env.MONDAY_COL_LAST_DATE!,
  amount: () => process.env.MONDAY_COL_AMOUNT!,
  currency: () => process.env.MONDAY_COL_CURRENCY!,
  platform: () => process.env.MONDAY_COL_PLATFORM!,
  status: () => process.env.MONDAY_COL_STATUS!,
};

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

  const data = (await response.json()) as { data: unknown; errors?: unknown[] };

  if (data.errors && data.errors.length > 0) {
    throw new Error(`Monday API error: ${JSON.stringify(data.errors)}`);
  }

  return data.data;
}

export async function findDonorByEmail(email: string): Promise<string | null> {
  const query = `
    query ($boardId: ID!, $email: String!) {
      items_page_by_column_values(
        limit: 1
        board_id: $boardId
        columns: [{ column_id: "email", column_values: [$email] }]
      ) {
        items { id }
      }
    }
  `;

  const data = (await mondayRequest(query, {
    boardId: process.env.MONDAY_MASTER_BOARD_ID,
    email,
  })) as { items_page_by_column_values: { items: { id: string }[] } };

  const items = data.items_page_by_column_values?.items ?? [];
  return items.length > 0 ? items[0].id : null;
}

export async function createDonorItem(donor: CreateDonorInput): Promise<string> {
  const columnValues = JSON.stringify({
    [cols.email()]: { email: donor.email, text: donor.email },
    [cols.firstDate()]: { date: donor.firstDonationDate },
    [cols.lastDate()]: { date: donor.lastDonationDate },
    [cols.amount()]: donor.amount,
    [cols.currency()]: { label: donor.currency },
    [cols.platform()]: { label: capitalise(donor.platform) },
    [cols.status()]: { label: 'Active' },
  });

  const mutation = `
    mutation ($boardId: ID!, $name: String!, $columnValues: JSON!) {
      create_item(board_id: $boardId, item_name: $name, column_values: $columnValues) {
        id
      }
    }
  `;

  const data = (await mondayRequest(mutation, {
    boardId: process.env.MONDAY_MASTER_BOARD_ID,
    name: donor.name || donor.email,
    columnValues,
  })) as { create_item: { id: string } };

  return data.create_item.id;
}

export async function updateDonorItem(itemId: string, updates: UpdateDonorInput): Promise<void> {
  const columnValues: Record<string, unknown> = {};

  if (updates.lastDonationDate) {
    columnValues[cols.lastDate()] = { date: updates.lastDonationDate };
  }
  if (updates.status) {
    columnValues[cols.status()] = { label: updates.status };
  }
  if (updates.amount) {
    columnValues[cols.amount()] = updates.amount;
  }

  if (Object.keys(columnValues).length === 0) return;

  const mutation = `
    mutation ($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
      change_multiple_column_values(
        board_id: $boardId
        item_id: $itemId
        column_values: $columnValues
      ) {
        id
      }
    }
  `;

  await mondayRequest(mutation, {
    boardId: process.env.MONDAY_MASTER_BOARD_ID,
    itemId,
    columnValues: JSON.stringify(columnValues),
  });
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
