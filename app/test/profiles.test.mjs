import test from 'node:test';
import assert from 'node:assert/strict';
import { actorName, agentName, agentRole, taskTitle, profileKey, validateProfile, decodeProfiles, encodeProfiles } from '../public/activity.js';

const observed = {
  id: 'copilot-abc-main', agent: 'Copilot abc', source: 'observed',
  requestExcerpt: '核对测量数据', status: 'in_progress', workstream: 'automation',
};

test('nicknames and role notes never replace original identity, hook goal or business state', () => {
  const task = { ...observed, workspaceName: '10_DM_HUB', profile: { nickname: '数据小助手', role: '负责数据复核' } };
  assert.equal(agentName(task), '数据小助手');
  assert.equal(actorName(task), '10_DM_HUB');
  assert.equal(agentRole(task), '负责数据复核');
  assert.equal(task.agent, observed.agent);
  assert.equal(taskTitle(task), '任务目标未采集（仅元数据）');
  assert.equal(task.status, observed.status);
  assert.equal(profileKey(task), profileKey(observed));
  assert.equal(agentName(observed), observed.agent);
  assert.equal(agentRole(observed), '职责尚未设置');
  assert.equal(agentRole({ ...observed, source: 'manual' }), '职责尚未设置');
  assert.equal(agentName({ ...observed, profile: { nickname: '', role: '备注' } }), observed.agent);
  assert.equal(actorName(observed), observed.agent);
  assert.equal(actorName({ ...observed, source: 'manual', workspaceName: '10_DM_HUB' }), observed.agent);
});

test('only known demo fixtures have default illustrative roles; real workers have no inferred role', () => {
  const demo = { ...observed, id: 'demo-analysis', source: 'simulated' };
  assert.match(agentRole(demo), /检查样件数据/);
  assert.equal(agentRole({ ...demo, source: 'observed' }), '职责尚未设置');
  assert.equal(agentRole({ ...demo, source: 'bridge_test' }), '职责尚未设置');
  assert.equal(agentRole({ ...demo, id: 'unknown-demo' }), '职责尚未设置');
});

test('profile validation checks exact allowed fields, lengths and trimming', () => {
  assert.deepEqual(validateProfile({ nickname: '  小林  ', role: '  复核数据\n整理结论  ' }), { nickname: '小林', role: '复核数据\n整理结论' });
  assert.equal(validateProfile({ nickname: '名'.repeat(32), role: '责'.repeat(160) }).nickname.length, 32);
  for (const input of [
    null, [], {}, { nickname: 3, role: '' }, { nickname: '', role: null },
    { nickname: 'x'.repeat(33), role: '' }, { nickname: '', role: 'x'.repeat(161) },
    { nickname: '名字', role: '', requestExcerpt: 'must not be stored' },
    { nickname: '名字', role: '', status: 'completed' },
  ]) assert.throws(() => validateProfile(input));
});

test('profile round trips persist only user metadata and isolate same names across IDs and sources', () => {
  const profiles = new Map([
    [profileKey(observed), { nickname: '相同名字', role: 'A' }],
    [profileKey({ ...observed, id: 'copilot-def-main' }), { nickname: '相同名字', role: 'B' }],
    [profileKey({ ...observed, source: 'bridge_test' }), { nickname: '相同名字', role: 'C' }],
  ]);
  const raw = encodeProfiles(profiles);
  assert.deepEqual(decodeProfiles(raw), profiles);
  for (const forbidden of ['requestExcerpt', 'status', 'in_progress', '核对测量数据', 'tool', 'event', 'token']) {
    assert.ok(!raw.includes(forbidden));
  }
  assert.deepEqual(decodeProfiles(null), new Map());
  assert.deepEqual(decodeProfiles(encodeProfiles(new Map([['manual:empty', { nickname: '', role: '' }]]))), new Map());
  profiles.delete(profileKey(observed));
  assert.equal(decodeProfiles(encodeProfiles(profiles)).size, 2);
});

test('corrupt or unrecognized profile storage fails explicitly instead of silently overwriting it', () => {
  const value = { nickname: '', role: '' };
  const wrap = entries => JSON.stringify({ version: 1, entries });
  for (const raw of [
    '', '{broken', 'null', '[]', JSON.stringify({ version: 2, entries: [] }),
    JSON.stringify({ version: 1, entries: [], task: observed }),
    wrap([['observed:a', value], ['observed:a', value]]),
    wrap([['__proto__', value]]), wrap([['external:a', value]]),
    wrap([['observed:../private', value]]), wrap([['manual:a']]),
    wrap(Array.from({ length: 501 }, (_, index) => [`manual:${index}`, value])),
    ' '.repeat(512 * 1024 + 1),
  ]) assert.throws(() => decodeProfiles(raw));
  assert.throws(() => encodeProfiles(new Map([['observed:a', { ...value, prompt: 'forbidden' }]])));
});
