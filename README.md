<p align="center">
  <img src="./img.png" alt="RootVector Dashboard" width="100%">
</p>

<h1 align="center">RootVector</h1>

<p align="center">
  <strong>An autonomous AI agent that investigates production incidents — and proves its work.</strong>
</p>

<p align="center">
  RootVector connects to your engineering stack, detects incidents from real monitoring signals, and runs the
  investigation itself — correlating deployments, pull requests, errors and traces into a
  <strong>root cause backed by evidence and a confidence score</strong>. It recommends a reversible fix, waits for a
  human to approve, executes, then <strong>verifies recovery against live metrics</strong>.
</p>

<p align="center">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white">
  <img alt="NestJS" src="https://img.shields.io/badge/NestJS-E0234E?logo=nestjs&logoColor=white">
  <img alt="Prisma" src="https://img.shields.io/badge/Prisma-2D3748?logo=prisma&logoColor=white">
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-4169E1?logo=postgresql&logoColor=white">
  <img alt="Gemini" src="https://img.shields.io/badge/LLM-Gemini-8E75B2?logo=googlegemini&logoColor=white">
  <img alt="Human-in-the-loop" src="https://img.shields.io/badge/policy-human--in--the--loop-16a34a">
  <img alt="License MIT" src="https://img.shields.io/badge/license-MIT-black">
</p>

<p align="center"><em>Find the cause. Verify the evidence. Fix the system.</em></p>

---

## Why this matters

When production breaks, one engineer drops everything and spends **30–60 minutes** manually stitching together logs, deployments, GitHub, Slack and past incidents to find the cause. The real cost isn't the downtime — it's the context-switching and the same manual detective work, **every single time**.

RootVector automates the detective work, not the decision. The agent does the correlation a senior engineer would do, shows its evidence, scores its own confidence, and then **hands the decision to a human**. Nothing destructive runs without approval — and after it does, the system confirms the fix actually worked.

---

## What makes it interesting (for engineers)

| | |
|---|---|
| 🧠 **Agentic investigation, not a chatbot** | The agent gathers real evidence (deployments, PRs, error rates), forms **competing hypotheses each with a confidence score**, and grounds a root cause strictly in that evidence — no free-floating speculation. |
| 🔬 **Grounded + LLM-optional** | It runs an LLM (Google Gemini) when configured, and falls back to a **deterministic correlation engine** otherwise — so the pipeline is fully functional and reproducible with zero API keys. |
| 👤 **Human-in-the-loop by design** | The agent investigates and *recommends*; a person must **Approve & Execute** before any remediation runs. Approval is the control plane, not an afterthought. |
| ✅ **Closed-loop verification** | After remediation, RootVector re-checks the metrics and only marks an incident resolved once recovery is verified. |
| 🔁 **Real-time streaming** | Every investigation step streams to the browser over **Server-Sent Events** — you watch the agent reason live. |
| 🔒 **Security-first** | OAuth secrets never reach the browser; provider tokens are **AES-256-GCM encrypted at rest**; inbound webhooks are **HMAC signature-verified**; sessions are a signed JWT in an **httpOnly cookie**. |
| 🧑‍🤝‍🧑 **Fully multi-tenant** | Every incident, repository and activity feed is **scoped per user** — GitHub-webhook incidents are attributed to the repo owner, and one user can never see or act on another's incidents. |
| 🐙 **Acts on the real world** | On approval, RootVector **comments on and closes the real GitHub issue** ("RootVector solved this") through the owner's `repo`-scoped token. |

---

## The investigation loop

```
DETECT ─▶ INVESTIGATE ─▶ REASON ─▶ RECOMMEND ─▶ APPROVE ─▶ REMEDIATE ─▶ VERIFY
  │           │             │           │           │           │           │
 real       gather        competing   reversible   human      execute    re-check
 signal     evidence      hypotheses  fix +        gate       fix        metrics →
 (webhook/  (deploys,     + root      risk note               (+ close   resolve
  Sentry)   PRs, errors)  cause,                              GitHub
                          confidence                          issue)
```

This is the same pipeline whether an incident arrives from a **live monitoring signal** or from built-in **Demo Mode** — Demo Mode runs the *real* engine, not a mock.

### Sequence of a real incident

