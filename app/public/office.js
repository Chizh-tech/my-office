import { actorName, agentName, fromHook, observedActivity, observationOrigin, taskTitle } from './activity.js';

const WIDTH = 960;
const HEIGHT = 600;
const INK = '#40364f';
const CREAM = '#fff4d9';
const WOOD = '#c68d68';
const ACCENTS = ['#a9d8bc', '#a8cee5', '#c9b5df', '#eeb49c', '#dfca82', '#a8cfcf'];
const SOURCE_NAMES = { simulated: '模拟演示', manual: '手动上报', observed: '真实观测', bridge_test: '桥接测试' };
const STATUS_NAMES = {
  queued: '排队中', in_progress: '进行中', waiting_input: '等待输入', waiting_review: '等待审核',
  blocked: '已阻塞', failed: '失败', completed: '已完成', cancelled: '已取消',
};
const WORK = [[120, 230], [120, 430], [340, 430], [560, 430], [120, 550], [340, 550]];
const RECEPTION = [[610, 190], [750, 190], [890, 190], [610, 270], [750, 270], [890, 270]];
export const VP = {
  visitor: { x: 390, y: 250 },
  queue: [[590, 240], [650, 240], [710, 240], [770, 240], [830, 240], [890, 240]],
};
const POSITIONS = {
  work: WORK,
  waiting: RECEPTION,
  help: RECEPTION,
  review: VP.queue,
  rest: [[750, 450], [820, 450], [890, 450], [750, 550], [820, 550], [890, 550]],
};

// The drawing and the navigation grid use the same solid-wall and furniture footprints.
export const FLOORPLAN = {
  walls: [
    [216, 96, 12, 200], [548, 96, 12, 98], [548, 270, 12, 26],
    [22, 284, 66, 12], [164, 284, 64, 12],
    [228, 284, 124, 12], [428, 284, 132, 12],
    [560, 284, 132, 12], [772, 284, 166, 12],
    [704, 328, 12, 46], [704, 454, 12, 128],
  ],
  furniture: [
    ...WORK.map(([x, y]) => [x - 84, y - 104, 168, 78]),
    [318, 180, 144, 52], // VP desk.
    [246, 140, 50, 68], // Executive bookcase.
    [362, 128, 56, 48], // VP chair.
    [584, 128, 330, 40], // Reception/support counter.
    [736, 334, 180, 48], // Coffee counter.
    [736, 392, 180, 24], // Lounge sofa back.
    [798, 478, 48, 24], // Coffee table.
    [525, 472, 76, 69], // Library.
  ],
};

// A location is a visualization of reported state, never a claim about tool execution.
export function sceneState(task, running = false, connected = true) {
  const neutral = { zone: null, badge: '?', tone: 'neutral', motion: false, typing: false, bob: false };
  if (!connected) return { ...neutral, label: '连接中断，当前状态未知', detail: '页面未刷新；冻结位置与动作，不代表任务完成。' };
  if (task.stale || task.freshness === 'stale') {
    return {
      ...neutral,
      label: task.status === 'turn_ended' ? '本轮已结束，记录已过期' : '记录已过期，当前状态未确认',
      detail: '无新事件不代表离线，不代表业务任务完成；位置与动作已冻结。',
    };
  }
  if (task.status === 'turn_ended') {
    return {
      ...neutral, zone: 'rest', badge: 'END',
      motion: fromHook(task) || (task.source === 'simulated' && running),
      label: '本轮已结束 · 非任务完成', detail: '请在原聊天检查结果；不表示已批准或业务完成。',
    };
  }
  if (fromHook(task)) {
    if (task.status !== 'in_progress') return { ...neutral, zone: 'rest', label: '当前状态未确认', detail: '观测记录不能确认业务阶段或完成状态。' };
    const activity = observedActivity(task, connected);
    return {
      ...neutral, zone: 'work', badge: '…', motion: true,
      label: `近期有活动事件 · ${activity.label}`,
      detail: `${activity.detail} 人物位置仅示意近期活动，不代表工具获准、正在执行或业务进度。`,
    };
  }
  if (!['manual', 'simulated'].includes(task.source) || !STATUS_NAMES[task.status]) {
    return { ...neutral, zone: 'rest', label: '当前状态未确认', detail: '没有可解释的明确状态。' };
  }
  const states = {
    queued: ['waiting', 'WAIT', 'neutral'],
    in_progress: ['work', '…', 'mint'],
    waiting_input: ['waiting', 'ASK', 'sky'],
    waiting_review: ['review', 'REV', 'lilac'],
    blocked: ['help', '!', 'peach'],
    failed: ['help', '!', 'peach'],
    completed: ['rest', 'DONE', 'mint'],
    cancelled: ['rest', '—', 'neutral'],
  };
  const [zone, badge, tone] = states[task.status];
  const simulated = task.source === 'simulated';
  return {
    zone, badge, tone,
    motion: simulated && running,
    typing: simulated && running && task.status === 'in_progress',
    bob: simulated && running && task.status === 'in_progress',
    label: `${simulated ? (running ? '模拟演示' : '模拟已暂停') : '手动上报'} · ${STATUS_NAMES[task.status]}`,
    detail: simulated ? '演示状态与动作，不是实际工作进度。' : '人物静态位置来自手动上报，不代表实时执行。',
  };
}

