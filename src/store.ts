/**
 * paynut proof journal (C1/C2).
 *
 * Cashu proofs are bearer money and cashu-ts keeps no proof store: the moment
 * `wallet.receive()` returns, the redeemed value exists only as JS objects in
 * this process. A crash between that return and whatever the app does with the
 * proofs destroys the money outright — nobody, including the gate, can spend
 * it again.
 *
 * This module is the durable side of that: an append-only JSONL file, one
 * record per line, written with `appendFileSync` so a record is on disk before
 * the next statement runs. `readAll()` parses the file back so a restarted
 * process can see what the previous one did.
 *
 * Record types written by the gate:
 *   { type: 'redeem_started',  at, tokenHash }
 *   { type: 'redeemed',        at, mint, tokenHash, proofs, changeProofs }
 *   { type: 'redeem_failed',   at, tokenHash, detail }
 *   { type: 'redeem_refunded', at, mint, tokenHash, proofs, received, changeToken }
 *
 * A `redeem_started` with no matching completion is the crash marker: the mint
 * may or may not have burned the presented proofs, so the gate refuses to
 * retry that token (see CashuGate.verifyPayment).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The seam the gate writes through. Kept deliberately tiny so a caller can
 * swap in a database, a queue, or a test double without pulling in fs.
 */
export interface ProofStore {
  /** Append one record. Must be durable by the time it returns. */
  append(entry: unknown): void;
  /**
   * Optional. When present the gate can recover a previous process's records
   * (crash markers, already-redeemed tokens) instead of redeeming blind.
   */
  readAll?(): unknown[];
}

/** One journal line. Extra fields are allowed and preserved. */
export interface JournalEntry {
  type: string;
  at: string;
  tokenHash?: string;
  mint?: string;
  proofs?: unknown;
  changeProofs?: unknown;
  received?: number;
  changeToken?: string;
  detail?: string;
  [key: string]: unknown;
}

/**
 * Append-only JSONL proof journal.
 *
 *   const store = new FileProofStore('./paynut-proofs.jsonl');
 *   const gate = new CashuGate({ price: 5, mints: [MINT], proofStore: store });
 *
 * The file is bearer money: it holds proof secrets. It is created 0600 and
 * should be gitignored like the client wallet file.
 */
export class FileProofStore implements ProofStore {
  readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  append(entry: unknown): void {
    const dir = dirname(this.file);
    if (dir && dir !== '.' && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    // One line, one record. appendFileSync opens/writes/closes, so the bytes
    // are handed to the OS before this returns — that is the whole point.
    appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  readAll(): unknown[] {
    if (!existsSync(this.file)) return [];
    const raw = readFileSync(this.file, 'utf8');
    const out: unknown[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed));
      } catch {
        // A torn final line (crash mid-append) is expected; skip it rather
        // than refusing to read a journal that is otherwise intact.
      }
    }
    return out;
  }
}

/** Convenience: every journal record written for one token hash. */
export function entriesFor(store: ProofStore, tokenHash: string): JournalEntry[] {
  const all = store.readAll?.() ?? [];
  const out: JournalEntry[] = [];
  for (const raw of all) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as JournalEntry;
    if (entry.tokenHash === tokenHash) out.push(entry);
  }
  return out;
}
