import { Controller, Post, Req, Headers, HttpCode, Query } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { IncidentsService } from './incidents.service';
import { AgentService } from './agent.service';
import { IntegrationsService } from '../integrations/integrations.service';

/** GitHub & Sentry webhook receivers. NOT auth-guarded (providers can't send a
 *  session cookie) — instead every delivery is verified by HMAC signature. */
@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly incidents: IncidentsService,
    private readonly agent: AgentService,
    private readonly integrations: IntegrationsService,
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
    // Attribute everything from this repo to the RootVector user who connected it.
    const ownerLogin = body.repository?.owner?.login || body.organization?.login || '';
    const repoFullName = body.repository?.full_name || null;
    const ownerUserId = await this.integrations.userIdByGithubLogin(ownerLogin).catch(() => null);
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
    } else if (event === 'issues' && ['opened', 'reopened'].includes(body.action)) {
      // A new GitHub issue = a reported problem → open a real incident.
      // Store the issue reference so approval can comment on + close the real issue.
      await this.openFromGithub(
        body.repository?.name || 'github',
        `Issue: ${body.issue?.title || 'New issue'}`,
        body.issue?.html_url, false,
        { userId: ownerUserId, repoFullName, issueNumber: body.issue?.number ?? null },
      );
    } else if (event === 'workflow_run' && body.action === 'completed' && body.workflow_run?.conclusion === 'failure') {
      // A failed CI/deploy workflow → open a real incident (deduped per service).
      await this.openFromGithub(
        body.repository?.name || 'github',
        `Workflow failed: ${body.workflow_run?.name || ''}`.trim(),
        body.workflow_run?.html_url, true,
        { userId: ownerUserId, repoFullName },
      );
    } else if (event === 'check_run' && body.action === 'completed' && body.check_run?.conclusion === 'failure') {
      await this.openFromGithub(
        body.repository?.name || 'github',
        `Check failed: ${body.check_run?.name || ''}`.trim(),
        body.check_run?.html_url, true,
        { userId: ownerUserId, repoFullName },
      );
    }
    return { ok: true };
  }

  // ── Generic alert receivers (Datadog · Grafana · Kubernetes · OpenTelemetry) ──
  // Point any of these tools' alerting at the matching URL below with a shared
  // token (header `x-rootvector-token` or `?token=`) equal to ALERT_WEBHOOK_SECRET.
  // A firing alert opens a real incident; a resolved/recovered one closes it.

  private alertAuthed(req: Request, token?: string): boolean {
    const secret = process.env.ALERT_WEBHOOK_SECRET;
    if (!secret) return false;
    const provided = (req.headers['x-rootvector-token'] as string) || token;
    return provided === secret;
  }

  /** Prometheus/Alertmanager-style payload (Grafana + Kubernetes Alertmanager). */
  private normalizeAlertmanager(body: any): { title: string; service: string; severity: number; state: string }[] {
    const arr = Array.isArray(body?.alerts) ? body.alerts : [];
    if (!arr.length && body?.title) return [{ title: body.title, service: 'production', severity: 2, state: body.status || 'firing' }];
    return arr.map((a: any) => {
      const l = a.labels || {}, an = a.annotations || {};
      return {
        title: an.summary || an.description || l.alertname || body.title || 'Alert',
        service: l.service || l.job || l.namespace || l.deployment || l.pod || 'production',
        severity: /crit|p1|sev1|page/i.test(l.severity || '') ? 1 : 2,
        state: String(a.status || body.status || 'firing'),
      };
    });
  }

  /** Free-form payload (Datadog templated webhook, OpenTelemetry, generic). */
  private normalizeGeneric(body: any): { title: string; service: string; severity: number; state: string }[] {
    return [{
      title: body.title || body.alert || body.message || body.event_title || body.alert_title || 'Alert',
      service: body.service || body.host || body.hostname || body.resource || body.scope || 'production',
      severity: /crit|p1|sev1/i.test(String(body.severity || body.priority || body.alert_type || '')) ? 1 : 2,
      state: String(body.state || body.status || body.alert_transition || body.alert_type || 'firing'),
    }];
  }

  private async ingestAlerts(provider: string, req: RawBodyRequest<Request>, token: string | undefined, items: { title: string; service: string; severity: number; state: string }[]) {
    const verified = this.alertAuthed(req, token);
    await this.prisma.webhookDelivery.create({ data: { provider, event: 'alert', verified } });
    if (!verified) return { ok: false, reason: 'unauthorized (bad or missing token)' };

    const opened: string[] = [], resolved: string[] = [];
    for (const it of items) {
      const isResolved = /resolv|recover|\bok\b|clos|heal|success/i.test(it.state);
      const isFiring = !isResolved && /fir|trig|alert|crit|open|warn|bad|error|fail|page/i.test(it.state);
      if (isFiring || (!isResolved && items.length)) {
        await this.incidents.addActivity({ kind: 'error', title: it.title, service: it.service });
        const existing = await this.incidents.hasActive(it.service);
        if (existing) { opened.push(existing.key); continue; }
        const inc = await this.incidents.create({ title: it.title, service: it.service, severity: it.severity, source: provider });
        this.agent.run(inc.id).catch(() => undefined);
        opened.push(inc.key);
      } else if (isResolved) {
        const r = await this.incidents.resolveByService(it.service);
        if (r.resolved) resolved.push(it.service);
      }
    }
    return { ok: true, opened, resolved };
  }

  @Post('grafana') @HttpCode(200)
  grafana(@Req() req: RawBodyRequest<Request>, @Query('token') token: string) {
    return this.ingestAlerts('grafana', req, token, this.normalizeAlertmanager(req.body || {}));
  }
  @Post('kubernetes') @HttpCode(200)
  kubernetes(@Req() req: RawBodyRequest<Request>, @Query('token') token: string) {
    return this.ingestAlerts('kubernetes', req, token, this.normalizeAlertmanager(req.body || {}));
  }
  @Post('datadog') @HttpCode(200)
  datadog(@Req() req: RawBodyRequest<Request>, @Query('token') token: string) {
    return this.ingestAlerts('datadog', req, token, this.normalizeGeneric(req.body || {}));
  }
  @Post('opentelemetry') @HttpCode(200)
  opentelemetry(@Req() req: RawBodyRequest<Request>, @Query('token') token: string) {
    return this.ingestAlerts('opentelemetry', req, token, this.normalizeGeneric(req.body || {}));
  }

  /** Turn a GitHub problem into a real incident (+ live AI investigation),
   *  attributed to the repo owner and (for issues) linked to the real issue. */
  private async openFromGithub(
    service: string,
    title: string,
    url: string | undefined,
    dedupByService: boolean,
    ref?: { userId?: string | null; repoFullName?: string | null; issueNumber?: number | null },
  ) {
    await this.incidents.addActivity({ kind: 'error', title, service, url });
    if (dedupByService) {
      const existing = await this.incidents.hasActive(service, ref?.userId ?? undefined);
      if (existing) return existing;
    }
    const inc = await this.incidents.create({
      title, service, severity: 2, source: 'github',
      userId: ref?.userId ?? null,
      repoFullName: ref?.repoFullName ?? null,
      issueNumber: ref?.issueNumber ?? null,
    });
    this.agent.run(inc.id).catch(() => undefined);
    return inc;
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
