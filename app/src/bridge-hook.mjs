import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import http from 'node:http';
import { normalizeHook } from './copilot-events.mjs';

export async function sendHook(input, eventName, descriptorFile, provider = 'vscode-copilot') {
  try {
    if (statSync(descriptorFile).size > 8192) return false;
    const descriptor = JSON.parse(readFileSync(descriptorFile, 'utf8'));
    if (![1, 2].includes(descriptor.version) || typeof descriptor.token !== 'string' || !/^[a-f0-9]{64}$/.test(descriptor.token) || typeof descriptor.workspaceRoot !== 'string') return false;
    if (descriptor.version === 2 && (!['workspace', 'all-local'].includes(descriptor.scope) || descriptor.privacy !== 'metadata-only')) return false;
    const target = new URL(descriptor.origin);
    if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.username || target.password || target.pathname !== '/' || target.search || target.hash || !target.port) return false;
    const event = normalizeHook(input, eventName, descriptor.workspaceRoot, {
      provider, version: descriptor.version, scope: descriptor.version === 1 ? 'workspace' : descriptor.scope,
    });
    if (!event) return false;
    const body = JSON.stringify(event);
    return await new Promise(resolveSend => {
      const request = http.request(`${target.origin}/api/bridge/events`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Office-Bridge-Token': descriptor.token },
      }, response => { response.resume(); resolveSend(response.statusCode === 200); });
      const deadline = setTimeout(() => { request.destroy(); resolveSend(false); }, 650);
      request.on('error', () => resolveSend(false));
      request.on('close', () => clearTimeout(deadline));
      request.end(body);
    });
  } catch { return false; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    process.stdout.write('{}\n', () => process.exit(0));
  };
  const deadline = setTimeout(finish, 1400);
  let size = 0;
  const chunks = [];
  process.stdin.on('data', chunk => {
    size += chunk.length;
    if (size > 1024 * 1024) { chunks.length = 0; finish(); }
    else chunks.push(chunk);
  });
  process.stdin.on('error', finish);
  process.stdin.on('end', async () => {
    try {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const descriptorFile = process.env.MY_OFFICE_BRIDGE_FILE || fileURLToPath(new URL('../.local/bridge.json', import.meta.url));
      await sendHook(input, process.argv[2], descriptorFile, process.argv[3]);
    } catch {}
    clearTimeout(deadline);
    finish();
  });
}
