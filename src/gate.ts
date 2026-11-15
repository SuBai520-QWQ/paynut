/**
 * paynut core gate: verify a Cashu ecash token as payment for one API call.
 *
 * Framework-agnostic. The default redeemer/change-issuer talk to a real mint
 * via @cashu/cashu-ts; both are injectable so the money math can be unit
 * tested without a mint.
 */
import { createHash } from 'node:crypto';
import { Wallet, getEncodedToken, getTokenMetadata } from '@cashu/cashu-ts';
import type { Proof } from '@cashu/cashu-ts';
import type { ProofStore } from './store.js';

/**
 * Thrown by a redeemer when the failure happened BEFORE the swap request was
 * sent to the mint (mint info / keyset loading, local token decoding). Such a
 * failure proves the presented proofs were never burned, so the gate may
 * safely retry the same token later: it cancels the pending journal marker
 * (appending `redeem_aborted`) and does NOT cache the result.
 *
 * Any other redeemer throw is treated as an UNKNOWN outcome: the swap may or
 * may not have been accepted, so the marker stays and a later verify of the
 * same token refuses to retry rather than risk a second charge.
 */
export class PreSubmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreSubmissionError';
  }
}

export interface PaymentInfo {
  /**
   * Amount the gate kept. Usually `price`; it can differ when the mint's swap
   * fees are paid out of it, or when change could not be split and the gate
   * had to keep the full received amount.
   */
  amount: number;
  mint: string;
  unit: string;
  /** Proofs the gate now owns for the kept amount. */
  proofs: Proof[];
}

export type VerifyResult =
  | {
      ok: true;
      paid: PaymentInfo;
      changeToken?: string;
      /** Total value the mint returned for this token (kept + change). */
      received?: number;
    }
  | {
      ok: false;
      reason:
        | 'malformed_token'
        | 'untrusted_mint'
        | 'wrong_unit'
        | 'insufficient'
        | 'insufficient_after_fees'
        | 'redeem_failed'
        | 'already_redeemed';
      detail?: string;
      received?: number;
      /**
       * `insufficient_after_fees`: a refund of the value the gate received.
       * `already_redeemed`: the ORIGINAL change token from the first
       * redemption, so a payer whose success response was lost can still
       * recover their money — but not a second serving.
       */
      changeToken?: string;
    };

export interface GateOptions {
  /** Price of one call, in `unit`. */
  price: number;
  /** Cashu unit. Default 'sat'. */
  unit?: string;
  /** Mint URLs whose tokens are accepted. */
  mints: string[];
  /** Called once per successful payment with the kept proofs. */
  onPayment?: (info: PaymentInfo) => void;
  /**
   * Durable proof journal (C1). When set, every redemption is written here
   * BEFORE onPayment runs, and a token that was already redeemed is answered
   * from the journal instead of being redeemed a second time.
   *
   * When NOT set, the gate is memory-only: a crash between the mint's
   * `receive()` and whatever the app does with `paid.proofs` loses the
   * redeemed value permanently. Configure a store for anything that is not a
   * throwaway demo.
   */
  proofStore?: ProofStore;
  /** Test seam: redeem a token string at a mint, returning fresh proofs. */
  redeemer?: (mintUrl: string, token: string) => Promise<Proof[]>;
  /** Test seam: split `amount` out of `proofs`, returning { keep, send }. */
  splitter?: (mintUrl: string, amount: number, proofs: Proof[]) => Promise<{ keep: Proof[]; send: Proof[] }>;
}

const walletPromises = new Map<string, Promise<Wallet>>();

/** `err.message` for anything throwable. */
function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Lazily create + loadMint() one wallet per (mint, unit); cashu-ts v3 requires loadMint before use. */
function walletFor(mintUrl: string, unit: string): Promise<Wallet> {
  const key = `${mintUrl}|${unit}`;
  let p = walletPromises.get(key);
  if (!p) {
    p = (async () => {
      const w = new Wallet(mintUrl, { unit });
      await w.loadMint();
      return w;
    })();
    walletPromises.set(key, p);
    // A transient loadMint failure (mint restarting, network blip) must not
    // poison this (mint, unit) forever: drop the rejected promise so the next
    // payment retries instead of failing instantly for the process lifetime.
    p.catch(() => {
      if (walletPromises.get(key) === p) walletPromises.delete(key);
    });
  }
  return p;
}