export function assignSlots(tasks, previous = new Map()) {
  const ids = [...new Set(tasks.slice(0, 6).map(task => task.id))];
  const next = new Map();
  const used = new Set();
  // Reserve every surviving actor before allocating newcomers, regardless of snapshot order.
  for (const id of ids) {
    const slot = previous.get(id);
    if (Number.isInteger(slot) && slot >= 0 && slot < 6 && !used.has(slot)) {
      next.set(id, slot);
      used.add(slot);
    }
  }
  for (const id of ids) {
    if (next.has(id)) continue;
    const slot = [0, 1, 2, 3, 4, 5].find(value => !used.has(value));
    next.set(id, slot);
    used.add(slot);
  }
  return next;
}

export function zonePosition(zone, slot) {
  const [x, y] = (POSITIONS[zone] ?? POSITIONS.rest)[slot];
  return { x, y };
}

export function isWalkable({ x, y }) {
  return x >= 36 && x <= 924 && y >= 108 && y <= 566
    && ![...FLOORPLAN.walls, ...FLOORPLAN.furniture].some(([left, top, width, height]) =>
      x > left - 12 && x < left + width + 12 && y > top - 12 && y < top + height + 12);
}

const GRID = 10;
const COLUMNS = WIDTH / GRID;
const CELLS = COLUMNS * HEIGHT / GRID;
const WALKABLE = Array.from({ length: CELLS }, (_, index) =>
  isWalkable({ x: index % COLUMNS * GRID, y: Math.floor(index / COLUMNS) * GRID }));
const gridPoint = index => ({ x: index % COLUMNS * GRID, y: Math.floor(index / COLUMNS) * GRID });

export function planRoute(start, target) {
  const first = Math.round(start.y / GRID) * COLUMNS + Math.round(start.x / GRID);
  const last = Math.round(target.y / GRID) * COLUMNS + Math.round(target.x / GRID);
  if (!isWalkable(start) || !isWalkable(target) || !WALKABLE[first] || !WALKABLE[last]) return [];
  // Actors only leave grid edges while interpolating; the nearest grid point is on that edge.
  const previous = new Int32Array(CELLS).fill(-1);
  const queue = new Int32Array(CELLS);
  previous[first] = first;
  queue[0] = first;
  let head = 0;
  let tail = 1;
  while (head < tail && previous[last] === -1) {
    const current = queue[head++];
    for (const next of [current - COLUMNS, current + 1, current + COLUMNS, current - 1]) {
      if (next < 0 || next >= CELLS || !WALKABLE[next] || previous[next] !== -1) continue;
      previous[next] = current;
      queue[tail++] = next;
    }
  }
  if (previous[last] === -1) return [];
  const path = [];
  for (let index = last; ; index = previous[index]) {
    path.push(gridPoint(index));
    if (index === first) break;
  }
  path.reverse();
  if (path[0].x === start.x && path[0].y === start.y) path.shift();
  // Retain corners only; navigation stays bounded to the 96×60 floor grid.
  return path.filter((point, index) => {
    const before = index ? path[index - 1] : start;
    const after = path[index + 1];
    return !after || !((before.x === point.x && point.x === after.x) || (before.y === point.y && point.y === after.y));
  });
}

function rect(context, x, y, width, height, color) {
  context.fillStyle = color;
  context.fillRect(Math.round(x), Math.round(y), width, height);
}

function box(context, x, y, width, height, color, border = INK) {
  rect(context, x, y, width, height, border);
  rect(context, x + 3, y + 3, width - 6, height - 6, color);
}

function text(context, value, x, y, size = 10, color = INK, align = 'left') {
  context.font = `bold ${size}px monospace`;
  context.textAlign = align;
  context.textBaseline = 'middle';
  context.fillStyle = color;
  context.fillText(value, Math.round(x), Math.round(y));
}

function sign(context, value, x, y, width, accent = CREAM) {
  rect(context, x + 3, y + 3, width, 22, '#bda789');
  box(context, x, y, width, 22, accent);
  text(context, value, x + width / 2, y + 12, 10, INK, 'center');
}

