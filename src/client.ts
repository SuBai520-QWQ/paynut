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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Wallet, getEncodedToken } from '@cashu/cashu-ts';
import type { Proof } from '@cashu/cashu-ts';
import { sumProofs, normalizeMintUrl } from './gate.js';
import { TEST_MINT } from './server.js';

interface WalletFile {
  mint: string;
  unit: string;
  proofs: Proof[];
}

const STORE = process.env.PAYNUT_WALLET ?? 'client-wallet.json';
const MINT = normalizeMintUrl(process.env.PAYNUT_MINT ?? TEST_MINT);
const UNIT = 'sat';

function loadStore(): WalletFile {
  if (existsSync(STORE)) {
    const data = JSON.parse(readFileSync(STORE, 'utf8')) as WalletFile;
    if (normalizeMintUrl(data.mint) === MINT) return data;
    console.error(`wallet file is for mint ${data.mint}, not ${MINT}; starting fresh (old file kept)`);
  }
  return { mint: MINT, unit: UNIT, proofs: [] };
}

function saveStore(store: WalletFile) {
  writeFileSync(STORE, JSON.stringify(store, null, 2), { mode: 0o600 });
}

async function topUp(wallet: Wallet, store: WalletFile, amount: number) {
  const quote = await wallet.createMintQuoteBolt11(amount);
  console.log(`mint quote ${quote.quote}: pay this Lightning invoice to fund the wallet:`);
  console.log(quote.request);
  console.log('(test mint uses a FakeWallet — the invoice settles by itself, just wait)');
  const deadline = Date.now() + 120_000;
  for (;;) {
    const status = await wallet.checkMintQuoteBolt11(quote.quote);
    if (String(status.state) === 'PAID') break;
    if (Date.now() > deadline) throw new Error('mint quote not paid within 120s');
    await new Promise((r) => setTimeout(r, 1000));
  }
  const proofs = await wallet.mintProofs(amount, quote.quote);
  store.proofs.push(...proofs);
  saveStore(store);
  console.log(`minted ${amount} ${UNIT}; balance now ${sumProofs(store.proofs)}`);
}

async function main() {
  const args = process.argv.slice(2);
  const url = args.find((a) => !a.startsWith('--')) ?? 'http://localhost:8402/paid/fortune';
  const topupIdx = args.indexOf('--topup');
  const topupAmount = topupIdx >= 0 ? Number(args[topupIdx + 1]) : 32;

  const wallet = new Wallet(MINT, { unit: UNIT });
  await wallet.loadMint();
  const store = loadStore();

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
    await topUp(wallet, store, topupAmount);
  }

  // includeFees: the gate's redemption swap costs the mint's input fee, so
  // the token's face value must be price + that fee for the gate to net `price`.
  const { send, keep } = await wallet.send(price, store.proofs, { includeFees: true });
  store.proofs = keep;
  saveStore(store);
  const token = getEncodedToken({ mint: MINT, proofs: send, unit: UNIT });

  res = await fetch(url, { headers: { 'X-Cashu': token } });
  const changeHeader = res.headers.get('x-cashu-change');
  if (changeHeader) {
    // Swap the change token into fresh proofs we own (also proves it is real).
    const changeProofs = await wallet.receive(changeHeader);
    store.proofs.push(...changeProofs);
    saveStore(store);
    console.log(`got change worth ${sumProofs(changeProofs)} ${UNIT}`);
  }
  console.log(`status ${res.status}`);
  console.log(await res.text());
  console.log(`wallet balance after call: ${sumProofs(store.proofs)} ${UNIT}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
