// A push-optimal Sokoban solver, one room at a time.
//
// One run answers a whole set of levels: it reads every level.txt under the
// input directory and writes one solution.txt per level under the output
// directory. Every level is a hallway with a few small rooms off it, and a
// box pushed out of its room can never be pushed back, so each room is an
// independent puzzle: the program cuts the level into rooms, solves each room
// on its own for the fewest pushes, and stitches the room answers together
// with plain walking moves for the player between rooms.
//
// Inside a room the search is A* over pushes, not steps. A state is the
// boxes' squares together with the region the player can walk in (named by
// its lowest square), so two states that differ only in where the player
// stands inside one region count as one state. The remaining work is
// estimated by matching boxes to goals: each box must be pushed at least its
// shortest-path distance through open floor to the goal it ends on, so the
// cheapest matching over all pairings is a lower bound on the pushes still
// needed, and A* with that estimate finds the fewest pushes. Positions no
// push can rescue are pruned before they are searched: a box on a square
// from which no push can ever reach a goal, and a box frozen inside a
// two-by-two block of walls and boxes with a box off its goal.
//
// The search is budgeted by a fixed amount of work per room and for the
// whole run, never by the wall clock, and it reads no clock, no environment
// and no file outside the program and the input and output directories, so
// two runs write byte-identical answers.
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Work budgets, counted in search steps. Fixed counts, never time, so the
// answers do not depend on how fast the machine runs.
const ROOM_POP_CAP = 120_000;
const LEVEL_POP_CAP = 60_000;
const WORK_BUDGET = 600_000;
const EXTRA_GOAL_POPS = 10_000;

// How many pops the whole run has spent so far, across every level.
let workSpent = 0;

interface Step {
  dx: number;
  dy: number;
  walk: string;
  push: string;
}
const STEPS: Step[] = [
  { dx: 0, dy: -1, walk: 'u', push: 'U' },
  { dx: 0, dy: 1, walk: 'd', push: 'D' },
  { dx: -1, dy: 0, walk: 'l', push: 'L' },
  { dx: 1, dy: 0, walk: 'r', push: 'R' },
];

interface Board {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

interface Found {
  pushes: number;
  moves: string;
}

/** A level in XSB text: # wall, space floor, . goal, $ box, * box on a goal, @ player, + player on a goal. */
function parseLevel(text: string): Board {
  const rows: string[] = [];
  for (const line of text.split('\n')) if (line.length > 0) rows.push(line);
  const h = rows.length;
  let w = 0;
  for (const row of rows) if (row.length > w) w = row.length;
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  for (let y = 0; y < h; y++) {
    const row = rows[y]!;
    for (let x = 0; x < row.length; x++) {
      const at = y * w + x;
      const ch = row[x]!;
      if (ch === '#') continue;
      wall[at] = 0;
      if (ch === '.') goals.push(at);
      else if (ch === '*') {
        goals.push(at);
        boxes.push(at);
      } else if (ch === '$') boxes.push(at);
      else if (ch === '@') player = at;
      else if (ch === '+') {
        goals.push(at);
        player = at;
      }
    }
  }
  // The outermost frame is wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * The squares a box can stand on and still reach some goal: pull a box back
 * from each goal, one push at a time, over open floor. A square the pull
 * never reaches is dead: a box there can never be pushed onto a goal.
 */
function liveSquares(b: Board): Uint8Array {
  const live = new Uint8Array(b.w * b.h);
  const queue: number[] = [];
  for (const g of b.goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const s of STEPS) {
      const d = s.dy * b.w + s.dx;
      const from = x - d;
      const stand = from - d;
      if (from < 0 || stand < 0 || from >= b.w * b.h || stand >= b.w * b.h) continue;
      if (!b.wall[from] && !b.wall[stand] && !live[from]) {
        live[from] = 1;
        queue.push(from);
      }
    }
  }
  return live;
}

/** Shortest walks from one square over open floor (walls only, boxes ignored), -1 where no walk exists. */
function distancesFrom(b: Board, start: number): Int32Array {
  const dist = new Int32Array(b.w * b.h).fill(-1);
  const queue = [start];
  dist[start] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    for (const s of STEPS) {
      const q = p + s.dy * b.w + s.dx;
      if (q < 0 || q >= b.w * b.h) continue;
      if (b.wall[q] || dist[q] !== -1) continue;
      dist[q] = dist[p] + 1;
      queue.push(q);
    }
  }
  return dist;
}

/** Every ordering of n items, as index lists. */
function permutations(n: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const used = new Array<boolean>(n).fill(false);
  const build = (): void => {
    if (cur.length === n) {
      out.push(cur.slice());
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      cur.push(i);
      build();
      cur.pop();
      used[i] = false;
    }
  };
  build();
  return out;
}

