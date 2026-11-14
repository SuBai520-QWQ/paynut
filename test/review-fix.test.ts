/**
 * Regression tests for the first review round (see ../REVIEW-01.md).
 * Each test targets a bug that the pre-fix code exhibited.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { getEncodedToken, getTokenMetadata } from '@cashu/cashu-ts';
import type { Proof } from '@cashu/cashu-ts';
import { CashuGate, normalizeMintUrl } from '../src/gate.js';
import { paywall } from '../src/express.js';

const MINT = 'https://mint.example';

function fakeProof(amount: number): Proof {
  return {
    id: '009a1f293cbfe5e9',
    amount,
    secret: `secret-${amount}-${Math.random()}`,
    C: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  } as Proof;
}

function tokenFor(amounts: number[], mint = MINT, unit = 'sat'): string {
  return getEncodedToken({ mint, proofs: amounts.map(fakeProof), unit });
}

test('a transient mint load failure does not poison the wallet cache', async () => {
  let hits = 0;
  const server = http.createServer((_req, res) => {
    hits += 1;
    res.statusCode = 500;
    res.end('mint down');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const mint = `http://127.0.0.1:${port}`;
    const gate = new CashuGate({ price: 5, mints: [mint] });
    const token = tokenFor([8], mint);

    const first = await gate.verifyPayment(token);
    assert.equal(first.ok, false);
    if (!first.ok) assert.equal(first.reason, 'redeem_failed');
    const afterFirst = hits;

    const second = await gate.verifyPayment(token);
    assert.equal(second.ok, false);
    assert.ok(hits > afterFirst, `loadMint was not retried (requests stayed at ${afterFirst})`);
  } finally {
    server.close();
  }
});

test('a token with a missing or non-string mint is malformed, not a crash', async () => {
  const gate = new CashuGate({ price: 5, mints: [MINT], redeemer: async () => [fakeProof(8)] });
  const encodeV3 = (value: unknown) =>
    'cashuA' + Buffer.from(JSON.stringify(value)).toString('base64url');
  for (const mint of [undefined, null, 123]) {
    const token = encodeV3({ token: [{ mint, proofs: [fakeProof(8)] }] });
    const res = await gate.verifyPayment(token);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, 'malformed_token');
  }
});

test('a split failure after redemption still delivers the call', async (t) => {
  t.mock.method(console, 'error', () => {});
  const seen: number[] = [];
  const gate = new CashuGate({
    price: 5,
    mints: [MINT],
    redeemer: async () => [fakeProof(8)],
    splitter: async () => {
      throw new Error('mint hiccup');
    },
    onPayment: (info) => seen.push(info.amount),
  });

  const res = await gate.verifyPayment(tokenFor([8]));
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.paid.amount, 8);
    assert.equal(res.changeToken, undefined);
  }
  assert.deepEqual(seen, [8]);
});

test('insufficient_after_fees returns the received value as a refund token', async () => {
  let payments = 0;
  const gate = new CashuGate({
    price: 5,
    mints: [MINT],
    redeemer: async () => [fakeProof(4)],
    onPayment: () => {
      payments += 1;
    },
  });

  const res = await gate.verifyPayment(tokenFor([5]));
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.reason, 'insufficient_after_fees');
    assert.equal(res.received, 4);
    assert.ok(res.changeToken, 'refund token missing');
    const refund = getTokenMetadata(res.changeToken!);
    assert.equal(refund.amount, 4);
    assert.equal(refund.mint, MINT);
    assert.equal(refund.unit, 'sat');
  }
  assert.equal(payments, 0, 'a failed payment must not count as revenue');
});

test('express puts the refund token on the 402 response', async () => {
  const app = express();
  app.get(
    '/paid',
    paywall({ price: 5, mints: [MINT], redeemer: async () => [fakeProof(4)] }),
    (_req, res) => {
      res.json({ ok: true });
    },
  );
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/paid`, {
      headers: { 'X-Cashu': tokenFor([5]) },
    });
    assert.equal(res.status, 402);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'insufficient_after_fees');
    const refund = res.headers.get('x-cashu-change');
    assert.ok(refund, 'refund header missing');
    assert.equal(getTokenMetadata(refund!).amount, 4);
  } finally {
    server.close();
  }
});

test('a throwing onPayment does not lose a settled payment', async (t) => {
  t.mock.method(console, 'error', () => {});
  const gate = new CashuGate({
    price: 5,
    mints: [MINT],
    redeemer: async () => [fakeProof(8)],
    splitter: async () => ({ keep: [fakeProof(5)], send: [fakeProof(3)] }),
    onPayment: () => {
      throw new Error('db down');
    },
  });

  const res = await gate.verifyPayment(tokenFor([8]));
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.paid.amount, 5);
    assert.ok(res.changeToken, 'change token missing');
  }
});

test('concurrent submissions of one token pay at most once', async () => {
  // The mint is the arbiter: its swap burns the inputs exactly once. This
  // fake mimics that atomicity and checks the gate does not double-count.
  let spent = false;
  let payments = 0;
  const gate = new CashuGate({
    price: 5,
    mints: [MINT],
    redeemer: async () => {
      if (spent) throw new Error('proofs already spent');
      spent = true;
      return [fakeProof(5)];
    },
    onPayment: () => {
      payments += 1;
    },
  });

  const token = tokenFor([5]);
  const [a, b] = await Promise.all([gate.verifyPayment(token), gate.verifyPayment(token)]);
  assert.equal([a, b].filter((r) => r.ok).length, 1);
  assert.equal(payments, 1);
});

test('mint URLs compare canonically while lookalikes stay untrusted', async () => {
  assert.equal(normalizeMintUrl('https://MINT.example:443/'), 'https://mint.example');
  assert.equal(normalizeMintUrl('https://mint.example/cashu/'), 'https://mint.example/cashu');
  assert.notEqual(
    normalizeMintUrl('https://mint.example.evil.com'),
    normalizeMintUrl('https://mint.example'),
  );

  const gate = new CashuGate({ price: 5, mints: [MINT], redeemer: async () => [fakeProof(5)] });
  const sameMint = await gate.verifyPayment(tokenFor([5], 'https://MINT.example:443/'));
  assert.equal(sameMint.ok, true);

  const lookalike = await gate.verifyPayment(tokenFor([5], 'https://mint.example.evil.com'));
  assert.equal(lookalike.ok, false);
  if (!lookalike.ok) assert.equal(lookalike.reason, 'untrusted_mint');
});
