// js/perf.js
// Phase-10：双向 FPS 监测——低帧持续 → onDegrade(level) 逐级降；高帧持续 → onRecover(level) 逐级恢复（可一路回 0）。
// 开局 warmupMs 预热豁免：shader 编译/纹理上传期的卡顿不累积降级。level 不再 Math.max 单向锁。

export class PerfMonitor {
  /**
   * @param {{onDegrade?:(level:number,fps:number)=>void, onRecover?:(level:number,fps:number)=>void,
   *          lowFps?:number, sustainMs?:number, sampleMs?:number, maxLevel?:number,
   *          warmupMs?:number, recoverFps?:number, recoverMs?:number}} options
   */
  constructor({
    onDegrade, onRecover,
    lowFps = 24,          // Phase-10：30 → 24（更少误降）
    sustainMs = 5000,     // Phase-10：3000 → 5000（持续 5 秒低帧才降一级）
    sampleMs = 1000,
    maxLevel = 3,         // Phase-10：2 → 3（L2 保留签名视觉，L3 才是保底）
    warmupMs = 6000,      // Phase-10：开局预热豁免（首帧起 6 秒内低帧不累积、不降级）
    recoverFps = 42,      // Phase-10：高于 42fps 才计恢复（与 lowFps 间为滞回带，防抖振荡）
    recoverMs = 4000,     // Phase-10：持续 4 秒高帧才升回一级
  } = {}) {
    this.onDegrade = onDegrade;
    this.onRecover = onRecover;
    this.lowFps = lowFps;
    this.sustainMs = sustainMs;
    this.sampleMs = sampleMs;
    this.maxLevel = maxLevel;
    this.warmupMs = warmupMs;
    this.recoverFps = recoverFps;
    this.recoverMs = recoverMs;
    this.level = 0;
    this.fps = 0;
    this.frames = 0;
    this.windowStart = 0;
    this.startedAt = 0;
    this.lowStreakMs = 0;
    this.highStreakMs = 0;
  }

  /** 暂停采样后恢复（手动画质档切回自动）时调用：清空窗口与连续计数，避免 elapsed 跨暂停期造成误判 */
  reset() {
    this.frames = 0;
    this.windowStart = 0;
    this.lowStreakMs = 0;
    this.highStreakMs = 0;
  }

  /** 每帧由主循环调用（手动画质档下主循环跳过调用 = 暂停采样） */
  frame(nowMs) {
    this.frames++;
    if (!this.windowStart) this.windowStart = nowMs;
    if (!this.startedAt) this.startedAt = nowMs;
    const elapsed = nowMs - this.windowStart;
    if (elapsed < this.sampleMs) return;

    this.fps = (this.frames * 1000) / elapsed;
    this.frames = 0;
    this.windowStart = nowMs;

    // 预热豁免：开局 shader 编译期低帧既不降级也不恢复
    if (nowMs - this.startedAt < this.warmupMs) {
      this.lowStreakMs = 0;
      this.highStreakMs = 0;
      return;
    }

    if (this.fps < this.lowFps) { this.lowStreakMs += elapsed; this.highStreakMs = 0; }
    else if (this.fps > this.recoverFps) { this.highStreakMs += elapsed; this.lowStreakMs = 0; }
    else { this.lowStreakMs = 0; this.highStreakMs = 0; }   // 滞回带内：维持当前级别

    if (this.lowStreakMs >= this.sustainMs && this.level < this.maxLevel) {
      this.level++;
      this.lowStreakMs = 0;
      if (this.onDegrade) this.onDegrade(this.level, this.fps);
    } else if (this.highStreakMs >= this.recoverMs && this.level > 0) {
      this.level--;                       // 可一路回 0（Phase-10：无单向锁）
      this.highStreakMs = 0;
      if (this.onRecover) this.onRecover(this.level, this.fps);
    }
  }
}