```mermaid
sequenceDiagram
    autonumber
    participant Src as Monitoring / GitHub
    participant BE as Incident Engine
    participant AG as AI Agent
    participant DB as PostgreSQL
    participant UI as Dashboard (SSE)
    participant Eng as Engineer

    Src->>BE: Signed webhook (error / failed check / new issue)
    BE->>BE: Verify signature · dedup · attribute to owner
    BE->>DB: Create incident (userId-scoped)
    BE->>AG: Run investigation
    AG->>AG: Gather evidence · correlate · form hypotheses
    AG->>DB: Persist evidence, hypotheses, root cause, recommendation
    AG-->>UI: Stream every step (Server-Sent Events)
    UI-->>Eng: Root cause + confidence + recommended fix
    Eng->>BE: Approve & Execute
    BE->>BE: Remediate → verify recovery
    BE->>Src: Comment on + close the real GitHub issue
    BE->>DB: Mark resolved
    BE-->>UI: Recovery verified ✓
```

---

## Architecture

```mermaid
flowchart LR
  U([Engineer]) --> FE["Frontend<br/>Static HTML/CSS/JS<br/>Marketing · Auth · Dashboard"]

  FE -->|"REST + SSE<br/>httpOnly Cookie"| BE

  subgraph BE["NestJS Backend"]
    direction TB
    A["Authentication<br/>Google · GitHub · Email · JWT"]
    I["Integrations<br/>GitHub · Sentry · Datadog · Grafana<br/>Encrypted Tokens · Webhooks"]
    N["Incident Engine<br/>Detection · Investigation<br/>Remediation · Verification · SSE"]
    A --> I
    I --> N
  end

  BE --> DB[("PostgreSQL<br/>Prisma")]

  GH["GitHub"] -->|"OAuth + Webhooks"| I
  SEN["Sentry"] -->|"Signed Webhooks"| N
  DD["Datadog"] -->|"Alert Webhooks"| N
  GF["Grafana"] -->|"Alert Webhooks"| N

  N --> AGENT["AI Investigation Agent<br/>Evidence · Correlation<br/>Hypotheses · Confidence"]
  AGENT -.->|"Optional"| LLM["LLM<br/>Gemini"]
  AGENT --> RCA["Root Cause + Evidence<br/>Confidence Score"]
  RCA --> FIX["Recommended Fix<br/>Human Approval"]
  FIX --> REM["Remediation<br/>(+ close GitHub issue)"]
  REM --> VERIFY["Recovery Verification<br/>Metrics + Monitoring"]
  VERIFY --> N
```

**Layers**

- **Frontend** — static HTML/CSS/JS (no build step): marketing site, auth pages, single-page dashboard. Talks to the API over REST + Server-Sent Events with an httpOnly session cookie.
- **Backend (NestJS)** — `auth` (Google/GitHub/email + JWT), `integrations` (provider OAuth, AES-256-GCM token storage, signature-verified webhooks), `incidents` (the pipeline, the AI investigation agent, SSE streaming).
- **Data** — PostgreSQL via Prisma: users, integrations, incidents, investigation events, activity, webhook deliveries — all incident data scoped by `userId`.
- **AI agent** — gathers real evidence and produces hypotheses, a root cause and a recommendation; uses an LLM when configured, and a grounded correlation engine otherwise.

---

## How the agent reasons

The investigation is deliberately **evidence-first**:

1. **Evidence collection** — the agent pulls the real signals around the failing service: recent deployments, merged PRs, error activity and the current error rate. No evidence, no claim.
2. **Hypothesis generation** — it proposes competing explanations, each with a **confidence integer** (the set sums to ~100), plus a *for* / *against* note so the reasoning is auditable.
3. **Root cause** — the highest-support hypothesis is promoted to a root cause with a `why` list that cites only the gathered evidence.
4. **Recommendation** — a **low-risk, reversible** remediation (e.g. a rollback), with an explicit risk rating and rationale.
5. **Guardrails** — steps are safe activity lines (no raw chain-of-thought), the model is instructed to never invent data, and when the LLM is unavailable the deterministic engine produces the same shape of grounded verdict.

> Design principle: the LLM is an accelerator, not a dependency. Remove the key and RootVector still detects, investigates, recommends, and verifies.

---

## Feature highlights

