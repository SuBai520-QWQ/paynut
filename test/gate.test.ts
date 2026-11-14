import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEncodedToken } from '@cashu/cashu-ts';
import type { Proof } from '@cashu/cashu-ts';
import { CashuGate, sumProofs } from '../src/gate.js';

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

/** A gate whose "mint" simply re-issues the presented value as fresh proofs. */
function fakeGate(price: number, extra: Partial<ConstructorParameters<typeof CashuGate>[0]> = {}) {
  const redeemed: string[] = [];
  const gate = new CashuGate({
    price,
    mints: [MINT],
    redeemer: async (_mint, token) => {
      redeemed.push(token);
      const { getDecodedToken } = await import('@cashu/cashu-ts');
      return getDecodedToken(token).proofs.map((p) => fakeProof(Number(p.amount)));
    },
    splitter: async (_mint, amount, proofs) => {
      // take `amount` out of the first proof(s): good enough for math checks
      let remaining = amount;
      const send: Proof[] = [];
      const keep: Proof[] = [];
      for (const p of proofs) {
        const a = Number(p.amount);
        if (remaining >= a) {
          send.push(p);
          remaining -= a;
        } else if (remaining > 0) {
          send.push(fakeProof(remaining));
          keep.push(fakeProof(a - remaining));
          remaining = 0;
        } else {
          keep.push(p);
        }
      }
      return { keep, send };
    },
    ...extra,
  });
  return { gate, redeemed };
}

test('underpayment is rejected without redeeming the token', async () => {
  const { gate, redeemed } = fakeGate(5);
  const res = await gate.verifyPayment(tokenFor([2, 2]));
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.reason, 'insufficient');
    assert.equal(res.received, 4);
  }
  assert.equal(redeemed.length, 0, 'token must stay unspent so the client can reuse it');
});

test('exact payment succeeds with no change', async () => {
  const { gate } = fakeGate(5);
  const res = await gate.verifyPayment(tokenFor([4, 1]));
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.paid.amount, 5);
    assert.equal(res.changeToken, undefined);
  }
});

test('overpayment returns change worth the difference', async () => {
  const { gate } = fakeGate(5);
  const res = await gate.verifyPayment(tokenFor([8]));
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.ok(res.changeToken, 'change token expected');
    const { getDecodedToken } = await import('@cashu/cashu-ts');
    assert.equal(sumProofs(getDecodedToken(res.changeToken!).proofs), 3);
    assert.equal(res.paid.amount, 5);
  }
});

test('token from an untrusted mint is rejected', async () => {
  const { gate } = fakeGate(5);
  const res = await gate.verifyPayment(tokenFor([8], 'https://evil.example'));
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, 'untrusted_mint');
});

test('token in the wrong unit is rejected', async () => {
  const { gate } = fakeGate(5);
  const res = await gate.verifyPayment(tokenFor([8], MINT, 'usd'));
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, 'wrong_unit');
});

test('garbage input is a malformed token, not a crash', async () => {
  const { gate } = fakeGate(5);
  const res = await gate.verifyPayment('not-a-cashu-token');
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, 'malformed_token');
});

test('onPayment fires once with the kept amount', async () => {
  const seen: number[] = [];
  const { gate } = fakeGate(5, { onPayment: (info) => seen.push(info.amount) });
  await gate.verifyPayment(tokenFor([8]));
  assert.deepEqual(seen, [5]);
});
