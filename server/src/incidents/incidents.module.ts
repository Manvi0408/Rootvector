import { Module } from '@nestjs/common';
import { IncidentsService } from './incidents.service';
import { AgentService } from './agent.service';
import { LlmService } from './llm.service';
import { IncidentsController } from './incidents.controller';
import { WebhooksController } from './webhooks.controller';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { IntegrationsModule } from '../integrations/integrations.module';

@Module({
  imports: [IntegrationsModule],
  controllers: [IncidentsController, WebhooksController],
  providers: [IncidentsService, AgentService, LlmService, JwtAuthGuard],
  exports: [IncidentsService, AgentService],
})
export class IncidentsModule {}
