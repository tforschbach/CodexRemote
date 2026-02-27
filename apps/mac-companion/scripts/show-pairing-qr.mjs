#!/usr/bin/env node
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function main() {
  const port = Number.parseInt(process.env.PORT ?? '8787', 10);
  const host = process.env.BIND_HOST ?? '127.0.0.1';

  const response = await fetch(`http://${host}:${port}/v1/pairing/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  });

  if (!response.ok) {
    throw new Error(`Failed to create pairing request: ${response.status}`);
  }

  const payload = await response.json();
  const dir = await mkdtemp(join(tmpdir(), 'codex-remote-pairing-'));
  const htmlPath = join(dir, 'pairing.html');

  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Codex Remote Pairing</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 24px; }
      img { width: 320px; height: 320px; border: 1px solid #ddd; border-radius: 8px; }
      code { display: block; margin-top: 16px; padding: 12px; background: #f5f5f5; border-radius: 8px; word-break: break-all; }
    </style>
  </head>
  <body>
    <h1>Codex Remote Pairing</h1>
    <p>Scan this QR code with the iOS app.</p>
    <img src="${payload.qrDataUrl}" alt="Pairing QR" />
    <code>${payload.pairingUri}</code>
  </body>
</html>`;

  await writeFile(htmlPath, html, 'utf8');
  await execFileAsync('open', [htmlPath]);

  // eslint-disable-next-line no-console
  console.log(`Pairing page opened: ${htmlPath}`);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
});
