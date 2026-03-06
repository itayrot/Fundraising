import { Router, Request, Response } from 'express';
import { runVerifyStatus } from '../jobs/verify-status';

const router = Router();

/**
 * GET /api/verify-status
 * Protected by CRON_SECRET header — called by DigitalOcean Cron Job or manually.
 */
router.get('/', async (req: Request, res: Response) => {
  const token = req.headers['x-cron-secret'];
  if (!process.env.CRON_SECRET || token !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const result = await runVerifyStatus();
    return res.status(200).json({ status: 'ok', ...result });
  } catch (err) {
    console.error('[verify-status] Unhandled error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
