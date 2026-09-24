import test from 'node:test';
import assert from 'node:assert/strict';
import { realObservationState, observationStatus } from '../public/activity.js';

test('the UI snapshot excludes every non-real task and timeline event without changing stored data', () => {
  const sources = ['observed', 'manual', 'simulated', 'bridge_test', 'external', undefined];
  const snapshot = {
    tasks: sources.map((source, id) => ({ id: String(id), source, agent: `Agent ${id}` })),
    events: sources.map((source, id) => ({ taskId: String(id), source, message: `Event ${id}` })),
    bridge: { ready: true }, realConnections: 1,
  };
  const before = structuredClone(snapshot);
  const filtered = realObservationState(snapshot);
  assert.deepEqual(filtered.tasks.map(task => task.id), ['0']);
  assert.deepEqual(filtered.events.map(event => event.taskId), ['0']);
  assert.deepEqual(snapshot, before);
  assert.equal(filtered.bridge, snapshot.bridge);
  assert.deepEqual(realObservationState(filtered), filtered);
});

test('no real observations means empty tasks and timeline, never demo fallback', () => {
  const snapshot = {
    tasks: [{ source: 'bridge_test' }, { source: 'manual' }, { source: 'simulated' }],
    events: [{ source: 'bridge_test' }, { source: 'manual' }, { source: 'simulated' }],
  };
  assert.deepEqual(realObservationState(snapshot), { tasks: [], events: [] });
});

test('observation metrics and status filters use evidence, never inferred business completion', () => {
  assert.equal(observationStatus({ status: 'in_progress' }), 'in_progress');
  assert.equal(observationStatus({ status: 'in_progress', stale: true }), 'unknown');
  assert.equal(observationStatus({ status: 'in_progress', freshness: 'stale' }), 'unknown');
  assert.equal(observationStatus({ status: 'in_progress' }, false), 'unknown');
  for (const status of ['completed', 'queued', 'waiting_input', 'waiting_review', 'failed', 'blocked', 'unknown']) {
    assert.equal(observationStatus({ status }), 'unknown');
  }
  for (const connected of [true, false]) {
    assert.equal(observationStatus({ status: 'turn_ended', stale: true }, connected), 'turn_ended');
  }
});
