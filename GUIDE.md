# paynut integration guide

Five minutes from `npm install` to charging sats for an API call.

## 1. Install

```bash
npm install @cashu/cashu-ts express   # paynut itself is this repo's src/
```

Copy `src/gate.ts` + `src/express.ts` into your project (or depend on the
package once published). The only hard dependency is `@cashu/cashu-ts` v3.

## 2. Gate an endpoint

```ts
import { paywall } from './express.js';

app.get('/paid/report', paywall({
  price: 21,                                   // per call, in `unit`
  unit: 'sat',                                 // default
  mints: ['https://your-mint.example'],        // ONLY these mints' tokens count
  onPayment: (info) => saveProofs(info),       // persist what you earned!
}), handler);
```

`onPayment` receives `{ amount, mint, unit, proofs }` — the proofs are your
revenue. Store them (they are bearer assets), then melt or spend them from
your own wallet code whenever you like.

## 3. What your clients see

**Unpaid:**

```http
HTTP/1.1 402 Payment Required
Content-Type: application/json

{
  "error": "payment_required",
  "paynut": {
    "price": 21,
    "unit": "sat",
    "mints": ["https://your-mint.example"],
    "header": "X-Cashu",
    "changeHeader": "X-Cashu-Change"
  }
}
```

**Paid request:**

```http
GET /paid/report
X-Cashu: cashuBo2FteB...
```

**Paid response:** your handler's normal response, plus — when the client
overpaid — an `X-Cashu-Change` header carrying a fresh token for the
difference.

**Errors:** `400 malformed_token`; `402` with `error` one of
`untrusted_mint` / `wrong_unit` / `insufficient` (token untouched, client may
top up and retry) / `insufficient_after_fees` / `redeem_failed` (e.g. token
already spent).

## 4. What your clients do (cashu-ts)

```ts
const wallet = new Wallet(mintUrl, { unit: 'sat' });
await wallet.loadMint();

// includeFees matters: redeeming costs the mint's per-proof input fee,
// so the token's face value must cover price + fee for the gate to net `price`.
const { send, keep } = await wallet.send(price, myProofs, { includeFees: true });
const token = getEncodedToken({ mint: mintUrl, proofs: send, unit: 'sat' });

const res = await fetch(url, { headers: { 'X-Cashu': token } });
const change = res.headers.get('x-cashu-change');
if (change) myProofs.push(...(await wallet.receive(change))); // bank the change
```

## 5. Production notes

- **Pick mints deliberately.** Accepting a mint means trusting it to honour
  redemption. Start with one reputable mint; the list is yours to extend.
- **Persist earnings.** The demo server keeps proofs in memory for clarity.
  In production, write `onPayment` proofs to your wallet store immediately —
  a restart must not evaporate revenue.
- **Price above the fee floor.** With a 1 sat/proof input fee, a 1 sat price
  nets zero. Prices of 5+ sats behave sanely; batch-priced endpoints (one
  payment, N calls via a session token) are a natural next step.
- **One token, one call.** Redemption burns the presented proofs at the mint,
  so replay is impossible by construction — no nonce store needed.
- **Test for free.** `https://testnut.cashu.space` is a public test mint on a
  FakeWallet: invoices settle themselves, sats are worthless, and the full
  flow (including fees) behaves like production.
