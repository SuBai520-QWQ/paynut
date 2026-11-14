/**
 * paynut core gate: verify a Cashu ecash token as payment for one API call.
 *
 * Framework-agnostic. The default redeemer/change-issuer talk to a real mint
 * via @cashu/cashu-ts; both are injectable so the money math can be unit
 * tested without a mint.
 */
import { Wallet, getEncodedToken, getTokenMetadata } from '@cashu/cashu-ts';
import type { Proof } from '@cashu/cashu-ts';

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
  | { ok: true; paid: PaymentInfo; changeToken?: string }
  | {
      ok: false;
      reason:
        | 'malformed_token'
        | 'untrusted_mint'
        | 'wrong_unit'
        | 'insufficient'
        | 'insufficient_after_fees'
        | 'redeem_failed';
      detail?: string;
      received?: number;
      /**
       * Refund for a token that was redeemed but did not net `price` after the
       * mint's swap fee (`insufficient_after_fees`). The received proofs are
       * already burned, so this is the only way to give the value back.
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
  /** Test seam: redeem a token string at a mint, returning fresh proofs. */
  redeemer?: (mintUrl: string, token: string) => Promise<Proof[]>;
  /** Test seam: split `amount` out of `proofs`, returning { keep, send }. */
  splitter?: (mintUrl: string, amount: number, proofs: Proof[]) => Promise<{ keep: Proof[]; send: Proof[] }>;
}

const walletPromises = new Map<string, Promise<Wallet>>();

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

export class CashuGate {
  readonly price: number;
  readonly unit: string;
  readonly mints: string[];
  private readonly onPayment?: (info: PaymentInfo) => void;
  private readonly redeemer: NonNullable<GateOptions['redeemer']>;
  private readonly splitter: NonNullable<GateOptions['splitter']>;

  constructor(opts: GateOptions) {
    if (!Number.isInteger(opts.price) || opts.price <= 0) {
      throw new Error('price must be a positive integer');
    }
    if (!opts.mints?.length) throw new Error('at least one mint is required');
    this.price = opts.price;
    this.unit = opts.unit ?? 'sat';
    this.mints = opts.mints.map(normalizeMintUrl);
    this.onPayment = opts.onPayment;
    this.redeemer =
      opts.redeemer ??
      (async (mintUrl, token) => {
        const attempt = async (): Promise<Proof[]> => {
          const wallet = await walletFor(mintUrl, this.unit);
          // cashu-ts compares the token's mint string with the wallet's, so a
          // token that spells the same mint differently (case, default port)
          // would be rejected after passing the canonical trust check. Decode
          // with the wallet's keysets and redeem against the canonical URL.
          const decoded = wallet.decodeToken(token);
          decoded.mint = mintUrl;
          return wallet.receive(decoded);
        };
        try {
          return await attempt();
        } catch (err) {
          // A mint that rotates its keysets leaves the cached wallet holding
          // a stale keyset table, and every redemption then fails with a
          // keyset error until the process restarts (round-1 known limit).
          // Reload the mint info once and retry; if it still fails, evict
          // the cached wallet so the next payment loads it fresh.
          const message = err instanceof Error ? err.message : String(err);
          if (!/keyset/i.test(message)) throw err;
          const wallet = await walletFor(mintUrl, this.unit);
          await wallet.loadMint().catch(() => undefined);
          try {
            return await attempt();
          } catch {
            walletPromises.delete(`${mintUrl}|${this.unit}`);
            throw err;
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
   * Flow: decode -> trust checks -> pre-check the amount *without* redeeming
   * (an underpaying token is rejected untouched) -> redeem at the mint (this
   * is what burns the presented proofs, so a token can never be spent twice)
   * -> split off the change and hand it back as a fresh token.
   */
  async verifyPayment(tokenString: string): Promise<VerifyResult> {
    // getTokenMetadata parses mint/unit/total without needing the mint's
    // keyset table (full getDecodedToken throws on v4 tokens with short
    // keyset ids unless keysets are supplied). Redemption below does the
    // cryptographic verification against the mint itself.
    let meta;
    try {
      meta = getTokenMetadata(tokenString);
    } catch {
      return { ok: false, reason: 'malformed_token' };
    }
    // getTokenMetadata does not validate the decoded shape: a v3 token whose
    // `mint` is missing or not a string parses fine, and would otherwise
    // crash on the URL handling below (500 instead of 400).
    if (typeof meta.mint !== 'string' || meta.mint.length === 0) {
      return { ok: false, reason: 'malformed_token' };
    }
    const mint = normalizeMintUrl(meta.mint);
    if (!this.mints.includes(mint)) {
      return { ok: false, reason: 'untrusted_mint', detail: mint };
    }
    if (meta.unit && meta.unit !== this.unit) {
      return { ok: false, reason: 'wrong_unit', detail: meta.unit };
    }
    const presented = meta.amount;
    if (!Number.isFinite(presented) || presented < 0) {
      return { ok: false, reason: 'malformed_token' };
    }
    if (presented < this.price) {
      return { ok: false, reason: 'insufficient', received: presented };
    }

    let receivedProofs: Proof[];
    try {
      receivedProofs = await this.redeemer(mint, tokenString);
    } catch (err) {
      return {
        ok: false,
        reason: 'redeem_failed',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    const receivedTotal = sumProofs(receivedProofs);
    if (receivedTotal < this.price) {
      // The mint's swap/input fees ate into the payment. The presented proofs
      // are already burned, so the received value must go back to the payer
      // instead of being silently kept by the gate.
      const refund = receivedTotal > 0 ? this.encodeChange(mint, receivedProofs) : undefined;
      if (receivedTotal > 0 && !refund) {
        // Encoding the refund failed (PN-N3): the value cannot ride back in
        // a header, so leave the proofs in the log for manual recovery
        // instead of letting them evaporate without a trace.
        console.error(
          `paynut: could not encode the insufficient_after_fees refund for ${mint}; received proofs kept for manual recovery: ${JSON.stringify(receivedProofs)}`,
        );
      }
      return {
        ok: false,
        reason: 'insufficient_after_fees',
        received: receivedTotal,
        changeToken: refund,
      };
    }

    const change = receivedTotal - this.price;
    let keptProofs = receivedProofs;
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
          changeToken = encoded;
        } else {
          // Encoding the change failed (PN-N3): the split's send proofs
          // exist only in this variable, so handing them back is impossible
          // and dropping them would burn the payer's change. Keep the full
          // received amount in the gate's own balance instead — the same
          // least-bad outcome as the split-failure path above, and
          // paid.amount reports it honestly.
          console.error(
            `paynut: change encoding failed for ${mint}; keeping the full ${receivedTotal} ${this.unit} received`,
          );
          keptProofs = receivedProofs;
        }
      }
    }

    const paid: PaymentInfo = {
      amount: sumProofs(keptProofs),
      mint,
      unit: this.unit,
      proofs: keptProofs,
    };
    try {
      this.onPayment?.(paid);
    } catch (err) {
      // The payment is already settled; a throwing callback must not turn it
      // into a 500 where the payer loses the call and the change.
      console.error('paynut: onPayment threw after the payment was settled', err);
    }
    return { ok: true, paid, changeToken };
  }

  /**
   * Encode a settled payment's kept proofs as a token that hands the full
   * kept value back to the payer. Adapters use this to compensate the payer
   * when the paid handler fails after the payment already settled (PN-N2):
   * the proofs are bearer instruments, so encoding them IS the refund.
   * Returns undefined when the proofs cannot be encoded.
   */
  refundTokenFor(info: PaymentInfo): string | undefined {
    return this.encodeChange(info.mint, info.proofs);
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
