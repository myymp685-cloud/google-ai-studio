// Phase-14 验收 C：chaseStep 追逐状态机纯函数单元测试——
// 失误骤减(-6 instant + 2/s×2s) / 完美缓增(+0.5/排,+0.8/币,+0.1/s) / 上限30 / 归零死亡 /
// 狂飙进出（cd∈[45,60] 到期进入 20s；chase<8 立即进入/延长；到期 cd 重置）。
// 与采样脚本同法：截取 runner3d.js 类定义前纯函数区 eval，被测对象 = 真实生产代码。
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../js/runner3d.js', import.meta.url), 'utf8');
const cut = src.indexOf('export class Runner3D');
const pure = src.slice(0, cut).replace(/^import .*$/m, '').replace(/^export /gm, '');
const api = new Function(pure + `
  return { chaseStep, CHASE_INIT, CHASE_MAX, CHASE_REGEN, CHASE_PERFECT, CHASE_COIN,
           CHASE_SLOW_INSTANT, CHASE_SLOW_DRAIN, SLOW_DUR, FRENZY_DUR,
           FRENZY_CD_MIN, FRENZY_CD_SPAN, FRENZY_TRIGGER_CHASE }; `)();

const st = (o = {}) => Object.assign({ chase: api.CHASE_INIT, slowT: 0, frenzyT: 0, frenzyCd: 999, dead: false }, o);
const ev = (o = {}) => ({ perfectRows: 0, coins: 0, slowEntered: false, ...o });
const rng5 = () => 0.5;                                   // cd = 45+0.5×15 = 52.5
let fail = 0;
const eq = (name, a, b, tol = 1e-9) => {
  const ok = Math.abs(a - b) <= tol;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + '  [' + a.toFixed(4) + (ok ? ' == ' : ' != ') + b + ']');
  if (!ok) fail++;
};
const truth = (name, v) => { console.log((v ? 'PASS' : 'FAIL') + '  ' + name); if (!v) fail++; };

// T1 失误骤减：slowEntered → instant -6 且 slowT=2
let s = st({ chase: 18 });
api.chaseStep(s, 0, ev({ slowEntered: true }), rng5);
eq('T1 instant -6 → chase=12', s.chase, 12);
eq('T1 slowT=2', s.slowT, 2);

// T2 减速期额外 -2/s（含 +0.1/s 自然回复）：dt=0.5 → 12 - 1 + 0.05 = 11.05，slowT=1.5
api.chaseStep(s, 0.5, ev(), rng5);
eq('T2 drain 2/s + regen 0.1/s', s.chase, 11.05);
eq('T2 slowT=1.5', s.slowT, 1.5);
// 减速满 2s 总损 = 6 + 4 - 0.2 = 9.8
let s2 = st({ chase: 20 });
api.chaseStep(s2, 0, ev({ slowEntered: true }), rng5);
for (let i = 0; i < 40; i++) api.chaseStep(s2, 0.05, ev(), rng5);   // 2s @50Hz
eq('T2b 2s 减速全程净损 9.8 → 20-9.8=10.2', s2.chase, 10.2, 1e-6);
truth('T2c slowT 到期归零', s2.slowT === 0);

// T3 完美缓增：perfectRows×0.5 + coins×0.8 + 0.1/s
let s3 = st({ chase: 10 });
api.chaseStep(s3, 1, ev({ perfectRows: 2, coins: 1 }), rng5);
eq('T3 +2×0.5+1×0.8+0.1 → 11.9', s3.chase, 11.9);

// T4 上限 30
let s4 = st({ chase: 29.95 });
api.chaseStep(s4, 1, ev({ perfectRows: 10 }), rng5);
eq('T4 clamp CHASE_MAX=30', s4.chase, api.CHASE_MAX);

// T5 归零死亡：chase=5 → slowEntered(-6) → dead
let s5 = st({ chase: 5 });
api.chaseStep(s5, 0, ev({ slowEntered: true }), rng5);
truth('T5 dead=true', s5.dead === true);
eq('T5 chase clamp 0', s5.chase, 0);

// T6 狂飙进入（cd 到期）：frenzyCd=0.5, dt=1 → frenzyT=20
let s6 = st({ frenzyCd: 0.5 });
api.chaseStep(s6, 1, ev(), rng5);
eq('T6 cd 到期 → frenzyT=FRENZY_DUR(20)', s6.frenzyT, api.FRENZY_DUR);

// T7 狂飙进入（chase<8 立即）：cd 未到也触发
let s7 = st({ chase: 7, frenzyCd: 999 });
api.chaseStep(s7, 0.1, ev(), rng5);
eq('T7 chase<8 → 立即 frenzyT=20', s7.frenzyT, api.FRENZY_DUR);

// T8 狂飙延长：frenzyT=0.5 且 chase<8 → 重新拉满 20
let s8 = st({ chase: 5 + 3, frenzyT: 0.5 });   // chase=8 边界不触发（<8 才触发）
api.chaseStep(s8, 1, ev(), rng5);
truth('T8a chase=8（非<8）→ 倒计时不延长', s8.frenzyT === 0);   // 0.5-1 → ≤0 到期
let s8b = st({ chase: 6, frenzyT: 0.5 });
api.chaseStep(s8b, 1, ev(), rng5);
eq('T8b chase<8 → 延长回 20', s8b.frenzyT, api.FRENZY_DUR);

// T9 狂飙到期 → cd 重置 45+rng×15
let s9 = st({ chase: 20, frenzyT: 0.5 });
api.chaseStep(s9, 1, ev(), rng5);
truth('T9a frenzyT 归零', s9.frenzyT === 0);
eq('T9b cd=45+0.5×15=52.5', s9.frenzyCd, api.FRENZY_CD_MIN + 0.5 * api.FRENZY_CD_SPAN);

// T10 自然回复速率：无事件 dt=1 → +0.1
let s10 = st({ chase: 10, frenzyCd: 999 });
api.chaseStep(s10, 1, ev(), rng5);
eq('T10 regen 0.1/s', s10.chase, 10.1);

// T11 常量自证（简报数值）
truth('T11 常量 = 简报值', api.CHASE_INIT === 18 && api.CHASE_MAX === 30 && api.CHASE_REGEN === 0.1 &&
  api.CHASE_PERFECT === 0.5 && api.CHASE_COIN === 0.8 && api.CHASE_SLOW_INSTANT === 6 &&
  api.CHASE_SLOW_DRAIN === 2 && api.SLOW_DUR === 2 && api.FRENZY_DUR === 20 &&
  api.FRENZY_CD_MIN === 45 && api.FRENZY_CD_SPAN === 15 && api.FRENZY_TRIGGER_CHASE === 8);

// T12 长程仿真：15000 步 @50Hz 无事件 → chase 收敛 30 且永不越界/死亡
let s12 = st({ chase: 1, frenzyCd: 9999 });
let bounded = true;
for (let i = 0; i < 15000; i++) { api.chaseStep(s12, 0.02, ev(), rng5); if (s12.chase < 0 || s12.chase > 30) bounded = false; }
truth('T12 长程有界 [0,30]', bounded);
truth('T12b 300s 缓增到上限且未死', s12.chase === 30 && !s12.dead);

if (fail) { console.error('CHASE STATE MACHINE FAILED (' + fail + ')'); process.exit(1); }
console.log('ALL CHASE MACHINE CHECKS PASSED');
