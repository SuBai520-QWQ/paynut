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
  /** Amount the gate kept (== price, unless fees made the received total land exactly). */
  amount: number;
  mint: string;
  unit: string;
  /** Proofs the gate now owns for the kept amount. */
  proofs: Proof[];
}

export type VerifyResult =
  | { ok: true; paid: PaymentInfo; changeToken?: string }
  | { ok: false; reason: 'malformed_token' | 'untrusted_mint' | 'wrong_unit' | 'insufficient' | 'insufficient_after_fees' | 'redeem_failed'; detail?: string; received?: number };

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
  }
  return p;
}

export function normalizeMintUrl(url: string): string {
  return url.replace(/\/+$/, '');
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
      (async (mintUrl, token) => (await walletFor(mintUrl, this.unit)).receive(token));
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
    const mint = normalizeMintUrl(meta.mint);
    if (!this.mints.includes(mint)) {
      return { ok: false, reason: 'untrusted_mint', detail: mint };
    }
    if (meta.unit && meta.unit !== this.unit) {
      return { ok: false, reason: 'wrong_unit', detail: meta.unit };
    }
    const presented = meta.amount;
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
      // are already burned; be honest about it instead of pretending.
      return { ok: false, reason: 'insufficient_after_fees', received: receivedTotal };
    }

    const change = receivedTotal - this.price;
    let keptProofs = receivedProofs;
    let changeToken: string | undefined;
    if (change > 0) {
      const { keep, send } = await this.splitter(mint, change, receivedProofs);
      keptProofs = keep;
      changeToken = getEncodedToken({ mint, proofs: send, unit: this.unit });
    }

    const paid: PaymentInfo = {
      amount: sumProofs(keptProofs),
      mint,
      unit: this.unit,
      proofs: keptProofs,
    };
    this.onPayment?.(paid);
    return { ok: true, paid, changeToken };
  }
}