/**
 * Canonical form of a mint URL for trust checks and wallet caching. URL
 * parsing lowercases the scheme/host, drops default ports and resolves
 * dot-segments; trailing slashes are stripped. Anything unparseable falls
 * back to trailing-slash stripping.
 */
export function normalizeMintUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch {
    return url.replace(/\/+$/, '');
  }
}

export function sumProofs(proofs: Pick<Proof, 'amount'>[]): number {
  return proofs.reduce((acc, p) => acc + Number(p.amount), 0);
}

/** sha256 of the presented token string: the idempotency key. */
function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * What the journal (or this process) knows about one token hash. Built once
 * from `proofStore.readAll()` and then maintained in memory as we append.
 */
interface StoreIndexEntry {
  started: boolean;
  redeemed?: { mint: string; proofs: Proof[]; changeProofs: Proof[] };
  refunded?: { mint: string; proofs: Proof[]; received: number; changeToken?: string };
  failed?: string;
}

/** Upper bound on the in-memory idempotency cache; oldest entries evict first. */
const MAX_CACHED_RESULTS = 10_000;

export class CashuGate {
  readonly price: number;
  readonly unit: string;
  readonly mints: string[];
  private readonly onPayment?: (info: PaymentInfo) => void;
  private readonly proofStore?: ProofStore;
  private readonly redeemer: NonNullable<GateOptions['redeemer']>;
  private readonly splitter: NonNullable<GateOptions['splitter']>;

  /** tokenHash -> the answer this process already gave for that token. */
  private readonly resultCache = new Map<string, VerifyResult>();
  /** tokenHash -> what the journal says about it. */
  private readonly storeIndex = new Map<string, StoreIndexEntry>();
  private storeIndexReady = false;

  constructor(opts: GateOptions) {
    if (!Number.isInteger(opts.price) || opts.price <= 0) {
      throw new Error('price must be a positive integer');
    }
    if (!opts.mints?.length) throw new Error('at least one mint is required');
    this.price = opts.price;
    this.unit = opts.unit ?? 'sat';
    this.mints = opts.mints.map(normalizeMintUrl);
    this.onPayment = opts.onPayment;
    this.proofStore = opts.proofStore;
    this.redeemer =
      opts.redeemer ??
      (async (mintUrl, token) => {
        const attempt = async (): Promise<Proof[]> => {
          let wallet: Wallet;
          try {
            wallet = await walletFor(mintUrl, this.unit);
          } catch (err) {
            // Mint info / keyset loading phase: nothing has been sent to the
            // mint, so the presented proofs are provably untouched.
            throw new PreSubmissionError(
              `mint ${mintUrl} could not be loaded: ${message(err)}`,
            );
          }
          const decoded = (() => {
            try {
              return wallet.decodeToken(token);
            } catch (err) {
              // Local decode against the cached keyset table: still nothing
              // sent. A stale keyset table is the usual cause and the next
              // verify reloads it, so this is safe to call pre-submission.
              throw new PreSubmissionError(
                `token could not be decoded against ${mintUrl}: ${message(err)}`,
              );
            }
          })();
          decoded.mint = mintUrl;
          return wallet.receive(decoded);
        };

        try {
          return await attempt();
        } catch (err) {
          // Pre-submission failures are final for this attempt: nothing was
          // sent, the wallet promise is already evicted, and the next verify
          // starts from a fresh loadMint. No keyset retry needed.
          if (err instanceof PreSubmissionError) throw err;
          // A mint that rotates its keysets leaves the cached wallet holding
          // a stale keyset table, and every redemption then fails with a
          // keyset error until the process restarts. Reload the mint info
          // once and retry; if it still fails, evict the cached wallet so the
          // next payment loads it fresh.
          if (!/keyset/i.test(message(err))) throw err;
          let wallet: Wallet;
          try {
            wallet = await walletFor(mintUrl, this.unit);
          } catch (reloadErr) {
            throw new PreSubmissionError(
              `mint ${mintUrl} could not be reloaded: ${message(reloadErr)}`,
            );
          }
          await wallet.loadMint().catch(() => undefined);
          try {
            return await attempt();
          } catch (retryErr) {
            walletPromises.delete(`${mintUrl}|${this.unit}`);
            throw retryErr;
          }
        }
      });
    this.splitter =
      opts.splitter ??
      (async (mintUrl, amount, proofs) => {
        const { send, keep } = await (await walletFor(mintUrl, this.unit)).send(amount, proofs);
        return { keep, send };
      });
  }

