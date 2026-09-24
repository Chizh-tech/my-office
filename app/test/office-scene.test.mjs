import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficeScene, assignSlots, sceneState, zonePosition, actorAppearance, portraitSvg, executivePortraitSvg, VP, isWalkable, planRoute } from '../public/office.js';

const task = (id, changes = {}) => ({
  id, agent: `Agent ${id}`, source: 'simulated', title: `Goal ${id}`, status: 'in_progress',
  workstream: 'engineering', stale: false, ...changes,
});

test('hooks mean recent activity, not tool execution, approval or reported business stages', () => {
  for (const source of ['observed', 'bridge_test']) {
    const recent = sceneState(task('a', { source, lastHook: 'PreToolUse', lastTool: 'runTests' }), true);
    assert.equal(recent.zone, 'work');
    assert.equal(recent.typing, false);
    assert.equal(recent.bob, false);
    assert.equal(recent.tone, 'neutral');
    assert.match(recent.label, /近期有活动/);
    assert.match(recent.detail, /是否获准/);
    assert.match(recent.detail, /不代表工具获准、正在执行或业务进度/);
    for (const status of ['waiting_input', 'waiting_review', 'blocked', 'failed', 'completed', 'unknown', 'queued']) {
      const state = sceneState(task('a', { source, status }), true);
      assert.equal(state.zone, 'rest');
      assert.equal(state.badge, '?');
      assert.equal(state.motion, false);
    }
    const ended = sceneState(task('a', { source, status: 'turn_ended', lastHook: 'Stop' }), true);
    assert.equal(ended.zone, 'rest');
    assert.equal(ended.badge, 'END');
    assert.equal(ended.typing, false);
    assert.equal(ended.bob, false);
    assert.match(ended.label, /非任务完成/);
  }
});

test('only explicit manual and simulated reports enter waiting, review, help and done states', () => {
  const expected = {
    queued: ['waiting', 'WAIT'], waiting_input: ['waiting', 'ASK'], waiting_review: ['review', 'REV'],
    blocked: ['help', '!'], failed: ['help', '!'], completed: ['rest', 'DONE'], cancelled: ['rest', '—'],
  };
  for (const source of ['manual', 'simulated']) {
    for (const [status, [zone, badge]] of Object.entries(expected)) {
      const state = sceneState(task('a', { source, status }), true);
      assert.equal(state.zone, zone);
      assert.equal(state.badge, badge);
      assert.equal(state.motion, source === 'simulated');
      assert.equal(state.typing, false);
    }
  }
  assert.equal(sceneState(task('a', { source: 'manual' }), true).motion, false);
  assert.equal(sceneState(task('a'), true).typing, true);
  assert.equal(sceneState(task('a'), false).motion, false);
  assert.match(sceneState(task('a'), false).label, /模拟已暂停/);
  const unsupported = sceneState(task('a', { source: 'external', status: 'completed' }), true);
  assert.equal(unsupported.badge, '?');
});

test('stale and disconnected take precedence over every positive or ended state for all sources', () => {
  for (const source of ['observed', 'bridge_test', 'manual', 'simulated']) {
    for (const status of ['in_progress', 'waiting_input', 'waiting_review', 'blocked', 'completed', 'turn_ended']) {
      const record = task('a', { source, status, stale: true });
      for (const state of [sceneState(record, true), sceneState(record, true, false)]) {
        assert.equal(state.zone, null);
        assert.equal(state.badge, '?');
        assert.equal(state.motion, false);
        assert.equal(state.typing, false);
        assert.equal(state.tone, 'neutral');
      }
      assert.match(sceneState(record, true).detail, /不代表离线/);
      assert.match(sceneState(record, true, false).label, /连接中断/);
    }
  }
  assert.equal(sceneState(task('a', { freshness: 'stale' }), true).badge, '?');
});

