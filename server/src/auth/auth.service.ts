import {
  Injectable,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';

type DbUser = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  name: string | null;
  avatarUrl: string | null;
  provider: string;
};

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  /** Mint the session JWT that goes into the httpOnly cookie. */
  sign(user: { id: string; email: string }): string {
    return this.jwt.sign({ sub: user.id, email: user.email });
  }

  /** Only fields that are safe to send to the browser. Never the hash. */
  publicUser(u: DbUser) {
    return {
      id: u.id,
      email: u.email,
      firstName: u.firstName,
      lastName: u.lastName,
      name: u.name,
      avatarUrl: u.avatarUrl,
      provider: u.provider,
    };
  }

  async signup(b: {
    email: string;
    password: string;
    firstName?: string;
    lastName?: string;
  }) {
    const email = b.email.toLowerCase().trim();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) throw new ConflictException('Email already registered.');

    const passwordHash = await bcrypt.hash(b.password, 10);
    const name = [b.firstName, b.lastName].filter(Boolean).join(' ') || null;
    return this.prisma.user.create({
      data: {
        email,
        passwordHash,
        firstName: b.firstName ?? null,
        lastName: b.lastName ?? null,
        name,
        provider: 'password',
      },
    });
  }

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
    });
    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Invalid credentials.');
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Invalid credentials.');
    return user;
  }

  /**
   * Verify a Google access token by calling Google's userinfo endpoint
   * server-side, then upsert the real profile (name, email, photo).
   */
  async loginWithGoogle(accessToken: string) {
    const resp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) throw new UnauthorizedException('Invalid Google token.');
    const p: any = await resp.json();
    if (!p?.email) throw new UnauthorizedException('Google account has no email.');
    const email = String(p.email).toLowerCase();
    return this.prisma.user.upsert({
      where: { email },
      update: {
        googleId: p.sub,
        name: p.name ?? null,
        avatarUrl: p.picture ?? null,
        firstName: p.given_name ?? null,
        lastName: p.family_name ?? null,
        provider: 'google',
      },
      create: {
        email,
        googleId: p.sub,
        name: p.name ?? null,
        avatarUrl: p.picture ?? null,
        firstName: p.given_name ?? null,
        lastName: p.family_name ?? null,
        provider: 'google',
      },
    });
  }

  /** Upsert from a real GitHub profile fetched with the OAuth access token. */
  async loginWithGithub(profile: {
    id: number;
    login: string;
    name?: string | null;
    email?: string | null;
    avatar_url?: string | null;
  }) {
    const email = (
      profile.email || `${profile.login}@users.noreply.github.com`
    ).toLowerCase();
    return this.prisma.user.upsert({
      where: { email },
      update: {
        githubId: String(profile.id),
        name: profile.name || profile.login,
        avatarUrl: profile.avatar_url ?? null,
        provider: 'github',
      },
      create: {
        email,
        githubId: String(profile.id),
        name: profile.name || profile.login,
        avatarUrl: profile.avatar_url ?? null,
        provider: 'github',
      },
    });
  }
}
