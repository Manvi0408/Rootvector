import { Controller, Get, Post, Body, Param, Sse, UseGuards, MessageEvent } from '@nestjs/common';
import { Observable, interval, from } from 'rxjs';
import { concatMap, mergeMap, map } from 'rxjs/operators';
import { IncidentsService } from './incidents.service';
import { AgentService } from './agent.service';
import { LlmService } from './llm.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { JwtAuthGuard, CurrentUser, AuthedUser } from '../auth/jwt.guard';

@Controller()
@UseGuards(JwtAuthGuard)
export class IncidentsController {
  constructor(
    private readonly incidents: IncidentsService,
    private readonly agent: AgentService,
    private readonly integrations: IntegrationsService,
    private readonly llm: LlmService,
  ) {}

  /** Help assistant — real LLM answer when Gemini is configured, else null so
   *  the frontend falls back to its built-in knowledge base. */
  @Post('help/chat')
  async helpChat(@Body() b: { message: string }) {
    const reply = await this.llm.ask((b?.message || '').slice(0, 1000));
    return { reply, enabled: this.llm.enabled };
  }

  @Get('overview')
  async overview(@CurrentUser() u: AuthedUser) {
    const base = await this.incidents.overview(u.userId);
    // Pull recent LIVE GitHub activity so the dashboard fills the moment you connect.
    const gh = await this.integrations.githubActivity(u.userId).catch(() => null);
    if (gh && gh.length) {
      const activity = [...gh, ...base.activity].slice(0, 8);
      const services = new Set(
        [...gh, ...base.activity].map((a: any) => a.service).filter(Boolean),
      );
      return {
        stats: {
          activeIncidents: base.stats.activeIncidents,
          servicesMonitored: services.size,
          recentDeployments: base.stats.recentDeployments + gh.filter((a: any) => a.kind === 'deployment').length,
          alertsAnalyzed: base.stats.alertsAnalyzed + gh.filter((a: any) => a.kind === 'error').length,
        },
        activity,
        activeIncidents: base.activeIncidents,
        githubConnected: true,
      };
    }
    return { ...base, githubConnected: gh !== null };
  }

  @Get('incidents')
  list(@CurrentUser() u: AuthedUser) {
    return this.incidents.list(u.userId);
  }

  /** Recent incidents for the notification bell. */
  @Get('notifications')
  notifications(@CurrentUser() u: AuthedUser) {
    return this.incidents.list(u.userId);
  }

  /** Live notifications (SSE) — pushes every NEW incident the moment it's created,
   *  from any source (GitHub webhooks, Sentry, demo). Drives the bell in real time. */
  @Sse('notifications/stream')
  notificationsStream(@CurrentUser() u: AuthedUser): Observable<MessageEvent> {
    let since = Date.now();
    return interval(2000).pipe(
      concatMap(async () => {
        const list = await this.incidents.recentSince(since, u.userId).catch(() => [] as any[]);
        if (list.length) since = new Date(list[list.length - 1].startedAt).getTime();
        return list;
      }),
      mergeMap((list) => from(list)),
      map((inc) => ({ data: inc }) as MessageEvent),
    );
  }

  @Get('incidents/:key')
  get(@Param('key') key: string, @CurrentUser() u: AuthedUser) {
    return this.incidents.get(key, u.userId);
  }

  /** Live investigation stream (Server-Sent Events) — pushes new events as the agent works. */
  @Sse('incidents/:key/stream')
  stream(@Param('key') key: string, @CurrentUser() u: AuthedUser): Observable<MessageEvent> {
    let lastAt = 0;
    return interval(700).pipe(
      concatMap(async () => {
        const inc = await this.incidents.get(key, u.userId).catch(() => null);
        if (!inc) return [] as any[];
        const fresh = inc.events.filter((e) => new Date(e.at).getTime() > lastAt);
        if (fresh.length) lastAt = new Date(fresh[fresh.length - 1].at).getTime();
        return fresh.map((e) => ({
          kind: e.kind, message: e.message, data: e.data, at: e.at,
          status: inc.status, rootCause: inc.rootCause, confidence: inc.confidence,
        }));
      }),
      mergeMap((list) => from(list)),
      map((payload) => ({ data: payload }) as MessageEvent),
    );
  }

  /** Human approval → real remediation + verification + resolution. */
  @Post('incidents/:key/approve')
  approve(@Param('key') key: string, @CurrentUser() u: AuthedUser) {
    return this.incidents.approve(key, u.userId);
  }

  /** Human rejected the recommendation → recorded in History as cancelled. */
  @Post('incidents/:key/reject')
  reject(@Param('key') key: string, @CurrentUser() u: AuthedUser) {
    return this.incidents.reject(key, u.userId);
  }

  /** DEV/DEMO: simulate an incident, then let the agent investigate it live. */
  @Post('dev/simulate-incident')
  async simulate(@CurrentUser() u: AuthedUser) {
    const inc = await this.incidents.simulate(u.userId);
    this.agent.run(inc.id).catch(() => undefined); // fire-and-forget; streamed via SSE
    return inc;
  }

  /** DEV: clear all demo incidents + seeded activity. */
  @Post('dev/reset-demo')
  resetDemo(@CurrentUser() u: AuthedUser) {
    return this.incidents.resetDemo(u.userId);
  }
}