  /** The 402 quote a client needs in order to pay. */
  quote() {
    return {
      price: this.price,
      unit: this.unit,
      mints: this.mints,
      header: 'X-Cashu',
      changeHeader: 'X-Cashu-Change',
    };
  }

  /**
   * Verify (and redeem) a Cashu token string as payment for one call.
   *
   * Flow: idempotency lookup -> decode -> trust checks -> pre-check the amount
   * *without* redeeming (an underpaying token is rejected untouched) -> write
   * the intent to the journal -> redeem at the mint (this is what burns the
   * presented proofs, so a token can never be spent twice) -> split off the
   * change, assert the gate actually kept `price` -> write the redeemed proofs
   * to the journal -> onPayment -> cache the answer.
   *
   * One token buys exactly one call: a replay of a token this gate already
   * redeemed answers `already_redeemed` (HTTP 402) carrying the original
   * change token, so a payer whose success response was lost recovers their
   * money without being served twice.
   *
   * A PreSubmissionError from the redeemer aborts the marker and is NOT
   * cached, so the same token can be retried once the mint is reachable.
   */
  async verifyPayment(tokenString: string): Promise<VerifyResult> {
    const tokenHash = sha256Hex(tokenString);

    // A token this process already answered for never reaches the mint again.
    const cached = this.resultCache.get(tokenHash);
    if (cached) {
      return cached.ok
        ? this.alreadyRedeemed(cached.changeToken, cached.received ?? cached.paid.amount)
        : cached;
    }

    // Recover what a previous process wrote before it died.
    this.ensureStoreIndex();
    const known = this.storeIndex.get(tokenHash);
    if (known) {
      if (known.redeemed) {
        return this.alreadyRedeemedFromRecord(known.redeemed);
      }
      if (known.refunded) {
        const refunded = this.refundFromRecord(tokenHash, known.refunded);
        if (refunded) return refunded;
      }
      if (known.failed) {
        return this.reject(tokenHash, {
          ok: false,
          reason: 'redeem_failed',
          detail: known.failed,
        });
      }
      // Started, never completed and never aborted: the mint may or may not
      // have burned the presented proofs. Redeeming again could charge the
      // payer twice, so the only safe answer is to refuse.
      return this.reject(tokenHash, {
        ok: false,
        reason: 'redeem_failed',
        detail: 'previous redemption outcome unknown — not retried',
      });
    }

    // getTokenMetadata parses mint/unit/total without needing the mint's
    // keyset table (full getDecodedToken throws on v4 tokens with short
    // keyset ids unless keysets are supplied). Redemption below does the
    // cryptographic verification against the mint itself.
    let meta;
    try {
      meta = getTokenMetadata(tokenString);
    } catch {
      return this.reject(tokenHash, { ok: false, reason: 'malformed_token' });
    }
    // getTokenMetadata does not validate the decoded shape: a v3 token whose
    // `mint` is missing or not a string parses fine, and would otherwise
    // crash on the URL handling below (500 instead of 400).
    if (typeof meta.mint !== 'string' || meta.mint.length === 0) {
      return this.reject(tokenHash, { ok: false, reason: 'malformed_token' });
    }
    const mint = normalizeMintUrl(meta.mint);
    if (!this.mints.includes(mint)) {
      return this.reject(tokenHash, { ok: false, reason: 'untrusted_mint', detail: mint });
    }
    if (meta.unit && meta.unit !== this.unit) {
      return this.reject(tokenHash, { ok: false, reason: 'wrong_unit', detail: meta.unit });
    }
    const presented = meta.amount;
    if (!Number.isFinite(presented) || presented < 0) {
      return this.reject(tokenHash, { ok: false, reason: 'malformed_token' });
    }
    if (presented < this.price) {
      return this.reject(tokenHash, {
        ok: false,
        reason: 'insufficient',
        received: presented,
      });
    }

    // Write the intent down BEFORE the mint is touched. If this process dies
    // mid-redemption the next run sees the marker and refuses to retry
    // instead of risking a second charge.
    this.markStarted(tokenHash);

    let receivedProofs: Proof[];
    try {
      receivedProofs = await this.redeemer(mint, tokenString);
    } catch (err) {
      if (err instanceof PreSubmissionError) {
        // Nothing reached the mint, so the presented proofs are provably
        // untouched. Cancel the marker and do NOT cache: a later verify of
        // the same token must retry cleanly.
        this.markAborted(tokenHash);
        return { ok: false, reason: 'redeem_failed', detail: err.message };
      }
      const detail = message(err);
      this.markFailed(tokenHash, detail);
      return this.reject(tokenHash, { ok: false, reason: 'redeem_failed', detail });
    }
    const receivedTotal = sumProofs(receivedProofs);
    if (receivedTotal < this.price) {
      // The mint's swap/input fees ate into the payment. The presented proofs
      // are already burned, so the received value must go back to the payer
      // instead of being silently kept by the gate.
      return this.refundAll(tokenHash, mint, receivedProofs, receivedTotal);
    }

    const change = receivedTotal - this.price;
    let keptProofs = receivedProofs;
    // The split's send side, kept so an H1 refund can hand back every proof
    // the gate actually holds rather than re-encoding burned inputs.
    let changeProofs: Proof[] = [];
    let changeToken: string | undefined;
    if (change > 0) {
      let split: { keep: Proof[]; send: Proof[] } | undefined;
      try {
        split = await this.splitter(mint, change, receivedProofs);
      } catch (err) {
        // Redemption already happened, so the gate owns receivedProofs. Serving
        // the call and keeping the full amount is the least-bad outcome: a 500
        // would charge the payer and return neither the call nor the change.
        console.error(
          `paynut: change split failed for ${mint}; keeping the full ${receivedTotal} ${this.unit} received`,
          err,
        );
      }
      if (split) {
        const encoded = this.encodeChange(mint, split.send);
        if (encoded) {
          keptProofs = split.keep;
          changeProofs = split.send;
          changeToken = encoded;
        } else {
          // Encoding the change failed: the split's send proofs exist only in
          // this variable, so handing them back is impossible and dropping
          // them would burn the payer's change. Keep the full received amount
          // in the gate's own balance instead, and let paid.amount report it
          // honestly.
          console.error(
            `paynut: change encoding failed for ${mint}; keeping the full ${receivedTotal} ${this.unit} received`,
          );
          keptProofs = receivedProofs;
        }
      }
    }

    // H1: the split can hand back less than the price (the mint's swap fee
    // comes out of the kept side, and the splitter is only asked for
    // `receivedTotal - price`). Serving the call for less than the price is
    // not an option, and neither is keeping the difference: refund every
    // proof the gate now holds and report it exactly like the fee shortfall
    // above.
    const keptTotal = sumProofs(keptProofs);
    if (keptTotal < this.price) {
      const allProofs = changeProofs.length > 0 ? [...keptProofs, ...changeProofs] : keptProofs;
      return this.refundAll(tokenHash, mint, allProofs, receivedTotal);
    }

    const paid: PaymentInfo = {
      amount: keptTotal,
      mint,
      unit: this.unit,
      proofs: keptProofs,
    };

    // C1: the proofs exist only in this process until they are written down.
    // The journal entry lands before onPayment so a crash in the callback (or
    // in the handler right after) cannot lose the money.
    this.recordRedeemed(tokenHash, mint, keptProofs, changeProofs);

    try {
      this.onPayment?.(paid);
    } catch (err) {
      // The payment is already settled; a throwing callback must not turn it
      // into a 500 where the payer loses the call and the change.
      console.error('paynut: onPayment threw after the payment was settled', err);
    }

    const result: VerifyResult = { ok: true, paid, changeToken, received: receivedTotal };
    this.cacheResult(tokenHash, result);
    return result;
  }

