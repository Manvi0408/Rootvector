import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { IncidentsModule } from './incidents/incidents.module';
import { UsersController } from './users/users.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET ?? 'dev-only-insecure-secret',
      signOptions: { expiresIn: '7d' },
    }),
    // Serve the static frontend (copied to server/public at build time) from
    // the same origin as the API, so the session cookie is first-party.
    // Anything under /api is left to the controllers.
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'public'),
      exclude: ['/api/{*path}'],
    }),
    PrismaModule,
    AuthModule,
    IntegrationsModule,
    IncidentsModule,
  ],
  controllers: [UsersController],
})
export class AppModule {}
