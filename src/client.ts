/**
 * paynut demo client: a tiny file-backed Cashu wallet that pays for one call.
 *
 *   npx tsx src/client.ts [url] [--topup 32]
 *
 * Wallet state lives in ./client-wallet.json (proofs are bearer money — even
 * test sats — so the file is gitignored). If the balance cannot cover the
 * price, the client requests a mint quote, waits for it to be paid (the
 * public test mint uses a FakeWallet, so quotes settle on their own; with a
 * real mint you would pay the printed Lightning invoice), mints fresh proofs,
 * then pays and stores the change.
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Wallet, getEncodedToken } from '@cashu/cashu-ts';
import type { Proof } from '@cashu/cashu-ts';
import { sumProofs, normalizeMintUrl } from './gate.js';
import { TEST_MINT } from './server.js';

export interface WalletFile {
  mint: string;
  unit: string;
  proofs: Proof[];
}

const STORE = process.env.PAYNUT_WALLET ?? 'client-wallet.json';
const QUOTE_FILE = `${STORE}.quote.json`;
const MINT = normalizeMintUrl(process.env.PAYNUT_MINT ?? TEST_MINT);
const UNIT = 'sat';
export const DEFAULT_URL = 'http://localhost:8402/paid/fortune';

export interface CliOptions {
  url: string;
  topupAmount: number;
}

/** Parse `[url] [--topup N]`; the value after --topup is not the URL. */
export function parseArgs(args: string[]): CliOptions {
  let url: string | undefined;
  let topupAmount = 32;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--topup') {
      topupAmount = Number(args[i + 1]);
      i += 1;
      continue;
    }
    if (!args[i].startsWith('--') && url === undefined) url = args[i];
  }
  if (!Number.isInteger(topupAmount) || topupAmount <= 0) {
    throw new Error('--topup needs a positive integer');
  }
  return { url: url ?? DEFAULT_URL, topupAmount };
}

function backupPath(file: string, mint: string): string {
  return `${file}.${mint.replace(/[^a-zA-Z0-9]+/g, '_')}.bak`;
}

/**
 * First free backup path for a mint. Backups are bearer money: a later
 * backup must NEVER overwrite an earlier one (PN-N1 — the deterministic
 * path used to let the second switch destroy the first switch's wallet).
 */
function uniqueBackupPath(file: string, mint: string): string {
  const base = backupPath(file, mint);
  if (!existsSync(base)) return base;
  for (let n = 1; ; n += 1) {
    const candidate = `${base}.${n}`;
    if (!existsSync(candidate)) return candidate;
  }
}

/** All parseable backups of `file` that belong to `mint`, richest first. */
function backupsFor(file: string, mint: string): { path: string; data: WalletFile }[] {
  const dir = dirname(file) || '.';
  const prefix = `${basename(file)}.`;
  const found: { path: string; data: WalletFile }[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return found;
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.includes('.bak')) continue;
    try {
      const data = JSON.parse(readFileSync(join(dir, name), 'utf8')) as WalletFile;
      if (
        typeof data?.mint === 'string' &&
        Array.isArray(data.proofs) &&
        normalizeMintUrl(data.mint) === normalizeMintUrl(mint)
      ) {
        found.push({ path: join(dir, name), data });
      }
    } catch {
      // Not a readable wallet backup; leave it alone.
    }
  }
  return found.sort((a, b) => sumProofs(b.data.proofs) - sumProofs(a.data.proofs));
}

/**
 * Load the wallet file. A file belonging to another mint is moved aside
 * rather than reused: the next save would otherwise overwrite (and destroy)
 * proofs that only that other mint can redeem. The move-aside uses a unique
 * backup name, and if a backup for the requested mint is lying around it is
 * restored as the live wallet (PN-N1) instead of starting from zero.
 */