  /**
   * Encode a settled payment's kept proofs as a token that hands the full
   * kept value back to the payer. Adapters use this to compensate the payer
   * when the paid handler fails after the payment already settled: the proofs
   * are bearer instruments, so encoding them IS the refund.
   * Returns undefined when the proofs cannot be encoded.
   */
  refundTokenFor(info: PaymentInfo): string | undefined {
    return this.encodeChange(info.mint, info.proofs);
  }

  // ---- idempotency (one token, one call) ----

  /**
   * The replay answer: this gate already redeemed the token. It carries the
   * original change token so the payer can still recover their money, and it
   * is a failure so no second serving happens.
   */
  private alreadyRedeemed(changeToken: string | undefined, received: number): VerifyResult {
    return { ok: false, reason: 'already_redeemed', received, changeToken };
  }

  /** Same answer, rebuilt from a journal record written by an earlier run. */
  private alreadyRedeemedFromRecord(record: {
    mint: string;
    proofs: Proof[];
    changeProofs: Proof[];
  }): VerifyResult {
    const changeToken =
      record.changeProofs.length > 0
        ? this.encodeChange(record.mint, record.changeProofs)
        : undefined;
    return this.alreadyRedeemed(
      changeToken,
      sumProofs(record.proofs) + sumProofs(record.changeProofs),
    );
  }

