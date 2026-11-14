/**
 * End-to-end test against the public test mint (testnut.cashu.space).
 * The mint runs a FakeWallet: Lightning invoices settle by themselves and
 * the sats are worthless, so this exercises the real Cashu flow for free.
 * Skips itself when the mint is unreachable.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { Wallet, getEncodedToken, getTokenMetadata } from '@cashu/cashu-ts';
import type { Proof } from '@cashu/cashu-ts';
import { createApp, TEST_MINT } from '../src/server.js';
import { sumProofs } from '../src/gate.js';

const PRICE = 5;
let server: Server;
let base = '';
let wallet: Wallet;
let proofs: Proof[] = [];

async function mintReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${TEST_MINT}/v1/info`, { signal: AbortSignal.timeout(8000) });
    return res.ok;
  } catch {
    return false;
  }
}

before(async () => {
  if (!(await mintReachable())) return;
  const { app } = createApp({ ...process.env, PAYNUT_MINT: TEST_MINT, PAYNUT_PRICE: String(PRICE) });
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  wallet = new Wallet(TEST_MINT, { unit: 'sat' });
  await wallet.loadMint();
  const quote = await wallet.createMintQuoteBolt11(32);
  const deadline = Date.now() + 90_000;
  for (;;) {
    const status = await wallet.checkMintQuoteBolt11(quote.quote);
    if (String(status.state) === 'PAID') break;
    if (Date.now() > deadline) throw new Error('test mint quote never settled');
    await new Promise((r) => setTimeout(r, 1000));
  }
  proofs = await wallet.mintProofs(32, quote.quote);
  assert.equal(sumProofs(proofs), 32);
});

after(() => server?.close());

test('unpaid call gets a 402 quote', async (t) => {
  if (!base) return t.skip('test mint unreachable');
  const res = await fetch(`${base}/paid/fortune`);
  assert.equal(res.status, 402);
  const body = await res.json();
  assert.equal(body.paynut.price, PRICE);
  assert.deepEqual(body.paynut.mints, [TEST_MINT]);
});

test('paying the exact price returns the fortune', async (t) => {
  if (!base) return t.skip('test mint unreachable');
  // includeFees: the token must also cover the gate's redemption (swap) fee.
  const { send, keep } = await wallet.send(PRICE, proofs, { includeFees: true });
  proofs = keep;
  const token = getEncodedToken({ mint: TEST_MINT, proofs: send, unit: 'sat' });
  const res = await fetch(`${base}/paid/fortune`, { headers: { 'X-Cashu': token } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.fortune, 'fortune missing');
  assert.equal(body.paid.amount, PRICE);
  assert.equal(res.headers.get('x-cashu-change'), null);
});

test('overpaying returns change, and the same token cannot be spent twice', async (t) => {
  if (!base) return t.skip('test mint unreachable');
  const { send, keep } = await wallet.send(PRICE + 3, proofs);
  proofs = keep;
  const token = getEncodedToken({ mint: TEST_MINT, proofs: send, unit: 'sat' });

  const res = await fetch(`${base}/paid/fortune`, { headers: { 'X-Cashu': token } });
  assert.equal(res.status, 200);
  const change = res.headers.get('x-cashu-change');
  assert.ok(change, 'change header missing');
  // change = face value - gate's swap fee - price (fee read from the mint's keyset)
  const expectedChange = sumProofs(send) - wallet.getFeesForProofs(send) - PRICE;
  assert.equal(getTokenMetadata(change!).amount, expectedChange);

  const replay = await fetch(`${base}/paid/fortune`, { headers: { 'X-Cashu': token } });
  assert.equal(replay.status, 402, 'a spent token must not buy a second call');
});
