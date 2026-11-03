// js/main.js
// 引导（bootstrap）+ 单一 requestAnimationFrame 主循环 + 三通道输入接线 + 2D/3D 模式切换。
// 开场流程状态机在 js/introFlow.js：loading → prompt → calibrating → calibrated → playing。
// 加载进度 = three/runner3d/dinoGame/tasks-vision bundle/WASM/模型 等真实异步资源的聚合完成度。
// 模式（规格⑮）：mode='3d'（默认，js/runner3d.js 追尾跑酷）↔ mode='2d'（原 Canvas 兜底，dinoGame.js 核心未动）。

import { PerfMonitor } from './perf.js';
import { IntroFlow } from './introFlow.js';

const $ = (id) => document.getElementById(id);
const canvas = $('game-canvas');
const scoreEl = $('score');
const hiScoreEl = $('hi-score');
const perfEl = $('perf-status');
const uiLayer = $('ui-layer');
const hud3d = $('hud3d');
const score3dEl = $('score3d');
const hi3dEl = $('hi3d');
const speed3dEl = $('speed3d');
const resultPanel = $('result-panel');
const resultScoreEl = $('result-score-val');
const resultHiEl = $('result-hi-val');
const resultRestartBtn = $('result-restart-btn');
const modeToggleBtn = $('mode-toggle');
const leanToggle = $('lean-toggle');          // Phase-12：体感变道开关，默认勾选 = 开；取消勾选仅关体感通道，键盘 A/D 不受影响
const camToggleBtn = $('cam-toggle');         // 3D 视角切换（Phase-4 规格6）：高角度追尾 ↔ 斜45°等距
const dofToggleBtn = $('dof-toggle');         // 移轴景深开关（Phase-5 规格9）：BokehPass 一键开/关
const qualityToggleBtn = $('quality-toggle'); // 手动画质档（Phase-10）：自动→高→低 循环

const pad5 = (n) => String(Math.floor(n)).padStart(5, '0');

// ===== 运行时引用（动态加载后填充） =====
let scene3d = null;
let runner = null;   // 3D 跑酷
let game = null;     // 2D 兜底
let pose = null;
let mode = '3d';     // 默认 3D 跑酷模式（规格⑮：按钮双向切换）

const is3D = () => mode === '3d';

/** 依据 mode + flow.state 同步 UI 可见性与相机归属 */
function applyModeUI() {
  const playing3d = is3D() && flow.state === 'playing';
  uiLayer.classList.toggle('hidden', playing3d);   // 3D 跑酷时隐藏 2D 玻璃卡片
  hud3d.classList.toggle('hidden', !playing3d);    // 3D HUD 仅跑酷时显示
  scene3d.setCameraControl(!playing3d);            // 跑酷时相机交给 runner3d（追尾视角）
  modeToggleBtn.textContent = is3D() ? '🕹 切换 2D 模式' : '🕹 切换 3D 模式';
  camToggleBtn.classList.toggle('hidden', !is3D());   // 视角按钮仅 3D 模式相关
}

function restartRunner() {
  resultPanel.classList.add('hidden');
  runner.reset();
  score3dEl.textContent = pad5(0);
  speed3dEl.textContent = 'SPD --.-';
}

// ===== 开场流程状态机 =====
const handlers = {
  getHasPose: () => !!(pose && pose.hasPose),

  // Phase-11：进入校准倒计时 → 同步开启 poseController 的 2 秒 headY 基线采集窗口
  beginBaseline: () => { if (pose) pose.beginCalibration(); },

  // 「开启摄像头」/「重新校准」共用：引擎未加载则先加载，再开摄像头；失败弹兜底提示
  enableCamera: async () => {
    try {
      if (!pose.engineOK) {
        await pose.loadEngine((frac, label) => flow.setProgress(0.3 + 0.7 * frac, '体感引擎：' + label));
        flow.setProgress(1, '加载完成');
      }
      await pose.startCamera();
      return true;
    } catch (err) {
      // 兜底路径 1：授权失败 / 摄像头不可用 → 「可以先用空格键开始」
      flow.showFallback('摄像头不可用（' + (err && err.message ? err.message : err) + '）——可以先用空格键开始');
      return false;
    }
  },

  // 右上角「重新校准」：随时回到校准流程（跳过后也可在此开启摄像头）
  startRecalibration: async () => {
    if (!pose.engineOK || !pose.cameraOn) {
      const ok = await handlers.enableCamera();
      if (!ok) return;
    }
    flow.startCalibration(pose.hasPose ? 1 : 3);
  },

  // 校准通过/跳过 → 进入游玩：按当前模式初始化
  enterGame: () => {
    if (qualityMode === 'auto') perfEl.textContent = 'FPS --';   // Phase-11：手动画质档保持锁定文案
    applyModeUI();
    if (is3D() && (runner.state === 'idle' || runner.state === 'over')) restartRunner();
  },
};

