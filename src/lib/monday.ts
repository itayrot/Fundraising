import type { CreateDonorInput, UpdateDonorInput } from '../types';

const MONDAY_API_URL = 'https://api.monday.com/v2';

const cols = {
  email: () => process.env.MONDAY_COL_EMAIL!,           // text_mkza29j2
  firstDate: () => process.env.MONDAY_COL_FIRST_DATE!,  // date4
  lastDate: () => process.env.MONDAY_COL_LAST_DATE!,    // date_mm1afpjt
  amount: () => process.env.MONDAY_COL_AMOUNT!,         // numbers
  currency: () => process.env.MONDAY_COL_CURRENCY!,     // color_mkzak51x (status type)
  platform: () => process.env.MONDAY_COL_PLATFORM!,     // text_mkzacamp
  status: () => process.env.MONDAY_COL_STATUS!,         // status7
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function mondayRequest(query: string, variables?: Record<string, unknown>): Promise<unknown> {
  const MAX_RETRIES = 5;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(MONDAY_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: process.env.MONDAY_API_KEY!,
        'API-Version': '2024-01',
      },
      body: JSON.stringify({ query, variables }),
    });

    if (response.status === 429) {
      const waitSec = Math.min(5 * 2 ** attempt, 60);
      console.log(`[monday] Rate limited (429), waiting ${waitSec}s before retry ${attempt + 1}/${MAX_RETRIES}`);
      await sleep(waitSec * 1000);
      continue;
    }

    if (!response.ok) {
      throw new Error(`Monday API HTTP error: ${response.status}`);
    }

    const data = (await response.json()) as { data: unknown; errors?: unknown[]; error_code?: string };

    if (data.error_code === 'ComplexityException') {
      const waitSec = Math.min(10 * 2 ** attempt, 60);
      console.log(`[monday] Complexity limit, waiting ${waitSec}s before retry ${attempt + 1}/${MAX_RETRIES}`);
      await sleep(waitSec * 1000);
      continue;
    }

    if (data.errors && data.errors.length > 0) {
      throw new Error(`Monday API error: ${JSON.stringify(data.errors)}`);
    }

    return data.data;
  }

  throw new Error('Monday API: max retries exceeded due to rate limiting');
}

