import { Controller, Get, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard, CurrentUser, AuthedUser } from '../auth/jwt.guard';

@Controller()
export class UsersController {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /api/me — the authenticated user's real profile (or 401). */
  @UseGuards(JwtAuthGuard)
  @Get('me')
  async me(@CurrentUser() u: AuthedUser) {
    const user = await this.prisma.user.findUnique({ where: { id: u.userId } });
    if (!user) return null;
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      name: user.name,
      avatarUrl: user.avatarUrl, // null => frontend renders a blank avatar
      provider: user.provider,
    };
  }
}