function plant(context, x, y, type = 0) {
  rect(context, x - 13, y + 1, 32, 5, '#bda88b');
  box(context, x - 10, y - 18, 24, 22, type % 2 ? '#adcad0' : '#dc9d7f');
  rect(context, x - 7, y - 17, 18, 4, '#f3cc99');
  rect(context, x, y - 49, 4, 31, '#52745f');
  for (const [dx, dy, w, h] of [[-17, -45, 17, 10], [3, -53, 18, 12], [-12, -63, 14, 15], [4, -34, 14, 9]]) {
    rect(context, x + dx - 2, y + dy - 2, w + 4, h + 4, INK);
    rect(context, x + dx, y + dy, w, h, '#739b77');
    rect(context, x + dx + 2, y + dy + 2, Math.max(3, w - 7), 3, '#a5c98c');
  }
}

function books(context, x, y, count, scale = 1) {
  for (let index = 0; index < count; index++) {
    const height = (13 + index % 3 * 3) * scale;
    rect(context, x + index * 8 * scale, y - height, 6 * scale, height, ACCENTS[index % 6]);
    rect(context, x + (index * 8 + 1) * scale, y - height + 3 * scale, 4 * scale, 2 * scale, CREAM);
  }
}

function shelf(context, x, y, width, height) {
  rect(context, x + 4, y + 5, width, height, '#b99c83');
  box(context, x, y, width, height, WOOD);
  for (let row = 0; row < 2; row++) {
    const base = y + 29 + row * 29;
    rect(context, x + 6, base - 22, width - 12, 24, '#77566a');
    books(context, x + 10, base, Math.floor((width - 19) / 8));
    rect(context, x + 3, base + 2, width - 6, 4, '#ebbb88');
  }
}

function windowArt(context, x, y, width) {
  box(context, x, y, width, 68, '#a5cbdc');
  rect(context, x + 6, y + 6, width - 12, 22, '#bfdfdf');
  rect(context, x + 16, y + 13, 30, 5, CREAM);
  rect(context, x + 25, y + 9, 13, 4, CREAM);
  rect(context, x + width - 35, y + 12, 12, 12, '#f4d88b');
  for (let i = 0; i < 7; i++) {
    rect(context, x + 7 + i * 20, y + 46 - i % 3 * 6, 17, 16 + i % 3 * 6, '#85b1b7');
    rect(context, x + 10 + i * 20, y + 48 - i % 3 * 6, 3, 5, '#d6e6d0');
  }
  rect(context, x + width / 2 - 3, y + 3, 6, 59, CREAM);
  rect(context, x + 3, y + 32, width - 6, 5, CREAM);
  rect(context, x - 5, y + 64, width + 10, 7, INK);
  rect(context, x - 2, y + 64, width + 4, 3, '#f1c69a');
  for (const edge of [x + 4, x + width - 14]) {
    rect(context, edge, y + 3, 10, 47, '#d6b8cf');
    rect(context, edge + 3, y + 3, 3, 44, '#f0ced8');
  }
}

function mug(context, x, y, color) {
  box(context, x + 8, y + 3, 8, 9, color);
  box(context, x, y, 12, 14, color);
  rect(context, x + 3, y + 2, 6, 3, '#79576a');
}

function desk(context, x, y, index) {
  const accent = ACCENTS[index];
  rect(context, x - 88, y - 71, 176, 103, '#d7b99b');
  rect(context, x - 83, y - 72, 166, 2, '#ebd7b6');
  box(context, x - 76, y - 12, 14, 32, '#876471');
  box(context, x + 58, y - 12, 17, 32, '#876471');
  box(context, x - 82, y - 69, 164, 59, WOOD);
  rect(context, x - 78, y - 65, 156, 44, '#e4b585');
  rect(context, x - 75, y - 61, 147, 3, '#f2d0a1');
  rect(context, x - 74, y - 25, 62, 2, '#cb966f');
  rect(context, x + 10, y - 35, 59, 2, '#cb966f');
  const screenX = x + (index % 2 ? -38 : -24);
  box(context, screenX, y - 85, 55, 37, '#777181');
  rect(context, screenX + 5, y - 80, 45, 24, '#364657');
  rect(context, screenX + 9, y - 76, 22, 3, accent);
  rect(context, screenX + 9, y - 70, 31, 2, '#92a9bc');
  rect(context, screenX + 9, y - 64, 17, 2, '#92a9bc');
  rect(context, screenX + 23, y - 48, 8, 9, INK);
  rect(context, screenX + 14, y - 40, 27, 4, INK);
  box(context, x - 26, y - 32, 46, 12, '#f2e5c6');
  for (let row = 0; row < 2; row++) {
    for (let key = 0; key < 7; key++) rect(context, x - 21 + key * 5, y - 28 + row * 4, 3, 2, '#aaa2a4');
  }
  rect(context, x + 29, y - 30, 8, 10, accent);
  if (index === 0 || index === 4) {
    box(context, x - 68, y - 53, 27, 25, CREAM);
    rect(context, x - 62, y - 46, 15, 2, '#aaa2a4');
    rect(context, x - 62, y - 39, 10, 2, '#aaa2a4');
    rect(context, x - 41, y - 53, 3, 22, '#cb8589');
  } else if (index === 1 || index === 5) {
    books(context, x + 41, y - 28, 4);
    rect(context, x + 40, y - 27, 33, 3, INK);
  } else {
    box(context, x - 70, y - 51, 22, 23, accent);
    rect(context, x - 64, y - 46, 11, 3, CREAM);
    rect(context, x - 59, y - 42, 3, 9, CREAM);
  }
  mug(context, x + (index % 2 ? -65 : 52), y - 49, accent);
  box(context, x - 23, y - 2, 46, 30, accent);
  rect(context, x - 18, y + 2, 36, 8, '#fff4d980');
  rect(context, x - 4, y + 29, 8, 7, INK);
  rect(context, x - 20, y + 34, 40, 4, INK);
  text(context, `0${index + 1}`, x + 66, y + 12, 9, CREAM, 'center');
}

