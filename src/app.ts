import express from 'express';
import webhookRouter from './routes/webhook';
import verifyStatusRouter from './routes/verify-status';
import healthRouter from './routes/health';

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/api/webhook', webhookRouter);
app.use('/api/verify-status', verifyStatusRouter);
app.use('/api/health', healthRouter);

export default app;
