import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  Res,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { SESSION_COOKIE } from './jwt.guard';
import { IntegrationsService } from '../integrations/integrations.service';

// In production the frontend and backend are on different HTTPS hosts, so the
// session cookie must be SameSite=None; Secure to be stored/sent cross-site.
// Locally (http backend) we keep Lax so it works without HTTPS.
const CROSS_SITE = (process.env.BACKEND_PUBLIC_URL ?? '').startsWith('https://');

function sessionCookieOpts() {
  return {
    httpOnly: true as const, // never readable by JS → no token in the UI
    sameSite: (CROSS_SITE ? 'none' : 'lax') as 'none' | 'lax',
    secure: CROSS_SITE, // required alongside SameSite=None
    path: '/',
  };
}

function setSession(res: Response, token: string) {
  res.cookie(SESSION_COOKIE, token, {
    ...sessionCookieOpts(),
    maxAge: 7 * 24 * 3600 * 1000,
  });
}

const GH_CALLBACK = () =>
  `${process.env.BACKEND_PUBLIC_URL ?? 'http://localhost:4000'}/api/auth/github/callback`;

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly jwt: JwtService,
    private readonly integrations: IntegrationsService,
  ) {}

  @Post('signup')
  async signup(
    @Body()
    b: { email: string; password: string; firstName?: string; lastName?: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!b?.email || !b?.password) {
      throw new BadRequestException('email and password are required');
    }
    const user = await this.auth.signup(b);
    setSession(res, this.auth.sign(user));
    return this.auth.publicUser(user);
  }

  @Post('login')
  async login(
    @Body() b: { email: string; password: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = await this.auth.login(b.email, b.password);
    setSession(res, this.auth.sign(user));
    return this.auth.publicUser(user);
  }

  @Post('google')
  async google(
    @Body() b: { accessToken?: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!b?.accessToken) throw new BadRequestException('accessToken is required');
    const user = await this.auth.loginWithGoogle(b.accessToken);
    setSession(res, this.auth.sign(user));
    return this.auth.publicUser(user);
  }

  /** Step 1: bounce the user to GitHub's consent screen. */
  @Get('github')
  github(@Res() res: Response) {
    const clientId = process.env.GITHUB_CLIENT_ID;
    if (!clientId) {
      return res
        .status(500)
        .send('GITHUB_CLIENT_ID not configured on the backend.');
    }
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: GH_CALLBACK(),
      scope: 'read:user user:email',
      state: Math.random().toString(36).slice(2),
    });
    res.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
  }

  /** Step 2: GitHub returns ?code — exchanged here with the secret, server-side. */
  @Get('github/callback')
  async githubCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (!code) throw new BadRequestException('missing code');

    const tokenResp = await fetch(
      'https://github.com/login/oauth/access_token',
      {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: process.env.GITHUB_CLIENT_ID,
          client_secret: process.env.GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: GH_CALLBACK(),
        }),
      },
    );
    const tok: any = await tokenResp.json();
    const access = tok?.access_token;
    if (!access) throw new UnauthorizedException('GitHub token exchange failed');

    const gh: any = await (
      await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${access}`,
          'User-Agent': 'rootvector',
          Accept: 'application/json',
        },
      })
    ).json();

    let email: string | undefined = gh?.email ?? undefined;
    if (!email) {
      const emails: any = await (
        await fetch('https://api.github.com/user/emails', {
          headers: {
            Authorization: `Bearer ${access}`,
            'User-Agent': 'rootvector',
            Accept: 'application/json',
          },
        })
      ).json();
      if (Array.isArray(emails)) {
        const primary = emails.find((e: any) => e.primary) ?? emails[0];
        email = primary?.email;
      }
    }

    const front = process.env.FRONTEND_URL ?? 'http://localhost:4178';

    // "connect" flow: the user is already signed in and is linking GitHub as an
    // integration. Identify them from the session cookie and store the token.
    if (state === 'connect') {
      const sess = (req as any).cookies?.[SESSION_COOKIE];
      let userId: string | undefined;
      try { userId = this.jwt.verify(sess).sub; } catch { userId = undefined; }
      if (userId) {
        const scope = (tok?.scope as string) || 'repo';
        await this.integrations.connect(userId, 'github', access, gh.login, scope);
        return res.redirect(`${front}/app.html?t=${Date.now()}#/integrations`);
      }
      // no valid session → fall through to a normal login
    }

    // "login" flow
    const user = await this.auth.loginWithGithub({
      id: gh.id,
      login: gh.login,
      name: gh.name,
      email,
      avatar_url: gh.avatar_url,
    });
    // Signing in WITH GitHub also connects it as an integration, so the user
    // lands straight on their dashboard (real repos/activity) — never asked to
    // "connect your stack" again. Their token/repos are their own (per user).
    try {
      const scope = (tok?.scope as string) || 'read:user user:email';
      await this.integrations.connect(user.id, 'github', access, gh.login, scope);
    } catch { /* non-fatal: auth still succeeds */ }
    setSession(res, this.auth.sign(user));
    res.redirect(`${front}/app.html?t=${Date.now()}`);
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(SESSION_COOKIE, sessionCookieOpts());
    return { ok: true };
  }
}