function partition(context, [x, y, width, height]) {
  rect(context, x + 4, y + 7, width, height, '#b59b8b');
  box(context, x, y, width, height, '#eadfc9');
  if (width > height) {
    rect(context, x + 3, y + 3, width - 6, 3, CREAM);
    rect(context, x + 3, y + height - 4, width - 6, 2, '#9e8693');
  } else {
    rect(context, x + 3, y + 3, 3, height - 6, CREAM);
  }
}

function vpOffice(context) {
  box(context, 242, 123, 294, 151, '#9d88ae', '#cba86c');
  box(context, 249, 130, 280, 137, '#c9b9cf', '#edd7a2');
  rect(context, 257, 138, 264, 121, '#dacbda');
  for (const x of [263, 508]) for (const y of [146, 245]) {
    rect(context, x, y, 5, 5, '#bd985b');
  }
  shelf(context, 246, 140, 50, 68);
  box(context, 365, 128, 50, 54, '#655076', '#cda762');
  rect(context, 373, 135, 34, 29, '#8b6f9d');
  for (const x of [380, 398]) rect(context, x, 144, 3, 3, '#dcc28d');
  for (const [x, y, w, h, color] of executivePixels()) rect(context, 372 + x * 1.2, 126 + y * 1.2, w * 1.2, h * 1.2, color);
  box(context, 318, 180, 144, 52, '#6d526f', '#533f5b');
  rect(context, 322, 184, 136, 31, '#b9907c');
  rect(context, 326, 187, 128, 3, '#eac492');
  rect(context, 322, 216, 136, 4, '#d6b372');
  rect(context, 333, 222, 114, 3, '#a58a65');
  box(context, 331, 191, 32, 20, '#e5d7ba');
  rect(context, 336, 196, 22, 2, '#9a8699');
  rect(context, 336, 202, 15, 2, '#9a8699');
  box(context, 375, 193, 41, 17, '#604c70', '#e6c88c');
  text(context, 'CHI', 395, 202, 9, '#ffe9b4', 'center');
  mug(context, 432, 191, '#ead199');
  plant(context, 508, 194, 1);
  box(context, 481, 133, 34, 27, '#f5e4b4', '#a47e4d');
  text(context, 'VP', 498, 147, 12, '#75577f', 'center');
  box(context, 373, 244, 34, 20, '#a18cb0');
  rect(context, 378, 247, 24, 4, '#e6d9e8');
  sign(context, 'VP OFFICE / CHI 的办公室', 242, 95, 294, '#ebd5a1');
}

function reception(context) {
  box(context, 584, 128, 330, 40, '#ad8d82');
  rect(context, 588, 132, 322, 26, '#e9c5a0');
  for (const x of [595, 705, 815]) {
    rect(context, x, 143, 88, 2, '#bb9684');
    rect(context, x + 7, 169, 70, 3, '#b59b8b');
  }
  box(context, 609, 125, 35, 27, '#95b7b5');
  rect(context, 615, 131, 23, 12, '#394a5b');
  rect(context, 619, 135, 13, 2, '#a9d8bc');
  box(context, 735, 132, 32, 19, CREAM);
  rect(context, 741, 137, 20, 2, '#a899a5');
  rect(context, 741, 143, 13, 2, '#a899a5');
  box(context, 864, 130, 26, 25, '#d5b7ca');
  text(context, '?', 877, 143, 15, INK, 'center');
  rect(context, 568, 206, 354, 58, '#dfcfba');
  rect(context, 568, 258, 354, 3, '#c4a46f');
  for (const [index, [x, y]] of VP.queue.entries()) {
    rect(context, x - 18, y + 3, 36, 3, '#b298bb');
    text(context, String(index + 1).padStart(2, '0'), x, y + 15, 8, '#8d748d', 'center');
  }
  sign(context, 'COPILOT LOUNGE / 观测区', 585, 95, 330, '#eee1c2');
  text(context, 'READ ONLY / 状态以 VS CODE COPILOT 为准', 748, 188, 9, '#806581', 'center');
}