const flow = new IntroFlow({
  introOverlay: $('intro-overlay'),
  ring: $('ring-ellipse'),
  loadLabel: $('intro-load-label'),
  card: document.querySelector('.glass-card'),
  camPrompt: $('cam-prompt'),
  enableCamBtn: $('enable-cam-btn'),
  skipLink: $('skip-cam-link'),
  calibOverlay: $('calib-overlay'),
  countText: $('calib-count'),
  stepText: $('calib-step-text'),
  silhouette: $('dino-silhouette'),
  fallbackToast: $('fallback-toast'),
  fallbackMsg: $('fallback-msg'),
  fallbackStartBtn: $('fallback-start-btn'),
  recalibrateBtn: $('recalibrate-btn'),
}, handlers);

// ===== 加载 1/4：three.js + 3D 场景（真实进度聚合，非假计时器） =====
flow.setProgress(0.02, '正在加载 three.js 场景引擎…');
const sceneMod = await import('./scene3d.js');            // 含 three 与 addons 整个模块图
scene3d = new sceneMod.Scene3D($('scene3d-container'));
scene3d.setLoading(true);                                 // 粒子向中心聚合、方块云由远及近淡入
dofToggleBtn.textContent = scene3d.dofEnabled ? '🔍 景深：开' : '🔍 景深：关';   // 初始标签（移动端默认关，规格9）
flow.attachScene3d(scene3d);
flow.setProgress(0.2, 'three.js 场景引擎 ✓');

// ===== 加载 2/4：3D 跑酷跑道（恐龙网格/障碍池/碰撞/追尾相机，js/runner3d.js） =====
const { Runner3D } = await import('./runner3d.js');
runner = new Runner3D(scene3d, {
  onJump: () => { scene3d.triggerRipple(); },             // 跳跃 → 暖金波纹脉冲（Phase-5 默认色）
  onScore: (score, speed) => {
    score3dEl.textContent = pad5(score);
    speed3dEl.textContent = 'SPD ' + speed.toFixed(1) + ' · CHASE ' + Math.ceil(runner.chase);   // Phase-14：追逐距离 HUD（10Hz 随分数节流）
  },
  onGameOver: (score, hi) => {                            // 撞击结算面板（父代理假设④）
    resultScoreEl.textContent = pad5(score);
    resultHiEl.textContent = pad5(hi);
    resultPanel.classList.remove('hidden');
  },
});
score3dEl.textContent = pad5(0);
hi3dEl.textContent = pad5(runner.hi);
flow.setProgress(0.3, '3D 跑道就绪 ✓');

// ===== 加载 3/4：2D 兜底游戏（原 Canvas 逻辑，核心未动） =====
const { DinoGame } = await import('./dinoGame.js');
game = new DinoGame(canvas, {
  // 恐龙每次起跳（无论来源）→ 3D 层波纹脉冲 + 相机弹动
  onJump: () => {
    scene3d.triggerRipple();
    scene3d.jumpBounce();
  },
  onScore: (s, hi) => {
    scoreEl.textContent = pad5(s);
    hiScoreEl.textContent = pad5(hi);
  },
  onGameOver: (s, hi) => {
    scoreEl.textContent = pad5(s);
    hiScoreEl.textContent = pad5(hi);
  },
});
scoreEl.textContent = pad5(0);
hiScoreEl.textContent = pad5(game.hiScore);