export function loadStore(file: string, mint: string): WalletFile {
  if (existsSync(file)) {
    let data: WalletFile;
    try {
      data = JSON.parse(readFileSync(file, 'utf8')) as WalletFile;
    } catch (err) {
      throw new Error(
        `wallet file ${file} is not valid JSON (${err instanceof Error ? err.message : String(err)}); move it aside to start fresh`,
      );
    }
    if (typeof data?.mint !== 'string' || !Array.isArray(data.proofs)) {
      throw new Error(`wallet file ${file} is not a paynut wallet; move it aside to start fresh`);
    }
    // PN-N4: reject files whose unit or proof shapes do not match what this
    // client writes, instead of failing obscurely on the payment path.
    if (typeof data.unit === 'string' && data.unit !== UNIT) {
      throw new Error(
        `wallet file ${file} is for unit ${data.unit}, not ${UNIT}; move it aside to start fresh`,
      );
    }
    if (
      data.proofs.some(
        (p) => !p || typeof p !== 'object' || !Number.isFinite(Number((p as Proof).amount)),
      )
    ) {
      throw new Error(`wallet file ${file} holds malformed proofs; move it aside to start fresh`);
    }
    if (normalizeMintUrl(data.mint) === normalizeMintUrl(mint)) return data;
    const backup = uniqueBackupPath(file, data.mint);
    renameSync(file, backup);
    console.error(`wallet file is for mint ${data.mint}, not ${mint}; moved to ${backup}`);
  }
  const [restore] = backupsFor(file, mint);
  if (restore) {
    renameSync(restore.path, file);
    console.error(`restored the wallet for mint ${mint} from backup ${restore.path}`);
    return restore.data;
  }
  return { mint: normalizeMintUrl(mint), unit: UNIT, proofs: [] };
}

export function saveStore(file: string, store: WalletFile) {
  // Write-then-rename: a crash mid-write must not leave a truncated wallet
  // behind (round-1 known limit). renameSync is atomic on the same volume.
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

interface PendingQuote {
  quote: string;
  request: string;
  amount: number;
}

function readPendingQuote(quoteFile: string, amount: number): PendingQuote | undefined {
  try {
    const data = JSON.parse(readFileSync(quoteFile, 'utf8')) as PendingQuote;
    if (typeof data?.quote === 'string' && data.amount === amount) return data;
  } catch {
    // No (readable) pending quote: a fresh one is created below.
  }
  return undefined;
}

/**
 * Fund the wallet by `amount`. The mint quote is persisted BEFORE waiting
 * for payment (round-1 known limit): if the process dies after the invoice
 * was paid but before minting, the next run resumes the same quote instead
 * of paying for a second one. The persisted quote is cleared once minted.
 */
export async function topUp(
  wallet: Wallet,
  store: WalletFile,
  amount: number,
  save: (s: WalletFile) => void,
  quoteFile: string = QUOTE_FILE,
) {
  let quote = readPendingQuote(quoteFile, amount);
  if (quote) {
    console.log(`resuming mint quote ${quote.quote} from the previous run:`);
    console.log(quote.request);
  } else {
    const created = await wallet.createMintQuoteBolt11(amount);
    quote = { quote: created.quote, request: created.request, amount };
    writeFileSync(quoteFile, JSON.stringify(quote), { mode: 0o600 });
    console.log(`mint quote ${quote.quote}: pay this Lightning invoice to fund the wallet:`);
    console.log(quote.request);
  }
  console.log('(test mint uses a FakeWallet — the invoice settles by itself, just wait)');
  const deadline = Date.now() + 120_000;
  for (;;) {
    const status = await wallet.checkMintQuoteBolt11(quote.quote);
    if (String(status.state) === 'PAID') break;
    if (Date.now() > deadline) throw new Error('mint quote not paid within 120s');
    await new Promise((r) => setTimeout(r, 1000));
  }
  const proofs = await wallet.mintProofs(amount, quote.quote);
  rmSync(quoteFile, { force: true });
  store.proofs.push(...proofs);
  save(store);
  console.log(`minted ${amount} ${UNIT}; balance now ${sumProofs(store.proofs)}`);
}

/** The slice of cashu-ts Wallet that paying needs (injectable for tests). */
export interface PaymentWallet {
  send(
    amount: number,
    proofs: Proof[],
    config?: { includeFees?: boolean },
  ): Promise<{ keep: Proof[]; send: Proof[] }>;
  receive(token: string): Promise<Proof[]>;
}

export interface CallResult {
  status: number;
  body: string;
  /** Value banked from the X-Cashu-Change header (0 when there was none). */
  change: number;
  /** Value banked from the X-Cashu-Refund header (0 when there was none). */
  refund: number;
  /** True when the payment token was returned to the wallet after a rejected call. */
  reclaimed: boolean;
}

/**
 * Pay for one call and keep the wallet file consistent on every path.
 *
 * The send proofs leave the store before the request; if the request fails,
 * they are recovered (rejected before redemption) or swapped back at the mint
 * (unknown outcome), and only printed as a last resort.
 */
export async function payForCall(
  url: string,
  price: number,
  wallet: PaymentWallet,
  store: WalletFile,
  save: (s: WalletFile) => void,
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = fetch,
  ensureFunds?: () => Promise<void>,
): Promise<CallResult> {
  let sent: { keep: Proof[]; send: Proof[] };
  try {
    sent = await wallet.send(price, store.proofs, { includeFees: true });
  } catch (err) {
    if (!ensureFunds) throw err;
    // The balance check only compares face value; the mint's swap fee can push
    // the real requirement above it. Top up once and retry.
    await ensureFunds();
    sent = await wallet.send(price, store.proofs, { includeFees: true });
  }
  store.proofs = sent.keep;
  save(store);
  const token = getEncodedToken({ mint: store.mint, proofs: sent.send, unit: store.unit });

  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { 'X-Cashu': token } });
  } catch (err) {
    const back = await wallet.receive(token).catch(() => undefined);
    if (back) {
      store.proofs.push(...back);
      save(store);
    } else {
      console.error(`payment did not reach the server and the token could not be reclaimed; keep it for recovery:\n${token}`);
    }
    throw err;
  }

  const changeHeader = res.headers.get('x-cashu-change');
  let change = 0;
  if (changeHeader) {
    try {
      const changeProofs = await wallet.receive(changeHeader);
      store.proofs.push(...changeProofs);
      save(store);
      change = sumProofs(changeProofs);
    } catch (err) {
      console.error(`could not bank the change token; keep it for recovery:\n${changeHeader}`);
    }
  }

  // PN-N2: a server whose handler failed after settlement refunds the kept
  // amount in this header. Bank it like change — it is the price coming back.
  const refundHeader = res.headers.get('x-cashu-refund');
  let refund = 0;
  if (refundHeader) {
    try {
      const refundProofs = await wallet.receive(refundHeader);
      store.proofs.push(...refundProofs);
      save(store);
      refund = sumProofs(refundProofs);
    } catch (err) {
      console.error(`could not bank the refund token; keep it for recovery:\n${refundHeader}`);
    }
  }

  const body = await res.text();
  let reclaimed = false;
  if (res.status !== 200) {
    let reason: string | undefined;
    try {
      reason = (JSON.parse(body) as { error?: string }).error;
    } catch {
      // not a paynut error body
    }
    const untouched =
      res.status === 400 || ['insufficient', 'untrusted_mint', 'wrong_unit', 'malformed_token'].includes(reason ?? '');
    if (untouched) {
      // The gate rejected before redeeming, so these proofs were never spent.
      store.proofs.push(...sent.send);
      save(store);
      reclaimed = true;
    } else {
      // Redemption was attempted: the token is either burned or its outcome
      // is unknown. ALWAYS try to swap it back (PN-N2: a banked change token
      // must not stand in for the price and skip this), and when the swap
      // fails, print the token as the recovery record — refunded or not.
      const back = await wallet.receive(token).catch(() => undefined);
      if (back) {
        store.proofs.push(...back);
        save(store);
        reclaimed = true;
      } else {
        console.error(
          `payment was settled but the call failed with status ${res.status}` +
            `${refund ? `; a refund token worth ${refund} was banked` : ''}` +
            `; keep the payment token for recovery:\n${token}`,
        );
      }
    }
  }
  return { status: res.status, body, change, refund, reclaimed };
}

