import http from 'node:http';
import childProcess from 'node:child_process';
import { readFileSync } from 'node:fs';

export function isOfficeOrigin(origin) {
  return typeof origin === 'string' && /^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(origin) && URL.canParse(origin);
}

export async function existingOfficeOrigin(bridgeFile) {
  const contents = readFileSync(bridgeFile, 'utf8');
  const descriptor = JSON.parse(contents);
  if (!isOfficeOrigin(descriptor.origin) || ![1, 2].includes(descriptor.version)
    || typeof descriptor.token !== 'string' || !/^[a-f0-9]{64}$/.test(descriptor.token)) {
    throw new Error('Cannot reuse My Office: invalid bridge descriptor; file left unchanged.');
  }
  // Older servers have no authenticated health route. An empty event verifies the token but fails validation before changing observations.
  await new Promise((resolveProbe, reject) => {
    const request = http.request(`${descriptor.origin}/api/bridge/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': 2, 'X-Office-Bridge-Token': descriptor.token },
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 1024) request.destroy(new Error('Bridge verification response is too large'));
      });
      response.on('error', reject);
      response.on('end', () => {
        if (response.statusCode !== 400 || body !== '{"error":"Bridge event rejected"}') {
          reject(new Error(`Cannot reuse My Office at ${descriptor.origin}: bridge ownership verification failed (HTTP ${response.statusCode}); existing service left unchanged.`));
        } else resolveProbe();
      });
    });
    const deadline = setTimeout(() => request.destroy(new Error(`Bridge ownership verification timed out at ${descriptor.origin}`)), 1500);
    request.on('error', reject);
    request.on('close', () => clearTimeout(deadline));
    request.end('{}');
  });
  if (readFileSync(bridgeFile, 'utf8') !== contents) throw new Error('Bridge owner changed during verification; retry startup.');
  return descriptor.origin;
}

export function openOffice(origin) {
  if (!isOfficeOrigin(origin)) throw new Error('Cannot open an invalid My Office address');
  const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/d', '/c', 'start', '""', origin] : [origin];
  return new Promise((resolveOpen, reject) => {
    childProcess.execFile(command, args, { windowsHide: true }, error => {
      if (error) reject(new Error(`Could not open the browser. Open ${origin} manually. ${error.message}`, { cause: error }));
      else resolveOpen();
    });
  });
}