// ===== 加载 4/4：体感姿态（引擎按需加载：bundle → WASM → 模型，逐步上报真实进度） =====
const { PoseController } = await import('./poseController.js');
pose = new PoseController({
  video: $('cam-video'),
  overlay: $('pose-overlay'),
  statusEl: $('pose-status'),
  readoutEl: $('pose-readout'),
});
// 三通道之体感通道 + 校准试跳分流（验收 C：校准期试跳只作校准判定；playing 态按模式驱动 3D 或 2D 的同一 jump() 入口）
pose.onJump = () => {
  if (flow.state === 'calibrating') flow.calibJumpDetected();       // 校准试跳 → 仅状态机
  else if (flow.state === 'playing') {
    if (is3D()) runner.jump('pose');                                // 3D 跑酷（规格①②）
    else game.jump('pose');                                         // 2D 兜底
  }
};
// Phase-12 规格2a：体感变道通道——肩中点 X 偏移（poseController.feedLaneX 死区/滞回/冷却判定）→ runner.setTargetLane(±1)
pose.onLane = (dir) => {
  if (flow.state !== 'playing' || !is3D()) return;                  // 2D 兜底保持单车道（规格5）
  if (!leanToggle.checked) return;                                  // 体感变道可开关（默认开）
  runner.setTargetLane(dir);
};
try {
  await pose.loadEngine((frac, label) => flow.setProgress(0.3 + 0.7 * frac, '体感引擎：' + label));
} catch (err) {
  $('pose-status').textContent = '体感引擎加载失败：' + (err && err.message ? err.message : err);
}

// ===== 鼠标视差（开场/2D 模式用；3D 跑酷时相机由 runner3d 接管，scene3d 内部跳过视差） =====
let mouseX = 0, mouseY = 0;
window.addEventListener('pointermove', (e) => {
  mouseX = (e.clientX / window.innerWidth) * 2 - 1;
  mouseY = (e.clientY / window.innerHeight) * 2 - 1;
});

// ===== 输入通道 1：空格/上键（3D=跳跃或重开，校准态=跳过校准；仅相应状态生效） =====
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.code === 'ArrowUp') {
    e.preventDefault();
    if (flow.state === 'calibrating') { flow.skipCalibration(); return; }
    if (flow.state !== 'playing') return;
    if (is3D()) {
      if (runner.state === 'crashed' || runner.state === 'over') restartRunner();
      else runner.jump('key');
    } else {
      game.jump('key');   // 2D：dinoGame.jump 自带 Game Over 重开语义（经典 Chrome dino）
    }
  } else if (e.code === 'KeyA' || e.code === 'ArrowLeft') {
    // Phase-12 规格2b：键盘变道通道（与体感通道汇聚到同一 setTargetLane；仅 3D 游戏态生效）
    if (flow.state === 'playing' && is3D()) { e.preventDefault(); runner.setTargetLane(-1); }
  } else if (e.code === 'KeyD' || e.code === 'ArrowRight') {
    if (flow.state === 'playing' && is3D()) { e.preventDefault(); runner.setTargetLane(1); }
  }
});

// ===== 输入通道 2a：2D 模式点击/触摸游戏画布 =====
canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (flow.state === 'playing' && mode === '2d') game.jump('pointer');
});

// ===== 输入通道 2b：3D 模式点击/触摸全屏（排除按钮/面板/调试窗，不拦截 UI） =====
document.addEventListener('pointerdown', (e) => {
  if (mode !== '3d' || flow.state !== 'playing') return;
  if (e.target.closest('button, a, input, label, .glass-panel, #cam-debug, #mode-bar, #result-panel')) return;
  if (runner.state === 'crashed' || runner.state === 'over') restartRunner();
  else runner.jump('pointer');
});

// ===== 手动微调基线按钮（与开场校准并存） =====
$('calibrate-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  pose.calibrate();
});

// ===== 模式切换（规格⑮：双向可切） =====
modeToggleBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  mode = is3D() ? '2d' : '3d';
  applyModeUI();
  if (is3D() && flow.state === 'playing' && (runner.state === 'idle' || runner.state === 'over')) restartRunner();
});

// ===== 3D 视角切换（Phase-4 规格6）：高角度追尾（默认）↔ 斜 45° 等距，运行时可来回切 =====
camToggleBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const next = runner.camMode === 'iso' ? 'chase' : 'iso';
  runner.setCameraMode(next);
  camToggleBtn.textContent = next === 'iso' ? '📷 视角：45° 等距' : '📷 视角：高角度追尾';
});

