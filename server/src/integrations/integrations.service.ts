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
    const lastSentry = await this.prisma.webhookDelivery.findFirst({
      where: { provider: 'sentry', verified: true },
      orderBy: { at: 'desc' },
    });

    const providers = [
      { key: 'github', name: 'GitHub', blurb: 'PRs · commits · deployments', available: true, style: 'oauth' as const },
      { key: 'sentry', name: 'Sentry', blurb: 'Errors · crashes · stack traces', available: true, style: 'webhook' as const },
      { key: 'datadog', name: 'Datadog', blurb: 'Logs · metrics · traces', available: false, style: null },
      { key: 'kubernetes', name: 'Kubernetes', blurb: 'Pods · deployments · rollouts', available: false, style: null },
      { key: 'opentelemetry', name: 'OpenTelemetry', blurb: 'Distributed traces · spans', available: false, style: null },
      { key: 'slack', name: 'Slack', blurb: 'Alerts · incident channels', available: false, style: null },
      { key: 'grafana', name: 'Grafana', blurb: 'Dashboards · metrics · alerts', available: false, style: null },
    ];
    return providers.map((p) => {
      if (p.key === 'sentry') {
        return {
          ...p,
          status: sentryConfigured ? 'connected' : 'disconnected',
          externalLogin: null,
          connectedAt: null,
          lastEventAt: lastSentry?.at ?? null,
        };
      }
      const row = byProvider[p.key];
      return {
        ...p,
        status: row ? row.status : 'disconnected',
        externalLogin: row?.externalLogin ?? null,
        connectedAt: row?.createdAt ?? null,
        lastEventAt: row?.lastEventAt ?? null,
      };
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
