// Copies the static frontend (html + assets) from the repo root into
// server/public so the NestJS backend can serve it same-origin. Runs after
// `nest build`. Serving from a dedicated folder (not the repo root) keeps
// server/.env and source files from ever being exposed as static assets.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..'); // repo root
const out = path.join(__dirname, '..', 'public'); // server/public

fs.mkdirSync(out, { recursive: true });

const files = ['index.html', 'login.html', 'signup.html', 'app.html'];
for (const f of files) {
  const src = path.join(root, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(out, f));
}

const assetsSrc = path.join(root, 'assets');
if (fs.existsSync(assetsSrc)) {
  fs.cpSync(assetsSrc, path.join(out, 'assets'), { recursive: true });
}

console.log('[copy-frontend] frontend copied into', out);
