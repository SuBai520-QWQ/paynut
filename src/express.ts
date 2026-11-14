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
 *
 * Handler failures (PN-N2): the payment settles BEFORE the handler runs, so
 * a handler that answers 5xx through the normal response methods (res.json /
 * res.send / res.sendStatus / res.end) gets an `X-Cashu-Refund` header
 * carrying a token worth the full kept amount — the payer is made whole.
 * Errors that escape to Express's default error handler are the exception:
 * it writes the response head itself, after which no header can be added.
 * Apps that need the refund on thrown errors too should install their own
 * error handler that responds via res.status(...).json(...) — the refund
 * wrapper is still attached to that response object, so it applies there.
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

    // PN-N2 compensation: wrap the response senders so a 5xx answer carries
    // a refund token for the settled payment. The wrapper only adds the
    // header while headers are still unsent, and only once.
    const paid = result.paid;
    const attachRefund = () => {
      if (res.statusCode >= 500 && !res.headersSent && !res.getHeader('X-Cashu-Refund')) {
        const refund = gate.refundTokenFor(paid);
        if (refund) res.setHeader('X-Cashu-Refund', refund);
      }
    };
    const origJson = res.json.bind(res);
    const origSend = res.send.bind(res);
    const origSendStatus = res.sendStatus.bind(res);
    const origEnd = res.end.bind(res);
    res.json = ((body: unknown) => {
      attachRefund();
      return origJson(body);
    }) as typeof res.json;
    res.send = ((body: unknown) => {
      attachRefund();
      return origSend(body);
    }) as typeof res.send;
    res.sendStatus = ((code: number) => {
      attachRefund();
      return origSendStatus(code);
    }) as typeof res.sendStatus;
    res.end = ((...args: unknown[]) => {
      attachRefund();
      return (origEnd as (...a: unknown[]) => Response)(...args);
    }) as typeof res.end;

    next();
  };
}

export { CashuGate };