test('slots survive reorder and only departed slots are reused; scene is bounded to first six tasks', () => {
  const initial = Array.from({ length: 7 }, (_, index) => task(String(index)));
  const slots = assignSlots(initial);
  assert.equal(slots.size, 6);
  assert.equal(slots.has('6'), false);
  const shuffled = assignSlots([initial[5], initial[0], initial[4], initial[2], initial[3], initial[1]], slots);
  for (const [id, slot] of slots) assert.equal(shuffled.get(id), slot);
  const replaced = assignSlots([task('new'), initial[5], initial[4], initial[3], initial[2], initial[1]], shuffled);
  assert.equal(replaced.get('new'), 0);
  for (let index = 1; index < 6; index++) assert.equal(replaced.get(String(index)), index);
  assert.equal(new Set(replaced.values()).size, 6);
  assert.equal(assignSlots([task('same'), task('same')]).size, 1);
  for (const zone of ['work', 'waiting', 'review', 'help', 'rest']) {
    const positions = [...slots.values()].map(slot => zonePosition(zone, slot));
    assert.equal(new Set(positions.map(point => `${point.x},${point.y}`)).size, 6);
    for (const { x, y } of positions) {
      assert.ok(x >= 40 && x <= 910);
      assert.ok(y > 100 && y + 14 < 600);
    }
  }
});

test('all floorplan destinations connect through walkable doorways without crossing solid furniture', () => {
  const positions = [VP.visitor, ...['work', 'waiting', 'review', 'help', 'rest'].flatMap(zone =>
    Array.from({ length: 6 }, (_, slot) => zonePosition(zone, slot)))];
  for (const start of positions) {
    assert.ok(isWalkable(start), JSON.stringify(start));
    for (const target of positions) {
      if (start.x === target.x && start.y === target.y) continue;
      const route = planRoute(start, target);
      assert.ok(route.length, `Unreachable: ${JSON.stringify({ start, target })}`);
      assert.deepEqual(route.at(-1), target);
      let previous = start;
      for (const next of route) {
        const distance = Math.hypot(next.x - previous.x, next.y - previous.y);
        const steps = Math.ceil(distance / 2);
        for (let step = 0; step <= steps; step++) {
          assert.ok(isWalkable({
            x: previous.x + (next.x - previous.x) * step / steps,
            y: previous.y + (next.y - previous.y) * step / steps,
          }), `Route crosses obstacle: ${JSON.stringify({ previous, next })}`);
        }
        previous = next;
      }
    }
  }
  assert.deepEqual(planRoute({ x: 0, y: 0 }, positions[0]), []);
});

test('portraits share stable actor appearance independent of name, role, status or slot', () => {
  const original = task('stable');
  const changed = { ...original, agent: '<script>', profile: { nickname: 'Changed', role: 'New role' }, status: 'turn_ended' };
  assert.deepEqual(actorAppearance(original), actorAppearance(changed));
  assert.equal(portraitSvg(original), portraitSvg(changed));
  assert.match(portraitSvg(original), /shape-rendering="crispEdges"/);
  assert.ok(portraitSvg(original).includes(actorAppearance(original).shirt));
  assert.doesNotMatch(portraitSvg(changed), /script|Changed|New role/);
  const appearances = Array.from({ length: 30 }, (_, index) => JSON.stringify(actorAppearance(task(`id-${index}`))));
  assert.ok(new Set(appearances).size > 10);
});