// ===== 景深开关（Phase-5 规格9）：BokehPass 移轴景深一键开/关（降级链第①级也会自动关它） =====
dofToggleBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  scene3d.setDof(!scene3d.dofEnabled);
  dofToggleBtn.textContent = scene3d.dofEnabled ? '🔍 景深：开' : '🔍 景深：关';
});

// ===== Phase-11：调试面板滑块——跳跃阈值 / 冷却 ms（input 即时生效，setter 带钳制） =====
const jumpThresholdSlider = $('jump-threshold');
const jumpCooldownSlider = $('jump-cooldown');
const jumpThresholdVal = $('jump-threshold-val');
const jumpCooldownVal = $('jump-cooldown-val');
jumpThresholdSlider.addEventListener('input', () => {
  pose.setThreshold(jumpThresholdSlider.value);
  jumpThresholdVal.textContent = pose.jumpThreshold.toFixed(3);
});
jumpCooldownSlider.addEventListener('input', () => {
  pose.setCooldown(jumpCooldownSlider.value);
  jumpCooldownVal.textContent = String(pose.cooldownMs);
});

// ===== 结算面板「再来一局」 =====
resultRestartBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  restartRunner();
});

// ===== 性能监测与画质档（Phase-10：双向可恢复 + 预热豁免 + 手动画质档） =====
// 自动：perf.js 采样——开局 6s 预热豁免；<24fps 持续 5s 逐级降（最高 L3）；>42fps 持续 4s 逐级升（可一路回 L0 完整画质）。
// 手动（#quality-toggle 循环 低(默认)→自动→高→低）：高 = 暂停采样并锁 L0；低 = 暂停采样并锁 L2（Bloom 保留）；自动 = perf.reset() 后恢复采样。
let qualityMode = 'low';   // Phase-11：默认『低』——启动即锁定 L2（Bloom/霓虹边线/路侧景物保留），暂停自动采样
const perf = new PerfMonitor({
  lowFps: 24, sustainMs: 5000, maxLevel: 3,
  warmupMs: 6000, recoverFps: 42, recoverMs: 4000,
  onDegrade: (level, fps) => {
    const desc = scene3d.applyQuality(level) + ' + ' + runner.degradeScenery(level);
    perfEl.textContent = '已降级 L' + level + '：' + desc + '（FPS ' + fps.toFixed(0) + '）';
  },
  onRecover: (level, fps) => {
    const desc = scene3d.applyQuality(level) + ' + ' + runner.degradeScenery(level);
    perfEl.textContent = level === 0
      ? 'FPS ' + fps.toFixed(0) + ' · 已恢复 L0：画质完整'
      : '已恢复 L' + level + '：' + desc;
  },
});

// ===== Phase-11：默认画质档『低』——启动即应用 L2（applyQuality/degradeScenery 幂等），采样保持暂停 =====
scene3d.applyQuality(2);
runner.degradeScenery(2);
perfEl.textContent = '画质：低（手动锁定 L2，Bloom 保留，自动降级已暂停）';

// 手动画质档按钮：低（默认）→ 自动（恢复采样）→ 高（锁 L0，停采样）→ 低（锁 L2，停采样）
qualityToggleBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  qualityMode = qualityMode === 'auto' ? 'high' : qualityMode === 'high' ? 'low' : 'auto';
  qualityToggleBtn.textContent = qualityMode === 'auto' ? '🎚 画质：自动'
    : qualityMode === 'high' ? '🎚 画质：高' : '🎚 画质：低';
  if (qualityMode === 'high') {
    scene3d.applyQuality(0); runner.degradeScenery(0);
    perfEl.textContent = '画质：高（手动锁定 L0，已暂停自动降级）';
  } else if (qualityMode === 'low') {
    scene3d.applyQuality(2); runner.degradeScenery(2);
    perfEl.textContent = '画质：低（手动锁定 L2，Bloom 保留，已暂停自动降级）';
  } else {
    perf.reset();                                 // 清掉跨暂停期的采样窗口再恢复
    perfEl.textContent = 'FPS --';
  }
});

