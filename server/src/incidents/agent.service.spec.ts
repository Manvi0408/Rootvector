import { AgentService } from './agent.service';
import { Verdict } from './llm.service';

/**
 * Unit tests for the deterministic, evidence-grounded fallback that runs when
 * no LLM key is configured. This is the core reasoning of the product, so it
 * must be predictable: correlate the error spike with the most recent
 * deployment, and recommend rolling that deployment back.
 *
 * `grounded` is a private method with no external dependencies, so we can
 * construct the service with null collaborators and call it directly.
 */
describe('AgentService.grounded (evidence-grounded fallback)', () => {
  const service = new AgentService(null as any, null as any, null as any);
  const grounded = (inc: any, activity: any[]): Verdict =>
    (service as any).grounded(inc, activity);

  const deployment = { kind: 'deployment', title: 'Deploy 7f31 — payment-service' };
  const prMerged = { kind: 'pr_merged', title: 'PR #204 — refactor charge handler' };

  it('names the recent deployment as the root cause', () => {
    const v = grounded({ service: 'payment-service', errorRate: 387 }, [deployment, prMerged]);
    expect(v.rootCause.title).toBe(deployment.title);
    expect(v.rootCause.confidence).toBe(90);
    expect(v.rootCause.why.length).toBeGreaterThanOrEqual(3);
  });

  it('recommends rolling back that deployment, at low risk', () => {
    const v = grounded({ service: 'payment-service' }, [deployment]);
    expect(v.recommendation.action).toBe(`Rollback ${deployment.title}`);
    expect(v.recommendation.risk).toBe('Low');
  });

  it('ranks the faulty-deployment hypothesis highest', () => {
    const v = grounded({ service: 'payment-service' }, [deployment]);
    const top = [...v.hypotheses].sort((a, b) => b.confidence - a.confidence)[0];
    expect(top.title).toContain(deployment.title);
    expect(top.confidence).toBe(90);
    // competing hypotheses are present but low-confidence, each with a reason against
    const others = v.hypotheses.filter((h) => h !== top);
    expect(others.length).toBeGreaterThanOrEqual(2);
    for (const h of others) expect(h.confidence).toBeLessThan(top.confidence);
  });

  it('cites the merged PR as evidence when one is present', () => {
    const v = grounded({ service: 'payment-service' }, [deployment, prMerged]);
    expect(v.evidence.join(' ')).toContain(prMerged.title);
  });

  it('degrades gracefully when there is no deployment in the activity feed', () => {
    const v = grounded({ service: 'auth-service' }, []);
    expect(v.rootCause.title).toBe('Recent deployment');
    expect(v.recommendation.action).toBe('Rollback the most recent change');
    // shape is still a complete, valid verdict
    expect(v.steps.length).toBeGreaterThan(0);
    expect(v.evidence.length).toBeGreaterThan(0);
    expect(v.hypotheses.length).toBeGreaterThan(0);
  });

  it('always attributes the failure to the incident’s own service', () => {
    const v = grounded({ service: 'checkout-service' }, [deployment]);
    expect(v.evidence.join(' ')).toContain('checkout-service');
  });
});
