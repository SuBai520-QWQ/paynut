/**
 * Express adapter for the paynut gate.
 *
 * Usage:
 *   app.get('/paid/fortune', paywall({ price: 5, mints: [MINT] }), handler);
 *
 * Unpaid requests get HTTP 402 with a JSON quote. Paid requests carry the
 * Cashu token in the `X-Cashu` header; overpayment change comes back in the
 * `X-Cashu-Change` response header. A 402 can also carry `X-Cashu-Change`
 * when a token was redeemed but fees left it short of the price: the header
 * then holds a refund of the value the gate received.
 */
import type { NextFunction, Request, Response } from 'express';
import { CashuGate, type GateOptions, type PaymentInfo } from './gate.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      paynut?: PaymentInfo;
    }
  }
}

export function paywall(opts: GateOptions) {
  const gate = new CashuGate(opts);
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = req.get('x-cashu');
    if (!token) {
      res.status(402).json({
        error: 'payment_required',
        message: `This call costs ${gate.price} ${gate.unit}. Pay with a Cashu token in the X-Cashu header.`,
        paynut: gate.quote(),
      });
      return;
    }
    const result = await gate.verifyPayment(token);
    if (!result.ok) {
      // insufficient_after_fees refunds the redeemed value in a change token.
      if (result.changeToken) res.setHeader('X-Cashu-Change', result.changeToken);
      const status = result.reason === 'malformed_token' ? 400 : 402;
      res.status(status).json({
        error: result.reason,
        detail: result.detail,
        received: result.received,
        paynut: gate.quote(),
      });
      return;
    }
    if (result.changeToken) res.setHeader('X-Cashu-Change', result.changeToken);
    req.paynut = result.paid;
    next();
  };
}

export { CashuGate };
