import {
  Controller,
  Get,
  Post,
  Body,
  Res,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import type { Response } from 'express';
import { IntegrationsService } from './integrations.service';
import { JwtAuthGuard, CurrentUser, AuthedUser } from '../auth/jwt.guard';

@Controller()
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  /** Integrations UI state (no tokens). */
  @UseGuards(JwtAuthGuard)
  @Get('integrations')
  list(@CurrentUser() u: AuthedUser) {
    return this.integrations.list(u.userId);
  }

  /**
   * Start connecting GitHub: top-level redirect to GitHub with `repo` scope.
   * The single OAuth callback (in AuthController) finishes it, keyed by state.
   */
  @Get('integrations/github/connect')
  githubConnect(@Res() res: Response) {
    const clientId = process.env.GITHUB_CLIENT_ID;
    if (!clientId) {
      return res.status(500).send('GITHUB_CLIENT_ID not configured.');
    }
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: `${process.env.BACKEND_PUBLIC_URL ?? 'http://localhost:4000'}/api/auth/github/callback`,
      scope: 'read:user user:email repo',
      state: 'connect', // distinguishes connect from login on the shared callback
    });
    res.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
  }

  @UseGuards(JwtAuthGuard)
  @Post('integrations/github/disconnect')
  githubDisconnect(@CurrentUser() u: AuthedUser) {
    return this.integrations.disconnect(u.userId, 'github');
  }

  /** Connect Slack by saving an Incoming Webhook URL (stored encrypted). */
  @UseGuards(JwtAuthGuard)
  @Post('integrations/slack/connect')
  slackConnect(@CurrentUser() u: AuthedUser, @Body() b: { url: string }) {
    return this.integrations.connectSlack(u.userId, (b?.url || '').trim());
  }

  @UseGuards(JwtAuthGuard)
  @Post('integrations/slack/disconnect')
  slackDisconnect(@CurrentUser() u: AuthedUser) {
    return this.integrations.disconnect(u.userId, 'slack');
  }

  /** Real repositories from the connected GitHub account. */
  @UseGuards(JwtAuthGuard)
  @Get('github/repositories')
  async repositories(@CurrentUser() u: AuthedUser) {
    try {
      return await this.integrations.githubRepositories(u.userId);
    } catch (e: any) {
      throw new BadRequestException(e?.message || 'GitHub not connected');
    }
  }
}
