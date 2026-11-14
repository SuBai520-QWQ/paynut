/**
 * Regression tests for the second review round (bug-hunt 2026-11-15 +
 * Perch review). Each test targets a bug the pre-fix code exhibited:
 * PN-N1 (mint-switch backups overwriting each other), PN-N2 (settled
 * payment lost when the handler fails), PN-N3 (change evaporating when its
 * encoding fails), PN-N4 (wallet unit not validated), plus the round-1
 * known limits fixed in this round (atomic saveStore, persisted topUp
 * quotes).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { getEncodedToken, getTokenMetadata, type Wallet } from '@cashu/cashu-ts';
import type { Proof } from '@cashu/cashu-ts';
import { CashuGate } from '../src/gate.js';
import { paywall } from '../src/express.js';
import {
  loadStore,
  saveStore,
  payForCall,
  topUp,
  type PaymentWallet,
  type WalletFile,
} from '../src/client.js';

const MINT_A = 'https://mint-a.example';
const MINT_B = 'https://mint-b.example';

function fakeProof(amount: number): Proof {
  return {
    id: '009a1f293cbfe5e9',
    amount,
    secret: `secret-${amount}-${Math.random()}`,
    C: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  } as Proof;
}

function total(proofs: Proof[]): number {
  return proofs.reduce((acc, p) => acc + Number(p.amount), 0);
}

function tokenFor(amounts: number[], mint = MINT_A, unit = 'sat'): string {
  return getEncodedToken({ mint, proofs: amounts.map(fakeProof), unit });
}

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'paynut-round2-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

// ---- PN-N1: backups never overwrite; switching back restores ----

test('PN-N1: mint switches never destroy an earlier backup and switching back restores it', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'wallet.json');
  writeFileSync(file, JSON.stringify({ mint: MINT_A, unit: 'sat', proofs: [fakeProof(64)] }));

  // A(64) -> B: A is backed up, B starts fresh.
  let store = loadStore(file, MINT_B);
  assert.equal(total(store.proofs), 0);
  saveStore(file, { mint: MINT_B, unit: 'sat', proofs: [fakeProof(8)] });

  // B(8) -> A: the 64 sat backup is RESTORED, not orphaned.
  store = loadStore(file, MINT_A);
  assert.equal(total(store.proofs), 64, 'the original 64 sat must come back');
  saveStore(file, store);

  // A -> B again: B's 8 comes back, and A's 64 still exists in a backup.
  store = loadStore(file, MINT_B);
  assert.equal(total(store.proofs), 8);
  const aBackups = readdirSync(dir)
    .filter((n) => n.includes('.bak'))
    .map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')) as WalletFile)
    .filter((w) => w.mint === MINT_A);
  assert.ok(
    aBackups.some((w) => total(w.proofs) === 64),
    'a backup holding the original 64 sat must survive every switch',
  );
});

test('PN-N1: a second backup for the same mint gets a fresh name instead of overwriting', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'wallet.json');
  // Pre-existing backup holding 64 sat for mint A (name format of backupPath).
  const baseBackup = join(dir, 'wallet.json.https_mint_a_example.bak');
  writeFileSync(baseBackup, JSON.stringify({ mint: MINT_A, unit: 'sat', proofs: [fakeProof(64)] }));
  // Live wallet for mint A now holds only 1 sat; switching to B backs it up.
  writeFileSync(file, JSON.stringify({ mint: MINT_A, unit: 'sat', proofs: [fakeProof(1)] }));

  loadStore(file, MINT_B);

  assert.equal(
    total((JSON.parse(readFileSync(baseBackup, 'utf8')) as WalletFile).proofs),
    64,
    'the first backup must not be overwritten by the 1 sat backup',
  );
  const oneSat = readdirSync(dir)
    .filter((n) => n.includes('.bak'))
    .map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')) as WalletFile)
    .filter((w) => w.mint === MINT_A && total(w.proofs) === 1);
  assert.equal(oneSat.length, 1, 'the 1 sat backup exists under its own name');
});

// ---- PN-N4 + atomic save ----

test('PN-N4: loadStore rejects a wallet file for a different unit', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'wallet.json');
  writeFileSync(file, JSON.stringify({ mint: MINT_A, unit: 'usd', proofs: [fakeProof(8)] }));
  assert.throws(() => loadStore(file, MINT_A), /unit usd/);
});

test('saveStore is atomic: no temp file remains and the content round-trips', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'wallet.json');
  saveStore(file, { mint: MINT_A, unit: 'sat', proofs: [fakeProof(8)] });
  assert.deepEqual(readdirSync(dir), ['wallet.json']);
  const store = loadStore(file, MINT_A);
  assert.equal(total(store.proofs), 8);
});

// ---- topUp quote persistence (round-1 known limit) ----

function fakeMintWallet(overrides: Record<string, unknown> = {}): Wallet {
  return {
    createMintQuoteBolt11: async () => ({ quote: 'q-fresh', request: 'lnbc-fresh' }),
    checkMintQuoteBolt11: async () => ({ state: 'PAID' }),
    mintProofs: async (amount: number) => [fakeProof(amount)],
    ...overrides,
  } as unknown as Wallet;
}

test('topUp resumes a persisted quote instead of paying for a new one', async (t) => {
  const dir = tempDir(t);
  const quoteFile = join(dir, 'wallet.json.quote.json');
  writeFileSync(quoteFile, JSON.stringify({ quote: 'q-old', request: 'lnbc-old', amount: 32 }));

  let mintedWith: string | undefined;
  const wallet = fakeMintWallet({
    createMintQuoteBolt11: async () => {
      throw new Error('must not create a second quote');
    },
    mintProofs: async (amount: number, quote: string) => {
      mintedWith = quote;
      return [fakeProof(amount)];
    },
  });
  const store: WalletFile = { mint: MINT_A, unit: 'sat', proofs: [] };
  await topUp(wallet, store, 32, () => {}, quoteFile);

  assert.equal(mintedWith, 'q-old');
  assert.equal(total(store.proofs), 32);
  assert.equal(existsSync(quoteFile), false, 'the quote file is cleared after minting');
});

test('topUp persists a fresh quote before waiting and clears it after minting', async (t) => {
  const dir = tempDir(t);
  const quoteFile = join(dir, 'wallet.json.quote.json');
  let persistedDuringWait = false;
  const wallet = fakeMintWallet({
    checkMintQuoteBolt11: async () => {
      persistedDuringWait = existsSync(quoteFile);
      return { state: 'PAID' };
    },
  });
  const store: WalletFile = { mint: MINT_A, unit: 'sat', proofs: [] };
  await topUp(wallet, store, 16, () => {}, quoteFile);

  assert.equal(persistedDuringWait, true, 'the quote must be on disk while payment is pending');
  assert.equal(existsSync(quoteFile), false);
  assert.equal(total(store.proofs), 16);
});

// ---- PN-N2: handler failure after settlement ----

async function withServer(
  app: express.Express,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    await fn((server.address() as AddressInfo).port);
  } finally {
    server.close();
  }
}

test('PN-N2: a handler answering 500 returns the settled payment as X-Cashu-Refund', async () => {
  const app = express();
  app.get(
    '/paid',
    paywall({ price: 5, mints: [MINT_A], redeemer: async () => [fakeProof(5)] }),
    (_req, res) => {
      res.status(500).json({ error: 'boom' });
    },
  );
  await withServer(app, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/paid`, {
      headers: { 'X-Cashu': tokenFor([5]) },
    });
    assert.equal(res.status, 500);
    const refund = res.headers.get('x-cashu-refund');
    assert.ok(refund, 'refund header missing on a settled 500');
    assert.equal(getTokenMetadata(refund!).amount, 5);
  });
});

test('PN-N2: a successful handler response carries no refund header', async () => {
  const app = express();
  app.get(
    '/paid',
    paywall({ price: 5, mints: [MINT_A], redeemer: async () => [fakeProof(5)] }),
    (_req, res) => {
      res.json({ ok: true });
    },
  );
  await withServer(app, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/paid`, {
      headers: { 'X-Cashu': tokenFor([5]) },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-cashu-refund'), null);
  });
});

function fakeWallet(overrides: Partial<PaymentWallet> = {}): PaymentWallet {
  return {
    send: overrides.send ?? (async (_amount, proofs) => ({ keep: [], send: proofs })),
    receive: overrides.receive ?? (async () => []),
  };
}

test('PN-N2 client: a banked change token no longer skips the reclaim attempt / token record', async (t) => {
  const errors: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => {
    errors.push(args.map((a) => String(a)).join(' '));
  });
  const store: WalletFile = { mint: MINT_A, unit: 'sat', proofs: [fakeProof(8)] };
  const wallet = fakeWallet({
    send: async () => ({ keep: [fakeProof(3)], send: [fakeProof(5)] }),
    receive: async (token) => {
      if (token === 'change-token') return [fakeProof(3)];
      throw new Error('already spent');
    },
  });

  const result = await payForCall(
    'http://server/paid',
    5,
    wallet,
    store,
    () => {},
    async () => jsonResponse(500, { error: 'boom' }, { 'x-cashu-change': 'change-token' }),
  );

  assert.equal(result.status, 500);
  assert.equal(result.change, 3, 'the change is still banked');
  assert.equal(result.reclaimed, false);
  assert.ok(
    errors.some((line) => line.includes('cashu')),
    'the payment token must be printed as the recovery record',
  );
});

test('PN-N2 client: an X-Cashu-Refund token is banked on a failed call', async () => {
  const store: WalletFile = { mint: MINT_A, unit: 'sat', proofs: [fakeProof(8)] };
  const wallet = fakeWallet({
    send: async () => ({ keep: [fakeProof(3)], send: [fakeProof(5)] }),
    receive: async (token) => {
      if (token === 'refund-token') return [fakeProof(5)];
      throw new Error('already spent');
    },
  });

  const result = await payForCall(
    'http://server/paid',
    5,
    wallet,
    store,
    () => {},
    async () => jsonResponse(500, { error: 'boom' }, { 'x-cashu-refund': 'refund-token' }),
  );

  assert.equal(result.status, 500);
  assert.equal(result.refund, 5);
  assert.equal(total(store.proofs), 8, 'keep 3 + refund 5: the payer is whole');
});

test('PN-N3: an un-encodable fee refund leaves the proofs in the log for recovery', async (t) => {
  const errors: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => {
    errors.push(args.map((a) => String(a)).join(' '));
  });
  const unencodable = { ...fakeProof(4), C: 123 } as unknown as Proof;
  const gate = new CashuGate({
    price: 5,
    mints: [MINT_A],
    redeemer: async () => [unencodable], // received 4 < price 5 after fees
  });

  const res = await gate.verifyPayment(tokenFor([5]));
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.reason, 'insufficient_after_fees');
    assert.equal(res.changeToken, undefined, 'the refund could not be encoded');
  }
  assert.ok(
    errors.some((line) => line.includes('manual recovery') && line.includes('secret-4')),
    'the received proofs must be logged for manual recovery, not dropped',
  );
});

// ---- PN-N3: change encoding failure keeps the value in the gate ----

test('PN-N3: when change encoding fails the gate keeps the full received amount', async (t) => {
  t.mock.method(console, 'error', () => {});
  // A proof getEncodedToken refuses to serialize (C must be a hex string):
  // encoding the change throws, which is exactly the PN-N3 trigger.
  const unencodable = { ...fakeProof(3), C: 123 } as unknown as Proof;
  const gate = new CashuGate({
    price: 5,
    mints: [MINT_A],
    redeemer: async () => [fakeProof(8)],
    splitter: async () => ({
      keep: [fakeProof(5)],
      send: [unencodable],
    }),
  });

  const res = await gate.verifyPayment(tokenFor([8]));
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.changeToken, undefined);
    assert.equal(res.paid.amount, 8, 'the un-encodable change stays in the gate, not in the void');
  }
});