function coffeeRoom(context) {
  rect(context, 720, 328, 215, 253, '#d9ded0');
  for (let row = 0; row < 8; row++) {
    for (let column = 0; column < 7; column++) {
      rect(context, 723 + column * 30, 332 + row * 30, 28, 28, (row + column) % 2 ? '#dde3d5' : '#d0d9cb');
    }
  }
  box(context, 736, 334, 180, 48, '#b8a48f');
  rect(context, 740, 338, 172, 31, '#f0dfbc');
  box(context, 748, 329, 42, 40, '#8c858b');
  box(context, 754, 334, 30, 13, '#b5d6cd');
  rect(context, 756, 351, 26, 14, INK);
  mug(context, 762, 352, CREAM);
  mug(context, 804, 350, '#b7d2da');
  box(context, 850, 337, 53, 30, '#cbd5c6');
  rect(context, 860, 344, 33, 3, '#97afac');
  rect(context, 860, 352, 33, 3, '#97afac');
  box(context, 736, 392, 180, 24, '#78968d');
  for (let i = 0; i < 3; i++) box(context, 741 + i * 57, 396, 54, 17, '#adc7b4');
  box(context, 798, 478, 48, 24, '#ddb68f');
  mug(context, 804, 480, CREAM);
  rect(context, 823, 484, 16, 11, '#b2bed6');
  sign(context, 'COFFEE / 中性休息', 727, 301, 204, '#e5eadb');
  plant(context, 917, 574);
}

function sceneBitmap() {
  const bitmap = document.createElement('canvas');
  bitmap.width = WIDTH;
  bitmap.height = HEIGHT;
  const context = bitmap.getContext('2d');
  context.imageSmoothingEnabled = false;
  rect(context, 0, 0, WIDTH, HEIGHT, '#e6d4b5');
  box(context, 14, 12, 932, 576, '#efdcbc');
  rect(context, 22, 99, 916, 482, '#eed9b4');
  for (let row = 0; row < 16; row++) {
    const y = 102 + row * 30;
    rect(context, 22, y + 28, 916, 2, '#d8b996');
    for (let col = 0; col < 8; col++) {
      const x = 24 + col * 128 + (row % 2 ? 64 : 0);
      if (x < 936) rect(context, x, y, 2, 28, '#d8b996');
      if (x + 46 < 934) rect(context, x + 18, y + 20, 27, 2, '#e1c59e');
    }
  }
  rect(context, 22, 20, 916, 80, '#f8ecd1');
  rect(context, 22, 95, 916, 7, INK);
  rect(context, 22, 95, 916, 3, '#c6987e');
  windowArt(context, 48, 21, 154);
  windowArt(context, 311, 21, 154);
  windowArt(context, 634, 21, 154);
  shelf(context, 828, 24, 91, 64);
  box(context, 248, 37, 34, 34, CREAM);
  rect(context, 263, 43, 3, 12, INK);
  rect(context, 265, 52, 10, 3, INK);
  rect(context, 29, 122, 179, 144, '#dfddd0');
  sign(context, 'FOCUS / 独立工位', 32, 95, 176, '#e9e7d7');
  vpOffice(context);
  reception(context);
  // A continuous unpartitioned hall links the three upper doors and the workroom.
  rect(context, 24, 297, 676, 24, '#e2c5a3');
  rect(context, 24, 298, 676, 2, '#f7dfba');
  for (const x of [108, 372, 714]) {
    rect(context, x, 284, 36, 12, '#ddc19c');
    rect(context, x + 2, 287, 32, 2, '#f6debb');
  }
  text(context, 'OPEN WORKROOM / 公共工位', 359, 308, 10, '#745e70', 'center');
  coffeeRoom(context);
  WORK.forEach(([x, y], index) => desk(context, x, y - 18, index));
  shelf(context, 525, 472, 76, 69);
  sign(context, 'LIBRARY', 516, 550, 94);
  plant(context, 666, 545, 1);
  for (const wall of FLOORPLAN.walls) partition(context, wall);
  rect(context, 548, 194, 12, 3, '#c9a76b');
  rect(context, 548, 267, 12, 3, '#c9a76b');
  rect(context, 551, 200, 3, 61, '#c9a76b');
  // Door jambs and thresholds leave the entire pathfinding opening unobstructed.
  for (const [left, right] of [[88, 164], [352, 428], [692, 772]]) {
    rect(context, left - 3, 280, 3, 20, '#90748a');
    rect(context, right, 280, 3, 20, '#90748a');
  }
  rect(context, 704, 374, 12, 3, '#90748a');
  rect(context, 704, 451, 12, 3, '#90748a');
  text(context, 'OBSERVED ACTIVITY · NOT TASK COMPLETION', 355, 574, 9, '#806978', 'center');
  rect(context, 16, 582, 928, 6, INK);
  rect(context, 27, 582, 906, 3, '#b98570');
  return bitmap;
}

