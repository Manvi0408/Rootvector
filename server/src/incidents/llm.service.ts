import { Injectable } from '@nestjs/common';

export interface Verdict {
  steps: string[];
  evidence: string[];
  hypotheses: { title: string; confidence: number; for?: string; against?: string }[];
  rootCause: { title: string; confidence: number; why: string[] };
  recommendation: { action: string; risk: string; rationale: string };
}

/**
 * Real LLM reasoning for the investigation agent. Enabled only when
 * ANTHROPIC_API_KEY and LLM_MODEL are set. The SDK is imported lazily so the
 * app runs fine (on the grounded engine) without a key.
 */
@Injectable()
export class LlmService {
  private client: any = null;

  get enabled(): boolean {
    return !!(process.env.ANTHROPIC_API_KEY && process.env.LLM_MODEL);
  }

  private async anthropic() {
    if (!this.client) {
      const mod = await import('@anthropic-ai/sdk');
      const Anthropic = mod.default;
      this.client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
    }
    return this.client;
  }

  /** Analyze real incident evidence; returns a grounded verdict, or null if disabled/failed. */
  async analyze(input: { service: string; evidence: string[] }): Promise<Verdict | null> {
    if (!this.enabled) return null;
    const system =
      'You are RootVector, an autonomous production-incident investigation agent. ' +
      'You are given REAL evidence gathered from a service (deployments, pull requests, errors, error rate). ' +
      'Analyze it and reply with ONLY a JSON object, no prose, matching exactly:\n' +
      '{"steps":[string],"evidence":[string],"hypotheses":[{"title":string,"confidence":number,"for":string,"against":string}],' +
      '"rootCause":{"title":string,"confidence":number,"why":[string]},"recommendation":{"action":string,"risk":string,"rationale":string}}\n' +
      'Rules: confidences are integers summing to ~100 across hypotheses; ground every claim ONLY in the provided evidence; ' +
      'never invent data; "steps" are short, safe activity lines (no chain-of-thought); recommend a low-risk, reversible remediation (e.g. a rollback).';
    const user =
      `Service: ${input.service}\nEvidence:\n` +
      input.evidence.map((e, i) => `${i + 1}. ${e}`).join('\n');

    try {
      const client = await this.anthropic();
      const res = await client.messages.create({
        model: process.env.LLM_MODEL,
        max_tokens: 2000,
        system,
        messages: [{ role: 'user', content: user }],
      });
      const block = (res.content || []).find((b: any) => b.type === 'text');
      if (!block) return null;
      const text: string = block.text.trim().replace(/^```json\s*|\s*```$/g, '');
      const verdict = JSON.parse(text) as Verdict;
      return verdict;
    } catch {
      return null; // fall back to the grounded heuristic in AgentService
    }
  }
}
