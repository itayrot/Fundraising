/**
 * Imports a customer list CSV into the customer_registry table.
 *
 * Usage:
 *   npm run script:import-registry -- --file=customers.csv
 *
 * Expected CSV columns (order doesn't matter, detected by header name):
 *   - national_id / nationalId / id / ת.ז / ח.פ / tz / hp
 *   - email / מייל / mail
 *   - name / שם / fullName / full_name
 *
 * Any unrecognised column is ignored.
 * Rows with missing national_id or email are skipped.
 * Existing rows (same national_id) are updated in-place (upsert).
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { db } from '../src/lib/db';
import { customerRegistry } from '../src/db/schema';
import { eq } from 'drizzle-orm';

// ── Column name aliases ────────────────────────────────────────────────────

const ID_ALIASES    = ['national_id', 'nationalid', 'id', 'ת.ז', 'ח.פ', 'tz', 'hp', 'teudat_zehut', 'mispar_zehut'];
const EMAIL_ALIASES = ['email', 'מייל', 'mail', 'e-mail', 'email_address'];
const NAME_ALIASES  = ['name', 'שם', 'fullname', 'full_name', 'customer_name', 'שם_לקוח', 'שם לקוח'];

function normalise(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, '_');
}

function detectColumn(headers: string[], aliases: string[]): number {
  for (const alias of aliases) {
    const idx = headers.findIndex(h => normalise(h) === normalise(alias));
    if (idx !== -1) return idx;
  }
  return -1;
}

// ── CSV parser (handles quoted fields) ────────────────────────────────────

function parseLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if ((ch === ',' || ch === '\t') && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const fileArg = args.find(a => a.startsWith('--file='));

  if (!fileArg) {
    console.error('Usage: npm run script:import-registry -- --file=path/to/customers.csv');
    process.exit(1);
  }

  const filePath = path.resolve(fileArg.replace('--file=', ''));

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  console.log(`[import-registry] Reading ${filePath}`);

  const lines: string[] = [];
  const rl = readline.createInterface({ input: fs.createReadStream(filePath, 'utf8') });
  for await (const line of rl) {
    if (line.trim()) lines.push(line);
  }

  if (lines.length < 2) {
    console.error('[import-registry] File is empty or has no data rows');
    process.exit(1);
  }

  // Detect BOM
  const headerLine = lines[0].startsWith('\uFEFF') ? lines[0].slice(1) : lines[0];
  const headers = parseLine(headerLine);

  const idCol    = detectColumn(headers, ID_ALIASES);
  const emailCol = detectColumn(headers, EMAIL_ALIASES);
  const nameCol  = detectColumn(headers, NAME_ALIASES);

  console.log(`[import-registry] Detected columns → national_id: col ${idCol}, email: col ${emailCol}, name: col ${nameCol}`);

  if (idCol === -1 || emailCol === -1) {
    console.error('[import-registry] Could not detect required columns (national_id, email).');
    console.error('[import-registry] Found headers:', headers);
    process.exit(1);
  }

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const cols = parseLine(lines[i]);

    const nationalId = cols[idCol]?.trim().replace(/\s/g, '');
    const email      = cols[emailCol]?.trim().toLowerCase();
    const name       = nameCol !== -1 ? cols[nameCol]?.trim() || null : null;

    if (!nationalId || !email) {
      console.warn(`[import-registry] Row ${i + 1}: missing national_id or email — skipped`);
      skipped++;
      continue;
    }

    if (!email.includes('@')) {
      console.warn(`[import-registry] Row ${i + 1}: invalid email "${email}" — skipped`);
      skipped++;
      continue;
    }

    const [existing] = await db
      .select({ id: customerRegistry.id })
      .from(customerRegistry)
      .where(eq(customerRegistry.nationalId, nationalId))
      .limit(1);

    if (existing) {
      await db
        .update(customerRegistry)
        .set({ email, name, updatedAt: new Date() })
        .where(eq(customerRegistry.id, existing.id));
      updated++;
    } else {
      await db.insert(customerRegistry).values({ nationalId, email, name, source: 'import' });
      inserted++;
    }
  }

  console.log(`
[import-registry] Done.
  Inserted: ${inserted}
  Updated:  ${updated}
  Skipped:  ${skipped}
  Total rows processed: ${lines.length - 1}
  `);

  process.exit(0);
}

main().catch(err => {
  console.error('[import-registry] Fatal:', err);
  process.exit(1);
});