const HAIR = [
  ['..hhhhhh..', '.hhhhhhhh.', '.hhsssshh.', '.hssssssh.', '..ssssss..'],
  ['...hhhh...', '..hhhhhh..', '.hhhsshhh.', '.hhsssshh.', '.hssssssh.'],
  ['..hhhhhh..', '.hhhhhhhh.', '.hssssssh.', '..ssssss..', '..ssssss..'],
  ['...hhh....', '..hhhhhh..', '.hhhhhhhh.', '.hssssssh.', '..ssssss..'],
  ['..hhhhhh..', '.hhhhhhhh.', '.hssssssh.', '.hssssssh.', '.hssssssh.'],
  ['...hhhh...', '..hhhhhh..', '.hhsssshh.', '.hssssssh.', '..ssssss..'],
];

function executivePixels() {
  const pixels = humanPixels({ variant: 2, skin: '#e4b292', hair: '#453b4d', shirt: '#675079' });
  return [...pixels,
    [6, 1, 18, 3, '#685264'], [9, 1, 9, 2, '#998074'],
    [5, 8, 10, 2, '#d6b574'], [16, 8, 10, 2, '#d6b574'],
    [7, 18, 4, 11, '#d6b574'], [19, 18, 4, 11, '#d6b574'],
    [11, 19, 8, 4, CREAM], [14, 22, 3, 8, '#e0b46d'],
    [21, 23, 3, 3, '#f4dfb0'], [14, 32, 3, 2, '#d6b574'],
    [0, 29, 6, 2, '#d6b574'], [4, 38, 8, 2, '#aa8b62'], [18, 38, 8, 2, '#aa8b62'],
  ];
}

export function executivePortraitSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 48" aria-hidden="true" focusable="false" shape-rendering="crispEdges"><rect width="40" height="48" fill="#e8d4a4"/>${executivePixels().map(([x, y, width, height, color]) =>
    `<rect x="${x + 5}" y="${y + 3}" width="${width}" height="${height}" fill="${color}"/>`).join('')}</svg>`;
}

export function actorAppearance(task) {
  let hash = 2166136261;
  for (const character of String(task.id ?? '')) hash = Math.imul(hash ^ character.codePointAt(0), 16777619) >>> 0;
  return {
    variant: hash % HAIR.length,
    skin: ['#e4b28a', '#b78063', '#f0c29f', '#cd9570', '#9b6c59', '#e4b292'][(hash >>> 5) % 6],
    hair: ['#574654', '#6b4552', '#58474b', '#9a684b', '#3e3c50', '#b07e4e'][(hash >>> 9) % 6],
    shirt: ACCENTS[(hash >>> 13) % ACCENTS.length],
  };
}

function humanPixels(appearance, stride = 0, hands = 0) {
  const pixels = [];
  const add = (x, y, width, height, color) => pixels.push([x, y, width, height, color]);
  const { variant, skin, hair, shirt } = appearance;
  const palette = { h: hair, s: skin };
  HAIR[variant].forEach((row, rowIndex) => [...row].forEach((pixel, column) => {
    if (palette[pixel]) add(column * 3, rowIndex * 3, 3, 3, palette[pixel]);
  }));
  add(9, 9, 3, 3, INK);
  add(18, 9, 3, 3, INK);
  if (variant === 2 || variant === 5) {
    add(6, 8, 9, 2, INK);
    add(15, 8, 9, 2, INK);
    add(12, 10, 6, 2, INK);
  }
  add(12, 14, 6, 5, skin);
  add(3, 18, 24, 17, INK);
  add(6, 21, 18, 11, shirt);
  add(12, 18, 6, 3, CREAM);
  add(15, 25, 3, 3, INK);
  add(0, 22 - hands, 6, 10, INK);
  add(0, 25 - hands, 6, 5, skin);
  add(24, 22 + hands, 6, 10, INK);
  add(24, 25 + hands, 6, 5, skin);
  add(6, 34, 7, 7 - stride, '#5b5c77');
  add(17, 34, 7, 4 + stride, '#5b5c77');
  add(3, 39 - stride, 10, 3, INK);
  add(17, 36 + stride, 10, 3, INK);
  return pixels;
}

export function portraitSvg(task) {
  // Only fixed coordinates and palette colors enter SVG; no profile, goal or ID text is interpolated.
  const pixels = humanPixels(actorAppearance(task));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 36" aria-hidden="true" focusable="false" shape-rendering="crispEdges"><rect width="32" height="36" fill="${CREAM}"/>${pixels.map(([x, y, width, height, color]) =>
    `<rect x="${x + 1}" y="${y + 1}" width="${width}" height="${height}" fill="${color}"/>`).join('')}</svg>`;
}

