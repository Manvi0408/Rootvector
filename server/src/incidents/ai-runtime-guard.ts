/**
 * AiRuntimeGuard — a minimal AI runtime-security gateway that sits between the
 * agent and the LLM, inspecting every prompt on the way out and every response
 * on the way back. This mirrors, in miniature, what a dedicated AI runtime
 * security product does:
 *
 *  - PROMPT firewall  : data-leak prevention (redact secrets/PII before they
 *                       reach the model) + prompt-injection detection.
 *  - RESPONSE firewall: exfiltration detection (outbound URLs, markdown-image
 *                       beacons, secrets echoed in output) → block.
 *  - AGENT firewall   : runtime enforcement of the read-only tool allowlist
 *                       (excessive-agency prevention).
 *
 * Every decision produces a structured GuardFinding so the agent can emit
 * security telemetry. The guard is dependency-free and pure, so it is trivially
 * unit-testable and reusable.
 */

export type GuardCategory =
  | 'prompt-injection'
  | 'data-leak'
  | 'exfiltration'
  | 'excessive-agency'
  | 'schema-violation';

export type GuardAction = 'allow' | 'redact' | 'block';
export type GuardSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface GuardFinding {
  category: GuardCategory;
  action: GuardAction;
  severity: GuardSeverity;
  detail: string;
}

export interface PromptInspection {
  text: string; // possibly redacted
  findings: GuardFinding[];
}

export interface ResponseInspection {
  text: string;
  allowed: boolean; // false → the response must not be trusted/used
  findings: GuardFinding[];
}

// Secret / PII shapes that must never be sent to the model, nor echoed back.
const SECRET_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\bAKIA[0-9A-Z]{16}\b/g, label: 'AWS access key id' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, label: 'GitHub token' },
  { re: /\bAIza[0-9A-Za-z_\-]{20,}\b/g, label: 'Google API key' },
  { re: /\bsk-[A-Za-z0-9]{20,}\b/g, label: 'secret key' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, label: 'Slack token' },
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, label: 'JWT' },
  { re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, label: 'email address (PII)' },
];

// Instruction-hijack / secret-exfiltration prompt patterns.
const INJECTION_PATTERNS: { re: RegExp; detail: string }[] = [
  { re: /ignore\s+(all\s+)?(the\s+)?(previous|prior|above)\s+instructions?/i, detail: 'instruction override' },
  { re: /disregard\s+(the\s+)?(above|previous|prior)/i, detail: 'instruction override' },
  { re: /(reveal|print|show|dump|leak|expose)\b[^.\n]{0,40}\b(env|environment|secret|api[\s_-]?key|token|credential|system\s*prompt|password)/i, detail: 'secret-exfiltration request' },
  { re: /\bsystem\s*:/i, detail: 'fake system role' },
  { re: /you\s+are\s+now\b/i, detail: 'role reassignment' },
  { re: /new\s+instructions?\s*:/i, detail: 'instruction injection' },
];

export class AiRuntimeGuard {
  /** Prompt firewall: redact secrets/PII (DLP) and neutralize injection before egress. */
  inspectPrompt(input: string): PromptInspection {
    let text = (input ?? '').toString();
    const findings: GuardFinding[] = [];

    for (const { re, label } of SECRET_PATTERNS) {
      if (re.test(text)) {
        findings.push({ category: 'data-leak', action: 'redact', severity: 'high', detail: `${label} redacted from prompt before egress` });
        text = text.replace(new RegExp(re.source, re.flags), '⟦redacted-secret⟧');
      }
    }
    for (const { re, detail } of INJECTION_PATTERNS) {
      if (re.test(text)) {
        findings.push({ category: 'prompt-injection', action: 'redact', severity: 'medium', detail: `possible prompt injection (${detail}) — neutralized, treated as data` });
        text = text.replace(new RegExp(re.source, re.flags + (re.flags.includes('g') ? '' : 'g')), '⟦redacted-instruction⟧');
      }
    }
    return { text, findings };
  }

  /** Response firewall: block secrets echoed back or any exfiltration channel. */
  inspectResponse(input: string): ResponseInspection {
    const text = (input ?? '').toString();
    const findings: GuardFinding[] = [];
    let allowed = true;

    for (const { re, label } of SECRET_PATTERNS) {
      // Emails alone in a response aren't necessarily a breach; secrets are.
      if (label.includes('PII')) continue;
      if (re.test(text)) {
        findings.push({ category: 'data-leak', action: 'block', severity: 'critical', detail: `${label} present in model output — blocked` });
        allowed = false;
      }
    }
    // Markdown-image beacon: classic data-exfiltration-on-render trick.
    if (/!\[[^\]]*\]\(\s*https?:\/\//i.test(text)) {
      findings.push({ category: 'exfiltration', action: 'block', severity: 'high', detail: 'markdown image beacon in output — blocked' });
      allowed = false;
    }
    // Any outbound URL: the agent's verdict has no legitimate reason to emit one.
    const url = text.match(/https?:\/\/[^\s)"']+/i);
    if (url) {
      findings.push({ category: 'exfiltration', action: 'block', severity: 'high', detail: `outbound URL in output (${url[0].slice(0, 60)}) — blocked` });
      allowed = false;
    }
    return { text, allowed, findings };
  }

  /** Agent firewall: runtime enforcement of the read-only tool allowlist. */
  authorizeTool(name: string, allowlist: string[]): GuardFinding | null {
    if (allowlist.includes(name)) return null;
    return {
      category: 'excessive-agency',
      action: 'block',
      severity: 'high',
      detail: `blocked out-of-scope tool request: ${name || '(empty)'} — not on the read-only allowlist`,
    };
  }
}
