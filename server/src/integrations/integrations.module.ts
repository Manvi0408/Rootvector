import { Module } from '@nestjs/common';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { CryptoService } from '../common/crypto.service';
import { JwtAuthGuard } from '../auth/jwt.guard';

@Module({
  controllers: [IntegrationsController],
  providers: [IntegrationsService, CryptoService, JwtAuthGuard],
  exports: [IntegrationsService, CryptoService],
})
export class IntegrationsModule {}