/**
 * A lower bound on the pushes still needed: each box must be pushed at least
 * its shortest walk to the goal it ends on, so the cheapest way to pair boxes
 * with goals bounds the whole job from below. With many boxes the pairing is
 * skipped and each box just takes its nearest goal, which still bounds.
 */
function lowerBound(boxes: number[], dists: Int32Array[], perms: number[][] | null): number {
  if (perms !== null) {
    let best = Infinity;
    for (const perm of perms) {
      let sum = 0;
      let ok = true;
      for (let i = 0; i < boxes.length; i++) {
        const d = dists[perm[i]]![boxes[i]]!;
        if (d < 0) {
          ok = false;
          break;
        }
        sum += d;
      }
      if (ok && sum < best) best = sum;
    }
    return best;
  }
  let sum = 0;
  for (const box of boxes) {
    let nearest = Infinity;
    for (const dist of dists) {
      const d = dist[box]!;
      if (d >= 0 && d < nearest) nearest = d;
    }
    if (nearest === Infinity) return Infinity;
    sum += nearest;
  }
  return sum;
}

/**
 * The squares the player reaches from `from` with `occupied` in the way,
 * marked in `mark` under `stamp`; answers the lowest square reached, which
 * names the whole region.
 */
function regionLow(
  b: Board,
  occupied: Uint8Array,
  from: number,
  mark: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  let low = from;
  let n = 0;
  stack[n++] = from;
  mark[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (const s of STEPS) {
      const q = p + s.dy * b.w + s.dx;
      if (q < 0 || q >= b.w * b.h) continue;
      if (b.wall[q] === 0 && occupied[q] === 0 && mark[q] !== stamp) {
        mark[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen two-by-two block of walls and boxes with a box off its goal. */
function frozenBlock(b: Board, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const w = b.w;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const c = a + 1;
    const d = a + w;
    const e = d + 1;
    if (a < 0 || e >= b.w * b.h) continue;
    if (!(b.wall[a] || occupied[a])) continue;
    if (!(b.wall[c] || occupied[c])) continue;
    if (!(b.wall[d] || occupied[d])) continue;
    if (!(b.wall[e] || occupied[e])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d]) || (occupied[e] && !goal[e])) return true;
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower-case letters, first direction first on ties. */
function walkTo(b: Board, occupied: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const prev = new Int32Array(b.w * b.h).fill(-1);
  const how = new Array<string>(b.w * b.h);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const s of STEPS) {
      const q = p + s.dy * b.w + s.dx;
      if (q < 0 || q >= b.w * b.h) continue;
      if (b.wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = s.walk;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let out = '';
  for (let p = to; p !== from; p = prev[p]!) out = how[p]! + out;
  return out;
}

/** Whether the player, standing at `from`, can walk to some square of row `row` with `occupied` in the way. */
function canReachRow(b: Board, occupied: Uint8Array, from: number, row: number): boolean {
  const seen = new Uint8Array(b.w * b.h);
  const queue = [from];
  seen[from] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (Math.floor(p / b.w) === row) return true;
    for (const s of STEPS) {
      const q = p + s.dy * b.w + s.dx;
      if (q < 0 || q >= b.w * b.h) continue;
      if (b.wall[q] || occupied[q] || seen[q]) continue;
      seen[q] = 1;
      queue.push(q);
    }
  }
  return false;
}

/**
 * The fewest-push solution of one board, or null when the search gives up.
 * A* over pushes: a state is the boxes plus the player's region, the cost is
 * pushes made, the estimate is the cheapest box-to-goal matching. When
 * `exitRow` is given, among the cheapest solutions the search prefers one
 * whose player can still walk out to that row, so the next room stays
 * reachable; it only settles for a trapped cheapest solution when no other
 * cheapest one shows up.
 */
function pushSearch(sub: Board, cap: number, exitRow: number | null): Found | null {
  const size = sub.w * sub.h;
  const goal = new Uint8Array(size);
  for (const g of sub.goals) goal[g] = 1;
  const live = liveSquares(sub);
  if (sub.boxes.some((b) => !live[b])) return null;
  if (sub.boxes.every((b) => goal[b])) return { pushes: 0, moves: '' };
  const dists = sub.goals.map((g) => distancesFrom(sub, g));
  const perms = sub.boxes.length <= 5 ? permutations(sub.goals.length) : null;
  if (lowerBound(sub.boxes, dists, perms) === Infinity) return null;

  const occupied = new Uint8Array(size);
  const markA = new Int32Array(size);
  const markB = new Int32Array(size);
  const stack = new Int32Array(size);
  let stampA = 0;
  let stampB = 0;
  const numericKeys = Math.pow(size, sub.boxes.length + 1) < Number.MAX_SAFE_INTEGER;
  const keyOf = (boxes: number[], low: number): number | string => {
    if (!numericKeys) return `${low}:${boxes.join(',')}`;
    let k = low;
    for (const b of boxes) k = k * size + b;
    return k;
  };

  // The states in the order found: their boxes, the square the player stands
  // on after the push that made them, their region's lowest square, their
  // push count, the state they came from, and the push that made them: the
  // box's square before it and the direction it went.
  const stateBoxes: number[][] = [sub.boxes.slice()];
  const statePlayer: number[] = [sub.player];
  const stateLow: number[] = [0];
  const stateG: number[] = [0];
  const parent: number[] = [-1];
  const stateFrom: number[] = [-1];
  const stateDir: number[] = [-1];
  for (const b of sub.boxes) occupied[b] = 1;
  stateLow[0] = regionLow(sub, occupied, sub.player, markA, ++stampA, stack);
  for (const b of sub.boxes) occupied[b] = 0;
  const seen = new Map<number | string, number>();
  seen.set(keyOf(sub.boxes, stateLow[0]!), 0);

  // The open list, a heap on pushes made plus the estimate, deeper first on
  // ties, then in the order found: [f, g, order, state].
  const heap: [number, number, number, number][] = [[lowerBound(sub.boxes, dists, perms), 0, 0, 0]];
  let order = 1;
  const heapBefore = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapBefore(heap[i]!, heap[p]!)) break;
      const tmp = heap[i]!;
      heap[i] = heap[p]!;
      heap[p] = tmp;
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heapBefore(heap[c + 1]!, heap[c]!)) c++;
        if (!heapBefore(heap[c]!, heap[i]!)) break;
        const tmp = heap[i]!;
        heap[i] = heap[c]!;
        heap[c] = tmp;
        i = c;
      }
    }
    return top;
  };

  const finish = (found: number): Found => {
    // Walk the chain of pushes back to the start, then play it forward:
    // for each push, walk the player to the square behind the box, then
    // push it. The push each state remembers says which box moved and
    // where it went, so no box set has to be compared here.
    const chain: number[] = [];
    for (let s = found; s > 0; s = parent[s]!) chain.push(s);
    chain.reverse();
    let moves = '';
    let player = sub.player;
    for (const s of chain) {
      const dir = STEPS[stateDir[s]!]!;
      const from = stateFrom[s]!;
      const before = stateBoxes[parent[s]!]!;
      for (const b of before) occupied[b] = 1;
      moves += walkTo(sub, occupied, player, from - (dir.dy * sub.w + dir.dx));
      for (const b of before) occupied[b] = 0;
      moves += dir.push;
      player = from;
    }
    return { pushes: chain.length, moves };
  };
  const canExit = (idx: number): boolean => {
    const boxes = stateBoxes[idx]!;
    for (const b of boxes) occupied[b] = 1;
    const ok = canReachRow(sub, occupied, statePlayer[idx]!, exitRow!);
    for (const b of boxes) occupied[b] = 0;
    return ok;
  };

  let pops = 0;
  let firstFound = -1;
  let firstPushes = 0;
  let extra = 0;
  while (heap.length > 0) {
    if (firstFound >= 0) {
      if (extra >= EXTRA_GOAL_POPS || heap[0]![0] > firstPushes) return finish(firstFound);
      extra++;
    }
    if (pops >= cap || workSpent >= WORK_BUDGET) return firstFound >= 0 ? finish(firstFound) : null;
    const [, g, , idx] = heapPop();
    pops++;
    workSpent++;
    const boxes = stateBoxes[idx]!;
    if (seen.get(keyOf(boxes, stateLow[idx]!)) !== g) continue;
    if (boxes.every((b) => goal[b])) {
      if (exitRow === null || canExit(idx)) return finish(idx);
      if (firstFound < 0) {
        firstFound = idx;
        firstPushes = g;
      }
      continue;
    }
    for (const b of boxes) occupied[b] = 1;
    regionLow(sub, occupied, statePlayer[idx]!, markA, ++stampA, stack);
    const here = stampA;
    for (let bi = 0; bi < boxes.length; bi++) {
      const box = boxes[bi]!;
      for (let di = 0; di < STEPS.length; di++) {
        const s = STEPS[di]!;
        const d = s.dy * sub.w + s.dx;
        const t = box + d;
        if (t < 0 || t >= size) continue;
        if (markA[box - d] !== here) continue;
        if (sub.wall[t] || occupied[t] || !live[t]) continue;
        occupied[box] = 0;
        occupied[t] = 1;
        if (frozenBlock(sub, occupied, goal, t)) {
          occupied[t] = 0;
          occupied[box] = 1;
          continue;
        }
        const next = boxes.slice();
        next[bi] = t;
        next.sort((a, b) => a - b);
        const low = regionLow(sub, occupied, box, markB, ++stampB, stack);
        const h = lowerBound(next, dists, perms);
        const key = keyOf(next, low);
        const prevG = seen.get(key);
        if (h === Infinity || (prevG !== undefined && prevG <= g + 1)) {
          occupied[t] = 0;
          occupied[box] = 1;
          continue;
        }
        if (stateBoxes.length >= cap * 4) {
          occupied[t] = 0;
          occupied[box] = 1;
          for (const x of boxes) occupied[x] = 0;
          return firstFound >= 0 ? finish(firstFound) : null;
        }
        seen.set(key, g + 1);
        stateBoxes.push(next);
        statePlayer.push(box);
        stateLow.push(low);
        stateG.push(g + 1);
        parent.push(idx);
        stateFrom.push(box);
        stateDir.push(di);
        heapPush([g + 1 + h, g + 1, order++, stateBoxes.length - 1]);
        occupied[t] = 0;
        occupied[box] = 1;
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  return firstFound >= 0 ? finish(firstFound) : null;
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
  done: boolean;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway:
 * a box there reaches no goal) out of the floor, and each part left that
 * holds a box is a room. Null when some part holds more or fewer boxes than
 * goals, or a box starts in the hallway: then the level is no set of rooms.
 */
function splitRooms(b: Board): Room[] | null {
  const live = liveSquares(b);
  const hall = Math.floor(b.player / b.w);
  const cut = new Uint8Array(b.w * b.h);
  for (let x = 0; x < b.w; x++) {
    const i = hall * b.w + x;
    if (b.wall[i] === 0 && live[i] === 0) cut[i] = 1;
  }
  for (const box of b.boxes) if (cut[box]) return null;
  const owner = new Int32Array(b.w * b.h).fill(-1);
  const rooms: Room[] = [];
  const stack: number[] = [];
  for (let s = 0; s < b.w * b.h; s++) {
    if (b.wall[s] || cut[s] || owner[s] >= 0) continue;
    const id = rooms.length;
    const squares: number[] = [];
    stack.length = 0;
    stack.push(s);
    owner[s] = id;
    while (stack.length > 0) {
      const cur = stack.pop()!;
      squares.push(cur);
      for (const st of STEPS) {
        const q = cur + st.dy * b.w + st.dx;
        if (q < 0 || q >= b.w * b.h) continue;
        if (b.wall[q] || cut[q] || owner[q] >= 0) continue;
        owner[q] = id;
        stack.push(q);
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const box of b.boxes) {
    const p = owner[box]!;
    if (p < 0) return null;
    rooms[p]!.boxes.push(box);
  }
  for (const g of b.goals) {
    const p = owner[g]!;
    if (p < 0) return null;
    rooms[p]!.goals.push(g);
  }
  for (const r of rooms) if (r.boxes.length !== r.goals.length) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** The square the player stands on after `moves` from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/**
 * One level, solved room by room: each room's fewest-push answer in turn,
 * the other rooms' boxes standing as walls (on their goals once their room
 * is done), the player walking on from where the last room left it. A box
 * never leaves its room, so the rooms' optima add up to the level's. Falls
 * back to a search over the whole level when the level is no set of rooms,
 * and to an empty answer when no search solves it.
 */
function solveLevel(text: string): string {
  const board = parseLevel(text);
  const hallwayRow = Math.floor(board.player / board.w);
  const rooms = splitRooms(board);
  if (rooms !== null) {
    let player = board.player;
    let moves = '';
    let ok = true;
    for (const room of rooms) {
      const wall = board.wall.slice();
      for (const other of rooms) {
        if (other === room) continue;
        for (const sq of other.done ? other.goals : other.boxes) wall[sq] = 1;
      }
      const sub: Board = {
        w: board.w,
        h: board.h,
        wall,
        goals: room.goals.slice().sort((a, b) => a - b),
        boxes: room.boxes.slice().sort((a, b) => a - b),
        player,
      };
      const solved = pushSearch(sub, ROOM_POP_CAP, hallwayRow);
      if (solved === null) {
        ok = false;
        break;
      }
      moves += solved.moves;
      player = endOf(board.w, player, solved.moves);
      room.done = true;
    }
    if (ok) return moves;
  }
  const whole = pushSearch(board, LEVEL_POP_CAP, null);
  return whole === null ? '' : whole.moves;
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  const moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  const out = join(OUTPUT_DIR, id, 'solution.txt');
  writeFileSync(out, `${moves}\n`);
  chmodSync(out, 0o644);
}