  private cacheResult(tokenHash: string, result: VerifyResult): void {
    if (this.resultCache.size >= MAX_CACHED_RESULTS) {
      const oldest = this.resultCache.keys().next();
      if (!oldest.done) this.resultCache.delete(oldest.value);
    }
    this.resultCache.set(tokenHash, result);
  }

  /** Cache a definitive pre-redeem rejection and hand it back. */
  private reject(tokenHash: string, result: VerifyResult): VerifyResult {
    this.cacheResult(tokenHash, result);
    return result;
  }

  // ---- proof journal (C1) ----

  private appendEntry(entry: unknown): void {
    if (!this.proofStore) return;
    try {
      this.proofStore.append(entry);
    } catch (err) {
      // The journal is the only durable record of a settled payment. If it
      // cannot be written, print the record so an operator can recover the
      // proofs by hand instead of letting them evaporate.
      console.error('paynut: could not write to the proof store; record follows', entry, err);
    }
  }

  private markStarted(tokenHash: string): void {
    const current = this.storeIndex.get(tokenHash) ?? { started: false };
    current.started = true;
    this.storeIndex.set(tokenHash, current);
    this.appendEntry({ type: 'redeem_started', at: new Date().toISOString(), tokenHash });
  }

  /**
   * Cancel a pending marker after a pre-submission failure: started + aborted
   * == clean. The in-memory entry is dropped so this process retries at once,
   * and the abort is journaled so a restarted process sees the same thing.
   */
  private markAborted(tokenHash: string): void {
    this.storeIndex.delete(tokenHash);
    this.appendEntry({ type: 'redeem_aborted', at: new Date().toISOString(), tokenHash });
  }

  private markFailed(tokenHash: string, detail: string): void {
    const current = this.storeIndex.get(tokenHash) ?? { started: true };
    current.started = true;
    current.failed = detail;
    this.storeIndex.set(tokenHash, current);
    this.appendEntry({ type: 'redeem_failed', at: new Date().toISOString(), tokenHash, detail });
  }

  private markRefunded(
    tokenHash: string,
    mint: string,
    proofs: Proof[],
    received: number,
    changeToken: string | undefined,
  ): void {
    const current = this.storeIndex.get(tokenHash) ?? { started: true };
    current.started = true;
    current.refunded = { mint, proofs, received, changeToken };
    this.storeIndex.set(tokenHash, current);
    this.appendEntry({
      type: 'redeem_refunded',
      at: new Date().toISOString(),
      mint,
      tokenHash,
      proofs,
      received,
      changeToken,
    });
  }

  private recordRedeemed(
    tokenHash: string,
    mint: string,
    proofs: Proof[],
    changeProofs: Proof[],
  ): void {
    const current = this.storeIndex.get(tokenHash) ?? { started: true };
    current.started = true;
    current.redeemed = { mint, proofs, changeProofs };
    this.storeIndex.set(tokenHash, current);
    this.appendEntry({
      type: 'redeemed',
      at: new Date().toISOString(),
      mint,
      tokenHash,
      proofs,
      changeProofs,
    });
  }

