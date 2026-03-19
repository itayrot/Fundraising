import nodemailer from 'nodemailer';
import { eq, gte } from 'drizzle-orm';
import { db } from './db';
import { syncState, webhookLog } from '../db/schema';

const ALERT_THROTTLE_HOURS = 6;
const ALERT_OPERATION = 'webhook-health-alert';

/**
 * Checks whether the webhook is healthy by looking for any entries
 * in webhook_log within the last 24 hours.
 *
 * If none found AND we haven't sent an alert in the last 6 hours,
 * sends an email alert and records the time in sync_state.
 */
export async function checkWebhookHealth(): Promise<void> {
  const to = process.env.ALERT_DEV_EMAIL_TO;
  if (!to) {
    console.warn('[alert] ALERT_DEV_EMAIL_TO not set — skipping webhook health check');
    return;
  }

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [recent] = await db
    .select({ id: webhookLog.id })
    .from(webhookLog)
    .where(gte(webhookLog.receivedAt, since24h))
    .limit(1);

  if (recent) {
    // Webhook is active — clear any existing alert state
    await db
      .insert(syncState)
      .values({ operation: ALERT_OPERATION, lastRun: new Date(), status: 'ok', details: {} })
      .onConflictDoUpdate({
        target: syncState.operation,
        set: { lastRun: new Date(), status: 'ok', details: {} },
      });
    return;
  }

  // No webhook entries in the last 24h — check throttle before alerting
  const [alertRow] = await db
    .select({ lastRun: syncState.lastRun, status: syncState.status })
    .from(syncState)
    .where(eq(syncState.operation, ALERT_OPERATION))
    .limit(1);

  if (alertRow?.status === 'alert-sent' && alertRow.lastRun) {
    const hoursSinceLast =
      (Date.now() - new Date(alertRow.lastRun).getTime()) / (1000 * 60 * 60);
    if (hoursSinceLast < ALERT_THROTTLE_HOURS) {
      console.log(
        `[alert] Webhook unhealthy but alert already sent ${hoursSinceLast.toFixed(1)}h ago — skipping`,
      );
      return;
    }
  }

  // Send the alert
  const sent = await sendEmail({
    to,
    subject: '[Fundraising] אזהרה: לא התקבלו Webhooks מ-HYP ב-24 שעות האחרונות',
    html: `
      <h2 style="color:#c0392b">⚠️ Webhook לא פעיל</h2>
      <p>לא נכנסה אף רשומה חדשה לטבלת <strong>webhook_log</strong> ב-24 השעות האחרונות.</p>
      <p>ייתכן שה-Webhook של HYP אינו מוגדר נכון, או שחל שיבוש בתקשורת.</p>
      <hr/>
      <p>זמן גילוי: <strong>${new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}</strong></p>
      <p style="color:#888;font-size:12px">
        התראה זו נשלחת לכל היותר פעם בכל ${ALERT_THROTTLE_HOURS} שעות.
      </p>
    `,
  });

  if (sent) {
    await db
      .insert(syncState)
      .values({
        operation: ALERT_OPERATION,
        lastRun: new Date(),
        status: 'alert-sent',
        details: { sentAt: new Date().toISOString() },
      })
      .onConflictDoUpdate({
        target: syncState.operation,
        set: {
          lastRun: new Date(),
          status: 'alert-sent',
          details: { sentAt: new Date().toISOString() },
        },
      });

    console.log(`[alert] Webhook health alert sent to ${to}`);
  }
}

async function sendEmail(opts: { to: string; subject: string; html: string }): Promise<boolean> {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT) || 587;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.ALERT_EMAIL_FROM ?? user;

  if (!host || !user || !pass) {
    console.error('[alert] SMTP credentials missing (SMTP_HOST / SMTP_USER / SMTP_PASS)');
    return false;
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  try {
    await transporter.sendMail({
      from: `"Fundraising Monitor" <${from}>`,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
    });
    return true;
  } catch (err) {
    console.error('[alert] Failed to send email:', err);
    return false;
  }
}
