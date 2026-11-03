// js/introFlow.js
// 开场流程状态机（单一职责）：
//   loading → prompt → calibrating → calibrated → playing
// 兜底路径（非独立状态，均通向 playing，保证无死锁）：
//   prompt --「跳过，用空格键玩」--> playing (skipped)
//   prompt/calibrating --授权失败 / 10s 未检测到人体--> fallback 提示 → playing
//   playing --「重新校准」--> calibrating（可无限往返）
// 所有时间逻辑由 main.js 的单一 rAF 循环通过 frame(dt) 驱动，不引入第二个循环。

export const FLOW = {
  LOADING: 'loading',
  PROMPT: 'prompt',
  CALIBRATING: 'calibrating',
  CALIBRATED: 'calibrated',
  PLAYING: 'playing',
};

// 合法转移表（验收 A：每条路径都有出口）
const TRANSITIONS = {
  loading: ['prompt'],
  prompt: ['calibrating', 'playing'],        // 开启摄像头 | 跳过/兜底
  calibrating: ['calibrated', 'playing'],    // 试跳成功 | 10s 无人兜底直接开始
  calibrated: ['playing'],                   // 成功动效后进入
  playing: ['calibrating'],                  // 重新校准
};

const NO_HUMAN_MS = 10000;   // 兜底：10 秒未检测到人体
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class IntroFlow {
  /**
   * @param {object} els DOM 元素集合
   * @param {{getHasPose:()=>boolean, enableCamera:()=>Promise<boolean>,
   *          startRecalibration:()=>Promise<void>|void, enterGame:()=>void}} handlers
   */
  constructor(els, handlers) {
    this.els = els;
    this.handlers = handlers;
    this.scene3d = null;          // attachScene3d() 注入
    this.state = FLOW.LOADING;
    this.skipped = false;         // 用户是否跳过体感
    this.detecting = false;       // 倒计时结束后才接受试跳
    this.calibDone = false;       // 本轮校准是否已成功
    this.countdownLeft = 0;       // 校准倒计时（秒）
    this.noHumanMs = 0;           // 连续未检测到人体的时长
    this.fallbackShown = false;

    // 事件接线
    els.enableCamBtn.addEventListener('click', () => this.onEnableCam());
    els.skipLink.addEventListener('click', (e) => { e.preventDefault(); this.skip(); });
    els.fallbackStartBtn.addEventListener('click', () => this.enterPlaying());
    els.recalibrateBtn.addEventListener('click', () => this.handlers.startRecalibration());

    this._syncUI();
  }

  attachScene3d(scene3d) { this.scene3d = scene3d; }

  setState(next) {
    const allowed = TRANSITIONS[this.state] || [];
    if (next !== this.state && !allowed.includes(next)) {
      console.warn('[introFlow] 非法状态转移:', this.state, '→', next);
    }
    this.state = next;
    this._syncUI();
  }

  _syncUI() {
    const e = this.els, s = this.state;
    e.camPrompt.classList.toggle('hidden', s !== FLOW.PROMPT);
    e.calibOverlay.classList.toggle('hidden', !(s === FLOW.CALIBRATING || s === FLOW.CALIBRATED));
    e.recalibrateBtn.classList.toggle('hidden', s !== FLOW.PLAYING);
  }

  /** 加载进度环：真实资源加载状态聚合（由 main.js 按 three/bundle/wasm/model 完成度调用） */
  setProgress(p, label) {
    const clamped = Math.max(0, Math.min(1, p));
    // SVG pathLength=1000：弧长 = 真实进度，细线由 CSS 动画环绕标题旋转
    this.els.ring.style.strokeDasharray = Math.max(clamped, 0.015) * 1000 + ' 1000';
    this.els.loadLabel.textContent = label + ' ' + Math.round(clamped * 100) + '%';
  }

  /** 加载完成：标题弹跳淡出 + 粒子散开 + 露出游戏卡片 → prompt */
  async finishLoading() {
    if (this.scene3d) this.scene3d.finishLoading();       // 粒子场向四周散开
    this.els.introOverlay.classList.add('done');          // 标题弹跳 + 淡出（CSS）
    await sleep(1400);
    this.els.introOverlay.classList.add('hidden');
    this.els.card.classList.add('revealed');              // 玻璃卡片缩放淡入
    await sleep(700);
    this.setState(FLOW.PROMPT);                           // 摄像头授权引导
  }

  /** 「开启摄像头」→ 成功进入校准；失败由 enableCamera 处理器弹兜底提示 */
  async onEnableCam() {
    const ok = await this.handlers.enableCamera();
    if (ok) this.startCalibration(3);   // 摄像头开启后 3 秒倒计时校准
  }

  /** 「跳过，用空格键玩」 */
  skip() {
    this.skipped = true;
    this.enterPlaying();
    this._toast('已跳过体感：用空格键 / 点击跳跃', 2600);
  }

  /** 空格键跳过校准（兜底文案「按空格键跳过校准」对应出口，calibrating → playing） */
  skipCalibration() {
    if (this.state !== FLOW.CALIBRATING || this.calibDone) return;
    this.calibDone = true;          // 防止跳过后延迟到达的试跳再进 calibJumpDetected
    this.enterPlaying();
    this._toast('已跳过校准：空格键 / 点击跳跃', 2400);
  }

  /** 进入校准：countdownSec 倒计时后开始接受试跳 */
  startCalibration(countdownSec = 3) {
    this.hideFallback();
    this.fallbackShown = false;
    this.noHumanMs = 0;
    this.calibDone = false;
    this.detecting = false;
    this.countdownLeft = countdownSec;
    this.els.silhouette.classList.remove('lit');
    this.els.countText.textContent = String(Math.ceil(countdownSec));
    this.els.countText.classList.remove('hidden');
    this.els.stepText.textContent = '请保持上半身处于画面中央，坐直或站直';
    if (this.handlers.beginBaseline) this.handlers.beginBaseline();   // Phase-11：同步开启 2 秒头部基线采集
    if (this.scene3d) this.scene3d.enterCalib();   // 粒子场收拢为校准聚集态
    this.setState(FLOW.CALIBRATING);
  }

  /** 每帧由主循环调用：倒计时 + 两步提示 + 10s 无人兜底（验收 D） */
  frame(dt) {
    if (this.state !== FLOW.CALIBRATING || this.calibDone) return;
    const hasPose = this.handlers.getHasPose();

    // 兜底路径 2：10 秒内未检测到人体 → 「可以先用空格键开始」
    if (hasPose) this.noHumanMs = 0;
    else {
      this.noHumanMs += dt * 1000;
      if (this.noHumanMs >= NO_HUMAN_MS && !this.fallbackShown) {
        this.fallbackShown = true;
        this.showFallback('未检测到跳跃，请保持上半身处于画面中央，或按空格键跳过校准');
      }
    }

    // 3 秒倒计时（3-2-1 后开始接受试跳）
    if (this.countdownLeft > 0) {
      this.countdownLeft -= dt;
      const n = Math.ceil(this.countdownLeft);
      if (n > 0) this.els.countText.textContent = String(n);
      else {
        this.els.countText.classList.add('hidden');
        this.detecting = true;
      }
      return;
    }
    // 两步提示：入镜 → 试跳
    this.els.stepText.textContent = hasPose ? '准备好了吗？快速起身或原地跳一下试试' : '请保持上半身处于画面中央，坐直或站直';
  }

  /**
   * 校准试跳被识别（由 pose.onJump 在 state===calibrating 时转发，绝不触发 game.jump）。
   * 剪影亮青色描边 + 「校准成功！」 + 3D 粒子波纹，随后进入 playing。
   */
  calibJumpDetected() {
    if (this.state !== FLOW.CALIBRATING || !this.detecting || this.calibDone) return;
    this.calibDone = true;
    this.detecting = false;
    this.els.countText.classList.add('hidden');
    this.els.silhouette.classList.add('lit');
    this.els.stepText.textContent = '校准成功！';
    if (this.scene3d) this.scene3d.triggerRipple();     // 复用波纹爆发
    this.setState(FLOW.CALIBRATED);
    setTimeout(() => this.enterPlaying(), 1200);
  }

  /** 校准成功 / 跳过 / 兜底 → 正式进入游戏（过渡动效：相机推进 + 卡片脉冲 + 粒子散开） */
  enterPlaying() {
    this.hideFallback();
    this.detecting = false;
    if (this.scene3d) this.scene3d.playTransition();
    this.setState(FLOW.PLAYING);
    const card = this.els.card;
    card.classList.remove('pulse');
    void card.offsetWidth;                 // 重触发 CSS 动画
    card.classList.add('pulse');
    if (this.handlers.enterGame) this.handlers.enterGame();
  }

  showFallback(msg) {
    this.els.fallbackMsg.textContent = msg;
    this.els.fallbackToast.classList.remove('hidden');
  }

  hideFallback() { this.els.fallbackToast.classList.add('hidden'); }

  /** 一次性轻提示（复用兜底 toast 样式，自动消失） */
  _toast(msg, ms) {
    this.showFallback.call(this, msg);
    this.els.fallbackStartBtn.classList.add('hidden');
    setTimeout(() => {
      this.hideFallback();
      this.els.fallbackStartBtn.classList.remove('hidden');
    }, ms);
  }
}