function sprite(context, actor, selected) {
  const { x, y, state } = actor;
  const walking = actor.route.length > 0 && actor.animating;
  const beat = Math.floor(actor.phase / 180) % 2;
  const bob = actor.animating && (walking || state.bob) ? beat * 2 : 0;
  const sx = Math.round(x) - 15;
  const sy = Math.round(y) - 42 - bob;
  rect(context, x - 18, y - 1, 36, 5, '#9e8b8460');
  if (selected) {
    rect(context, x - 24, y + 3, 48, 3, '#735794');
    rect(context, x - 27, y - 4, 3, 10, '#735794');
    rect(context, x + 24, y - 4, 3, 10, '#735794');
  }
  const hands = state.typing && actor.animating ? beat * 3 : 0;
  const stride = walking ? beat * 3 : 0;
  for (const [px, py, width, height, color] of humanPixels(actor.appearance, stride, hands)) {
    rect(context, sx + px, sy + py, width, height, color);
  }
  const bubbleColor = ({ mint: '#c6e5cc', sky: '#cbe4ee', lilac: '#e3d4f0', peach: '#f3c7ad', neutral: CREAM })[state.tone];
  const bubbleX = Math.round(x) + 12;
  const bubbleY = Math.round(y) - 43;
  const bubbleWidth = 40;
  box(context, bubbleX, bubbleY, bubbleWidth, 21, bubbleColor);
  rect(context, bubbleX + 5, bubbleY + 21, 6, 5, INK);
  rect(context, bubbleX + 8, bubbleY + 18, 3, 5, bubbleColor);
  text(context, state.badge, bubbleX + bubbleWidth / 2, bubbleY + 11, 10, INK, 'center');
  if (selected) {
    rect(context, x - 6, y - 61, 12, 3, '#735794');
    rect(context, x - 3, y - 58, 6, 3, '#735794');
  }
}

