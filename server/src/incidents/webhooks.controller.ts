import { Controller, Post, Req, Headers, HttpCode } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { IncidentsService } from './incidents.service';
import { AgentService } from './agent.service';

/** GitHub & Sentry webhook receivers. NOT auth-guarded (providers can't send a
 *  session cookie) — instead every delivery is verified by HMAC signature. */
@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly incidents: IncidentsService,
    private readonly agent: AgentService,
  ) {}

  private verify(raw: Buffer | undefined, secret: string | undefined, sig: string | undefined, scheme: 'gh' | 'sentry'): boolean {
    if (!secret) return false;                 // no secret configured → treat as unverified
    if (!raw || !sig) return false;
    const hmac = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    const expected = scheme === 'gh' ? `sha256=${hmac}` : hmac;
    try {
      return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
    } catch {
      return false;
    }
  }

  @Post('github')
  @HttpCode(200)
  async github(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-github-event') event: string,
    @Headers('x-hub-signature-256') sig: string,
  ) {
    const verified = this.verify(req.rawBody, process.env.GITHUB_WEBHOOK_SECRET, sig, 'gh');
    await this.prisma.webhookDelivery.create({ data: { provider: 'github', event, verified } });
    if (!verified) return { ok: false, reason: 'signature not verified' };

    const body: any = req.body || {};
    if (event === 'pull_request' && body.action === 'closed' && body.pull_request?.merged) {
      await this.incidents.addActivity({
        kind: 'pr_merged',
        title: `PR #${body.pull_request.number} merged`,
        service: body.repository?.name,
        url: body.pull_request.html_url,
      });
    } else if (event === 'deployment' || event === 'deployment_status') {
      await this.incidents.addActivity({
        kind: 'deployment',
        title: `Deployment ${body.deployment?.ref || ''}`.trim(),
        service: body.repository?.name,
      });
    } else if (event === 'push') {
      await this.incidents.addActivity({
        kind: 'push',
        title: `${(body.commits || []).length} commit(s) pushed`,
        service: body.repository?.name,
      });
    }
    return { ok: true };
  }

  @Post('sentry')
  @HttpCode(200)
  async sentry(
    @Req() req: RawBodyRequest<Request>,
    @Headers('sentry-hook-signature') sig: string,
    @Headers('sentry-hook-resource') resource: string,
  ) {
    const verified = this.verify(req.rawBody, process.env.SENTRY_CLIENT_SECRET, sig, 'sentry');
    await this.prisma.webhookDelivery.create({ data: { provider: 'sentry', event: resource, verified } });
    if (!verified) return { ok: false, reason: 'signature not verified' };

    const body: any = req.body || {};
    const action: string = body.action || '';
    const issue = body.data?.issue || {};
    const event = body.data?.event || {};
    const alert = body.data?.event_alert || body.data?.metric_alert || {};

    // Which resources indicate a *new* production problem worth an incident.
    const openable =
      resource === 'error' ||
      resource === 'event_alert' ||
      resource === 'metric_alert' ||
      (resource === 'issue' && ['created', 'unresolved', 'reprocessed'].includes(action));

    // service = the Sentry project slug (best-effort across payload shapes)
    const service =
      issue.project?.slug || event.project?.slug || alert.project?.slug ||
      body.data?.project?.slug || body.installation?.app_slug || 'production';
    const title =
      issue.title || issue.metadata?.value || event.title ||
      alert.title || 'Production error';

    if (!openable) return { ok: true, ignored: resource + '/' + action };

    await this.incidents.addActivity({ kind: 'error', title, service });

    // dedup — don't open a second incident while one is still active for this service
    const existing = await this.incidents.hasActive(service);
    if (existing) return { ok: true, incident: existing.key, note: 'already active' };

    const inc = await this.incidents.create({ title: `${service} degraded`, service, severity: 1, source: 'sentry' });
    this.agent.run(inc.id).catch(() => undefined); // real error → live AI investigation
    return { ok: true, incident: inc.key };
  }
}
