// Phase-13 验收 D + Phase-14 验收 B：pickObstaclePlan/planRowGap 种子采样自验（normal 2000 排 + frenzy 1000 + slowed 1000）——
// 从 js/runner3d.js 源码截取类定义之前的纯函数区（import 行剔除、export 前缀剥离）在 Node 内 eval，
// 采样对象 = 真实生产代码（非复刻）。校验：六类分布 / 组合车道∈[1,3] / 墙与减速块恒≥1安全车道 / 坑长区间 /
// 坑后缓冲≥30 / 组合后 slime-snow +8u / 减速态零 pit（红线c）/ 金币排合法 / 数学红线。
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../js/runner3d.js', import.meta.url), 'utf8');
const cut = src.indexOf('export class Runner3D');
if (cut < 0) { console.error('class marker not found'); process.exit(1); }
const pure = src.slice(0, cut)
  .replace(/^import .*$/m, '')
  .replace(/^export /gm, '');
const api = new Function(pure + `
  return { pickObstaclePlan, pickSpawnLanes, planRowGap, chaseStep,
           PLAN_WEIGHTS, PLAN_WEIGHTS_FRENZY, PIT_LEN_MIN, PIT_LEN_MAX, PIT_BUFFER_GAP, PIT_EPS,
           BARRIER_HEIGHT, WALL_HEIGHT, LANE_COUNT, BASE_SPEED, SPEED_GAIN, SPEED_MAX_BONUS,
           GRAVITY, JUMP_V0, OBSTACLE_MAX_HEIGHT, COMBO_FOLLOW_GAP, COMBO_P2, COMBO_P3,
           COMBO_P2_FRENZY, COMBO_P3_FRENZY, COIN_MIN, COIN_MAX, SNOW_H, SLIME_H }; `)();

// mulberry32 种子 rng
const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const SEED = 20251014;
const DINO_H = 2.125;                                   // 12.5 × VOXEL(0.17)
const apex = api.JUMP_V0 ** 2 / (2 * api.GRAVITY);      // 5.1607
const tAir = 2 * api.JUMP_V0 / api.GRAVITY;             // 1.2143
const speedMax = api.BASE_SPEED + api.SPEED_MAX_BONUS;  // 24
const TYPES = ['barrier', 'wall', 'pit', 'slime', 'snow', 'coin'];

function sampleRun(rows, opts, seed) {
  const rng = mulberry32(seed);
  const dist = Object.fromEntries(TYPES.map((t) => [t, 0]));
  let laneViol = 0, pitGapViol = 0, lenViol = 0, comboViol = 0, coinViol = 0, comboBufViol = 0;
  let distance = 30, prevPlan = null, minGap = Infinity, minGapAfterPit = Infinity, comboLanes = { 1: 0, 2: 0, 3: 0 };
  for (let i = 0; i < rows; i++) {
    const speed = api.BASE_SPEED + Math.min(distance * api.SPEED_GAIN, api.SPEED_MAX_BONUS);
    const plan = api.pickObstaclePlan(rng, Math.floor(distance / 10), opts);
    dist[plan.type]++;
    const uniq = new Set(plan.lanes);
    const inRange = plan.lanes.every((l) => l >= 0 && l < api.LANE_COUNT);
    if (plan.type === 'wall' || plan.type === 'slime' || plan.type === 'snow') {
      // 恒 ≥1 畅通车道（红线）：1~2 条占用、互异、不含 freeLane
      const ok = plan.lanes.length >= 1 && plan.lanes.length <= 2 && uniq.size === plan.lanes.length &&
        inRange && plan.lanes.every((l) => l !== plan.freeLane) &&
        plan.freeLane >= 0 && plan.freeLane < api.LANE_COUNT;
      if (!ok) laneViol++;
    } else if (plan.type === 'barrier') {
      const n = plan.lanes.length;
      if (n < 1 || n > 3 || uniq.size !== n || !inRange) comboViol++;
      else comboLanes[n]++;
      if (n === 3 && !(plan.lanes[0] === 0 && plan.lanes[1] === 1 && plan.lanes[2] === 2 && plan.freeLane === -1)) comboViol++;
    } else if (plan.type === 'pit') {
      if (!(plan.len >= api.PIT_LEN_MIN && plan.len <= api.PIT_LEN_MAX)) lenViol++;
      if (opts && opts.slowed) lenViol++;               // 红线c：减速态禁坑
    } else if (plan.type === 'coin') {
      if (plan.lanes.length !== 1 || !inRange || !(plan.count >= api.COIN_MIN && plan.count <= api.COIN_MAX)) coinViol++;
    }
    // 复现 _spawnObstacles 间距逻辑（同一 rng 流）：gap = planRowGap(rng, plan, prevPlan, speed)
    const gap = api.planRowGap(rng, plan, prevPlan, speed);
    const baseMin = 15 + speed * 0.45;                  // rng()×10 下界
    if (gap < baseMin - 1e-9) pitGapViol++;
    if (plan.type === 'pit') {
      minGapAfterPit = Math.min(minGapAfterPit, gap);
      if (gap < api.PIT_BUFFER_GAP - 1e-9) pitGapViol++;
    }
    const prevCombo = !!prevPlan && prevPlan.type === 'barrier' && prevPlan.lanes.length >= 2;
    if (prevCombo && (plan.type === 'slime' || plan.type === 'snow')) {
      if (gap < baseMin + api.COMBO_FOLLOW_GAP - 1e-9) comboBufViol++;   // 红线b：组合后落地侧 +8u
    }
    minGap = Math.min(minGap, gap);
    prevPlan = plan;
    distance += gap;
  }
  return { dist, rows, laneViol, pitGapViol, lenViol, comboViol, coinViol, comboBufViol, minGap, minGapAfterPit, comboLanes };
}

