// js/poseController.js
// 体感跳跃：MediaPipe PoseLandmarker（Phase-11 重做：头部 Y 位移 + 速度门控 + 冷却重武装，完全支持半身/坐姿）。
// 信号源 headY：两肩中点(11/12)的 Y 为主（对点头/低头更稳），肩部缺失（visibility ≤ 0.5）时回退鼻子(0)。
// 位移判定：h = baselineY − headY（归一化图像坐标，y 向下为正 → 头上移时 h 为正）；
//   baselineY = 校准期 2 秒窗口内 headY 的平均值；静息（非冷却、|h|<RETURN_EPS、v 低）时慢 EMA(α=0.02) 补偿
//   久坐下滑漂移。半身/坐姿下髋部常不可见，故不再使用髋部与躯干尺度归一化（Phase-2~10 旧方案）。
// 速度门控：v = (prevHeadY − headY)/dt（归一化/秒，向上为正），触发需 v > VEL_MIN——
//   理由：坐姿起身/跳跃的头部瞬时速度（常见 ≥1.0/s）远高于低头/后靠的慢速漂移（<0.3/s），0.55 取两者分界。
// 冷却重武装：触发后 armed=false；重武装 = 冷却(cooldownMs)已耗尽 且（|h|<RETURN_EPS 已回基线 或
//   超过 3×cooldownMs 安全超时防永久锁死）→ 杜绝『跳跃×21』连击误判。
// 姿态/头部关键点丢失时不触发、不误触发、不更新基线。
// 引擎为动态 import（本地 vendor ESM bundle），加载分 bundle→WASM→模型 三步，逐步上报真实进度。

const VISION_BUNDLE_URL = new URL('../vendor/mediapipe/vision_bundle.mjs', import.meta.url).href;
const WASM_URL = new URL('../vendor/mediapipe/wasm', import.meta.url).href;
const MODEL_URL = new URL('../vendor/models/pose_landmarker_lite.task', import.meta.url).href;

// ===================== 可调常量（Phase-11） =====================
export const JUMP_H_THRESHOLD = 0.06;   // 头部 Y 位移阈值 h（用户给定区间 0.05~0.1；UI 滑块可调 0.02~0.20）
export const JUMP_COOLDOWN_MS = 300;    // 触发后冷却（UI 滑块可调 150~800）
export const VEL_MIN = 0.55;            // 上升速度门控（归一化/秒）：起身/跳跃瞬时速度 ≫ 低头/后靠慢漂移
export const RETURN_EPS = 0.02;         // 回基线判定带：|h| < eps 视为已回基线（重武装条件 + 漂移补偿条件）
export const CALIB_WINDOW_MS = 2000;    // 校准窗口：2 秒 headY 平均值 = 基线（规格4）
const BASELINE_ALPHA = 0.02;            // 基线漂移补偿慢 EMA 系数（越小越稳，防久坐下滑）

// ---- Phase-12 规格2a：体感变道（肩中点 X 偏移，主信号）----
export const LANE_X_ENTER = 0.05;       // 变道触发死区：|肩中点X − 校准基线| > 0.05（归一化图像宽 5%）才触发
export const LANE_X_EXIT = 0.025;       // 滞回重武装带：触发后须回到 |dx| < 0.025 且冷却耗尽才可再次变道（防连续倾斜横跳）
export const LANE_COOLDOWN_MS = 350;    // 变道冷却（ms），与滞回带双重防抖
const LANE_X_SIGN = -1;                 // 方向符号：原始摄像头图像中用户右倾 → 肩中点 x 减小 → dx×(−1) > 0 = 右变道（与 roll 的 LEAN_SIGN 一致）

// 关键点索引（MediaPipe Pose Landmarker 33 点标准）
const NOSE = 0, L_SHOULDER = 11, R_SHOULDER = 12;

