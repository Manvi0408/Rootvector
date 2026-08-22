import { Controller, Post, Body } from '@nestjs/common';
import { LlmService } from './llm.service';

/** Public (no-auth) help endpoint for the marketing landing-page chatbox.
 *  Answers questions about RootVector; the frontend falls back to a built-in
 *  FAQ when the LLM isn't configured. */
@Controller('public')
export class PublicHelpController {
  constructor(private readonly llm: LlmService) {}

  @Post('help')
  async help(@Body() b: { message: string }) {
    const reply = await this.llm.ask((b?.message || '').slice(0, 800));
    return { reply, enabled: this.llm.enabled };
  }
}
