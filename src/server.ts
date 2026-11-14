/**
 * paynut demo server: one free info route, one Cashu-paid route.
 *
 *   PORT=8402 PAYNUT_MINT=https://testnut.cashu.space PAYNUT_PRICE=5 npm start
 *
 * The default mint is the public *test* mint (FakeWallet, worthless sats) so
 * anyone can run the full flow for free. Point PAYNUT_MINT at a real mint to
 * charge real sats.
 */
import express from 'express';
import { paywall } from './express.js';
import type { PaymentInfo } from './gate.js';

export const TEST_MINT = 'https://testnut.cashu.space';

const FORTUNES = [
  'A bearer token in hand is worth two in the mempool.',
  'Ship the wallet you wish to see in the world.',
  'Privacy is not a feature. It is the default state of cash.',
  'Small payments, honestly priced, move the world.',
  'May your proofs always verify and your change always return.',
  'The best API key is no API key: just cash.',
];

export function createApp(env: NodeJS.ProcessEnv = process.env) {
  const mint = env.PAYNUT_MINT ?? TEST_MINT;
  const price = Number(env.PAYNUT_PRICE ?? 5);
  const stats = { calls: 0, earned: 0, unit: 'sat' };

  const app = express();
  app.use(express.json());

  app.get('/', (_req, res) => {
    res.json({
      service: 'paynut demo',
      description: 'Pay-per-call API gated by Cashu ecash. No accounts, no API keys.',
      price,
      unit: stats.unit,
      mint,
      paidEndpoint: '/paid/fortune',
      howToPay:
        'GET the paid endpoint -> 402 quote -> retry with header `X-Cashu: <cashu token>`. Overpayment change returns in `X-Cashu-Change`.',
      stats,
    });
  });

  const onPayment = (info: PaymentInfo) => {
    stats.calls += 1;
    stats.earned += info.amount;
  };

  app.get('/paid/fortune', paywall({ price, mints: [mint], onPayment }), (req, res) => {
    const fortune = FORTUNES[Math.floor(Math.random() * FORTUNES.length)];
    res.json({
      fortune,
      paid: { amount: req.paynut?.amount, unit: req.paynut?.unit, mint: req.paynut?.mint },
      tip: 'Change (if any) is in the X-Cashu-Change response header.',
    });
  });

  return { app, stats };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const port = Number(process.env.PORT ?? 8402);
  const { app } = createApp();
  app.listen(port, () => {
    console.log(
      `paynut demo on http://localhost:${port} (mint ${process.env.PAYNUT_MINT ?? TEST_MINT}, price ${process.env.PAYNUT_PRICE ?? 5} sat)`,
    );
  });
}