// 调试骨架连线（简化上/下半身；下半身点在半身模式下自然缺失，drawOverlay 跳过）
const CONNECTIONS = [
  [11, 12], [11, 23], [12, 24], [23, 24],
  [11, 13], [13, 15], [12, 14], [14, 16],
  [23, 25], [25, 27], [24, 26], [26, 28],
];

export class PoseController {
  /**
   * @param {{video:HTMLVideoElement, overlay:HTMLCanvasElement,
   *          statusEl:HTMLElement, readoutEl:HTMLElement}} ui
   */
  constructor({ video, overlay, statusEl, readoutEl }) {
    this.video = video;
    this.overlay = overlay;
    this.overlayCtx = overlay.getContext('2d');
    this.statusEl = statusEl;
    this.readoutEl = readoutEl;

    this.onJump = null;              // 由 main.js 赋值：校准态 → 状态机；游戏态 → game.jump('pose')
    this.onLane = null;              // Phase-12：由 main.js 赋值：变道事件 (dir=±1) → runner.setTargetLane(dir)

    this.landmarker = null;
    this.engineOK = false;           // loadEngine() 成功后为 true
    this.cameraOn = false;           // startCamera() 成功后为 true
    this.hasPose = false;

    // ---- Phase-11 头部信号状态 ----
    this.baselineY = null;           // 基线 headY（校准 2 秒平均；静息时慢 EMA 补偿）
    this.prevHeadY = null;
    this.h = null;                   // 当前位移 = baselineY − headY（向上为正）
    this.v = 0;                      // 当前上升速度（归一化/秒，向上为正）
    this.armed = true;               // 重武装标志：触发后 false，冷却耗尽且回基线/安全超时后 true
    this.cooldownStartMs = -Infinity;
    this.calibActive = false;        // 校准采集窗口进行中
    this.calibStartMs = 0;
    this.calibSum = 0;
    this.calibN = 0;
    this.calibProgress = 0;          // 0~1，调试面板实时显示采样进度

    // ---- Phase-12：体感变道状态（肩中点 X 偏移，feedLaneX 纯逻辑驱动） ----
    this.baselineX = null;           // 校准窗 2 秒肩中点 X 均值 = 变道基线
    this.calibSumX = 0;
    this.calibNX = 0;
    this.laneDx = 0;                 // 当前带符号偏移（正=用户向右倾；调试读数显示）
    this.laneArmed = true;           // 触发→false；冷却耗尽且回到滞回带内→true
    this.laneCooldownStartMs = -Infinity;
    this.laneCount = 0;              // 变道触发计数（调试读数）

    this.prevNowMs = 0;
    this.lastDetectMs = -1;
    this.triggerCount = 0;
    this.triggeredThisFrame = false;

    // 运行期可调（调试面板滑块经 setter 写入，即时生效）
    this.jumpThreshold = JUMP_H_THRESHOLD;
    this.cooldownMs = JUMP_COOLDOWN_MS;

    this.parallax = { x: 0, y: 0 };  // 供相机视差用的归一化坐标 [-1,1]
    this.tiltX = 0;                  // 肩部倾斜（roll）[-1,1]——Phase-12 后仅调试参考；变道主信号 = 肩中点 X 偏移（feedLaneX）
    this.statusMsg = '摄像头：未启动';
  }

  /**
   * 加载体感引擎（真实进度三步：ESM bundle → WASM runtime → 姿态模型）。
   * @param {(frac:number,label:string)=>void} onStep 进度回调（0~1）
   */
  async loadEngine(onStep) {
    // 1/3：tasks-vision ESM bundle（动态 import，加载失败向上抛给引导层兜底）
    const mod = await import(VISION_BUNDLE_URL);
    if (onStep) onStep(1 / 3, 'vision bundle 已加载');
    // 2/3：WASM 运行时（FilesetResolver 需要 simd 与 nosimd 两套，均来自 WASM_URL）
    const fileset = await mod.FilesetResolver.forVisionTasks(WASM_URL);
    if (onStep) onStep(2 / 3, 'WASM 运行时就绪');
    // 3/3：姿态模型（GPU 委托失败自动回退 CPU）
    const options = {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numPoses: 1,
    };
    try {
      this.landmarker = await mod.PoseLandmarker.createFromOptions(fileset, options);
    } catch (gpuErr) {
      options.baseOptions.delegate = 'CPU';
      this.landmarker = await mod.PoseLandmarker.createFromOptions(fileset, options);
    }
    this.engineOK = true;
    if (onStep) onStep(1, '姿态模型已加载');
    this._status('体感引擎就绪 ✓');
  }

