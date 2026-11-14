/**
 * Regression tests for the demo client's wallet-file handling (first review
 * round). The payment flow is exercised with an injected fake wallet and
 * fetch, so no mint or server is needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Proof } from '@cashu/cashu-ts';
import {
  loadStore,
  saveStore,
  payForCall,
  parseArgs,
  DEFAULT_URL,
  type PaymentWallet,
  type WalletFile,
} from '../src/client.js';

const MINT = 'https://mint.example';
const OTHER = 'https://other.example';

function fakeProof(amount: number): Proof {
  return {
    id: '009a1f293cbfe5e9',
    amount,
    secret: `secret-${amount}-${Math.random()}`,
    C: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  } as Proof;
}

function storeWith(proofs: Proof[]): WalletFile {
  return { mint: MINT, unit: 'sat', proofs };
}

function total(proofs: Proof[]): number {
  return proofs.reduce((acc, p) => acc + Number(p.amount), 0);
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function fakeWallet(
  overrides: Partial<Pick<PaymentWallet, 'send' | 'receive'>> = {},
): PaymentWallet {
  return {
    send: overrides.send ?? (async (_amount, proofs) => ({ keep: [], send: proofs })),
    receive: overrides.receive ?? (async () => []),
  };
}

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'paynut-client-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('--topup before the URL does not swallow its value as the URL', () => {
  assert.deepEqual(parseArgs(['--topup', '64']), { url: DEFAULT_URL, topupAmount: 64 });
  assert.deepEqual(parseArgs(['--topup', '64', 'http://x/paid']), {
    url: 'http://x/paid',
    topupAmount: 64,
  });
  assert.deepEqual(parseArgs(['http://x/paid', '--topup', '8']), {
    url: 'http://x/paid',
    topupAmount: 8,
  });
  assert.deepEqual(parseArgs([]), { url: DEFAULT_URL, topupAmount: 32 });
  assert.throws(() => parseArgs(['--topup']), /positive integer/);
});

test('loadStore returns the store when the mint matches (trailing slash aside)', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'wallet.json');
  writeFileSync(file, JSON.stringify({ mint: 'https://MINT.example/', unit: 'sat', proofs: [fakeProof(8)] }));

  const store = loadStore(file, MINT);
  assert.equal(store.proofs.length, 1);
  assert.equal(total(store.proofs), 8);
});

test("loadStore moves another mint's wallet aside instead of overwriting it", (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'wallet.json');
  writeFileSync(file, JSON.stringify({ mint: OTHER, unit: 'sat', proofs: [fakeProof(8)] }));

  const store = loadStore(file, MINT);
  assert.equal(store.proofs.length, 0);
  assert.equal(existsSync(file), false, 'the old file must be moved before a new one is written');

  const backups = readdirSync(dir);
  assert.equal(backups.length, 1);
  const backupFile = join(dir, backups[0]);
  const backup = JSON.parse(readFileSync(backupFile, 'utf8')) as WalletFile;
  assert.equal(backup.mint, OTHER);
  assert.equal(total(backup.proofs), 8);

  saveStore(file, store);
  assert.equal(total((JSON.parse(readFileSync(backupFile, 'utf8')) as WalletFile).proofs), 8);
});

test('loadStore refuses a corrupt wallet file without touching it', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'wallet.json');
  writeFileSync(file, '{not json');

  assert.throws(() => loadStore(file, MINT), /not valid JSON/);
  assert.equal(readFileSync(file, 'utf8'), '{not json');
});

test('a failed request swaps the payment token back into the wallet', async () => {
  const store = storeWith([fakeProof(8)]);
  const saved: WalletFile[] = [];
  const wallet = fakeWallet({
    send: async () => ({ keep: [fakeProof(3)], send: [fakeProof(5)] }),
    receive: async (token) => {
      assert.ok(token.startsWith('cashu'), 'expected a cashu token');
      return [fakeProof(4)];
    },
  });

  await assert.rejects(
    payForCall(
      'http://server.invalid/paid',
      5,
      wallet,
      store,
      (s) => saved.push({ ...s, proofs: [...s.proofs] }),
      async () => {
        throw new Error('offline');
      },
    ),
    /offline/,
  );

  assert.equal(total(store.proofs), 7, 'keep 3 + reclaimed 4');
  assert.equal(saved.length, 2, 'saved after the send and after the reclaim');
});

test('a pre-redeem rejection restores the send proofs without a swap', async () => {
  const store = storeWith([fakeProof(8)]);
  let receives = 0;
  const wallet = fakeWallet({
    send: async () => ({ keep: [fakeProof(3)], send: [fakeProof(5)] }),
    receive: async () => {
      receives += 1;
      return [];
    },
  });

  const result = await payForCall(
    'http://server/paid',
    5,
    wallet,
    store,
    () => {},
    async () => jsonResponse(402, { error: 'insufficient' }),
  );

  assert.equal(result.status, 402);
  assert.equal(result.reclaimed, true);
  assert.equal(receives, 0, 'unspent proofs must not pay a swap fee');
  assert.equal(total(store.proofs), 8);
});

test('change is banked and the wallet stays consistent', async () => {
  const store = storeWith([fakeProof(8)]);
  const wallet = fakeWallet({
    send: async () => ({ keep: [fakeProof(3)], send: [fakeProof(5)] }),
    receive: async (token) => {
      assert.equal(token, 'change-token');
      return [fakeProof(2)];
    },
  });

  const result = await payForCall(
    'http://server/paid',
    5,
    wallet,
    store,
    () => {},
    async () => jsonResponse(200, { ok: true }, { 'x-cashu-change': 'change-token' }),
  );

  assert.equal(result.status, 200);
  assert.equal(result.change, 2);
  assert.equal(total(store.proofs), 5);
});

test('a change token that cannot be banked is printed, not silently lost', async (t) => {
  const errors: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => {
    errors.push(args.map((a) => String(a)).join(' '));
  });
  const store = storeWith([fakeProof(8)]);
  const wallet = fakeWallet({
    send: async () => ({ keep: [fakeProof(3)], send: [fakeProof(5)] }),
    receive: async () => {
      throw new Error('mint down');
    },
  });

  const result = await payForCall(
    'http://server/paid',
    5,
    wallet,
    store,
    () => {},
    async () => jsonResponse(200, { ok: true }, { 'x-cashu-change': 'change-token' }),
  );

  assert.equal(result.status, 200);
  assert.equal(result.change, 0);
  assert.ok(errors.some((line) => line.includes('change-token')));
});

test('a fee shortfall triggers one top-up and a retry', async () => {
  const store = storeWith([fakeProof(5)]);
  let attempts = 0;
  let toppedUp = 0;
  const wallet = fakeWallet({
    send: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('Not enough funds available to send');
      return { keep: [fakeProof(32)], send: [fakeProof(6)] };
    },
  });

  const result = await payForCall(
    'http://server/paid',
    5,
    wallet,
    store,
    () => {},
    async () => jsonResponse(200, { ok: true }),
    async () => {
      toppedUp += 1;
      store.proofs.push(fakeProof(32));
    },
  );

  assert.equal(result.status, 200);
  assert.equal(attempts, 2);
  assert.equal(toppedUp, 1);
});