- **Real authentication** — email/password, **Google** (token verified server-side) and **GitHub** (OAuth, secret stays on the server). Sessions are a signed JWT in an **httpOnly cookie** — no token is ever exposed to the browser.
- **Per-user everything** — incidents, repositories and activity are isolated per account; GitHub-webhook incidents are attributed to the connected repo owner, and cross-user access is rejected.
- **GitHub integration** — connect your account and see your real repositories and recent activity (commits, PRs, pushes). Tokens are stored **AES-256-GCM encrypted** at rest.
- **"RootVector solved this"** — when a GitHub-issue incident is approved, RootVector comments the investigation summary on the real issue and closes it via the owner's `repo`-scoped token.
- **Incident pipeline** — a real, persisted `incident → investigation → remediation → verification` flow. A monitoring error (Sentry) opens an incident automatically; **Demo Mode** runs the *same* pipeline for demonstrations.
- **Live investigation UI** — the agent's steps stream to the browser over **Server-Sent Events**; hypotheses, root cause and recommendation render as they arrive.
- **Integrations framework** — GitHub live; Sentry (webhook, signature-verified) ready; Datadog, Kubernetes, OpenTelemetry, Slack and Grafana onboard through a shared alert-webhook contract.

---

## Tech stack

| Layer | Technology |
|---|---|
| **Frontend** | Self-contained HTML / CSS / JS (no build step) — marketing site, auth pages, single-page dashboard, served statically |
| **Backend** | NestJS (TypeScript) · REST + Server-Sent Events |
| **Data** | PostgreSQL · Prisma ORM |
| **Auth** | Google · GitHub OAuth · email/password · JWT in an httpOnly cookie |
| **Security** | AES-256-GCM token encryption · HMAC-verified webhooks |
| **AI** | Google Gemini (optional) with a deterministic correlation-engine fallback |

---

## Getting started

### 1. Backend (`server/`)

```bash
cd server
cp .env.example .env          # fill in JWT_SECRET, GitHub OAuth, etc.
docker compose up -d          # Postgres on :5433  (or: node pg-dev.js — embedded Postgres, no Docker)
npm install
npx prisma generate
npx prisma migrate deploy     # apply migrations (dev: npx prisma db push)
npm run start:dev             # http://localhost:4000/api
```

Fill in `server/.env`:

| Variable | What it is |
|---|---|
| `JWT_SECRET` | A long random string — `openssl rand -hex 32` |
| `INTEGRATIONS_ENCRYPTION_KEY` | 32 bytes hex — `openssl rand -hex 32` |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | A GitHub OAuth App (callback `http://localhost:4000/api/auth/github/callback`) |
| `GOOGLE_CLIENT_ID` | A Google OAuth Web client (origin `http://localhost:4178`) |
| `GEMINI_API_KEY` *(optional)* | Enables LLM-driven investigation. Free key: https://aistudio.google.com/apikey |
| `LLM_MODEL` *(optional)* | Defaults to `gemini-flash-latest` |

> **GitHub scope:** RootVector requests `repo` so it can comment on and close the real issue after a human approves the fix.

### 2. Frontend (repo root)

```bash
python -m http.server 4178
```

Open **http://localhost:4178/login.html**, sign in, and you're on the dashboard.

---

## Project structure

```
rootvector/
├─ index.html            # marketing site
├─ login.html            # sign in (Google · GitHub · email)
├─ signup.html           # create account
├─ app.html              # dashboard (SPA: overview, investigations, services,
│                        #   repositories, integrations, settings)
├─ assets/               # all images
└─ server/               # NestJS backend
   ├─ prisma/schema.prisma
   └─ src/
      ├─ auth/           # email/Google/GitHub auth, JWT guard
      ├─ users/          # /api/me
      ├─ integrations/   # GitHub connect + repos + activity (encrypted tokens)
      └─ incidents/      # incident pipeline, investigation agent, SSE, webhooks
```

---

## Security

- OAuth **secrets and access tokens never reach the frontend** — the browser only holds the httpOnly session cookie.
- Provider tokens are **encrypted at rest** (AES-256-GCM).
- Inbound webhooks are **HMAC signature-verified**; unsigned deliveries are recorded but never trusted.
- Every incident query is **scoped to the authenticated user**; cross-user access returns `404`.
- Destructive remediation requires **explicit human approval**.
- `.env` files are git-ignored; never commit real secrets.

---

## Roadmap

- [x] Per-user, multi-tenant incident isolation
- [x] Close the real GitHub issue on approval ("RootVector solved this")
- [ ] First-class Datadog / Grafana / Kubernetes / OpenTelemetry connect UIs
- [ ] Slack two-way approvals (approve a fix from Slack)
- [ ] Postmortem generation from the persisted investigation timeline

---

## License

MIT

---

<p align="center">Built by <a href="https://github.com/Manvi0408">Manvi Yadav</a> · if RootVector is useful, leave a ⭐</p>