export class OfficeScene {
  constructor(canvas, hotspots, onSelect) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.context.imageSmoothingEnabled = false;
    this.bitmap = sceneBitmap();
    this.hotspots = hotspots;
    this.onSelect = onSelect;
    this.tasks = [];
    this.actors = new Map();
    this.slots = new Map();
    this.selected = null;
    this.running = false;
    this.connected = true;
    this.request = null;
    this.lastFrame = null;
    this.intersecting = true;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)');
    this.frame = timestamp => {
      this.request = null;
      if (!this.visible()) {
        this.lastFrame = null;
        return;
      }
      const elapsed = this.lastFrame === null ? 0 : Math.min(60, Math.max(0, timestamp - this.lastFrame));
      this.lastFrame = timestamp;
      this.advance(elapsed);
      this.draw();
      if (this.needsMotion()) this.request = requestAnimationFrame(this.frame);
      else this.lastFrame = null;
    };
    this.wake = () => {
      if (!this.visible()) {
        if (this.request !== null) cancelAnimationFrame(this.request);
        this.request = null;
        this.lastFrame = null;
        return;
      }
      if (this.request === null) this.request = requestAnimationFrame(this.frame);
    };
    document.addEventListener('visibilitychange', this.wake);
    this.reduced.addEventListener('change', this.wake);
    window.addEventListener('resize', this.wake);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(this.wake);
      this.resizeObserver.observe(canvas);
    }
    if (typeof IntersectionObserver !== 'undefined') {
      this.intersectionObserver = new IntersectionObserver(entries => {
        this.intersecting = entries[0].isIntersecting;
        this.draw();
        this.wake();
      });
      this.intersectionObserver.observe(canvas);
    }
    if (typeof MutationObserver !== 'undefined') {
      this.visibilityObserver = new MutationObserver(this.wake);
      for (let parent = canvas.parentElement; parent; parent = parent.parentElement) {
        this.visibilityObserver.observe(parent, { attributes: true, attributeFilter: ['hidden', 'class', 'style'] });
      }
    }
    this.wake();
  }

  visible() {
    return !document.hidden && this.intersecting && this.canvas.getClientRects().length > 0
      && (!this.canvas.checkVisibility || this.canvas.checkVisibility({ visibilityProperty: true }));
  }

  update(tasks, selected, running, connected = true) {
    this.tasks = tasks.slice(0, 6);
    this.selected = selected;
    this.running = running;
    this.connected = connected;
    this.slots = assignSlots(this.tasks, this.slots);
    for (const [id, actor] of this.actors) {
      if (!this.slots.has(id)) {
        actor.button.remove();
        this.actors.delete(id);
      }
    }
    for (const task of this.tasks) {
      let actor = this.actors.get(task.id);
      const state = sceneState(task, running, connected);
      const slot = this.slots.get(task.id);
      const destination = state.zone ? zonePosition(state.zone, slot) : null;
      if (!actor) {
        const button = document.createElement('button');
        button.type = 'button';
        // No data-task: the scene callback is the only selection handler.
        button.addEventListener('click', () => this.onSelect(task.id));
        this.hotspots.append(button);
        actor = { ...(destination ?? zonePosition('rest', slot)), slot, appearance: actorAppearance(task), route: [], phase: 0, button, targetZone: state.zone, target: destination, initialized: Boolean(state.zone) };
        this.actors.set(task.id, actor);
      } else if (state.zone && !actor.initialized) {
        Object.assign(actor, destination);
        actor.route = [];
        actor.targetZone = state.zone;
        actor.target = destination;
        actor.initialized = true;
      } else if (destination && (destination.x !== actor.target?.x || destination.y !== actor.target?.y)) {
        actor.route = planRoute(actor, destination);
        actor.targetZone = state.zone;
        actor.target = destination;
      }
      actor.task = task;
      actor.state = state;
      actor.animating = false;
      if (state.zone && task.source === 'manual') {
        Object.assign(actor, zonePosition(state.zone, actor.slot));
        actor.route = [];
      }
      const source = SOURCE_NAMES[task.source] ?? '来源未知';
      const role = task.profile?.role ? ` · 用户自定义职责：${task.profile.role}` : '';
      const label = `${actorName(task)} · 执行者：${agentName(task)} · 原执行者：${task.agent} · ${source}${role}${fromHook(task) ? ` · ${observationOrigin(task)}` : ''} · ${taskTitle(task)} · ${state.label}。${state.detail}`;
      actor.button.className = `agent-hotspot${task.id === selected ? ' selected' : ''}`;
      actor.button.textContent = actorName(task);
      actor.button.title = label;
      actor.button.setAttribute('aria-label', `查看任务：${label}`);
      actor.button.setAttribute('aria-pressed', String(task.id === selected));
      this.positionHotspot(actor);
    }
    // A background-tab load still needs a static picture; only animation requires visibility.
    if (this.canvas.getClientRects().length > 0) this.draw();
    this.wake();
  }

  positionHotspot(actor) {
    actor.button.style.left = `${actor.x / WIDTH * 100}%`;
    actor.button.style.top = `${(actor.y + 14) / HEIGHT * 100}%`;
    actor.button.style.zIndex = String(Math.round(actor.y));
    const width = actor.y < 296 ? (actor.x < 228 ? 148 : actor.x < 560 ? 96 : 110)
      : actor.x > 716 ? 62 : actor.y < 326 ? 96 : 190;
    actor.button.style.maxWidth = `${width / WIDTH * 100}%`;
  }

  needsMotion() {
    return !this.reduced.matches && [...this.actors.values()].some(actor =>
      actor.state.motion && (actor.route.length > 0 || actor.state.bob || actor.state.typing));
  }

  advance(elapsed) {
    for (const actor of this.actors.values()) {
      actor.animating = actor.state.motion && !this.reduced.matches;
      if (!actor.state.motion) continue;
      if (this.reduced.matches) {
        if (actor.route.length) Object.assign(actor, actor.route.at(-1));
        actor.route = [];
      } else {
        actor.phase += elapsed;
        let distance = elapsed * 0.115;
        while (actor.route.length && distance > 0) {
          const next = actor.route[0];
          const length = Math.hypot(next.x - actor.x, next.y - actor.y);
          if (length <= distance) {
            actor.x = next.x;
            actor.y = next.y;
            actor.route.shift();
            distance -= length;
          } else {
            actor.x += (next.x - actor.x) / length * distance;
            actor.y += (next.y - actor.y) / length * distance;
            distance = 0;
          }
        }
      }
      this.positionHotspot(actor);
    }
  }

  draw() {
    this.context.imageSmoothingEnabled = false;
    this.context.drawImage(this.bitmap, 0, 0);
    for (const actor of [...this.actors.values()].sort((a, b) => a.y - b.y)) {
      sprite(this.context, actor, actor.task.id === this.selected);
    }
    if (!this.connected) sign(this.context, '?  CONNECTION LOST / 当前状态未知', 199, 297, 320, '#f6e4cb');
    else if (!this.tasks.length) sign(this.context, 'NO RECORDS / 暂无任务记录', 212, 297, 296, CREAM);
  }

}
