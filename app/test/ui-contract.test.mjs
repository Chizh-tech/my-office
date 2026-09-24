import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startOffice } from '../src/server.mjs';

test('pixel UI preserves client controls and accessible panel relationships', async () => {
  const [html, client] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  ]);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  const uniqueIds = new Set(ids);
  assert.equal(uniqueIds.size, ids.length, 'HTML ids must remain unique');
  for (const [, id] of client.matchAll(/\bget\('([^']+)'\)/g)) {
    assert.ok(uniqueIds.has(id), `Missing client control: ${id}`);
  }
  for (const [, targets] of html.matchAll(/\baria-(?:controls|labelledby|describedby)="([^"]+)"/g)) {
    for (const target of targets.split(/\s+/)) {
      assert.ok(uniqueIds.has(target), `Missing accessible target: ${target}`);
    }
  }
  assert.match(html, /<canvas id="office-canvas" width="960" height="600"/);
  assert.match(html, /位置与动作仅为状态示意/);
  assert.doesNotMatch(html, /source-filter|demo-toggle|demo-step|demo-reset|demo-clear|new-task|task-dialog|task-form/);
  assert.doesNotMatch(client, /\/api\/(?:demo|tasks)|source-filter|demoRunning|needsAttention/);
  assert.match(client, /state = realObservationState\(next\)/);
  for (const status of ['all', 'in_progress', 'unknown', 'turn_ended']) {
    assert.ok(uniqueIds.has(`count-${status}`));
    assert.ok(html.includes(`data-status="${status}"`));
  }
  assert.match(html, /不代表业务完成/);
  assert.ok(uniqueIds.has('profile-dialog'));
  assert.ok(uniqueIds.has('workstream-dialog'));
  assert.ok(uniqueIds.has('roster-count'));
  for (const id of ['vp-title', 'vp-portrait', 'vp-observation-summary']) {
    assert.ok(uniqueIds.has(id), id);
  }
  assert.match(html, /所有审批及回复均以 VS Code 中的 Copilot 为准/);
  assert.doesNotMatch(html, /review-next|review-finish|review-queue|review-recover|data-invite|data-review-finish/);
  assert.doesNotMatch(client, /REVIEW_STORAGE_KEY|reviewPresentation|acknowledgeReview|data-invite|data-review-finish|data-review-return/);
});

test('pixel UI assets load through the existing local-only server contract', async () => {
  const app = await startOffice({ port: 0, dataFile: null, bridgeFile: null });
  try {
    for (const [path, type] of [
      ['/', 'text/html'],
      ['/styles.css', 'text/css'],
      ['/app.js', 'text/javascript'],
      ['/office.js', 'text/javascript'],
      ['/activity.js', 'text/javascript'],
      ['/favicon.svg', 'image/svg+xml'],
    ]) {
      const response = await fetch(`${app.origin}${path}`);
      assert.equal(response.status, 200, path);
      assert.ok(response.headers.get('content-type').startsWith(type), path);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.ok(response.headers.get('content-security-policy').includes("connect-src 'self'"));
      assert.ok((await response.text()).length > 0, path);
    }
    const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
    assert.match(css, /prefers-reduced-motion:\s*reduce/);
    assert.doesNotMatch(css, /@import|url\(\s*['"]?(?:https?:)?\/\//);
  } finally {
    await app.close();
  }
});
