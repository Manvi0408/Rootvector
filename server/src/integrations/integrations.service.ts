import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { GithubClient } from './github.client';

@Injectable()
export class IntegrationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  /** Persist a provider connection with its token encrypted at rest. */
  async connect(
    userId: string,
    provider: string,
    token: string,
    externalLogin?: string,
    scopes?: string,
  ) {
    const accessTokenEnc = this.crypto.encrypt(token);
    return this.prisma.integration.upsert({
      where: { userId_provider: { userId, provider } },
      update: { accessTokenEnc, externalLogin, scopes, status: 'connected' },
      create: { userId, provider, accessTokenEnc, externalLogin, scopes, status: 'connected' },
    });
  }

  /** Store a Slack Incoming Webhook URL (encrypted) so incidents post to Slack. */
  async connectSlack(userId: string, url: string) {
    if (!/^https:\/\/hooks\.slack\.com\/services\//.test(url || '')) {
      throw new BadRequestException('Enter a valid Slack Incoming Webhook URL (https://hooks.slack.com/services/...).');
    }
    const accessTokenEnc = this.crypto.encrypt(url);
    return this.prisma.integration.upsert({
      where: { userId_provider: { userId, provider: 'slack' } },
      update: { accessTokenEnc, status: 'connected' },
      create: { userId, provider: 'slack', accessTokenEnc, status: 'connected' },
    });
  }

  /** The active Slack webhook URL: env override, else the stored connection. */
  async slackUrl(): Promise<string | null> {
    if (process.env.SLACK_WEBHOOK_URL) return process.env.SLACK_WEBHOOK_URL;
    const row = await this.prisma.integration.findFirst({
      where: { provider: 'slack' }, orderBy: { createdAt: 'desc' },
    });
    if (!row) return null;
    try { return this.crypto.decrypt(row.accessTokenEnc); } catch { return null; }
  }

  async disconnect(userId: string, provider: string) {
    await this.prisma.integration
      .delete({ where: { userId_provider: { userId, provider } } })
      .catch(() => null);
    return { ok: true };
  }

  /** Safe, tokenless view for the Integrations UI. */
  async list(userId: string) {
    const rows = await this.prisma.integration.findMany({ where: { userId } });
    const byProvider = Object.fromEntries(rows.map((r) => [r.provider, r]));

    // Sentry connects by webhook + secret (not OAuth): "connected" once the
    // secret is configured; surface the last verified delivery.
    const sentryConfigured = !!process.env.SENTRY_CLIENT_SECRET;
    const alertConfigured = !!process.env.ALERT_WEBHOOK_SECRET;
    const slackConfigured = !!process.env.SLACK_WEBHOOK_URL || !!byProvider.slack;

    // last verified delivery per provider (for "last event" + status)
    const lastByProvider: Record<string, Date | null> = {};
    for (const p of ['sentry', 'grafana', 'kubernetes', 'datadog', 'opentelemetry']) {
      const d = await this.prisma.webhookDelivery.findFirst({
        where: { provider: p, verified: true }, orderBy: { at: 'desc' },
      });
      lastByProvider[p] = d?.at ?? null;
    }

    const path = '/api/webhooks';
    const providers = [
      { key: 'github', name: 'GitHub', blurb: 'PRs · commits · deployments', available: true, style: 'oauth' as const, webhookPath: null },
      { key: 'sentry', name: 'Sentry', blurb: 'Errors · crashes · stack traces', available: true, style: 'webhook' as const, webhookPath: `${path}/sentry` },
      { key: 'datadog', name: 'Datadog', blurb: 'Monitors · metrics · alerts', available: true, style: 'webhook' as const, webhookPath: `${path}/datadog` },
      { key: 'kubernetes', name: 'Kubernetes', blurb: 'Alertmanager · pod alerts', available: true, style: 'webhook' as const, webhookPath: `${path}/kubernetes` },
      { key: 'opentelemetry', name: 'OpenTelemetry', blurb: 'Collector · alert exporter', available: true, style: 'webhook' as const, webhookPath: `${path}/opentelemetry` },
      { key: 'grafana', name: 'Grafana', blurb: 'Alerting · contact points', available: true, style: 'webhook' as const, webhookPath: `${path}/grafana` },
      { key: 'slack', name: 'Slack', blurb: 'Incident notifications (outbound)', available: true, style: 'outbound' as const, webhookPath: null },
    ];

    return providers.map((p) => {
      if (p.key === 'github') {
        const row = byProvider.github;
        return { ...p, status: row ? row.status : 'disconnected', externalLogin: row?.externalLogin ?? null, connectedAt: row?.createdAt ?? null, lastEventAt: row?.lastEventAt ?? null };
      }
      if (p.key === 'sentry') {
        // "connected" only once it has actually delivered a verified event —
        // a server secret being set doesn't mean the user connected it.
        return { ...p, status: lastByProvider.sentry ? 'connected' : 'disconnected', ready: sentryConfigured, externalLogin: null, connectedAt: null, lastEventAt: lastByProvider.sentry };
      }
      if (p.key === 'slack') {
        return { ...p, status: slackConfigured ? 'connected' : 'disconnected', externalLogin: null, connectedAt: null, lastEventAt: null };
      }
      // datadog / kubernetes / opentelemetry / grafana → "connected" only after a real alert arrives.
      return { ...p, status: lastByProvider[p.key] ? 'connected' : 'disconnected', ready: alertConfigured, externalLogin: null, connectedAt: null, lastEventAt: lastByProvider[p.key] ?? null };
    });
  }

  private async tokenFor(userId: string, provider: string): Promise<string> {
    const row = await this.prisma.integration.findUnique({
      where: { userId_provider: { userId, provider } },
    });
    if (!row) throw new BadRequestException(`${provider} is not connected`);
    return this.crypto.decrypt(row.accessTokenEnc);
  }

  async githubClient(userId: string) {
    return new GithubClient(await this.tokenFor(userId, 'github'));
  }

  async githubRepositories(userId: string) {
    const gh = await this.githubClient(userId);
    return gh.repositories();
  }

  /** Which user connected a GitHub account matching this owner/login (for
   *  attributing webhook incidents to the repo owner). */
  async userIdByGithubLogin(login: string): Promise<string | null> {
    if (!login) return null;
    const row = await this.prisma.integration.findFirst({
      where: { provider: 'github', externalLogin: { equals: login, mode: 'insensitive' } },
      orderBy: { createdAt: 'desc' },
    });
    return row?.userId ?? null;
  }

  /** Comment on and close a real GitHub issue using the owner's stored token
   *  (needs `repo` scope). Returns false if not connected / no write access. */
  async closeGithubIssue(userId: string, repoFullName: string, issueNumber: number, comment: string): Promise<boolean> {
    const row = await this.prisma.integration.findUnique({
      where: { userId_provider: { userId, provider: 'github' } },
    });
    if (!row) return false;
    let token: string;
    try { token = this.crypto.decrypt(row.accessTokenEnc); } catch { return false; }
    const headers = {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'rootvector',
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    };
    try {
      await fetch(`https://api.github.com/repos/${repoFullName}/issues/${issueNumber}/comments`, {
        method: 'POST', headers, body: JSON.stringify({ body: comment }),
      });
      await fetch(`https://api.github.com/repos/${repoFullName}/issues/${issueNumber}`, {
        method: 'PATCH', headers, body: JSON.stringify({ state: 'closed' }),
      });
      return true;
    } catch { return false; }
  }

  /** Recent live GitHub activity for the user, or null if GitHub isn't connected. */
  async githubActivity(userId: string): Promise<any[] | null> {
    const row = await this.prisma.integration.findUnique({
      where: { userId_provider: { userId, provider: 'github' } },
    });
    if (!row) return null;
    try {
      const gh = new GithubClient(this.crypto.decrypt(row.accessTokenEnc));
      return await gh.recentActivity(row.externalLogin || '');
    } catch {
      return null;
    }
  }
}
