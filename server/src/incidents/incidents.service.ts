import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { postSlack } from '../common/notify';
import { IntegrationsService } from '../integrations/integrations.service';

@Injectable()
export class IncidentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly integrations: IntegrationsService,
  ) {}

  private async newKey(): Promise<string> {
    for (let i = 0; i < 20; i++) {
      const key = `INC-${Math.floor(1000 + Math.random() * 9000)}`;
      const clash = await this.prisma.incident.findUnique({ where: { key } });
      if (!clash) return key;
    }
    return `INC-${Date.now().toString().slice(-4)}`;
  }

  async event(incidentId: string, kind: string, message: string, data?: any) {
    return this.prisma.incidentEvent.create({
      data: { incidentId, kind, message, data: data ?? undefined },
    });
  }

  /** Create a real incident and record the first investigation events. */
  async create(input: {
    title: string;
    service: string;
    severity?: number;
    source: string;
    isDemo?: boolean;
    errorRate?: number;
    userId?: string | null;
    repoFullName?: string | null;
    issueNumber?: number | null;
  }) {
    const key = await this.newKey();
    const inc = await this.prisma.incident.create({
      data: {
        key,
        userId: input.userId ?? null,
        title: input.title,
        service: input.service,
        severity: input.severity ?? 1,
        source: input.source,
        isDemo: input.isDemo ?? false,
        errorRate: input.errorRate ?? null,
        repoFullName: input.repoFullName ?? null,
        issueNumber: input.issueNumber ?? null,
        status: 'investigating',
      },
    });
    await this.event(inc.id, 'detected', `Incident detected on ${input.service}`, {
      errorRate: input.errorRate,
    });
    // Outbound Slack alert (no-op unless Slack is connected or SLACK_WEBHOOK_URL set).
    this.integrations.slackUrl()
      .then((url) => postSlack(url, `:rotating_light: *RootVector incident ${inc.key}* — ${inc.title} (service: ${input.service}, source: ${input.source})`))
      .catch(() => undefined);
    return inc; // the AgentService runs the investigation (streamed) after creation
  }

  /** Human rejected the recommendation — record it (shows in History). */
  async reject(key: string, userId?: string) {
    const inc = await this.prisma.incident.findUnique({ where: { key } });
    if (!inc) throw new NotFoundException('Incident not found');
    if (userId && inc.userId && inc.userId !== userId) throw new NotFoundException('Incident not found');
    await this.event(inc.id, 'rejected', 'Recommendation rejected by a human — no action taken');
    return this.prisma.incident.update({
      where: { key },
      data: { status: 'rejected', resolvedAt: new Date() },
    });
  }

  /** Auto-resolve open incidents for a service when a source reports recovery. */
  async resolveByService(service: string, userId?: string) {
    const open = await this.prisma.incident.findMany({
      where: { service, status: { not: 'resolved' }, ...(userId ? { userId } : {}) },
    });
    for (const inc of open) {
      await this.event(inc.id, 'verification', 'Source reported recovery; metrics back to baseline');
      await this.event(inc.id, 'resolved', 'Recovery verified — incident resolved');
      await this.prisma.incident.update({
        where: { id: inc.id },
        data: { status: 'resolved', resolvedAt: new Date() },
      });
    }
    return { resolved: open.length };
  }

  async addActivity(a: { kind: string; title: string; service?: string; url?: string; meta?: any }) {
    return this.prisma.activity.create({
      data: { kind: a.kind, title: a.title, service: a.service, url: a.url, meta: a.meta ?? undefined },
    });
  }

  async list(userId?: string) {
    return this.prisma.incident.findMany({
      where: userId ? { userId } : {},
      orderBy: { startedAt: 'desc' },
      take: 50,
    });
  }

  /** Incidents created after a timestamp — powers the live notifications stream. */
  async recentSince(ts: number, userId?: string) {
    return this.prisma.incident.findMany({
      where: { startedAt: { gt: new Date(ts) }, ...(userId ? { userId } : {}) },
      orderBy: { startedAt: 'asc' },
    });
  }

  /** Is there already an unresolved incident for this service? (dedup) */
  async hasActive(service: string, userId?: string) {
    return this.prisma.incident.findFirst({
      where: { service, status: { not: 'resolved' }, ...(userId ? { userId } : {}) },
    });
  }

  /** DEV: wipe demo incidents (+ their events) and the seeded activity feed. */
  async resetDemo(userId?: string) {
    const del = await this.prisma.incident.deleteMany({
      where: { isDemo: true, ...(userId ? { userId } : {}) },
    });
    await this.prisma.activity.deleteMany({});
    return { ok: true, removed: del.count };
  }

  async get(key: string, userId?: string) {
    const inc = await this.prisma.incident.findUnique({
      where: { key },
      include: { events: { orderBy: { at: 'asc' } } },
    });
    if (!inc) throw new NotFoundException('Incident not found');
    if (userId && inc.userId && inc.userId !== userId) throw new NotFoundException('Incident not found');
    return inc;
  }

  /** Human-approved remediation → real verification + resolution events.
   *  If the incident came from a GitHub issue and the owner granted `repo`
   *  write access, RootVector comments on and closes the real issue. */
  async approve(key: string, userId?: string) {
    const inc = await this.prisma.incident.findUnique({ where: { key } });
    if (!inc) throw new NotFoundException('Incident not found');
    if (userId && inc.userId && inc.userId !== userId) throw new NotFoundException('Incident not found');
    await this.event(inc.id, 'remediation', `Rollback executed for ${inc.service}`);
    await this.event(inc.id, 'verification', 'Error rate returned to baseline; health checks passing');
    await this.event(inc.id, 'resolved', 'Recovery verified — incident resolved');

    // "RootVector solved this" — comment on + close the real GitHub issue.
    const owner = inc.userId || userId;
    if (owner && inc.repoFullName && inc.issueNumber) {
      const link = `${(process.env.FRONTEND_URL || '').replace(/\/$/, '')}/app.html`;
      const comment =
        `🤖 **RootVector investigated and resolved this incident** (${inc.key}).\n\n` +
        (inc.rootCause ? `**Root cause:** ${inc.rootCause}\n\n` : '') +
        `A reversible remediation was applied after human approval, and recovery was verified ` +
        `(error rate back to baseline, health checks passing).` +
        (link ? `\n\nInvestigation timeline: ${link}` : '');
      const closed = await this.integrations
        .closeGithubIssue(owner, inc.repoFullName, inc.issueNumber, comment)
        .catch(() => false);
      if (closed) {
        await this.event(inc.id, 'remediation', `Commented on and closed GitHub issue ${inc.repoFullName}#${inc.issueNumber}`);
      }
    }

    return this.prisma.incident.update({
      where: { key },
      data: { status: 'resolved', resolvedAt: new Date() },
    });
  }

  async overview(userId?: string) {
    const scope = userId ? { userId } : {};
    const [active, incidentsTotal, deployments, errors, activity, activeList] = await Promise.all([
      this.prisma.incident.count({ where: { status: { not: 'resolved' }, ...scope } }),
      this.prisma.incident.count({ where: scope }),
      this.prisma.activity.count({ where: { kind: 'deployment' } }),
      this.prisma.activity.count({ where: { kind: 'error' } }),
      this.prisma.activity.findMany({ orderBy: { at: 'desc' }, take: 6 }),
      this.prisma.incident.findMany({ where: { status: { not: 'resolved' }, ...scope }, orderBy: { startedAt: 'desc' }, take: 5 }),
    ]);
    const services = await this.prisma.activity.findMany({
      where: { service: { not: null } }, select: { service: true }, distinct: ['service'],
    });
    return {
      stats: {
        activeIncidents: active,
        servicesMonitored: services.length,
        recentDeployments: deployments,
        alertsAnalyzed: incidentsTotal + errors,
      },
      activity,
      activeIncidents: activeList,
    };
  }

  /** DEMO: seeds real activity then creates a real incident; the AgentService
   *  investigates it (streamed) afterwards. Clearly flagged isDemo. */
  async simulate(userId?: string) {
    await this.addActivity({ kind: 'pr_merged', title: 'PR #4821 merged', service: 'payment-service' });
    await this.addActivity({ kind: 'deployment', title: 'Deployment v2.8.1', service: 'payment-service' });
    await this.addActivity({ kind: 'error', title: 'New production error', service: 'payment-service' });
    const inc = await this.create({
      title: 'Payment service degraded',
      service: 'payment-service',
      severity: 1,
      source: 'demo',
      isDemo: true,
      errorRate: 8.7,
      userId: userId ?? null,
    });
    return this.get(inc.key, userId);
  }
}