const norm = sampleRun(2000, {}, SEED);
const fren = sampleRun(1000, { frenzy: true }, SEED + 1);
const slow = sampleRun(1000, { slowed: true }, SEED + 2);

// planRowGap 确定性单元测试（rng 恒 0.3）
const r03 = () => 0.3;
const gCombo = api.planRowGap(r03, { type: 'slime', lanes: [0], freeLane: 1, len: 0, count: 0 }, { type: 'barrier', lanes: [0, 1], freeLane: 2, len: 0, count: 0 }, 12);
const gPlain = api.planRowGap(r03, { type: 'slime', lanes: [0], freeLane: 1, len: 0, count: 0 }, { type: 'barrier', lanes: [0], freeLane: 1, len: 0, count: 0 }, 12);
const gPit = api.planRowGap(r03, { type: 'pit', lanes: [], freeLane: -1, len: 6, count: 0 }, null, 12);

const wSum = (w) => TYPES.reduce((s, t) => s + w[t], 0);
const asserts = [
  ['apex >= 2*BARRIER_HEIGHT（组合3车道同数学，必须跳成立）', apex >= 2 * api.BARRIER_HEIGHT, apex.toFixed(4) + ' >= ' + 2 * api.BARRIER_HEIGHT],
  ['WALL_HEIGHT >= apex+DINO_H', api.WALL_HEIGHT >= apex + DINO_H, api.WALL_HEIGHT + ' >= ' + (apex + DINO_H).toFixed(4)],
  ['apex 处恐龙盒顶 < WALL_HEIGHT', apex + 1.9 < api.WALL_HEIGHT, (apex + 1.9).toFixed(4) + ' < ' + api.WALL_HEIGHT],
  ['PIT_LEN_MAX <= min_speed*t_air*0.75', api.PIT_LEN_MAX <= api.BASE_SPEED * tAir * 0.75, api.PIT_LEN_MAX + ' <= ' + (api.BASE_SPEED * tAir * 0.75).toFixed(3)],
  ['PIT_LEN_MIN > 恐龙盒深 0.85（微跳跨不过）', api.PIT_LEN_MIN > 0.85, api.PIT_LEN_MIN + ' > 0.85'],
  ['PIT_BUFFER_GAP >= speedMax*0.8', api.PIT_BUFFER_GAP >= speedMax * 0.8, api.PIT_BUFFER_GAP + ' >= ' + speedMax * 0.8],
  ['红线c依据：减速最慢跳距 0.55×12×1.2143=8.01 < PIT_LEN_MAX → 禁坑必要', 0.55 * api.BASE_SPEED * tAir < api.PIT_LEN_MAX, (0.55 * api.BASE_SPEED * tAir).toFixed(2) + ' < ' + api.PIT_LEN_MAX],
  ['雪贴地触发语义：恐龙盒底 0.1 < SNOW_H 0.15', 0.1 < api.SNOW_H, '0.1 < ' + api.SNOW_H],
  ['权重合计=1（normal）', Math.abs(wSum(api.PLAN_WEIGHTS) - 1) < 1e-9, wSum(api.PLAN_WEIGHTS).toFixed(2)],
  ['权重合计=1（frenzy）', Math.abs(wSum(api.PLAN_WEIGHTS_FRENZY) - 1) < 1e-9, wSum(api.PLAN_WEIGHTS_FRENZY).toFixed(2)],
  ['红线常量未动 28/17/2.2', api.OBSTACLE_MAX_HEIGHT === 2.2 && api.GRAVITY === 28 && api.JUMP_V0 === 17, '28/17/2.2'],
  ['落地余量 = min_speed*t_air - PIT_LEN_MAX >= 4', api.BASE_SPEED * tAir - api.PIT_LEN_MAX >= 4, (api.BASE_SPEED * tAir - api.PIT_LEN_MAX).toFixed(3) + 'u'],
  ['planRowGap: 组合后 slime = 普通后 slime + 8', Math.abs((gCombo - gPlain) - api.COMBO_FOLLOW_GAP) < 1e-9, gCombo.toFixed(2) + ' - ' + gPlain.toFixed(2)],
  ['planRowGap: pit 排 gap ≥ 30', gPit >= api.PIT_BUFFER_GAP - 1e-9, gPit.toFixed(2)],
  ['slowed 采样零 pit（红线c）', slow.dist.pit === 0, 'pit=' + slow.dist.pit],
  ['frenzy barrier 占比 > normal', fren.dist.barrier / fren.rows > norm.dist.barrier / norm.rows, (fren.dist.barrier / fren.rows * 100).toFixed(1) + '% > ' + (norm.dist.barrier / norm.rows * 100).toFixed(1) + '%'],
  ['frenzy slime+snow 占比 > normal', (fren.dist.slime + fren.dist.snow) / fren.rows > (norm.dist.slime + norm.dist.snow) / norm.rows, ((fren.dist.slime + fren.dist.snow) / fren.rows * 100).toFixed(1) + '% > ' + ((norm.dist.slime + norm.dist.snow) / norm.rows * 100).toFixed(1) + '%'],
];
let fail = 0;
const report = (name, r) => {
  console.log('-- ' + name + ' rows=' + r.rows + ' 分布: ' + TYPES.map((t) => t + '=' + r.dist[t] + '(' + (r.dist[t] / r.rows * 100).toFixed(1) + '%)').join(' '));
  console.log('   车道违规=' + r.laneViol + ' 组合违规=' + r.comboViol + ' 坑长/禁坑违规=' + r.lenViol + ' 金币违规=' + r.coinViol +
    ' 坑后缓冲违规=' + r.pitGapViol + ' 组合后缓冲违规=' + r.comboBufViol +
    ' 组合车道 1/2/3=' + r.comboLanes[1] + '/' + r.comboLanes[2] + '/' + r.comboLanes[3] +
    ' 最小间距=' + r.minGap.toFixed(2) + 'u 坑后最小=' + (r.minGapAfterPit === Infinity ? 'n/a' : r.minGapAfterPit.toFixed(2) + 'u'));
  fail += r.laneViol + r.comboViol + r.lenViol + r.coinViol + r.pitGapViol + r.comboBufViol;
};
console.log('== Phase-14 pickObstaclePlan/planRowGap 采样报告 seed=' + SEED + ' ==');
console.log('apex=' + apex.toFixed(4) + 'u  t_air=' + tAir.toFixed(4) + 's  speed∈[' + api.BASE_SPEED + ',' + speedMax + ']');
report('normal(2000)', norm);
report('frenzy(1000)', fren);
report('slowed(1000)', slow);
for (const [name, ok, info] of asserts) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (info ? '  [' + info + ']' : ''));
  if (!ok) fail++;
}
if (fail) { console.error('SAMPLING FAILED (' + fail + ')'); process.exit(1); }
console.log('ALL SAMPLING CHECKS PASSED');
