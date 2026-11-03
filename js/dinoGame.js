// js/dinoGame.js
// 2D Canvas 小恐龙跑酷：地面、仙人掌/翼龙障碍、加速、分数、碰撞、Game Over、重开。
// 恐龙为简笔像素风（fillRect 块绘制）。

// ===================== 跳跃物理常量（验收 B） =====================
// 障碍物最大高度 OBSTACLE_MAX_HEIGHT = 46 px  →  要求跳跃最高点 apex ≥ 2 × 46 = 92 px
// apex = JUMP_V0² / (2 · GRAVITY) = 800² / (2 · 3200) = 640000 / 6400 = 100 px
// 100 px ≥ 92 px  ✓（最高点 ≥ 障碍物高度的 2 倍）
export const GRAVITY = 3200;             // px/s²，向下加速度
export const JUMP_V0 = 800;              // px/s，起跳初速度（apex = V0²/(2G) = 100px）
export const OBSTACLE_MAX_HEIGHT = 46;   // px，最高仙人掌

const GROUND_Y = 220;      // 地面 y 坐标（画布高 260）
const DINO_X = 60;         // 恐龙固定横坐标
const DINO_W = 40;
const DINO_H = 46;
const BASE_SPEED = 340;    // px/s，初始速度
const MAX_SPEED = 660;     // px/s，速度上限
const HI_KEY = 'dino-motion-hi';