function sceneHarness(t) {
  const context = { fillRect() {}, fillText() {}, draws: 0, drawImage() { this.draws++; } };
  const callbacks = new Map();
  let nextRequest = 0;
  const listeners = new Map();
  const observers = [];
  const document = {
    hidden: false,
    activeElement: null,
    addEventListener(type, callback) { listeners.set(type, callback); },
    createElement(tag) {
      if (tag === 'canvas') return { getContext: () => context };
      return {
        style: {}, attributes: {}, events: {},
        setAttribute(name, value) { this.attributes[name] = value; },
        addEventListener(name, handler) { this.events[name] = handler; },
        focus() { document.activeElement = this; },
        remove() { this.parent.children = this.parent.children.filter(child => child !== this); },
      };
    },
  };
  const reduced = { matches: false, addEventListener(type, handler) { this.change = handler; } };
  const parent = { parentElement: null, hidden: false };
  const canvas = {
    parentElement: parent,
    getContext: () => context,
    getClientRects: () => parent.hidden ? [] : [{}],
    checkVisibility: () => !parent.hidden,
  };
  const hotspots = { children: [], append(button) { button.parent = this; this.children.push(button); } };
  const globals = {
    document,
    window: { addEventListener() {} },
    matchMedia: () => reduced,
    requestAnimationFrame: callback => { callbacks.set(++nextRequest, callback); return nextRequest; },
    cancelAnimationFrame: id => callbacks.delete(id),
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe() {}
    },
    ResizeObserver: undefined,
    IntersectionObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe() {}
    },
  };
  const saved = new Map();
  for (const [key, value] of Object.entries(globals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  t.after(() => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const selections = [];
  const scene = new OfficeScene(canvas, hotspots, id => selections.push(id));
  const frame = time => {
    const entries = [...callbacks];
    callbacks.clear();
    for (const [, callback] of entries) callback(time);
  };
  return { scene, context, callbacks, listeners, observers, frame, document, parent, hotspots, reduced, selections };
}

test('a background-tab snapshot paints without scheduling animation', t => {
  const { scene, document, listeners, context, callbacks } = sceneHarness(t);
  document.hidden = true;
  listeners.get('visibilitychange')();
  const before = context.draws;
  scene.update([task('a')], 'a', true);
  assert.equal(context.draws, before + 1);
  assert.equal(callbacks.size, 0);
  assert.equal(scene.actors.get('a').phase, 0);
});

test('the first connected snapshot places paused demo actors at their reported zones', t => {
  const { scene, frame } = sceneHarness(t);
  const tasks = [task('a'), task('b', { status: 'waiting_review' })];
  scene.update(tasks, 'a', false, false);
  scene.update(tasks, 'a', false, true);
  for (const [id, zone] of [['a', 'work'], ['b', 'review']]) {
    const actor = scene.actors.get(id);
    assert.deepEqual({ x: actor.x, y: actor.y }, zonePosition(zone, actor.slot));
    assert.equal(actor.route.length, 0);
  }
  frame(60);
  assert.equal(scene.actors.get('a').phase, 0);
  assert.equal(scene.actors.get('b').button.style.maxWidth, `${110 / 960 * 100}%`);
});

test('same-ID updates preserve actors, progress, keyboard focus and one selection callback', t => {
  const { scene, document, hotspots, frame, selections } = sceneHarness(t);
  scene.update([task('a'), task('b')], 'a', true);
  frame(0);
  const actor = scene.actors.get('a');
  const button = actor.button;
  button.focus();
  scene.update([task('b'), task('a', { status: 'waiting_review' })], 'b', true);
  frame(60);
  frame(120);
  assert.ok(actor.route.length > 0);
  assert.notDeepEqual({ x: actor.x, y: actor.y }, zonePosition('work', actor.slot));
  const { x, y, phase, route } = actor;
  scene.update([task('a', { status: 'waiting_review' }), task('b')], 'a', true);
  assert.equal(scene.actors.get('a'), actor);
  assert.equal(actor.route, route);
  assert.deepEqual([actor.x, actor.y, actor.phase], [x, y, phase]);
  assert.equal(actor.button, button);
  assert.equal(document.activeElement, button);
  assert.equal(hotspots.children.length, 2);
  assert.equal(button.attributes['aria-pressed'], 'true');
  assert.match(button.title, /模拟演示.*Goal a.*等待审核/);
  assert.equal(button.attributes['data-task'], undefined);
  button.events.click();
  assert.deepEqual(selections, ['a']);
  assert.equal(button.style.left, `${actor.x / 960 * 100}%`);
  assert.equal(button.style.top, `${(actor.y + 14) / 600 * 100}%`);
});

test('walks finish in matching zones, with no movement for paused demo, stale or disconnected actors', t => {
  const { scene, frame } = sceneHarness(t);
  scene.update([task('a')], 'a', true);
  frame(0);
  scene.update([task('a', { status: 'waiting_review' })], 'a', true);
  frame(60);
  frame(120);
  const actor = scene.actors.get('a');
  assert.ok(actor.route.length > 0);
  for (const [record, running, connected] of [
    [task('a', { status: 'completed' }), false, true],
    [task('a', { status: 'completed', stale: true }), true, true],
    [task('a', { status: 'completed' }), true, false],
  ]) {
    const before = [actor.x, actor.y, actor.phase];
    scene.update([record], 'a', running, connected);
    frame(180);
    scene.advance(60);
    assert.deepEqual([actor.x, actor.y, actor.phase], before);
  }
  scene.update([task('a', { status: 'completed' })], 'a', true, true);
  for (let step = 0; step < 250; step++) scene.advance(60);
  assert.deepEqual({ x: actor.x, y: actor.y }, zonePosition('rest', actor.slot));
  assert.equal(actor.route.length, 0);
  assert.equal(actor.state.badge, 'DONE');
});

test('manual reports are static and real-source accessible labels never expose request excerpts', t => {
  const { scene, frame } = sceneHarness(t);
  scene.update([task('a', { source: 'manual' })], 'a', true);
  frame(0);
  scene.update([task('a', { source: 'manual', status: 'waiting_input' })], 'a', true);
  const actor = scene.actors.get('a');
  assert.deepEqual({ x: actor.x, y: actor.y }, zonePosition('waiting', actor.slot));
  assert.equal(actor.route.length, 0);
  scene.advance(60);
  assert.equal(actor.phase, 0);
  scene.update([task('real', { source: 'observed', title: 'Private session title', requestExcerpt: 'Actual goal', lastHook: 'PreToolUse' })], 'real', true);
  const button = scene.actors.get('real').button;
  assert.match(button.attributes['aria-label'], /真实观测.*任务目标未采集.*近期有活动事件/);
  assert.doesNotMatch(button.attributes['aria-label'], /Private session title|Actual goal/);
  scene.update([task('child', { source: 'bridge_test', parentId: 'parent' })], 'child', true);
  assert.match(scene.actors.get('child').button.title, /桥接测试.*任务目标未采集/);
});

test('hidden tabs and list view stop frames; entering repaints without elapsed-time catchup', t => {
  const { scene, frame, parent, document, listeners, observers, callbacks, context } = sceneHarness(t);
  scene.update([task('a')], 'a', true);
  frame(0);
  frame(60);
  const actor = scene.actors.get('a');
  const phase = actor.phase;
  document.hidden = true;
  listeners.get('visibilitychange')();
  assert.equal(callbacks.size, 0);
  scene.update([task('a', { status: 'waiting_review' })], 'a', true);
  const draws = context.draws;
  frame(10000);
  assert.equal(context.draws, draws);
  assert.equal(actor.phase, phase);
  document.hidden = false;
  listeners.get('visibilitychange')();
  frame(10060);
  assert.equal(actor.phase, phase);
  assert.equal(context.draws, draws + 1);
  parent.hidden = true;
  scene.visibilityObserver.callback();
  assert.equal(callbacks.size, 0);
  parent.hidden = false;
  scene.visibilityObserver.callback();
  frame(20000);
  assert.equal(actor.phase, phase);
  assert.equal(context.draws, draws + 2);
  // Offscreen scenes also sleep until the intersection observer reports them visible.
  observers[0].callback([{ isIntersecting: false }]);
  assert.equal(callbacks.size, 0);
  observers[0].callback([{ isIntersecting: true }]);
  assert.equal(callbacks.size, 1);
});

test('reduced motion snaps only allowed transitions, never animates or overrides pause/disconnect', t => {
  const { scene, frame, reduced, callbacks } = sceneHarness(t);
  scene.update([task('a')], 'a', true);
  frame(0);
  scene.update([task('a', { status: 'waiting_review' })], 'a', true);
  reduced.matches = true;
  reduced.change();
  frame(60);
  const actor = scene.actors.get('a');
  assert.deepEqual({ x: actor.x, y: actor.y }, zonePosition('review', actor.slot));
  assert.equal(actor.route.length, 0);
  assert.equal(actor.animating, false);
  assert.equal(callbacks.size, 0);
  scene.update([task('a', { status: 'completed' })], 'a', false);
  frame(120);
  assert.deepEqual({ x: actor.x, y: actor.y }, zonePosition('review', actor.slot));
  scene.update([task('a', { status: 'completed' })], 'a', true, false);
  frame(180);
  assert.deepEqual({ x: actor.x, y: actor.y }, zonePosition('review', actor.slot));
});

test('VP portrait is distinct and uses the executive gold and purple palette', () => {
  const portrait = executivePortraitSvg();
  assert.match(portrait, /crispEdges/);
  assert.match(portrait, /#d6b574/);
  assert.match(portrait, /#675079/);
  assert.notEqual(portrait, portraitSvg(task('owner')));
});