  /** 开启摄像头（授权失败抛异常，由调用方走兜底提示） */
  async startCamera() {
    this._status('摄像头：请求权限…');
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 320, height: 240, facingMode: 'user' },
      audio: false,
    });
    this.video.srcObject = stream;
    await this.video.play();
    this.cameraOn = true;
    this._status('摄像头：已启动 ✓ 坐直或站直后点击校准');
  }

  /**
   * 校准（规格4）：开启 2 秒 headY 采集窗口，窗口平均值为新基线。
   * 手动「点击校准」按钮与开场流程倒计时（introFlow → handlers.beginBaseline）走同一入口；
   * 采集期间 armed=false 不接受触发，进度经 calibProgress 实时显示在调试面板。
   */
  beginCalibration() {
    this.calibActive = true;
    this.calibStartMs = 0;
    this.calibSum = 0;
    this.calibN = 0;
    this.calibProgress = 0;
    this.armed = false;
    // Phase-12：同一校准窗采集肩中点 X 基线（变道），窗口关闭时在 feedHead 内一并结算
    this.calibSumX = 0;
    this.calibNX = 0;
    this.baselineX = null;
    this.laneArmed = false;
    this.laneDx = 0;
    this._status('校准中：请保持上半身静止（2 秒采样）…');
  }

  /** 兼容旧入口：校准按钮 → 同一 2 秒采集窗口 */
  calibrate() { this.beginCalibration(); }

  /** 调试面板滑块 setter（带范围钳制，即时生效） */
  setThreshold(t) {
    this.jumpThreshold = Math.min(0.20, Math.max(0.02, Number(t) || JUMP_H_THRESHOLD));
  }
  setCooldown(ms) {
    this.cooldownMs = Math.min(800, Math.max(150, Number(ms) || JUMP_COOLDOWN_MS));
  }

  /**
   * 每帧由 main.js 的单一 rAF 循环调用一次（detectForVideo 每帧最多一次）。
   * @param {number} nowMs performance.now() 时间戳（必须单调递增）
   * @param {boolean} isAirborne 游戏恐龙当前是否滞空（滞空不重复触发）
   */
  update(nowMs, isAirborne) {
    this.triggeredThisFrame = false;
    if (!this.landmarker || this.video.readyState < 2) return;
    if (nowMs <= this.lastDetectMs) return;   // 时间戳必须严格递增
    this.lastDetectMs = nowMs;

    let result;
    try {
      result = this.landmarker.detectForVideo(this.video, nowMs);
    } catch (err) {
      return;
    }

    const lm = result.landmarks && result.landmarks[0];
    this.hasPose = !!lm;
    const headY = lm ? this._headY(lm) : null;
    if (!lm || headY == null) {
      // 姿态/头部关键点丢失：不触发、不误触发；不更新基线与速度状态
      this.h = null;
      this.v = 0;
      this.tiltX = 0;                // 姿态丢失：侧移归零，不误触发
      this.drawOverlay(lm || null);
      this.readoutEl.textContent =
        'h: --（未检测到头部关键点）\n阈值: ' + this.jumpThreshold.toFixed(3) + '\n跳跃: ×' + this.triggerCount;
      return;
    }

    // ---- 头部信号核心（纯逻辑在 feedHead，自验脚本可直接驱动） ----
    this.feedHead(headY, nowMs, isAirborne);

    // ---- Phase-12 规格2a：肩中点 X → 变道通道（校准期累计基线，校准后滞回检测；纯逻辑在 feedLaneX） ----
    const sx = this._shoulderMidX(lm);
    if (sx != null) this.feedLaneX(sx, nowMs);

    // ---- 视差目标：优先用鼻子，其次肩中点（镜像后归一化到 [-1,1]） ----
    const sh = { x: (lm[L_SHOULDER].x + lm[R_SHOULDER].x) / 2, y: (lm[L_SHOULDER].y + lm[R_SHOULDER].y) / 2 };
    const anchor = lm[NOSE] && (lm[NOSE].visibility == null || lm[NOSE].visibility > 0.5) ? lm[NOSE] : sh;
    this.parallax.x = (0.5 - anchor.x) * 2;
    this.parallax.y = (anchor.y - 0.5) * 2;

    // ---- 肩部倾斜（roll）→ 侧移输入（UI 开关默认关；main.js 决定是否采用） ----
    // roll = 肩连线与水平线夹角；死区内归零，超出后线性映射到 ±1（LEAN_MAX_ANGLE 满偏）
    const LEAN_DEAD = 0.07, LEAN_MAX_ANGLE = 0.38, LEAN_SIGN = -1;   // 符号可调：镜像画面下方向直觉
    const roll = Math.atan2(lm[R_SHOULDER].y - lm[L_SHOULDER].y, Math.abs(lm[R_SHOULDER].x - lm[L_SHOULDER].x) || 1e-6);
    if (Math.abs(roll) <= LEAN_DEAD) this.tiltX = 0;
    else this.tiltX = LEAN_SIGN * Math.sign(roll) * Math.min(1, (Math.abs(roll) - LEAN_DEAD) / (LEAN_MAX_ANGLE - LEAN_DEAD));

    this.drawOverlay(lm);
    this.readoutEl.textContent =
      (this.calibActive
        ? '校准采样 ' + Math.round(this.calibProgress * 100) + '%  headY=' + headY.toFixed(3) + '\n'
        : '') +
      'h: ' + (this.h != null ? this.h.toFixed(3) : '--') + '  v: ' + this.v.toFixed(2) +
      '\n阈值: ' + this.jumpThreshold.toFixed(3) + '  冷却: ' + this.cooldownMs + 'ms' + (this.armed ? '' : '（冷却中）') +
      '\n侧移 dx: ' + (this.baselineX != null ? this.laneDx.toFixed(3) : '--') + (this.laneArmed ? '' : '（冷却中）') + '  变道: ×' + this.laneCount +
      '\n跳跃: ×' + this.triggerCount + (this.triggeredThisFrame ? '  ← 触发!' : '');
  }

  /**
   * headY 提取（规格1）：两肩中点 Y 为主（对点头/低头更稳），鼻子仅作肩部缺失时回退。
   * visibility 守卫沿用 >0.5 门槛风格；landmark 无 visibility 字段时视为可见。
   * @returns {number|null} null = 本帧无可用头部信号（跳过检测，不触发）
   */
  _headY(lm) {
    const vis = (p) => (p && p.visibility != null) ? p.visibility : 1;
    const ls = lm[L_SHOULDER], rs = lm[R_SHOULDER];
    if (ls && rs && vis(ls) > 0.5 && vis(rs) > 0.5) return (ls.y + rs.y) / 2;
    const n = lm[NOSE];
    if (n && vis(n) > 0.5) return n.y;
    return null;
  }

  /**
   * 头部信号核心（纯逻辑、无 DOM——Phase-11 验收 B 的 mock 关键点序列自验直接驱动此方法）。
   * 每帧一次：速度计算 → 校准窗口采集 → 位移 → 冷却重武装 → 漂移补偿 → 触发判定。
   * @param {number} headY 当前头部 Y（归一化图像坐标，向下为正）
   * @param {number} nowMs 单调时间戳
   * @param {boolean} isAirborne 恐龙滞空则不触发
   * @returns {boolean} 本帧是否触发跳跃
   */
  feedHead(headY, nowMs, isAirborne) {
    this.triggeredThisFrame = false;

    // 上升速度 v = (prevHeadY − headY)/dt（图像 y 向下，头上移 → headY 变小 → v 为正）
    const dtSec = (this.prevHeadY != null && this.prevNowMs > 0)
      ? Math.max((nowMs - this.prevNowMs) / 1000, 1e-4) : null;
    this.v = dtSec != null ? (this.prevHeadY - headY) / dtSec : 0;
    this.prevHeadY = headY;
    this.prevNowMs = nowMs;

    // ---- 校准窗口（规格4）：2 秒 headY 平均 → 基线；期间不接受触发 ----
    if (this.calibActive) {
      if (!this.calibStartMs) this.calibStartMs = nowMs;
      this.calibSum += headY;
      this.calibN++;
      const elapsed = nowMs - this.calibStartMs;
      this.calibProgress = Math.min(1, elapsed / CALIB_WINDOW_MS);
      this.h = this.baselineY != null ? this.baselineY - headY : 0;
      if (elapsed >= CALIB_WINDOW_MS && this.calibN > 0) {
        this.baselineY = this.calibSum / this.calibN;
        this.calibActive = false;
        this.h = 0;
        this.armed = true;
        // Phase-12：同窗采集的肩中点 X 均值 = 变道基线；重武装变道检测
        if (this.calibNX > 0) this.baselineX = this.calibSumX / this.calibNX;
        this.laneArmed = true;
        this._status('已校准：基线 = 2 秒头部/肩部平均 ✓');
      }
      return false;
    }

    if (this.baselineY == null) this.baselineY = headY;   // 未校准首帧兜底
    const h = this.baselineY - headY;                     // 向上为正（规格2）
    this.h = h;

    // ---- 冷却重武装（规格3）：冷却耗尽 且（回基线 |h|<eps 或 >3×cooldown 安全超时防永久锁死） ----
    if (!this.armed) {
      const since = nowMs - this.cooldownStartMs;
      if (since >= this.cooldownMs && (Math.abs(h) < RETURN_EPS || since > 3 * this.cooldownMs)) {
        this.armed = true;
      }
    }

    // ---- 基线漂移补偿（规格5）：非冷却期(armed) 且 近基线 且 低速 → 慢 EMA（防久坐下滑漂移） ----
    if (this.armed && Math.abs(h) < RETURN_EPS && Math.abs(this.v) < VEL_MIN) {
      this.baselineY += BASELINE_ALPHA * (headY - this.baselineY);
    }

    // ---- 触发判定：位移超阈值 + 速度门控 + 已重武装 + 在地面 ----
    if (this.armed && !isAirborne && h > this.jumpThreshold && this.v > VEL_MIN) {
      this.armed = false;
      this.cooldownStartMs = nowMs;
      this.triggerCount++;
      this.triggeredThisFrame = true;
      if (this.onJump) this.onJump();
      return true;
    }
    return false;
  }

  /**
   * Phase-12 规格2a：肩中点 X 提取——两肩 visibility>0.5 才可用（缺失返回 null，本帧跳过变道，不误触发）。
   * 有意不用鼻子回退：头部左右转动会与身体横移混淆，产生误变道。
   */
  _shoulderMidX(lm) {
    const vis = (p) => (p && p.visibility != null ? p.visibility : 1);
    const ls = lm[L_SHOULDER], rs = lm[R_SHOULDER];
    if (ls && rs && vis(ls) > 0.5 && vis(rs) > 0.5) return (ls.x + rs.x) / 2;
    return null;
  }

  /**
   * Phase-12 规格2a：肩中点 X 偏移 → 变道检测（纯逻辑，无 DOM，自验脚本可直接驱动）。
   * dx = (sx − baselineX) × LANE_X_SIGN（正 = 用户向右倾）。
   * - 校准窗进行中：累计 calibSumX/calibNX（窗口关闭由 feedHead 结算 baselineX），不检测；
   * - 触发：laneArmed 且 |dx| > LANE_X_ENTER(0.05 死区) → onLane(sign(dx))，进入冷却；
   * - 重武装：冷却耗尽(LANE_COOLDOWN_MS=350ms) 且回到滞回带 |dx| < LANE_X_EXIT(0.025) —— 无安全超时，
   *   因回滞回带是唯一重武装路径，且 armed 期基线慢 EMA 防久坐漂移导致永久锁死；
   * - 漂移补偿：armed 且近基线时 baselineX 慢 EMA（与 headY 同思路，BASELINE_ALPHA=0.02）。
   * @param {number} sx 肩中点 X（归一化图像坐标，原始未镜像）
   * @returns {number} 本帧触发的变道方向 ±1（正=右），0 = 未触发
   */
  feedLaneX(sx, nowMs) {
    if (this.calibActive) { this.calibSumX += sx; this.calibNX++; return 0; }
    if (this.baselineX == null) return 0;            // 未校准：不触发、不误触发

    const dx = (sx - this.baselineX) * LANE_X_SIGN;
    this.laneDx = dx;

    if (this.laneArmed && Math.abs(dx) < LANE_X_EXIT) {
      this.baselineX += BASELINE_ALPHA * (sx - this.baselineX);   // 慢漂移补偿（近基线时）
    }
    if (!this.laneArmed && (nowMs - this.laneCooldownStartMs) >= LANE_COOLDOWN_MS && Math.abs(dx) < LANE_X_EXIT) {
      this.laneArmed = true;                          // 滞回重武装
    }
    if (this.laneArmed && Math.abs(dx) > LANE_X_ENTER) {
      this.laneArmed = false;
      this.laneCooldownStartMs = nowMs;
      this.laneCount++;
      const dir = Math.sign(dx);                      // dx>0 = 右倾 → 右变道(+1)；dx<0 → 左(-1)
      if (this.onLane) this.onLane(dir);
      return dir;
    }
    return 0;
  }

  /** 调试小窗：摄像头画面（镜像）+ 骨架与关键点叠加 */
  drawOverlay(lm) {
    const ctx = this.overlayCtx;
    const w = this.overlay.width, h = this.overlay.height;
    ctx.clearRect(0, 0, w, h);
    if (this.video.videoWidth) {
      ctx.save();
      ctx.translate(w, 0);
      ctx.scale(-1, 1);                       // 前置摄像头镜像
      ctx.drawImage(this.video, 0, 0, w, h);
      ctx.restore();
    }
    if (!lm) return;
    const X = (p) => (1 - p.x) * w;           // 镜像后坐标
    const Y = (p) => p.y * h;
    ctx.strokeStyle = '#00f0ff';
    ctx.lineWidth = 1.5;
    for (const [a, b] of CONNECTIONS) {
      if (!lm[a] || !lm[b]) continue;
      ctx.beginPath();
      ctx.moveTo(X(lm[a]), Y(lm[a]));
      ctx.lineTo(X(lm[b]), Y(lm[b]));
      ctx.stroke();
    }
    ctx.fillStyle = '#ff2d55';
    for (const p of lm) {
      ctx.beginPath();
      ctx.arc(X(p), Y(p), 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    // 头部信号源（鼻 + 双肩）标黄
    ctx.fillStyle = '#ffe14d';
    for (const i of [NOSE, L_SHOULDER, R_SHOULDER]) {
      if (!lm[i]) continue;
      ctx.beginPath();
      ctx.arc(X(lm[i]), Y(lm[i]), 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _status(msg) {
    this.statusMsg = msg;
    this.statusEl.textContent = msg;
  }
}