export async function findDonorByEmail(email: string): Promise<string | null> {
  // Search by the email text column (text_mkza29j2)
  const query = `
    query ($boardId: ID!, $email: String!) {
      items_page_by_column_values(
        limit: 1
        board_id: $boardId
        columns: [{ column_id: "${cols.email()}", column_values: [$email] }]
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

/** Monday date column format */
function dateColVal(dateStr: string): object {
  return { date: dateStr };
}

export async function createDonorItem(donor: CreateDonorInput): Promise<string> {
  const columnValues = JSON.stringify({
    // Email - plain text column
    [cols.email()]: donor.email,
    // Dates - both first and last (date4 = Date, date_mm1afpjt = Last Donation Date)
    [cols.firstDate()]: dateColVal(donor.firstDonationDate),
    [cols.lastDate()]: dateColVal(donor.lastDonationDate),
    // Amount
    [cols.amount()]: donor.amount,
    // Currency - status column (uses label)
    [cols.currency()]: { label: donor.currency },
    // Platform - plain text column
    [cols.platform()]: capitalise(donor.platform),
    // Status - status column (uses label)
    [cols.status()]: { label: donor.mondayBoardStatus ?? 'Active' },
  });

  const mutation = `
    mutation ($boardId: ID!, $groupId: String!, $name: String!, $columnValues: JSON!) {
      create_item(board_id: $boardId, group_id: $groupId, item_name: $name, column_values: $columnValues) {
        id
      }
    }
  `;

  const data = (await mondayRequest(mutation, {
    boardId: process.env.MONDAY_MASTER_BOARD_ID,
    groupId: process.env.MONDAY_GROUP_ACTIVE,
    name: donor.name || donor.email,
    columnValues,
  })) as { create_item: { id: string } };

  return data.create_item.id;
}

/** One-time Donations board: column "Donor's email" has type=email, id from API (often "email") */
const oneTimeCols = {
  email: () => process.env.MONDAY_ONE_TIME_COL_EMAIL || 'email',
  date: 'date4',
  amount: 'numbers',
  // Optional status column on the one-time board (status type)
  status: () => process.env.MONDAY_ONE_TIME_COL_STATUS || null,
};

export async function createOneTimeDonationItem(donor: CreateDonorInput): Promise<string> {
  // Monday email column requires { text, email } - both required per API docs
  const emailColId = oneTimeCols.email();
  const oneTimeStatusLabel = mapOneTimeStatusLabel(donor.status);
  const columnValuesObj: Record<string, unknown> = {
    [emailColId]: { text: donor.email, email: donor.email },
    [oneTimeCols.date]: dateColVal(donor.firstDonationDate),
    [oneTimeCols.amount]: donor.amount,
  };
  const oneTimeStatusColId = oneTimeCols.status();
  if (oneTimeStatusColId && oneTimeStatusLabel) {
    columnValuesObj[oneTimeStatusColId] = { label: oneTimeStatusLabel };
  }
  const columnValues = JSON.stringify(columnValuesObj);

  const mutation = `
    mutation ($boardId: ID!, $name: String!, $columnValues: JSON!) {
      create_item(board_id: $boardId, item_name: $name, column_values: $columnValues) {
        id
      }
    }
  `;

  const data = (await mondayRequest(mutation, {
    boardId: process.env.MONDAY_BOARD_ONE_TIME,
    name: donor.status === 'failed'
      ? `[FAILED] ${donor.name || donor.email}`
      : (donor.name || donor.email),
    columnValues,
  })) as { create_item: { id: string } };

  return data.create_item.id;
}

/**
 * Searches the One-Time board for an existing parent donor item by email.
 * Returns the item ID if found, null otherwise.
 */
export async function findOneTimeDonorByEmail(email: string): Promise<string | null> {
  const emailColId = oneTimeCols.email();
  const query = `
    query ($boardId: ID!, $email: String!) {
      items_page_by_column_values(
        limit: 1
        board_id: $boardId
        columns: [{ column_id: "${emailColId}", column_values: [$email] }]
      ) {
        items { id }
      }
    }
  `;

  const data = (await mondayRequest(query, {
    boardId: process.env.MONDAY_BOARD_ONE_TIME,
    email,
  })) as { items_page_by_column_values: { items: { id: string }[] } };

  const items = data.items_page_by_column_values?.items ?? [];
  return items.length > 0 ? items[0].id : null;
}

/**
 * Creates a parent donor item in the One-Time board.
 * The item represents the donor (not a single donation).
 * Actual donations are stored as subitems.
 * Also fills Date/Amount/Currency from the first donation for display.
 */
export async function createOneTimeDonorParentItem(donor: {
  email: string;
  name?: string | null;
  date?: string;
  amount?: string | number;
  currency?: string;
}): Promise<string> {
  const emailColId = oneTimeCols.email();
  const colVals: Record<string, unknown> = {
    [emailColId]: { text: donor.email, email: donor.email },
  };
  if (donor.date) colVals[oneTimeCols.date] = dateColVal(donor.date);
  if (donor.amount != null) colVals[oneTimeCols.amount] = Number(donor.amount);
  if (donor.currency) colVals['text_mm1tk2x8'] = donor.currency;
  const columnValues = JSON.stringify(colVals);

  const mutation = `
    mutation ($boardId: ID!, $name: String!, $columnValues: JSON!) {
      create_item(board_id: $boardId, item_name: $name, column_values: $columnValues) {
        id
      }
    }
  `;

  const data = (await mondayRequest(mutation, {
    boardId: process.env.MONDAY_BOARD_ONE_TIME,
    name: donor.name || donor.email,
    columnValues,
  })) as { create_item: { id: string } };

  return data.create_item.id;
}

const subitemCols = {
  monthly: { date: 'date0', amount: 'numeric_mm1r4h80', currency: 'text_mm1rvmyd', status: 'text_mm1rzyms' },
  oneTime: { date: 'date0', amount: 'numeric_mm1rzvm9', currency: 'text_mm1rvdwf', status: 'text_mm1r5s4v' },
};

/**
 * Creates a donation subitem under a parent donor item.
 * Detects the board type by checking the parent item's board.
 */
export async function createDonationSubitem(
  parentItemId: string,
  donation: { date: string; amount: string | number; currency: string; status: string },
): Promise<string> {
  const name = `${donation.date} | ${donation.amount} ${donation.currency} | ${donation.status}`;

  const boardType = await detectSubitemBoard(parentItemId);
  const sc = subitemCols[boardType];

  const columnValues = JSON.stringify({
    [sc.date]: { date: donation.date },
    [sc.amount]: Number(donation.amount),
    [sc.currency]: donation.currency,
    [sc.status]: donation.status,
  });

  const mutation = `
    mutation ($parentItemId: ID!, $name: String!, $columnValues: JSON!) {
      create_subitem(parent_item_id: $parentItemId, item_name: $name, column_values: $columnValues) {
        id
      }
    }
  `;

  const data = (await mondayRequest(mutation, {
    parentItemId,
    name,
    columnValues,
  })) as { create_subitem: { id: string } };

  return data.create_subitem.id;
}

async function detectSubitemBoard(parentItemId: string): Promise<'monthly' | 'oneTime'> {
  const query = `query { items(ids: [${parentItemId}]) { board { id } } }`;
  const data = (await mondayRequest(query)) as { items: { board: { id: string } }[] };
  const boardId = data.items?.[0]?.board?.id;
  return boardId === process.env.MONDAY_BOARD_ONE_TIME ? 'oneTime' : 'monthly';
}

export async function updateOneTimeParentItem(
  itemId: string,
  updates: { date?: string; amount?: string | number; currency?: string },
): Promise<void> {
  const columnValues: Record<string, unknown> = {};
  if (updates.date) columnValues[oneTimeCols.date] = dateColVal(updates.date);
  if (updates.amount != null) columnValues[oneTimeCols.amount] = Number(updates.amount);
  if (updates.currency) columnValues['text_mm1tk2x8'] = updates.currency;

  if (Object.keys(columnValues).length === 0) return;

  const mutation = `
    mutation ($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
      change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $columnValues) { id }
    }
  `;

  await mondayRequest(mutation, {
    boardId: process.env.MONDAY_BOARD_ONE_TIME,
    itemId,
    columnValues: JSON.stringify(columnValues),
  });
}

export async function updateDonorItem(itemId: string, updates: UpdateDonorInput): Promise<void> {
  const columnValues: Record<string, unknown> = {};

  if (updates.lastDonationDate) {
    columnValues[cols.lastDate()] = dateColVal(updates.lastDonationDate);
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

function mapOneTimeStatusLabel(status: CreateDonorInput['status']): string | null {
  if (!status) return null;
  switch (status) {
    case 'succeeded':
      return 'Succeeded';
    case 'failed':
      return 'Failed';
    case 'refunded':
      return 'Refunded';
    default:
      return null;
  }
}
