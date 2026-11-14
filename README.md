# paynut 🌰

**Pay-per-call APIs with Cashu ecash.** Put a price on any HTTP endpoint: callers pay a few sats with a Cashu token — no accounts, no API keys, no payment processor. Built for [Nut November](https://nutnovember.org/), the Cashu community hackathon.

```text
client ── GET /paid/fortune ──────────────► server
client ◄── 402 { price: 5, mints: [...] } ── server
client ── GET /paid/fortune ──────────────► server
         X-Cashu: cashuB...
client ◄── 200 { fortune: "..." } ──────── server
         X-Cashu-Change: cashuB... (if overpaid)
```

This is the [HTTP 402](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/402) flow, settled in ecash instead of card rails: the server redeems the token at the mint (which burns the proofs, so a token can never buy twice), keeps the price, and returns the overpayment as a fresh change token.

## Try it in 2 minutes (free — test mint)

The demo defaults to the public **test mint** (`https://testnut.cashu.space`), whose sats are worthless and whose Lightning invoices settle by themselves. The whole flow costs nothing:

```bash
npm install
npm start          # terminal 1: demo server on :8402, 5 sat per fortune
npm run client     # terminal 2: wallet tops up 32 test sats, pays 5, gets a fortune
```

Watch the client handle the 402, mint, pay, and store its change. Point `PAYNUT_MINT` at a real mint (and `PAYNUT_PRICE` at your price) to charge real sats.

## Add Cashu payments to your own API

```ts
import express from 'express';
import { paywall } from './src/express.js'; // this repo: src/express.ts

const app = express();

app.get(
  '/paid/weather',
  paywall({ price: 10, mints: ['https://mint.example.com'], unit: 'sat' }),
  (req, res) => {
    // req.paynut tells you what was paid: { amount, mint, unit, proofs }
    res.json({ forecast: 'ecash with a chance of sats' });
  },
);
```

That's the whole integration. See [GUIDE.md](./GUIDE.md) for the protocol details, fee behaviour, and production notes (which mints to trust, how change works, how to withdraw what you earned by melting).

## What's in the box

| File | What it does |
|---|---|
| `src/gate.ts` | Framework-agnostic core: decode → trust checks → redeem at mint → split change. Money math is unit-tested with an injected fake mint. |
| `src/express.ts` | Express middleware (`paywall`) wrapping the gate: 402 quotes, `X-Cashu` in, `X-Cashu-Change` out. |
| `src/server.ts` | Demo server: free info route + one paid fortune route, with live earnings stats. |
| `src/client.ts` | Demo client: file-backed wallet, automatic top-up via mint quotes, pays and banks change. |
| `test/gate.test.ts` | Unit tests: underpayment is rejected *without* redeeming (the client's token stays spendable), exact/overpayment, untrusted mint, wrong unit, malformed input. |
| `test/e2e.test.ts` | Live end-to-end against the test mint: 402 → pay → fortune, overpay → change, replayed token → rejected. |

## Protocol in one paragraph

An unpaid request returns `402` with `{ price, unit, mints, header: "X-Cashu" }`. The client builds a Cashu token worth the price **plus the mint's swap fee** (in cashu-ts: `wallet.send(price, proofs, { includeFees: true })`) and retries with the token in the `X-Cashu` header. The server redeems the token at the mint — redemption is what makes the payment final and double-spend-proof — keeps the price, and if the redeemed value exceeds the price, returns the difference as a new token in the `X-Cashu-Change` header. One token buys exactly one call.

## Tests

```bash
npm test          # unit tests (no network)
npm run test:e2e  # live flow against the test mint (skips if unreachable)
npm run build     # typecheck + emit dist/
```

## Notes & limits

- **Fees are real.** Mints charge an input fee per proof on every swap. The gate nets `received − fee`; a token that doesn't cover price + fee is rejected (`insufficient_after_fees`), and the value the gate did receive comes back in `X-Cashu-Change` as a refund — clients should use `includeFees` or slightly overpay (change comes back anyway).
- **Handler failures are refunded.** The payment settles before your handler runs. If the handler answers 5xx through the normal response methods (`res.json` / `res.send` / `res.sendStatus`), the paywall attaches an `X-Cashu-Refund` token worth the full kept amount, and the demo client banks it automatically — the payer is made whole. One exception: errors that escape to Express's *default* error handler can't carry the header (it writes the response head itself); install your own error handler that responds via `res.status(...).json(...)` if you need refunds on thrown errors too.
- **Trust list = your mints list.** The gate only accepts tokens from mints you configure. A token from any other mint is rejected before redemption.
- **Earnings are proofs.** What the gate keeps are ordinary Cashu proofs at your mint: melt them to Lightning or hold them like any wallet would. The demo keeps them in memory and reports totals on `/`; a production deployment should persist `onPayment` proofs.
- Built with [`@cashu/cashu-ts`](https://github.com/cashubtc/cashu-ts) v3. MIT licensed.

*First-time Cashu contributor project, built entirely during Nut November 2026 (Nov 14) — with a coding agent doing the typing, as the rules encourage.*
