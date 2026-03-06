import express from 'express';
import webhookRouter from './routes/webhook';
import verifyStatusRouter from './routes/verify-status';
import healthRouter from './routes/health';

const app = express();

// Webhook routes receive the raw Buffer body (needed for signature validation)
app.use('/api/webhook', express.raw({ type: 'application/json' }));

// All other routes use parsed JSON
app.use(express.json());

app.use('/api/webhook', webhookRouter);
app.use('/api/verify-status', verifyStatusRouter);
app.use('/api/health', healthRouter);

export default app;
