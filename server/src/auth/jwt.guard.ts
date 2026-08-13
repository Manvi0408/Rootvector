import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

export interface AuthedUser {
  userId: string;
  email: string;
}

export const SESSION_COOKIE = 'rv_session';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) throw new UnauthorizedException('Not authenticated');
    try {
      const payload = this.jwt.verify(token);
      req.user = { userId: payload.sub, email: payload.email } as AuthedUser;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired session');
    }
  }
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthedUser =>
    ctx.switchToHttp().getRequest().user,
);
