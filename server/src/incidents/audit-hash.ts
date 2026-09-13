import * as crypto from 'crypto';

/**
 * Tamper-evident audit trail via hash chaining.
 *
 * Each incident event stores `hash = SHA-256(prevHash + canonical(event))` and
 * the `prevHash` it was computed from. The events therefore form a chain
 * anchored at a genesis marker: changing, reordering, inserting or deleting any
 * event changes its hash and breaks every link after it, so tampering is
 * detectable by recomputing the chain. Pure and dependency-free — the service
 * layer persists the values, this module just computes and verifies them.
 */

export const GENESIS = 'GENESIS';

export interface ChainEvent {
  incidentId: string;
  kind: string;
  message: string;
  data?: unknown;
  at: Date | string;
}

/** Deterministic hash of one event, linked to the previous hash. */
export function chainHash(prevHash: string, e: ChainEvent): string {
  const canon = JSON.stringify({
    p: prevHash,
    i: e.incidentId,
    k: e.kind,
    m: e.message,
    d: e.data ?? null,
    a: new Date(e.at).toISOString(),
  });
  return crypto.createHash('sha256').update(canon).digest('hex');
}

export interface StoredEvent extends ChainEvent {
  prevHash?: string | null;
  hash?: string | null;
}

/** Walk events in order and confirm the chain is intact. Returns the index of
 *  the first broken link, or -1 if the whole chain verifies. */
export function verifyChain(events: StoredEvent[]): { intact: boolean; brokenAt: number } {
  let prev = GENESIS;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const expected = chainHash(prev, e);
    if ((e.prevHash || GENESIS) !== prev || e.hash !== expected) {
      return { intact: false, brokenAt: i };
    }
    prev = e.hash as string;
  }
  return { intact: true, brokenAt: -1 };
}
