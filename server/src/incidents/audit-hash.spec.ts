import { chainHash, verifyChain, GENESIS, StoredEvent } from './audit-hash';

/**
 * The audit trail must be tamper-evident: recomputing the hash chain has to
 * catch any edit, reorder, insert or delete of a persisted event.
 */
describe('audit-hash — tamper-evident chain', () => {
  // Build a valid chain the way the service does.
  function build(messages: string[]): StoredEvent[] {
    let prev = GENESIS;
    const at0 = Date.parse('2026-01-01T00:00:00.000Z');
    return messages.map((m, i) => {
      const e: StoredEvent = { incidentId: 'inc1', kind: 'investigation.step', message: m, data: null, at: new Date(at0 + i * 1000) };
      e.prevHash = prev;
      e.hash = chainHash(prev, e);
      prev = e.hash;
      return e;
    });
  }

  it('verifies an untampered chain', () => {
    const chain = build(['detected', 'evidence', 'root cause', 'resolved']);
    expect(verifyChain(chain)).toEqual({ intact: true, brokenAt: -1 });
  });

  it('detects an edited message', () => {
    const chain = build(['detected', 'evidence', 'root cause', 'resolved']);
    chain[2].message = 'tampered root cause'; // rewrite history
    const r = verifyChain(chain);
    expect(r.intact).toBe(false);
    expect(r.brokenAt).toBe(2);
  });

  it('detects a reordered event', () => {
    const chain = build(['a', 'b', 'c', 'd']);
    [chain[1], chain[2]] = [chain[2], chain[1]]; // swap
    expect(verifyChain(chain).intact).toBe(false);
  });

  it('detects a deleted event', () => {
    const chain = build(['a', 'b', 'c', 'd']);
    chain.splice(1, 1); // drop the second event
    expect(verifyChain(chain).intact).toBe(false);
  });

  it('detects an inserted (forged) event', () => {
    const chain = build(['a', 'b', 'c']);
    const forged: StoredEvent = { incidentId: 'inc1', kind: 'resolved', message: 'forged approval', data: null, at: new Date(), prevHash: chain[2].hash, hash: 'deadbeef' };
    chain.splice(2, 0, forged);
    expect(verifyChain(chain).intact).toBe(false);
  });
});
