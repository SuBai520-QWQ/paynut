/**
 * Round-2 fix tests (C1, C2, H1, H3, H5, H6).
 *
 * One focused test per defect, using the existing test seams: a fake
 * redeemer/splitter for the gate, a temp dir for the proof journal and the
 * wallet file, and an injectable fetch for the client.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Proof } from '@cashu/cashu-ts';
import { CashuGate, sumProofs } from '../src/gate.js';
import { FileProofStore } from '../src/store.js';
import {
  loadStore,
  loadStoreChecked,
  payForCall,
  topUp,
  type PaymentWallet,
  type WalletFile,
} from '../src/client.js';

const MINT = 'https://testnut.cashu.space';

function proof(amount: number, id = 'p'): Proof {
  return {
    amount,
    id,
    secret: `s-${id}-${amount}`,
    C: `c-${id}-${amount}`,
  } as Proof;
}

/** Minimal v3 Cashu token: enough for getTokenMetadata to parse. */
function makeToken(mint: string, totalAmount: number, unit = 'sat'): string {
  const proofs = [proof(totalAmount, 'tok')];
  const payload = { token: [{ mint, proofs }], unit };
  return 'cashuA' + Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'paynut-fix2-'));
}

// ---- C1: redeemed proofs are journaled before onPayment fires ----