// ===== 单一 rAF 主循环：流程状态机 + 姿态(每帧≤1次) + 当前模式游戏 + 3D + 性能采样 =====
let last = performance.now();
let perfTextTimer = 0;
// ===== Phase-14：危险暗角 / 冰霜覆盖 元素与节流状态（opacity 仅在 |Δ|>0.02 时写 DOM）=====
const dangerEl = $('danger-vignette');
const frostEl = $('frost-overlay');
let lastDangerOp = 0;
let lastFrostOp = 0;
let lastDangerPulse = false;   // Phase-15：脉冲 class 切换状态（仅变化时写 classList）
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min((now - last) / 1000, 0.05);   // 钳制 dt
  last = now;

  flow.frame(dt);                                   // 状态机时间逻辑（倒计时/兜底）

  if (pose && pose.cameraOn && (flow.state === 'calibrating' || flow.state === 'playing')) {
    const airborne = is3D() ? runner.isAirborne() : (game ? game.isAirborne() : false);
    pose.update(now, airborne);                     // detectForVideo 每帧最多一次；基线冻结按当前模式腾空态
  }

  if (flow.state === 'playing') {
    if (is3D()) {
      // Phase-12：变道由 setTargetLane 事件驱动（体感 pose.onLane / 键盘 A/D），无逐帧连续侧移目标；
      // runner.update 内部对 dinoX 做车道中心平滑收敛
      runner.update(dt);
    } else {
      game.update(dt);                              // 仅游戏进行态推进物理
    }
  }
  // Phase-14/15：红色危险暗角（runner.dangerLevel=(1-chase/30)^1.5 常驻 | 狂飙≥0.45 | 减速≥0.55 | 怪物扑杀=1 | over 归零）+ 冰霜（frostT>0 → 0.9）
  if (is3D() && runner) {
    const dOp = Math.min(1, runner.dangerLevel);
    if (Math.abs(dOp - lastDangerOp) > 0.02) { dangerEl.style.opacity = dOp.toFixed(2); lastDangerOp = dOp; }
    // Phase-15：dangerLevel≥0.70（≈chase<6u / 怪物扑杀瞬间）红色脉冲呼吸——逼近威胁靠暗角传递，不靠大模型挡视线
    const dPulse = dOp >= 0.7;
    if (dPulse !== lastDangerPulse) { dangerEl.classList.toggle('pulsing', dPulse); lastDangerPulse = dPulse; }
    const fOp = runner.frostT > 0 ? 0.9 : 0;
    if (Math.abs(fOp - lastFrostOp) > 0.02) { frostEl.style.opacity = fOp.toFixed(2); lastFrostOp = fOp; }
  } else if (lastDangerOp !== 0 || lastFrostOp !== 0 || lastDangerPulse) {
    dangerEl.style.opacity = '0'; frostEl.style.opacity = '0';
    dangerEl.classList.remove('pulsing');
    lastDangerOp = 0; lastFrostOp = 0; lastDangerPulse = false;
  }
  if (mode === '2d') game.draw();                   // 2D 画布常绘（开场/结算也保持画面，与 phase-2 行为一致）

  if (scene3d) {
    if (!is3D() && pose && pose.hasPose && flow.state === 'playing') {
      scene3d.setParallaxTarget(pose.parallax.x, pose.parallax.y);
    } else {
      scene3d.setParallaxTarget(mouseX, mouseY);
    }
    scene3d.update(dt);                             // 粒子/几何体/Bloom 渲染；3D 跑酷时相机分支已被 cameraControl=false 跳过
  }

  if (qualityMode === 'auto') perf.frame(now);    // Phase-10：手动画质档暂停采样
  perfTextTimer += dt;
  if (perfTextTimer >= 1) {
    perfTextTimer = 0;
    if (qualityMode === 'auto' && perf.level === 0 && perf.fps > 0) perfEl.textContent = 'FPS ' + perf.fps.toFixed(0) + ' · 画质完整';
  }
}
requestAnimationFrame(loop);

// ===== 加载完成 → 标题弹跳淡出、粒子散开、卡片浮现 → 摄像头授权引导 =====
flow.setProgress(1, '加载完成');
await flow.finishLoading();