  /** Read the journal once, then keep the index current as we append. */
  private ensureStoreIndex(): void {
    if (this.storeIndexReady) return;
    this.storeIndexReady = true;
    const store = this.proofStore;
    if (!store) return;
    const readAll = store.readAll;
    if (typeof readAll !== 'function') return;

    let entries: unknown[];
    try {
      entries = readAll.call(store);
    } catch (err) {
      console.error('paynut: could not read the proof store; continuing without it', err);
      return;
    }

    for (const raw of entries) {
      if (!raw || typeof raw !== 'object') continue;
      const entry = raw as {
        type?: unknown;
        tokenHash?: unknown;
        mint?: unknown;
        proofs?: unknown;
        changeProofs?: unknown;
        received?: unknown;
        changeToken?: unknown;
        detail?: unknown;
      };
      const tokenHash = typeof entry.tokenHash === 'string' ? entry.tokenHash : undefined;
      if (!tokenHash) continue;
      const current = this.storeIndex.get(tokenHash) ?? { started: false };

      if (entry.type === 'redeem_started') {
        current.started = true;
      } else if (entry.type === 'redeem_aborted') {
        // started + aborted == clean: the redemption never reached the mint,
        // so this token is retryable again.
        this.storeIndex.delete(tokenHash);
        continue;
      } else if (entry.type === 'redeemed') {
        current.started = true;
        if (typeof entry.mint === 'string' && Array.isArray(entry.proofs)) {
          current.redeemed = {
            mint: entry.mint,
            proofs: entry.proofs as Proof[],
            changeProofs: Array.isArray(entry.changeProofs)
              ? (entry.changeProofs as Proof[])
              : [],
          };
        }
      } else if (entry.type === 'redeem_refunded') {
        current.started = true;
        if (typeof entry.mint === 'string' && Array.isArray(entry.proofs)) {
          current.refunded = {
            mint: entry.mint,
            proofs: entry.proofs as Proof[],
            received: Number.isFinite(Number(entry.received)) ? Number(entry.received) : 0,
            changeToken:
              typeof entry.changeToken === 'string' ? entry.changeToken : undefined,
          };
        }
      } else if (entry.type === 'redeem_failed') {
        current.started = true;
        current.failed =
          typeof entry.detail === 'string' ? entry.detail : 'previous redemption failed — not retried';
      } else {
        continue;
      }
      this.storeIndex.set(tokenHash, current);
    }
  }

  /** Rebuild a refund answer from a journal record written by an earlier run. */
  private refundFromRecord(
    tokenHash: string,
    record: { mint: string; proofs: Proof[]; received: number; changeToken?: string },
  ): VerifyResult | undefined {
    const changeToken =
      record.changeToken ??
      (record.proofs.length > 0 ? this.encodeChange(record.mint, record.proofs) : undefined);
    const result: VerifyResult = {
      ok: false,
      reason: 'insufficient_after_fees',
      received: record.received,
      changeToken,
    };
    this.cacheResult(tokenHash, result);
    return result;
  }

  /**
   * Hand every proof the gate holds back to the payer as one token and report
   * the fee shortfall. Used both when the mint's input fees already ate into
   * the payment and when the change split left the gate short of `price` (H1).
   */
  private refundAll(
    tokenHash: string,
    mint: string,
    proofs: Proof[],
    received: number,
  ): VerifyResult {
    const refund = proofs.length > 0 ? this.encodeChange(mint, proofs) : undefined;
    if (proofs.length > 0 && !refund) {
      // Encoding the refund failed: the value cannot ride back in a header, so
      // leave the proofs in the log for manual recovery instead of letting
      // them evaporate without a trace.
      console.error(
        `paynut: could not encode the insufficient_after_fees refund for ${mint}; proofs kept for manual recovery: ${JSON.stringify(proofs)}`,
      );
    }
    this.markRefunded(tokenHash, mint, proofs, received, refund);
    return this.reject(tokenHash, {
      ok: false,
      reason: 'insufficient_after_fees',
      received,
      changeToken: refund,
    });
  }

  /** Encode proofs as a token, or undefined if they cannot be encoded. */
  private encodeChange(mint: string, proofs: Proof[]): string | undefined {
    try {
      return getEncodedToken({ mint, proofs, unit: this.unit });
    } catch (err) {
      console.error('paynut: could not encode a change token', err);
      return undefined;
    }
  }
}
