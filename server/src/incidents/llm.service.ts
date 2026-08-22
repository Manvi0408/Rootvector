import { Injectable } from '@nestjs/common';

export interface Verdict {
  steps: string[];
  evidence: string[];
  hypotheses: { title: string; confidence: number; for?: string; against?: string }[];
  rootCause: { title: string; confidence: number; why: string[] };
  recommendation: { action: string; risk: string; rationale: string };
}

/**
 * LLM reasoning for the investigation agent, powered by Google Gemini.
 * Enabled only when GEMINI_API_KEY is set. Uses the Gemini REST API over
 * fetch (no SDK dependency), so the app runs fine on the grounded engine
 * without a key.
 */
@Injectable()
export class LlmService {
  private get model(): string {
    return process.env.LLM_MODEL || 'gemini-flash-latest';
  }

  get enabled(): boolean {
    return !!process.env.GEMINI_API_KEY;
  }

  /** Free-form help chat. Returns a conversational answer, or null if the LLM
   *  isn't configured / failed (the caller then falls back to the local FAQ). */
  async ask(message: string): Promise<string | null> {
    if (!this.enabled) return null;
    const system =
      'You are the RootVector Assistant, a friendly AI helper inside RootVector — an AI ' +
      'production-incident investigation platform. Context about RootVector: it connects to a ' +
      "team's stack (GitHub, Sentry, Datadog, Grafana, Kubernetes, OpenTelemetry), detects incidents " +
      'from real signals, runs an autonomous AI investigation that correlates deployments, PRs, errors ' +
      'and traces to find a root cause with a confidence score, recommends a reversible fix, and requires ' +
      'explicit human approval before executing anything; it then verifies recovery. The UI has pages: ' +
      'Overview, Investigations, Services, History, Repositories, Integrations, Ask AI. ' +
      'Answer the user conversationally and concisely (2-4 sentences). Greet back if greeted. ' +
      'Prefer answering about RootVector, but you may answer general questions helpfully too.';
    try {
      const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent` +
        `?key=${encodeURIComponent(process.env.GEMINI_API_KEY as string)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: message }] }],
          generationConfig: { maxOutputTokens: 1024, temperature: 0.6, thinkingConfig: { thinkingBudget: 0 } },
        }),
      });
      if (!res.ok) return null;
      const data: any = await res.json();
      // thinking models can return a "thought" part before the answer — join all text parts
      const parts: any[] = data?.candidates?.[0]?.content?.parts || [];
      const text = parts.map((p) => p?.text).filter(Boolean).join('').trim();
      return text || null;
    } catch {
      return null;
    }
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
      const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent` +
        `?key=${encodeURIComponent(process.env.GEMINI_API_KEY as string)}`;

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 2048, temperature: 0.2 },
        }),
      });
      if (!res.ok) return null;

      const data: any = await res.json();
      const parts: any[] = data?.candidates?.[0]?.content?.parts || [];
      const text = parts.map((p) => p?.text).filter(Boolean).join('').trim();
      if (!text) return null;

      const cleaned = text.replace(/^```json\s*|\s*```$/g, '');
      const verdict = JSON.parse(cleaned) as Verdict;
      return verdict;
    } catch {
      return null; // fall back to the grounded heuristic in AgentService
    }
  }
}