export class DinoGame {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{onJump?:Function,onGameOver?:Function,onScore?:Function,onRestart?:Function}} hooks
   */
  constructor(canvas, hooks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.hooks = hooks;
    this.hiScore = Number(localStorage.getItem(HI_KEY) || 0);
    this.state = 'ready';   // ready | running | over
    this.animTime = 0;
    this.reset();
  }

  reset() {
    this.dinoY = GROUND_Y - DINO_H;   // 恐龙顶部 y（贴地）
    this.vy = 0;                      // 向上为正
    this.obstacles = [];
    this.spawnTimer = 1.2;
    this.speed = BASE_SPEED;
    this.score = 0;
    this.distance = 0;
  }

  /** 恐龙是否离地（滞空）——供体感基线冻结与冷却判断使用 */
  isAirborne() {
    return this.dinoY + DINO_H < GROUND_Y - 0.5;
  }

  /**
   * 三通道（空格键 / 点击触摸 / 体感）统一汇聚的跳跃入口。
   * @param {'key'|'pointer'|'pose'} source 输入来源，仅用于回调展示
   */
  jump(source) {
    if (this.state === 'over') { this.restart(); return; }
    if (this.state === 'ready') this.state = 'running';
    if (!this.isAirborne()) {
      this.vy = JUMP_V0;   // apex = V0²/(2G) = 100px ≥ 2×OBSTACLE_MAX_HEIGHT = 92px
      if (this.hooks.onJump) this.hooks.onJump(source);
    }
  }

  restart() {
    this.reset();
    this.state = 'running';
    if (this.hooks.onRestart) this.hooks.onRestart();
    if (this.hooks.onScore) this.hooks.onScore(this.score, this.hiScore);
  }

  update(dt) {
    this.animTime += dt;
    if (this.state !== 'running') return;

    // 随分数加速
    this.speed = Math.min(BASE_SPEED + this.score * 0.08, MAX_SPEED);
    this.distance += this.speed * dt;
    const newScore = Math.floor(this.distance / 12);
    if (newScore !== this.score) {
      this.score = newScore;
      if (this.hooks.onScore) this.hooks.onScore(this.score, this.hiScore);
    }

    // 跳跃物理积分（v(t)=V0-G·t，y 上移；apex=V0²/(2G)=100px）
    if (this.vy !== 0 || this.isAirborne()) {
      this.dinoY -= this.vy * dt;
      this.vy -= GRAVITY * dt;
      if (this.dinoY >= GROUND_Y - DINO_H) {   // 落地
        this.dinoY = GROUND_Y - DINO_H;
        this.vy = 0;
      }
    }

    // 障碍生成
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnObstacle();
      // 间距随速度收紧，但保证最小反应窗口
      this.spawnTimer = 0.35 + (0.9 + Math.random() * 0.9) * (420 / this.speed);
    }

    // 障碍移动与清理
    for (const o of this.obstacles) o.x -= this.speed * dt;
    this.obstacles = this.obstacles.filter(o => o.x + o.w > -10);

    // 碰撞检测
    if (this.checkCollision()) this.gameOver();
  }

  spawnObstacle() {
    const x = this.canvas.width + 20;
    // 分数 > 150 后出现翼龙：低空需跳过（bottom=GROUND_Y-50），高空可直接跑过
    if (this.score > 150 && Math.random() < 0.25) {
      const low = Math.random() < 0.5;
      const y = low ? GROUND_Y - 78 : GROUND_Y - 128;
      this.obstacles.push({ type: 'ptero', x, y, w: 42, h: 28 });
      return;
    }
    // 仙人掌：高度 28 ~ OBSTACLE_MAX_HEIGHT(46)，偶尔双株
    const n = Math.random() < 0.3 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const h = 28 + Math.random() * (OBSTACLE_MAX_HEIGHT - 28);
      this.obstacles.push({ type: 'cactus', x: x + i * 22, y: GROUND_Y - h, w: 18, h });
    }
  }

  checkCollision() {
    // 恐龙碰撞盒（内缩几像素，判定更宽容）
    const dx = DINO_X + 5, dy = this.dinoY + 3, dw = DINO_W - 12, dh = DINO_H - 5;
    for (const o of this.obstacles) {
      const ox = o.x + 3, oy = o.y + 3, ow = o.w - 6, oh = o.h - 6;
      if (dx < ox + ow && dx + dw > ox && dy < oy + oh && dy + dh > oy) return true;
    }
    return false;
  }

  gameOver() {
    this.state = 'over';
    if (this.score > this.hiScore) {
      this.hiScore = this.score;
      localStorage.setItem(HI_KEY, String(this.hiScore));
    }
    if (this.hooks.onGameOver) this.hooks.onGameOver(this.score, this.hiScore);
  }

  // ===================== 绘制 =====================
  draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);   // 透明背景，透出 3D 场景
    this._drawGround(ctx);
    for (const o of this.obstacles) {
      if (o.type === 'cactus') this._drawCactus(ctx, o);
      else this._drawPtero(ctx, o);
    }
    this._drawDino(ctx);
    if (this.state === 'ready') {
      this._centerText(ctx, '按 空格 / 点击 / 起跳 开始', 110);
    } else if (this.state === 'over') {
      this._centerText(ctx, 'G A M E  O V E R', 104, 'rgba(255,80,110,0.95)');
      this._centerText(ctx, '空格 或 点击 重新开始', 132, '#9be8ff', 10);
    }
  }

  _drawGround(ctx) {
    ctx.strokeStyle = 'rgba(0, 240, 255, 0.75)';
    ctx.shadowColor = 'rgba(0,240,255,0.6)';
    ctx.shadowBlur = 6;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, GROUND_Y + 1);
    ctx.lineTo(this.canvas.width, GROUND_Y + 1);
    ctx.stroke();
    // 移动的小石子
    ctx.fillStyle = 'rgba(0, 240, 255, 0.35)';
    const off = this.distance % 46;
    for (let x = -off; x < this.canvas.width; x += 46) {
      ctx.fillRect(x + 12, GROUND_Y + 7, 6, 2);
      ctx.fillRect(x + 30, GROUND_Y + 12, 3, 2);
    }
    ctx.shadowBlur = 0;
  }

  _drawDino(ctx) {
    const x = DINO_X, y = this.dinoY;
    ctx.fillStyle = '#d9fbff';
    ctx.shadowColor = 'rgba(0,240,255,0.7)';
    ctx.shadowBlur = 8;
    // 尾
    ctx.fillRect(x - 4, y + 10, 6, 6);
    ctx.fillRect(x, y + 14, 8, 6);
    // 躯干
    ctx.fillRect(x + 6, y + 16, 22, 20);
    // 头
    ctx.fillRect(x + 16, y, 22, 16);
    // 嘴
    ctx.fillRect(x + 34, y + 8, 6, 5);
    // 手臂
    ctx.fillRect(x + 24, y + 24, 4, 8);
    // 眼（Game Over 时画 X）
    ctx.fillStyle = '#0f0c29';
    if (this.state === 'over') {
      ctx.fillRect(x + 29, y + 3, 2, 2); ctx.fillRect(x + 33, y + 3, 2, 2);
      ctx.fillRect(x + 31, y + 5, 2, 2);
      ctx.fillRect(x + 29, y + 7, 2, 2); ctx.fillRect(x + 33, y + 7, 2, 2);
    } else {
      ctx.fillRect(x + 30, y + 4, 4, 4);
    }
    ctx.fillStyle = '#d9fbff';
    // 腿：跑步两帧交替 / 滞空并拢
    const runA = Math.floor(this.animTime * 10) % 2 === 0;
    if (this.isAirborne()) {
      ctx.fillRect(x + 10, y + 36, 6, 10);
      ctx.fillRect(x + 20, y + 36, 6, 10);
    } else if (this.state === 'running' && runA) {
      ctx.fillRect(x + 10, y + 36, 6, 10);
      ctx.fillRect(x + 20, y + 36, 6, 4);
    } else if (this.state === 'running') {
      ctx.fillRect(x + 10, y + 36, 6, 4);
      ctx.fillRect(x + 20, y + 36, 6, 10);
    } else {
      ctx.fillRect(x + 10, y + 36, 6, 10);
      ctx.fillRect(x + 20, y + 36, 6, 10);
    }
    ctx.shadowBlur = 0;
  }

  _drawCactus(ctx, o) {
    ctx.fillStyle = '#39ff88';
    ctx.shadowColor = 'rgba(57,255,136,0.6)';
    ctx.shadowBlur = 6;
    const cx = o.x + o.w / 2;
    ctx.fillRect(cx - 4, o.y, 8, o.h);                       // 主干
    ctx.fillRect(o.x, o.y + o.h * 0.30, 6, o.h * 0.35);      // 左臂
    ctx.fillRect(o.x, o.y + o.h * 0.30, 4, 4);
    ctx.fillRect(o.x + o.w - 6, o.y + o.h * 0.15, 6, o.h * 0.30); // 右臂
    ctx.shadowBlur = 0;
  }

  _drawPtero(ctx, o) {
    const flap = Math.floor(this.animTime * 8) % 2 === 0;
    ctx.fillStyle = '#b967ff';
    ctx.shadowColor = 'rgba(185,103,255,0.7)';
    ctx.shadowBlur = 8;
    // 身体
    ctx.fillRect(o.x + 12, o.y + 10, 20, 8);
    // 头 + 喙
    ctx.fillRect(o.x + 30, o.y + 6, 8, 8);
    ctx.fillRect(o.x + 36, o.y + 9, 6, 3);
    // 翅膀（两帧扑动）
    ctx.beginPath();
    if (flap) {
      ctx.moveTo(o.x + 14, o.y + 10);
      ctx.lineTo(o.x + 24, o.y - 8);
      ctx.lineTo(o.x + 30, o.y + 10);
    } else {
      ctx.moveTo(o.x + 14, o.y + 18);
      ctx.lineTo(o.x + 24, o.y + 30);
      ctx.lineTo(o.x + 30, o.y + 18);
    }
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  _centerText(ctx, text, y, color = 'rgba(0,240,255,0.9)', size = 14) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.font = size + "px 'Press Start 2P', 'Microsoft YaHei', monospace";
    ctx.textAlign = 'center';
    ctx.shadowColor = 'rgba(0,240,255,0.8)';
    ctx.shadowBlur = 10;
    ctx.fillText(text, this.canvas.width / 2, y);
    ctx.restore();
  }
}
