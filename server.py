#!/usr/bin/env python3
"""
Minimal OAuth backend for RootVector — GitHub token exchange.
Pure Python standard library, no pip installs.

Why this exists:
  A GitHub sign-in requires swapping the login `code` for an access token using
  your Client SECRET. The secret must NEVER live in the browser, so that one
  step happens here, server-side.

Setup:
  1) Create a GitHub OAuth App:  https://github.com/settings/developers  -> "New OAuth App"
       Homepage URL:               http://localhost:4178
       Authorization callback URL: http://localhost:5000/auth/github/callback
  2) Copy .env.example -> .env and paste your Client ID + Secret.
  3) Run this backend:            python server.py         (http://localhost:5000)
  4) Keep the static site up:     python -m http.server 4178   (in this folder)

Never commit .env — it holds your client secret (.gitignore already excludes it).
"""
import os, json, secrets, urllib.parse, urllib.request, http.server


def load_env():
    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(here, ".env")
    if os.path.exists(path):
        for line in open(path, encoding="utf-8"):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())


load_env()

GITHUB_CLIENT_ID     = os.environ.get("GITHUB_CLIENT_ID", "")
GITHUB_CLIENT_SECRET = os.environ.get("GITHUB_CLIENT_SECRET", "")
FRONTEND_ORIGIN      = os.environ.get("FRONTEND_ORIGIN", "http://localhost:4178")
BACKEND_ORIGIN       = os.environ.get("BACKEND_ORIGIN", "http://localhost:5000")
PORT                 = int(os.environ.get("PORT", "5000"))

_states = set()  # anti-CSRF: remember the states we issued


def http_post_json(url, data, headers):
    body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())


def http_get_json(url, headers):
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())


class Handler(http.server.BaseHTTPRequestHandler):
    def _redirect(self, url):
        self.send_response(302)
        self.send_header("Location", url)
        self.end_headers()

    def _html(self, code, msg):
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(msg.encode())

    def log_message(self, *a):
        pass  # keep the console quiet

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)

        # Step 1 — send the user to GitHub's consent screen
        if u.path == "/auth/github/login":
            if not GITHUB_CLIENT_ID:
                return self._html(500, "GITHUB_CLIENT_ID is not set. See .env.example")
            state = secrets.token_urlsafe(16)
            _states.add(state)
            params = urllib.parse.urlencode({
                "client_id": GITHUB_CLIENT_ID,
                "redirect_uri": BACKEND_ORIGIN + "/auth/github/callback",
                "scope": "read:user user:email",
                "state": state,
            })
            return self._redirect("https://github.com/login/oauth/authorize?" + params)

        # Step 2 — GitHub redirects back here with ?code=...  (secret used here, server-side only)
        if u.path == "/auth/github/callback":
            code = (q.get("code") or [""])[0]
            state = (q.get("state") or [""])[0]
            if not code or state not in _states:
                return self._html(400, "Invalid OAuth state or missing code.")
            _states.discard(state)
            try:
                tok = http_post_json(
                    "https://github.com/login/oauth/access_token",
                    {
                        "client_id": GITHUB_CLIENT_ID,
                        "client_secret": GITHUB_CLIENT_SECRET,
                        "code": code,
                        "redirect_uri": BACKEND_ORIGIN + "/auth/github/callback",
                    },
                    {"Accept": "application/json"},
                )
                access = tok.get("access_token")
                if not access:
                    return self._html(400, "Token exchange failed: " + json.dumps(tok))
                user = http_get_json(
                    "https://api.github.com/user",
                    {"Authorization": "Bearer " + access,
                     "User-Agent": "rootvector",
                     "Accept": "application/json"},
                )
                # A real app would set a signed session cookie here. For this demo we
                # verified the identity server-side and now drop the user into the app.
                login = urllib.parse.quote(user.get("login", ""))
                dest = FRONTEND_ORIGIN + "/app.html#/investigations/INC-2841"
                return self._redirect(dest)
            except Exception as e:
                return self._html(500, "OAuth error: " + str(e))

        return self._html(404, "Not found")


if __name__ == "__main__":
    print("RootVector auth backend  ->  %s   (frontend: %s)" % (BACKEND_ORIGIN, FRONTEND_ORIGIN))
    if not (GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET):
        print("!! GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET are empty — copy .env.example to .env and fill them in.")
    http.server.HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