test('C1: proof store receives the redeemed proofs before onPayment runs', async () => {
  const dir = tmp();
  try {
    const storeFile = join(dir, 'proofs.jsonl');
    const store = new FileProofStore(storeFile);
    const redeemed = [proof(5, 'a'), proof(5, 'b')];
    let observedAtCallback: string | undefined;

    const gate = new CashuGate({
      price: 5,
      mints: [MINT],
      proofStore: store,
      redeemer: async () => redeemed,
      onPayment: () => {
        // The journal must already contain the 'redeemed' entry at this point.
        observedAtCallback = readFileSync(storeFile, 'utf8');
      },
    });

    const result = await gate.verifyPayment(makeToken(MINT, 10));
    assert.equal(result.ok, true);

    assert.ok(observedAtCallback, 'onPayment must have fired');
    assert.match(observedAtCallback!, /"type":"redeemed"/);
    assert.match(observedAtCallback!, /"tokenHash":/);
    assert.match(observedAtCallback!, /"proofs":/);

    // And the file on disk still has it after the call returned.
    const all = store.readAll() as Array<{ type: string }>;
    assert.ok(all.some((e) => e.type === 'redeemed'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- C2: one token buys exactly one call ----

test('C2: replaying a redeemed token returns already_redeemed with the original change', async () => {
  const dir = tmp();
  try {
    const store = new FileProofStore(join(dir, 'proofs.jsonl'));
    let redeems = 0;
    let payments = 0;
    const gate = new CashuGate({
      price: 5,
      mints: [MINT],
      proofStore: store,
      redeemer: async () => {
        redeems += 1;
        return [proof(8)];
      },
      splitter: async () => ({ keep: [proof(5)], send: [proof(3)] }),
      onPayment: () => {
        payments += 1;
      },
    });

    const token = makeToken(MINT, 8);
    const first = await gate.verifyPayment(token);
    assert.equal(first.ok, true);
    assert.ok(first.changeToken, 'the first redemption must return change');

    // Same token again: no second serving, but the change is still reachable.
    const second = await gate.verifyPayment(token);
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.equal(second.reason, 'already_redeemed');
      assert.equal(second.changeToken, first.changeToken);
      assert.equal(second.received, 8);
    }
    assert.equal(redeems, 1, 'redeemer must not run twice for the same token');
    assert.equal(payments, 1, 'onPayment must not fire twice for the same token');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('C2: a token with a crash marker is not re-redeemed', async () => {
  const dir = tmp();
  try {
    const storeFile = join(dir, 'proofs.jsonl');
    const store = new FileProofStore(storeFile);
    const token = makeToken(MINT, 5);
    const tokenHash = createHash('sha256').update(token).digest('hex');
    store.append({ type: 'redeem_started', at: new Date().toISOString(), tokenHash });

    let redeems = 0;
    const gate = new CashuGate({
      price: 5,
      mints: [MINT],
      proofStore: store,
      redeemer: async () => {
        redeems += 1;
        return [proof(5)];
      },
    });

    const result = await gate.verifyPayment(token);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'redeem_failed');
      assert.match(result.detail ?? '', /previous redemption outcome unknown/);
    }
    assert.equal(redeems, 0, 'a crash-marked token must never reach the mint again');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- H1: kept < price refunds everything ----

test('H1: a split that leaves the gate short of price refunds every proof', async () => {
  const dir = tmp();
  try {
    const store = new FileProofStore(join(dir, 'proofs.jsonl'));
    const gate = new CashuGate({
      price: 5,
      mints: [MINT],
      proofStore: store,
      redeemer: async () => [proof(10)],
      // The splitter hands back only 3 on the kept side (mint fee ate the rest).
      splitter: async () => ({ keep: [proof(3)], send: [proof(7)] }),
    });

    const result = await gate.verifyPayment(makeToken(MINT, 10));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'insufficient_after_fees');
      assert.ok(result.changeToken, 'the payer must get a refund token');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- H3: only malformed_token counts as untouched ----

test('H3: a malformed_token 400 re-banks the proofs, any other 400 does not', async () => {
  const sentProofs = [proof(5, 'sent')];
  const noopSave = () => {};

  // Case A: malformed_token -> untouched -> proofs go straight back.
  const storeA: WalletFile = { mint: MINT, unit: 'sat', proofs: [] };
  const walletA: PaymentWallet = {
    send: async () => ({ keep: [], send: sentProofs }),
    receive: async () => {
      throw new Error('receive must not be called for malformed_token');
    },
  };
  const fetchA = (async () =>
    new Response(JSON.stringify({ error: 'malformed_token' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;

  const resultA = await payForCall('http://x/paid', 5, walletA, storeA, noopSave, fetchA);
  assert.equal(resultA.reclaimed, true);
  assert.equal(sumProofs(storeA.proofs), 5);

  // Case B: a different 400 -> treat as spent, do not re-bank.
  const storeB: WalletFile = { mint: MINT, unit: 'sat', proofs: [] };
  const walletB: PaymentWallet = {
    send: async () => ({ keep: [], send: sentProofs }),
    receive: async () => {
      throw new Error('proofs are spent');
    },
  };
  const fetchB = (async () =>
    new Response(JSON.stringify({ error: 'handler_rejected' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;

  const resultB = await payForCall('http://x/paid', 5, walletB, storeB, noopSave, fetchB);
  assert.equal(resultB.reclaimed, false);
  assert.equal(sumProofs(storeB.proofs), 0, 'spent proofs must not be re-banked');
});

// ---- H5: quote file survives a failed save ----

test('H5: quote file is kept when saving proofs throws, removed after success', async () => {
  const dir = tmp();
  try {
    const quoteFile = join(dir, 'wallet.quote.json');
    const store: WalletFile = { mint: MINT, unit: 'sat', proofs: [] };

    const wallet = {
      createMintQuoteBolt11: async (amount: number) => ({
        quote: 'q-1',
        request: 'lnbc1...',
        amount,
      }),
      checkMintQuoteBolt11: async () => ({ state: 'PAID' }),
      mintProofs: async () => [proof(32, 'minted')],
    } as unknown as Parameters<typeof topUp>[0];

    // First run: save throws -> quote file must still exist.
    let saveCalls = 0;
    const failingSave = () => {
      saveCalls += 1;
      throw new Error('disk full');
    };
    await assert.rejects(topUp(wallet, store, 32, failingSave, quoteFile), /disk full/);
    assert.equal(saveCalls, 1);
    assert.ok(existsSync(quoteFile), 'quote file must survive a failed save');

    // Second run: save succeeds -> quote file is removed.
    const okSave = () => {};
    await topUp(wallet, store, 32, okSave, quoteFile);
    assert.equal(existsSync(quoteFile), false, 'quote file must be removed after a successful save');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- H6: restore picks the newest backup, not the richest ----

test('H6: loadStore restores the newer (poorer) backup, not the richer older one', () => {
  const dir = tmp();
  try {
    const walletFile = join(dir, 'client-wallet.json');
    const mintSlug = MINT.replace(/[^a-zA-Z0-9]+/g, '_');
    const older = `${walletFile}.${mintSlug}.bak`;
    const newer = `${walletFile}.${mintSlug}.bak.1`;

    // Older backup: 100 sats (the richer one).
    writeFileSync(
      older,
      JSON.stringify({ mint: MINT, unit: 'sat', proofs: [proof(100, 'old')] }),
    );
    // Newer backup: 40 sats (the poorer one, but the one that is actually current).
    writeFileSync(
      newer,
      JSON.stringify({ mint: MINT, unit: 'sat', proofs: [proof(40, 'new')] }),
    );
    const now = Date.now() / 1000;
    utimesSync(older, now - 3600, now - 3600);
    utimesSync(newer, now - 60, now - 60);

    const restored = loadStore(walletFile, MINT);
    assert.equal(sumProofs(restored.proofs), 40, 'must restore the newer (poorer) backup');
    assert.equal(restored.proofs[0].secret, 's-new-40');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('H6: loadStoreChecked skips backups the mint reports as spent', async () => {
  const dir = tmp();
  try {
    const walletFile = join(dir, 'client-wallet.json');
    const mintSlug = MINT.replace(/[^a-zA-Z0-9]+/g, '_');
    const older = `${walletFile}.${mintSlug}.bak`;
    const newer = `${walletFile}.${mintSlug}.bak.1`;

    writeFileSync(
      older,
      JSON.stringify({ mint: MINT, unit: 'sat', proofs: [proof(100, 'old')] }),
    );
    writeFileSync(
      newer,
      JSON.stringify({ mint: MINT, unit: 'sat', proofs: [proof(40, 'new')] }),
    );
    const now = Date.now() / 1000;
    utimesSync(older, now - 3600, now - 3600);
    utimesSync(newer, now - 60, now - 60);

    // Newest backup is spent; the older one is unspent.
    const restored = await loadStoreChecked(walletFile, MINT, async (proofs) =>
      proofs.every((p) => p.secret !== 's-new-40'),
    );
    assert.equal(sumProofs(restored.proofs), 100, 'must fall back to the unspent backup');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
