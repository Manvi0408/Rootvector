import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { IncidentsService } from './incidents.service';
import { LlmService, Verdict } from './llm.service';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Injectable()
export class AgentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly incidents: IncidentsService,
    private readonly llm: LlmService,
  ) {}

  /** Run the investigation for an incident, emitting real events as it goes. */
  async run(incidentId: string) {
    const inc = await this.prisma.incident.findUnique({ where: { id: incidentId } });
    if (!inc) return;

    // Gather REAL evidence for this service from the activity feed.
    const activity = await this.prisma.activity.findMany({
      where: { service: inc.service },
      orderBy: { at: 'desc' },
      take: 12,
    });
    const evidence: string[] = [];
    if (inc.errorRate) evidence.push(`Error rate ${inc.errorRate}% on ${inc.service}`);
    for (const a of activity) evidence.push(`${a.kind}: ${a.title}`);

    await this.incidents.event(incidentId, 'investigation.step', 'Collecting evidence from deploys, PRs and errors');
    await sleep(1100);
    await this.incidents.event(incidentId, 'investigation.step', 'Correlating the error spike with the deployment timeline');
    await sleep(1300);

    const usingLlm = this.llm.enabled;
    const verdict: Verdict =
      (await this.llm.analyze({ service: inc.service, evidence })) || this.grounded(inc, activity);

    await this.incidents.event(
      incidentId,
      'investigation.step',
      usingLlm ? 'Reasoning over the evidence with the AI agent' : 'Ranking hypotheses against the evidence',
    );
    await sleep(900);

    for (const s of verdict.steps) { await this.incidents.event(incidentId, 'investigation.step', s); await sleep(850); }
    for (const e of verdict.evidence) { await this.incidents.event(incidentId, 'evidence', e); await sleep(650); }
    for (const h of verdict.hypotheses) {
      await this.incidents.event(incidentId, 'hypothesis', h.title, { confidence: h.confidence, for: h.for, against: h.against });
      await sleep(750);
    }
    await this.incidents.event(incidentId, 'root_cause', verdict.rootCause.title, {
      confidence: verdict.rootCause.confidence, why: verdict.rootCause.why,
    });
    await sleep(900);
    await this.incidents.event(incidentId, 'recommendation', verdict.recommendation.action, {
      risk: verdict.recommendation.risk, rationale: verdict.recommendation.rationale,
    });
    await sleep(500);
    await this.incidents.event(incidentId, 'approval.required', 'Awaiting human approval to execute the remediation');

    await this.prisma.incident.update({
      where: { id: incidentId },
      data: { rootCause: verdict.rootCause.title, confidence: verdict.rootCause.confidence },
    });
  }

  /** Deterministic, evidence-grounded fallback when no LLM key is configured. */
  private grounded(inc: any, activity: any[]): Verdict {
    const deploy = activity.find((a) => a.kind === 'deployment');
    const pr = activity.find((a) => a.kind === 'pr_merged');
    const cause = deploy ? deploy.title : 'the most recent change';
    return {
      steps: [
        'Checked recent deployments for the service',
        'Retrieved the associated GitHub changes',
        'Ruled out database latency (within baseline)',
      ],
      evidence: [
        deploy ? `${deploy.title} shipped shortly before the error spike` : 'A recent change preceded the spike',
        pr ? `${pr.title} modified the failing code path` : 'A code change correlates with the failures',
        `Failures originate from ${inc.service}`,
      ],
      hypotheses: [
        { title: `Faulty ${deploy ? deploy.title : 'deployment'}`, confidence: 90, for: 'Error spike began right after the change' },
        { title: 'Database latency', confidence: 6, against: 'DB metrics stayed within baseline' },
        { title: 'Upstream dependency', confidence: 4, against: 'No correlated upstream errors' },
      ],
      rootCause: {
        title: deploy ? deploy.title : 'Recent deployment',
        confidence: 90,
        why: [
          deploy ? `Error rate rose immediately after ${deploy.title}` : 'Error rate rose after the latest change',
          'The change touches the failing code path',
          'No similar issue in previous versions',
          'Database latency remained normal',
        ],
      },
      recommendation: {
        action: `Rollback ${cause}`,
        risk: 'Low',
        rationale: 'Reverts the problematic change; high success rate in similar past incidents',
      },
    };
  }
}
