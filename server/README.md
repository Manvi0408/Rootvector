# RootVector backend

Real authentication + user profile for RootVector (Phase 1 of the product plan).

**Stack:** NestJS 10 · Prisma · PostgreSQL · JWT (httpOnly cookie).

## What it does (Phase 1–2)

- Real accounts in Postgres (email/password with bcrypt).
- **Google** sign-in — verifies the Google **ID token server-side** and stores the real name, email and photo.
- **GitHub** sign-in — full OAuth code flow; the **client secret stays on the server**, never in the browser.
- Session = a signed JWT in an **httpOnly cookie** (`rv_session`). No token is ever exposed to the UI.
- `GET /api/me` returns the authenticated user's real profile. If the provider gave no photo, `avatarUrl` is `null` and the UI shows a blank avatar (never a fake one).

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/signup` | `{ email, password, firstName?, lastName? }` |
| POST | `/api/auth/login` | `{ email, password }` |
| POST | `/api/auth/google` | `{ idToken }` (from Google Identity Services) |
| GET | `/api/auth/github` | redirect to GitHub consent |
| GET | `/api/auth/github/callback` | GitHub returns here; sets cookie; redirects to the app |
| POST | `/api/auth/logout` | clears the session cookie |
| GET | `/api/me` | current user profile (401 if not signed in) |

## Setup

```bash
cd rootvector/server
cp .env.example .env
```

Edit `.env`:
- `JWT_SECRET` → a long random string (`openssl rand -hex 32`).
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` → from a GitHub OAuth App
  (https://github.com/settings/developers) whose **Authorization callback URL** is
  **`http://localhost:4000/api/auth/github/callback`**.
- `GOOGLE_CLIENT_ID` is already filled with your existing public client id.
  In Google Cloud Console, add `http://localhost:4178` to the client's
  **Authorized JavaScript origins** (for the frontend popup).

Then:

```bash
docker compose up -d          # Postgres on host port 5433
npm install
npx prisma generate
npx prisma migrate dev --name init
npm run start:dev             # http://localhost:4000/api
```

(Or just `npm run setup` to do install + db + generate + migrate in one go, then `npm run start:dev`.)

## Security notes

- OAuth **secrets and access tokens never reach the frontend** — the browser only ever holds the httpOnly session cookie.
- CORS is locked to `FRONTEND_URL` with credentials.
- Passwords are bcrypt-hashed; only safe profile fields are returned by the API.