async function main() {
  const { url, topupAmount } = parseArgs(process.argv.slice(2));

  const wallet = new Wallet(MINT, { unit: UNIT });
  await wallet.loadMint();
  const store = loadStore(STORE, MINT);
  const save = (s: WalletFile) => saveStore(STORE, s);

  let res = await fetch(url);
  if (res.status === 200) {
    console.log('endpoint answered for free:', await res.text());
    return;
  }
  if (res.status !== 402) {
    console.log(`unexpected status ${res.status}:`, await res.text());
    return;
  }
  const quoteBody = (await res.json()) as { paynut: { price: number; mints: string[] } };
  const price = quoteBody.paynut.price;
  console.log(`endpoint wants ${price} ${UNIT} (mints: ${quoteBody.paynut.mints.join(', ')})`);
  if (!quoteBody.paynut.mints.map(normalizeMintUrl).includes(MINT)) {
    throw new Error(`endpoint does not accept our mint ${MINT}`);
  }
  if (sumProofs(store.proofs) < price) {
    console.log(`balance ${sumProofs(store.proofs)} < ${price}; topping up ${topupAmount}`);
    await topUp(wallet, store, topupAmount, save);
  }

  const result = await payForCall(url, price, wallet, store, save, fetch, () =>
    topUp(wallet, store, topupAmount, save),
  );
  if (result.change) console.log(`got change worth ${result.change} ${UNIT}`);
  if (result.refund) console.log(`got a refund worth ${result.refund} ${UNIT}`);
  console.log(`status ${result.status}`);
  console.log(result.body);
  console.log(`wallet balance after call: ${sumProofs(store.proofs)} ${UNIT}`);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
