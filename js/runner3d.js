// js/runner3d.js
// 3D 跑酷玩法主体（Phase-5 视觉重构）：第三人称追尾视角，恐龙沿 -Z 自动前进（实现为障碍向 +Z 迎面而来），
// 体感/空格驱动 Y 轴抛物线跳跃，AABB 包围盒碰撞，撞击三件套（震屏/方块碎裂粒子/闪烁——规格4 碎裂粒子替代红色波纹），
// 结算面板数据（分数=距离、速度随分数提升但跳跃参数不变）、跳跃拖影粒子。
// Phase-5 视觉层（规格3/4/8/10）：柏油微缩街道（程序化 Canvas 纹理）+ 中央暖色发光虚线 + 冷色距离刻度线，
// 路侧微缩建筑/方块树/路灯（3 个 InstancedMesh 取模滚动），体素拼装恐龙（InstancedMesh + MeshPhysicalMaterial 玻璃/高反光塑料），
// 高可见障碍（Phase-13：三类 Minecraft 体素障碍——岩浆路障/黑曜石高墙/虚空深坑，16×16 程序化像素纹理 NearestFilter + 白轮廓线框），零外部贴图文件。
// Phase-8 跑道动效（规格1-5）：车道彗星流光带（UV 随距离滚动=速度联动）+ 霓虹绿边界线 + 落地冲击波圆环池 + 路侧建筑窗光/路灯加密 + 柏油微反光。
// Phase-9 环境无限循环（规格1-4）：路侧景物逐实例回收池（越过相机重推最前端+重随机，全程两侧有景）+ 霓虹边线 340u 延伸至雾视距尽头。
// Phase-13 三类障碍（规格1-5）：①低矮岩浆路障(必须跳，apex≥2×高) ②高空黑曜石墙(必须变道，恒留≥1畅通车道，WALL_HEIGHT≥apex+恐龙身高→永不翻越) ③全宽虚空深坑(必须跳，坑长≤min_speed×t_air×0.687，坑后 PIT_BUFFER_GAP=30u 缓冲)；
// 三类各自对象池零 per-frame 分配，pickObstaclePlan(rng,score) 纯函数决定每排规划（种子采样可验收），全部纹理由 16×16 Canvas 程序化生成（零外部图片/零 CDN 新增）。
// Phase-14 怪物追逐四系统：①巨型体素怪物后方追逐 chaseDistance(18→0 扑杀，死亡瞬间扑击 0.6s) ②粘液块/细雪块非致命减速(扣 100 分+速度×0.55 持续 2s+红暗角/冰霜) ③组合路障(1~3 车道岩浆，3 车道全占=必须跳，命中致命) ④狂飙追逐期(20s/间隔 45~60s 或 chase<8，速度×1.2+FOV+4.5+持续震屏，生成向 slime/snow/组合倾斜) + 金币池(拾取 +50 分 +0.8 chase)；// chaseStep(st,dt,ev,rng)/planRowGap/pickObstaclePlan(rng,score,opts) 纯函数可种子采样；新实体全池化，热路径零 new；16×16 Canvas 程序化纹理延续（零外部图片/零 CDN 新增）。
// 玩法红线：物理常量 / AABB 碰撞 / 分数速度曲线 / 距离线索逻辑与 Phase-3/4 完全一致，未做任何数值改动。
// 复用 scene3d 的 scene/camera；3D 模式下相机由本模块接管（scene3d.setCameraControl(false)）。

import * as THREE from 'three';

// ===================== 可调物理常量（验收 B） =====================
// 障碍物最大高度 OBSTACLE_MAX_HEIGHT = 2.2 u  →  要求跳跃最高点 apex ≥ 2 × 2.2 = 4.4 u
// apex = JUMP_V0² / (2 · GRAVITY) = 17² / (2 · 28) = 289 / 56 ≈ 5.16 u  ≥ 4.4 u  ✓
export const OBSTACLE_MAX_HEIGHT = 2.2;  // 世界单位，最高障碍
export const GRAVITY = 28;               // 重力加速度 u/s²（可调）
export const JUMP_V0 = 17;               // 起跳初速度 u/s（apex = V0²/(2G) ≈ 5.16u）
// ===================== 相机（Phase-4：高角度追尾 + 可选斜 45° 等距） =====================
export const CAM_PITCH_DEG = 52;         // Phase-15：俯角 50→52（配合注视点前移扩大前方视野；怪物取景几何自证 tests/monster_framing.mjs）
export const CAM_DIST = 13;              // 追尾相机到注视点的斜距（适当拉远，规格1/5）
export const CAM_LOOK_AHEAD = 5;         // Phase-15：注视点前移 4→5u → 前方视野更大（脚下与前方跑道仍同屏，距离线索光斑/刻度可读）
export const ISO_PITCH_DEG = 45;         // 斜 45° 等距视角俯角（规格6 兜底选项）
export const ISO_YAW_DEG = 30;           // 等距视角水平斜角（“斜”45°：相机偏侧）
export const ISO_DIST = 17;              // 等距视角相机斜距
// ===================== 距离线索（Phase-4 规格2/3/4，常量按规格5全部命名可调） =====================
export const SHADOW_SCALE_K = 1.4;       // 光斑距离缩放系数：直径 = 障碍底面 × (1 + K × 距离比)
export const SHADOW_FADE_DIST = 55;      // 光斑归一化距离：障碍离恐龙 ≥ 此值视为“最远”（最淡最大）
export const SHADOW_OPACITY_MAX = 0.55;  // 最近处光斑不透明度（随距离线性降至 25%）
export const TICK_SPACING = 5;           // 地面刻度横线间距 u（沿前进方向等间距，随滚动移动）
export const WARN_DIST = 14;             // 最后反应距离：障碍进入 |z| < 此值时底边亮起暖色
// ===================== 分数 / 速度曲线（不改变跳跃参数） =====================
export const BASE_SPEED = 12;            // 初始前进速度 u/s
export const SPEED_GAIN = 0.008;         // 每 1 分（≈1u 距离）的速度加成
export const SPEED_MAX_BONUS = 12;       // 速度加成上限：speed = BASE + min(score·GAIN, MAX_BONUS)
// ===================== 其它 =====================
// ===== Phase-12：三车道（左0/中1/右2）=====
export const LANE_COUNT = 3;               // 车道数
export const LANE_WIDTH = 3.0;             // 车道宽 u（ROAD_WIDTH 9 = 3×3，跑道本身不加宽，scene3d 零改动）
export const LANE_X = Object.freeze([-LANE_WIDTH, 0, LANE_WIDTH]);   // 车道索引→世界 X 映射：laneX(i) = (i−1)×LANE_WIDTH
export const LANE_LERP_K = 10;             // 平滑横移指数阻尼系数（时间常数 0.1s，单向收敛无过冲）
export const LANE_SNAP_EPS = 0.005;        // 贴齐车道中心判定
export const SPAWN_DOUBLE_P = 0.45;        // 每排生成 2 个障碍的概率（3 车道最多占 2 → 每排恒 ≥1 条可通过）
export const SPAWN_JITTER = 0.2;           // 车道内 X 抖动 ±u；车道中心距 3.0 − 抖动 0.2 − 障碍半宽 ≤1.25 > 通行需求 1.725/2，邻道仍可通过

/** 车道索引钳制（边界车道不可越界） */
export function clampLane(i) { return Math.max(0, Math.min(LANE_COUNT - 1, i | 0)); }

/**
 * Phase-12 规格3：每排障碍车道分配纯函数（验收 B 直接采样）。
 * 先选一条可通过车道 freeLane，再在其余车道中放 1~2 个障碍 → 每排恒 ≥1 条可通过车道。
 * @param {()=>number} rng [0,1) 随机源（测试可注入种子 rng）
 * @returns {{freeLane:number, lanes:number[]}} lanes = 实际放置障碍的车道（长度 1~2，互异且 ≠ freeLane）
 */
export function pickSpawnLanes(rng = Math.random) {
  const freeLane = clampLane((rng() * LANE_COUNT) | 0);
  const n = rng() < SPAWN_DOUBLE_P ? 2 : 1;
  const rest = [];
  for (let l = 0; l < LANE_COUNT; l++) if (l !== freeLane) rest.push(l);
  const lanes = [];
  for (let i = 0; i < n; i++) lanes.push(rest.splice((rng() * rest.length) | 0, 1)[0]);
  return { freeLane, lanes };
}

/**
 * Phase-13 规格4 + Phase-14 扩展：每排规划纯函数（验收种子采样直接调用；rng 可注入）。
 * 六类按 PLAN_WEIGHTS / PLAN_WEIGHTS_FRENZY（狂飙期）加权随机：
 * - barrier 组合路障：1~3 车道并排岩浆块（狂飙期倾向 2~3 车道）；3 车道全占 = 必须跳（apex 5.1607 ≥ 2×BARRIER_HEIGHT=1.4，数学不变）；命中任一 = 致命
 * - wall：复用 pickSpawnLanes → 恒 ≥1 畅通车道（红线）；WALL_HEIGHT=7.5 ≥ apex+恐龙身高 → 永不翻越
 * - pit：全路横跨必须跳，len ∈ [4,10]；opts.slowed（减速态）禁产出 → 兜底单车道 barrier（红线 c：0.55×speed×t_air 可能 < 坑长）
 * - slime：1~2 车道粘液块，非致命减速（AABB 同路障形状，命中走 _slow 分支）
 * - snow：1~2 车道细雪薄板（高 SNOW_H=0.15），贴地踩上触发、跳跃越过不触发（AABB 薄板语义天然成立）
 * - coin：单车道 count=3~5 枚纵向弧线排列，拾取 +COIN_SCORE 分 +CHASE_COIN chase
 * @param {()=>number} rng [0,1) 随机源（可注入 mulberry32 采样）
 * @param {number} score 预留演进（权重随分数演进的非必须项）
 * @param {{frenzy?:boolean, slowed?:boolean}} opts frenzy=狂飙权重倾斜；slowed=减速态禁 pit
 * @returns {{type:'barrier'|'wall'|'pit'|'slime'|'snow'|'coin', lanes:number[], freeLane:number, len:number, count:number}}
 *   barrier: lanes 含 1~3（3 车道全占 freeLane=-1=必须跳）；wall: lanes 1~2 且 freeLane∉lanes；pit: lanes=[]，len>0；
 *   slime/snow: lanes 1~2 且 freeLane∉lanes；coin: lanes 恰 1，count∈[3,5]。
 */
export function pickObstaclePlan(rng = Math.random, score = 0, opts = {}) {
  const W = opts.frenzy ? PLAN_WEIGHTS_FRENZY : PLAN_WEIGHTS;
  const r = rng();
  let acc = W.barrier;
  if (r < acc) {
    const p3 = opts.frenzy ? COMBO_P3_FRENZY : COMBO_P3;
    const p2 = opts.frenzy ? COMBO_P2_FRENZY : COMBO_P2;
    const q = rng();
    if (q < p3) return { type: 'barrier', lanes: [0, 1, 2], freeLane: -1, len: 0, count: 0 };  // 3 车道全占 = 必须跳（仍可跳越，非必死）
    if (q < p3 + p2) {
      const freeLane = clampLane((rng() * LANE_COUNT) | 0);
      const lanes = [];
      for (let l = 0; l < LANE_COUNT; l++) if (l !== freeLane) lanes.push(l);
      return { type: 'barrier', lanes, freeLane, len: 0, count: 0 };   // 2 车道组合 → 恒 ≥1 空道
    }
    const lane = clampLane((rng() * LANE_COUNT) | 0);
    return { type: 'barrier', lanes: [lane], freeLane: (lane + 1) % LANE_COUNT, len: 0, count: 0 };
  }
  acc += W.wall;
  if (r < acc) {
    const { freeLane, lanes } = pickSpawnLanes(rng);   // 复用 Phase-12 纯函数 → 恒 ≥1 畅通车道
    return { type: 'wall', lanes, freeLane, len: 0, count: 0 };
  }
  acc += W.pit;
  if (r < acc) {
    if (opts.slowed) {   // 红线 c：减速态禁 pit（0.55×speed×t_air 可能 < 坑长）→ 确定性兜底单车道 barrier
      const lane = clampLane((rng() * LANE_COUNT) | 0);
      return { type: 'barrier', lanes: [lane], freeLane: (lane + 1) % LANE_COUNT, len: 0, count: 0 };
    }
    return { type: 'pit', lanes: [], freeLane: -1, len: PIT_LEN_MIN + rng() * (PIT_LEN_MAX - PIT_LEN_MIN), count: 0 };
  }
  acc += W.slime;
  if (r < acc) { const { freeLane, lanes } = pickSpawnLanes(rng); return { type: 'slime', lanes, freeLane, len: 0, count: 0 }; }
  acc += W.snow;
  if (r < acc) { const { freeLane, lanes } = pickSpawnLanes(rng); return { type: 'snow', lanes, freeLane, len: 0, count: 0 }; }
  const lane = clampLane((rng() * LANE_COUNT) | 0);
  const count = COIN_MIN + ((rng() * (COIN_MAX - COIN_MIN + 1)) | 0);
  return { type: 'coin', lanes: [lane], freeLane: -1, len: 0, count };
}

/**
 * Phase-14 红线 a/b：排间距纯函数（rng 可注入）。
 * base 与 Phase-13 一致：15+rng×10+speed×0.45（随速膨胀 → 反应时间恒定）；
 * pit 排自身 gap ≥ PIT_BUFFER_GAP(30u)（红线 a，Phase-13 语义不变）；
 * 组合路障(≥2 车道)之后的 slime/snow 排额外 +COMBO_FOLLOW_GAP(8u)（红线 b：落地侧 8u 内禁减速块）。
 */
export function planRowGap(rng, plan, prevPlan, speed) {
  let gap = 15 + rng() * 10 + speed * 0.45;
  const prevCombo = !!prevPlan && prevPlan.type === 'barrier' && prevPlan.lanes.length >= 2;
  if (prevCombo && (plan.type === 'slime' || plan.type === 'snow')) gap += COMBO_FOLLOW_GAP;
  if (plan.type === 'pit') gap = Math.max(gap, PIT_BUFFER_GAP);
  return gap;
}

/**
 * Phase-14：chaseDistance 状态机纯步进（就地改 st 并返回；rng 可注入 → 验收 C 直接单测）。
 * st = {chase, slowT, frenzyT, frenzyCd, dead}；ev = {perfectRows, coins, slowEntered}（调用方消费后清零）。
 * 规则：进减速态瞬间 -6 且 slowT(SLOW_DUR=2s) 内额外 -2/s（怪物猛拉）；完美排 +0.5；金币 +0.8；自然 +0.1/s；cap CHASE_MAX=30；
 * 狂飙：frenzyCd(45+rng×15) 到期或 chase<8 → 进入/延长 FRENZY_DUR=20s；期间 chase<8 持续延长；到期 cd 重掷；chase≤0 → dead（怪物扑杀）。
 */
export function chaseStep(st, dt, ev, rng = Math.random) {
  if (ev.slowEntered) { st.chase -= CHASE_SLOW_INSTANT; st.slowT = SLOW_DUR; }
  if (st.slowT > 0) { st.chase -= CHASE_SLOW_DRAIN * dt; st.slowT = Math.max(0, st.slowT - dt); }
  st.chase += (ev.perfectRows | 0) * CHASE_PERFECT + (ev.coins | 0) * CHASE_COIN + CHASE_REGEN * dt;
  if (st.frenzyT > 0) {
    if (st.chase < FRENZY_TRIGGER_CHASE) st.frenzyT = FRENZY_DUR;   // chase<8 → 延长狂飙（不给喘息）
    else {
      st.frenzyT -= dt;
      if (st.frenzyT <= 0) { st.frenzyT = 0; st.frenzyCd = FRENZY_CD_MIN + rng() * FRENZY_CD_SPAN; }
    }
  } else {
    st.frenzyCd -= dt;
    if (st.frenzyCd <= 0 || st.chase < FRENZY_TRIGGER_CHASE) { st.frenzyT = FRENZY_DUR; st.frenzyCd = 0; }
  }
  if (st.chase > CHASE_MAX) st.chase = CHASE_MAX;
  if (st.chase <= 0) { st.chase = 0; st.dead = true; }
  return st;
}
const SPAWN_Z = -95;                     // 障碍生成深度
const KILL_Z = 14;                       // 越过相机后回收（Phase-13：按障碍后缘 z − d/2 判定，深坑完全越过才回收）
// Phase-13：旧单池 POOL_SIZE(16) 拆分为三类各自池 BARRIER_POOL / WALL_POOL / PIT_POOL（见下方 Phase-13 常量区）
const HI_KEY = 'dino3d-hi';
// ===================== Phase-5 视觉层私有常量（非玩法数值） =====================
const ROAD_WIDTH = 9;                    // 柏油路面宽 u
const ROAD_LEN = 280;                    // 路面长 u（覆盖 SPAWN_Z 之外）
const DASH_SPACING = 6;                  // 中央暖色发光虚线间距 u
// ---- Phase-9 环境无限循环（规格1/3/4）----
const SCENERY_SPAN = 260;                // 景物回收带深度 u：世界带 [SCENERY_KILL-SPAN, SCENERY_KILL] = [-240, 20]
const SCENERY_KILL = 20;                 // 回收阈值：实例 z 越过相机后方(>20) → 重推最前端并重新随机化
const BUILD_N = 40;                      // 建筑槽位数（两侧合计；密度对齐旧静态段：≈7/侧/80u）
const POLE_N = 24;                       // 路灯槽位数（灯头与灯杆一一配对）
const TREE_N = 32;                       // 树槽位数（每树 = 树干+两层树冠 3 实例）
const EDGE_LEN = 340;                    // 规格3：霓虹边线长——覆盖 [20,-320]，端点在雾 0.0055 下 96%+ 雾化 → 不可见断点
const VOXEL = 0.17;                      // 恐龙体素边长 u（全身高约 12.5×VOXEL≈2.1u，与碰撞盒 1.9u 同量级）
// ===================== 障碍可见性常量（非玩法数值） =====================
// Phase-13：旧 Phase-6 亮橙残骸/亮青集装箱双色材质常量（OBST_COLOR_A/B + OBST_EMISSIVE_A/B + INT）已被
// 三类程序化像素纹理材质（_barrierMat/_wallMat/_pitMat，见 _buildObstaclePools）取代。
const EDGE_COLOR = 0xffffff;             // EdgesGeometry 亮白轮廓线框（规格2）
const RING_COLOR_FAR = 0xff8a1e;         // 贴地发光圆环常态暖橙（规格4）
const RING_COLOR_NEAR = 0xff0055;        // 进入 WARN_DIST 变霓虹红（合并原底边警告线）
// ===================== Phase-8 跑道动效常量（非玩法数值） =====================
const FLOW_UV_K = 0.16;                  // 流光 UV 滚动系数：offset = distance × K；d(offset)/dt = speed × K → 速度天然联动
const FLOW_COLOR = 0xbfefff;              // 流光冷白蓝（与暖橙中缝虚线、绿边界线、障碍橙/青区分）
const EDGE_NEON_COLOR = 0x39ff88;        // 跑道边界霓虹绿（与障碍橙 #ff5500 / 青 #00ffff、边线白、浮景紫均辨识度不同）
const EDGE_NEON_INT = 2.4;               // 绿线性亮度≈0.73 × 2.4 ≈ 1.76 > BLOOM_THRESHOLD(0.7) → 出光晕
const LANE_LINE_COLOR = 0x3d6a99;        // Phase-12 规格1：车道分割线微弱蓝（低强度 emissive，不抢主视觉）
const LANE_LINE_INT = 0.55;              // 线性亮度 ≈0.24×0.55≈0.13 < BLOOM_THRESHOLD(0.7) → 不出光晕，仅隐约可见
const SHOCK_COUNT = 3;                   // 落地冲击波圆环池容量（循环复用，运行期零 new）
const SHOCK_LIFE = 0.55;                 // 单个冲击波动画时长 s
const SHOCK_R0 = 0.9;                    // 冲击波起始半径 u
const SHOCK_R1 = 3.4;                    // 冲击波终止半径 u（easeOutQuad 放大 + 淡出）
const SHOCK_COLOR = 0x7fe9ff;            // 冲击波冷青（与障碍暖橙圆环区分；加色混合下 instanceColor 变暗=淡出）
const SHOCK_OPACITY = 0.9;               // 冲击波峰值不透明度
const ROAD_ROUGHNESS = 0.62;             // 规格5：柏油粗糙度 0.78 → 0.62（隐约反光，无 Reflector 真反射）
// ===================== Phase-13 三类体素障碍：玩法数值（验收 B/C/D 数学链） =====================
// 恐龙体素身高 = 12.5 × VOXEL(0.17) = 2.125u（_buildDino 最高体素层 y=12 + 半格余量，与 VOXEL 行注释一致）；碰撞盒高 1.9u（_dinoBox）。
// apex = JUMP_V0²/(2·GRAVITY) = 289/56 ≈ 5.1607u；t_air = 2·JUMP_V0/GRAVITY = 34/28 ≈ 1.2143s；
// 速度曲线 speed = BASE_SPEED(12) + min(distance×SPEED_GAIN, SPEED_MAX_BONUS) ∈ [12, 24] u/s → 最低跑速 12、最高 24。
export const BARRIER_HEIGHT = 0.7;    // 规格1 路障高 ≈ 恐龙身高/3（2.125/3≈0.708→取0.7）；红线 apex 5.1607 ≥ 2×0.7=1.4 ✓
export const WALL_HEIGHT = 7.5;       // 规格2 墙高 ≥ apex+恐龙身高 = 5.1607+2.125 = 7.286 → 取 7.5；碰撞盒 yFit=1.0 全高覆盖 → apex 处恐龙盒顶 5.16+1.9=7.06 < 7.5，跳跃永不翻越
export const PIT_LEN_MIN = 4;         // 规格3 坑长下限：> 2×恐龙碰撞盒深(0.85)+落点余量 → 一步/微跳跨不过，『必须跳』成立
export const PIT_LEN_MAX = 10;        // 规格3 坑长上限 = min_speed(12)×t_air(1.2143)×0.687 ≈ 10（安全系数取 0.6~0.75 带内）；最慢满跳距 14.57u → 落地余量 ≥ 4.57u
export const PIT_EPS = 0.1;           // 规格3 贴地 epsilon：z 区间重叠 且 jumpY ≤ PIT_EPS（贴地）→ 坠落失败；滞空通过安全（Y 反转判定）
export const PIT_BUFFER_GAP = 30;     // 红线：深坑之后距下一排障碍最小间距 u ≥ speed_max(24)×0.8s = 19.2（取建议带 25~35 中值）→ 杜绝落地即死
export const PLAN_WEIGHTS = Object.freeze({ barrier: 0.32, wall: 0.25, pit: 0.18, slime: 0.10, snow: 0.08, coin: 0.07 });   // Phase-14 六类权重（合计=1）
const DINO_HALF_DEPTH = 0.425;        // 恐龙碰撞盒半深（0.85/2），深坑平置区间判定用
const BARRIER_W_MIN = 1.5;            // 路障宽下限 u
const BARRIER_W_MAX = 2.2;            // 路障宽上限 u（半宽 ≤1.1 < 1.25 → SPAWN_JITTER 0.2 下邻道仍可通过，沿用 SPAWN_JITTER 行数学）
const BARRIER_D_MIN = 0.7;            // 路障厚下限 u
const BARRIER_D_MAX = 1.1;            // 路障厚上限 u
const WALL_SEG_W = 2.7;               // 墙体单车道段宽 u（车道 3.0 − 两侧各 0.15 视觉缝；双车道封路时安全车道净空 3.52u（墙碰撞内缘 ±1.76），恐龙 1.15u 通过余量充足）
const WALL_SEG_D = 0.9;               // 墙体厚 u
const PIT_WIDTH = 9.1;                // 坑宽：横跨整条跑道（ROAD_WIDTH=9，两侧各压 0.05 盖住路面接缝；不盖路缘石 x=±4.65）
const PIT_SLAB_H = 0.5;               // 坑虚空板厚 u（顶面 y=PIT_TOP_Y 盖住全部路面装饰：虚线顶 0.0375/车道线 0.04/流光 0.025/刻度 0.015）
const PIT_TOP_Y = 0.06;               // 坑顶面高度 u
const BARRIER_POOL = 8;               // 路障池容量（可调）：障碍在场行程 ≈110u ÷ 最小排距 15u ≈ 7.3 排 → 8 槽足够
const WALL_POOL = 10;                 // 墙体池容量（双车道排 = 2 段；池耗尽 → 跳过生成 → 该排更畅通，绝不制造必死排）
const PIT_POOL = 5;                   // 深坑池容量（在场行程 ≈119u ÷ 坑后缓冲 30u ≈ 4 → 5 槽）

// ===================== Phase-14 怪物追逐 × 减速块 × 组合路障 × 金币：玩法数值 =====================
// chaseDistance 语义：怪物与恐龙的距离 u（视觉映射 MONSTER_Z_*/M_SCALE_*；≤0 → 怪物扑杀，另一条死亡路径）。
export const CHASE_INIT = 18;            // 初始距离（规格：18u）
export const CHASE_MAX = 30;             // 距离上限
export const CHASE_REGEN = 0.1;          // 自然回复 +0.1/s
export const CHASE_PERFECT = 0.5;        // 完美通过一排（该排 z 区间无碰撞/减速）+0.5
export const CHASE_COIN = 0.8;           // 金币拾取 +0.8（并 +COIN_SCORE 分）
export const CHASE_SLOW_INSTANT = 6;     // 进入减速态瞬间 -6（规格）
export const CHASE_SLOW_DRAIN = 2;       // 减速态期间额外 -2/s（怪物猛拉）
export const SLOW_DUR = 2;               // 减速持续 s
export const SLOW_MUL = 0.55;            // 减速期速度 ×0.55
export const SLOW_SCORE_PENALTY = 100;   // 触发减速扣分（总分 clamp ≥0）
export const FRENZY_DUR = 20;            // 狂飙追逐期时长 s
export const FRENZY_CD_MIN = 45;         // 狂飙间隔下限 s
export const FRENZY_CD_SPAN = 15;        // 狂飙间隔跨度 s（cd = 45+rng×15 ∈ [45,60]）
export const FRENZY_TRIGGER_CHASE = 8;   // chase < 8 → 立即进入/延长狂飙
export const FRENZY_SPEED_MUL = 1.2;     // 狂飙全场速度 ×1.2
export const FRENZY_FOV_BOOST = 4.5;     // Phase-15：狂飙 FOV 增量 9→4.5（动态放大幅度降低，透视畸变减弱；updateProjectionMatrix）
export const FRENZY_SHAKE = 0.13;        // 狂飙轻微持续震屏幅度
export const COIN_SCORE = 50;            // 金币分值
export const COIN_MIN = 3;               // 单排金币数下限
export const COIN_MAX = 5;               // 单排金币数上限
export const COIN_SPACING = 1.5;         // 金币纵向(z)间距 u
export const COIN_POOL = 12;             // 金币池（单排最多 5 枚；在场 ≈2 排 + 余量）
export const SLIME_POOL = 8;             // 粘液块池（每排 ≤2 块 → 在场 ≈8）
export const SNOW_POOL = 8;              // 细雪块池（同上）
export const SLIME_H = 0.75;             // 粘液块高 u（≈路障；AABB 命中走非致命 _slow 分支）
export const SNOW_H = 0.15;              // 细雪块高 u（规格 ≈0.15；贴地踩上判定 jumpY<0.05，跳跃越过不触发）
export const COMBO_FOLLOW_GAP = 8;       // 红线 b：组合路障(≥2车道)后接 slime/snow 排的额外缓冲 u（落地侧 8u 内禁减速块）
export const COMBO_P2 = 0.30;            // 非狂飙组合路障 2 车道概率
export const COMBO_P3 = 0.15;            // 非狂飙组合路障 3 车道概率（全占=必须跳）
export const COMBO_P2_FRENZY = 0.40;     // 狂飙期 2 车道概率（生成倾斜）
export const COMBO_P3_FRENZY = 0.30;     // 狂飙期 3 车道概率
export const LUNGE_DUR = 0.6;            // 死亡瞬间怪物扑击动画时长 s（结果面板仍 crashT>1.15 弹出，链路不变）
export const MONSTER_Z_NEAR = 1.7;       // Phase-15：怪物视觉地面距离（chase→0）= 自恐龙向相机地面投影方向偏移 1.7u——屏幕最下缘只露头/半身（旧 2.3 贴相机巨型化挡视线，废弃）
export const MONSTER_Z_FAR = 1.3;        // Phase-15：chase→30 地面距离——远方狂奔的威胁（默认相机地面可见带 z≤1.44，脚部沉入带外无妨、头在屏内）
export const M_SCALE_NEAR = 0.55;        // Phase-15：chase→0 缩放（高 5.5×0.55≈3.0u，较 Phase-14 的 1.3 缩小 2.4×=视觉拉远）
export const M_SCALE_FAR = 0.38;         // Phase-15：chase→30 缩放（高 ≈2.1u，旧 0.78）
export const M_SINK = 2.2;               // Phase-15：下沉深度系数（×scale）——怪物屏幕投影严格低于恐龙包围盒底部（追尾相机全区间，几何自证）
export const M_SINK_ISO = 4.6;           // Phase-15：iso 相机更深下沉（斜 45° 视怪物/恐龙深度接近，须深沉+缩scale 才不遮恐龙本体）
export const M_ISO_R_MUL = 1.118;        // Phase-15：iso 地面距离倍率（iso 可见带 r≤1.95：1.7×1.118≈1.90）
export const M_ISO_SCALE_MUL = 0.6;      // Phase-15：iso 缩放倍率（tests/monster_framing.mjs 全区间不遮挡）
export const MONSTER_VIS_RATE = 2.0;     // Phase-15：视觉 z/scale 指数平滑速率/s（τ=0.5s；instant -6 数值跳变→视觉 ≥10 帧平滑扑近，99% 完成≈139 帧，首帧仅走 3.3%，无瞬移）
export const PLAN_WEIGHTS_FRENZY = Object.freeze({ barrier: 0.40, wall: 0.16, pit: 0.10, slime: 0.16, snow: 0.13, coin: 0.05 });  // 狂飙权重（向 slime/snow/组合倾斜，合计=1）

export class Runner3D {
  /**
   * @param {import('./scene3d.js').Scene3D} scene3d
   * @param {{onJump?:(src:string)=>void, onScore?:(score:number,speed:number)=>void,
   *          onGameOver?:(score:number,hi:number)=>void}} hooks
   */
  constructor(scene3d, hooks = {}) {
    this.scene3d = scene3d;
    this.scene = scene3d.scene;
    this.camera = scene3d.camera;
    this.hooks = hooks;

    this.state = 'idle';        // idle | running | crashed | over
    this.distance = 0;
    this.score = 0;
    this.speed = BASE_SPEED;
    this.jumpY = 0;
    this.vy = 0;
    this.dinoX = 0;
    this.lane = 1;              // Phase-12：目标车道 0=左 1=中 2=右（dinoX 平滑收敛到 LANE_X[lane]）
    this.camMode = 'chase';     // 'chase' 高角度追尾（默认） | 'iso' 斜45°等距（Phase-4 规格6）
    this.shakeT = 0;
    this.blinkT = 0;
    this.crashT = 0;
    this.crashKind = 'hit';       // Phase-13：'hit' 撞路障/墙 | 'pit' 深坑坠落（驱动下沉动画）
    // ---- Phase-14 追逐状态字段（热路径零 new：_chaseSt/_chaseEv 常驻对象复用，事件计数每帧消费后清零）----
    this._chaseSt = { chase: CHASE_INIT, slowT: 0, frenzyT: 0, frenzyCd: FRENZY_CD_MIN + Math.random() * FRENZY_CD_SPAN, dead: false };
    this._chaseEv = { perfectRows: 0, coins: 0, slowEntered: false };
    this.bonusScore = 0;          // 金币加分累计（+COIN_SCORE/枚）
    this.penaltyScore = 0;        // 减速扣分累计（-SLOW_SCORE_PENALTY/次，总分 clamp ≥0）
    this.frostT = 0;              // 冰霜覆盖剩余时间 s（细雪触发，main.js 读节流）
    this.dangerLevel = 0;         // 红色危险暗角强度 0~1（main.js 读节流写 opacity）
    this.fovBoost = 0;            // 狂飙 FOV 增量（平滑趋近 FRENZY_FOV_BOOST，写 camera.fov+updateProjectionMatrix）
    this._fovBase = scene3d.camera.fov;   // 基线 FOV（reset 恢复）
    this.monsterBob = true;       // 怪物狂奔上下浮动开关（degradeScenery L2+ 关动画不关碰撞）
    this.coinSpin = true;         // 金币自转开关（同上）
    // Phase-15：怪物视觉缓动状态（标量字段，热路径零 new）——初值=CHASE_INIT 映射，避免首帧 pop 跳
    this.monsterVisZ = MONSTER_Z_NEAR + (MONSTER_Z_FAR - MONSTER_Z_NEAR) * (CHASE_INIT / CHASE_MAX);
    this.monsterVisScale = M_SCALE_NEAR + (M_SCALE_FAR - M_SCALE_NEAR) * (CHASE_INIT / CHASE_MAX);
    this.monsterBobT = 0;
    this.rowSeq = 0;              // 排 id 生成器（完美通过排判定：该排 z 区间无碰撞/减速）
    this._curRowId = 0;
    this.lastRowId = 0;           // 已判定完美的最后排 id
    this.dirtySinceRow = false;   // 当前排区间内发生过碰撞/减速 → 非完美
    this._lastPlan = null;        // 上一排 plan（planRowGap 红线 b：组合路障→减速块排 +8u）
    this.chase = CHASE_INIT;      // 对外只读镜像（main.js HUD 读；每帧同步 _chaseSt.chase）
    this.scoreTimer = 0;
    this.hi = Number(localStorage.getItem(HI_KEY) || 0);

    this._dinoBox = new THREE.Box3();
    this._obsBox = new THREE.Box3();
    this._tmpSize = new THREE.Vector3();
    this._tmpCenter = new THREE.Vector3();

    this._buildGround();
    this._buildDashes();
    this._buildLaneLines();       // Phase-12 规格1：车道分割微弱发光线
    this._buildTicks();
    this._buildScenery();
    this._buildDino();
    this._buildObstaclePools();       // Phase-13 三类障碍池（barrier/wall/pit）+ Phase-14 减速块池（slime/snow）
    this._buildCoinPool();            // Phase-14：金币池（COIN_POOL 常驻，拾取 +50 分 +0.8 chase）
    this._buildMonster();             // Phase-14：巨型体素怪物常驻单例（苦力怕风绿黑体 + 发光眼，后方追逐）
    this._buildTrail();
    this._buildDebris();
    this._buildFlowStrips();      // Phase-8 规格1：车道流光带
    this._buildEdgeLines();       // Phase-8 规格3：霓虹边界线
    this._buildShockPool();       // Phase-8 规格4：落地冲击波池（复用 _buildObstaclePools 的 ringTex）
  }

  // ===================== 场景构建（Phase-5 视觉层） =====================
  /** 程序化柏油纹理（规格3/10）：深色底 + 随机颗粒噪点，零外部贴图文件 */
  _makeAsphaltTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#232833';   // Phase-7 规格3：柏油底色提亮（原 #171a22 在暮色光下≈纯黑，无质感）
    ctx.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 900; i++) {
      ctx.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.045)' : 'rgba(0,0,0,0.16)';
      const s = 1 + Math.random() * 2;
      ctx.fillRect(Math.random() * 128, Math.random() * 128, s, s);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(ROAD_WIDTH / 4, ROAD_LEN / 4);   // 一格纹理 ≈ 4u 见方
    return tex;
  }

  _buildGround() {
    // 规格3：微缩街道——两侧深色地面 + 柏油路面（receiveShadow 承接暖主光柔和阴影，规格1）+ 路缘石
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(140, 340),
      new THREE.MeshStandardMaterial({ color: 0x151d38, roughness: 0.95, metalness: 0 })   // Phase-7 规格3：路侧地面提亮
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, -0.02, -120);
    this.scene.add(ground);

    this.roadTex = this._makeAsphaltTexture();
    const road = new THREE.Mesh(
      new THREE.PlaneGeometry(ROAD_WIDTH, ROAD_LEN),
      new THREE.MeshStandardMaterial({
        map: this.roadTex, roughness: ROAD_ROUGHNESS, metalness: 0.18, envMapIntensity: 0.7,   // Phase-8 规格5：粗糙度 0.78→0.62 + 反射增强，隐约反光灯光（无真反射）
      })
    );
    road.rotation.x = -Math.PI / 2;
    road.position.set(0, 0, 20 - ROAD_LEN / 2);
    road.receiveShadow = true;
    this.scene.add(road);

    const curbMat = new THREE.MeshStandardMaterial({ color: 0x2a3557, roughness: 0.85 });   // Phase-7 规格3：路缘石提亮勾边
    for (const side of [-1, 1]) {
      const curb = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.16, ROAD_LEN), curbMat);
      curb.position.set(side * (ROAD_WIDTH / 2 + 0.15), 0.08, 20 - ROAD_LEN / 2);
      this.scene.add(curb);
    }
  }

  /** 规格3：中央暖色发光虚线/车道灯——单 InstancedMesh（规格8），emissive 2.4 → Bloom threshold 0.85 拾取（规格6） */
  _buildDashes() {
    const count = Math.ceil(250 / DASH_SPACING) + 2;   // z = +14 → -236 全覆盖
    const geo = new THREE.BoxGeometry(0.2, 0.035, 1.7);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x2a1c08, emissive: 0xffb45e, emissiveIntensity: 2.4, roughness: 0.5,
    });
    this.dashes = new THREE.InstancedMesh(geo, mat, count);
    this.dashes.frustumCulled = false;
    const d = new THREE.Object3D();
    for (let i = 0; i < count; i++) {
      d.position.set(0, 0.02, 14 - i * DASH_SPACING);
      d.updateMatrix();
      this.dashes.setMatrixAt(i, d.matrix);
    }
    this.dashes.instanceMatrix.needsUpdate = true;
    this.scene.add(this.dashes);
  }

  /**
   * Phase-12 规格1：车道分割微弱发光线（x = ±LANE_WIDTH/2 = ±1.5）。
   * 低强度 emissive（LANE_LINE_INT=0.55，线性亮度 < Bloom 阈值 → 无光晕，只作车道辨识），
   * 长度 EDGE_LEN 与霓虹边线一致延伸至雾中；2 实例 InstancedMesh = 1 draw call。
   * 玩法辅助元素：degradeScenery 任何级别不剥离。
   */
  _buildLaneLines() {
    const geo = new THREE.BoxGeometry(0.06, 0.02, EDGE_LEN);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x0a1626, emissive: LANE_LINE_COLOR, emissiveIntensity: LANE_LINE_INT, roughness: 0.5,
    });
    this.laneLines = new THREE.InstancedMesh(geo, mat, 2);
    this.laneLines.frustumCulled = false;
    const d = new THREE.Object3D();
    d.position.set(-LANE_WIDTH / 2, 0.03, 20 - EDGE_LEN / 2); d.updateMatrix();
    this.laneLines.setMatrixAt(0, d.matrix);
    d.position.x = LANE_WIDTH / 2; d.updateMatrix();
    this.laneLines.setMatrixAt(1, d.matrix);
    this.laneLines.instanceMatrix.needsUpdate = true;
    this.scene.add(this.laneLines);
  }

  /** 距离线索二（规格3）：跑道地面沿前进方向的等间距冷色刻度横线（Phase-5 改冷蓝，与中央暖虚线形成冷暖对比），随距离取模滚动 */
  _buildTicks() {
    const g = new THREE.Group();
    const minorMat = new THREE.LineBasicMaterial({ color: 0x2e3d70, transparent: true, opacity: 0.3 });
    const majorMat = new THREE.LineBasicMaterial({ color: 0x6f8fd8, transparent: true, opacity: 0.5 });
    const N = Math.ceil(150 / TICK_SPACING);                 // 覆盖 KILL_Z(+14) → SPAWN_Z 之后(-131)
    for (let i = 0; i < N; i++) {
      const z = 14 - i * TICK_SPACING;
      const mat = (i % 4 === 0) ? majorMat : minorMat;       // 每 4 条一条主刻度（20u 一循环）
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-3.9, 0.015, z), new THREE.Vector3(3.9, 0.015, z),
      ]);
      g.add(new THREE.Line(geo, mat));
    }
    this.ticks = g;
    this.scene.add(g);
  }

  /** Phase-8 规格1：彗星流光纹理（32×128，亮头拖尾、横向压扁的 alpha 塑形；RepeatWrapping 供 UV 滚动） */
  _makeFlowTexture() {
    const c = document.createElement('canvas');
    c.width = 32; c.height = 128;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, 32, 128);
    const rg = ctx.createRadialGradient(16, 92, 1, 16, 92, 48);
    rg.addColorStop(0, 'rgba(255,255,255,0.95)');
    rg.addColorStop(0.3, 'rgba(255,255,255,0.45)');
    rg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.save();
    ctx.translate(16, 92); ctx.scale(0.18, 1); ctx.translate(-16, -92);   // 横向压扁 → 细长竖直彗星
    ctx.fillStyle = rg;
    ctx.fillRect(-80, -80, 200, 260);
    ctx.restore();
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1, 18);            // 18 颗彗星铺满 ROAD_LEN=280u
    return tex;
  }

  /** Phase-8 规格1：两侧车道流光带——1 个 InstancedMesh（2 实例 = 1 draw call），加色混合，UV 随距离滚动 */
  _buildFlowStrips() {
    this.flowTex = this._makeFlowTexture();
    const geo = new THREE.PlaneGeometry(0.55, ROAD_LEN);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      map: this.flowTex, color: FLOW_COLOR, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.flowStrips = new THREE.InstancedMesh(geo, mat, 2);
    this.flowStrips.frustumCulled = false;
    const d = new THREE.Object3D();
    d.position.set(-3.4, 0.025, 20 - ROAD_LEN / 2); d.updateMatrix();
    this.flowStrips.setMatrixAt(0, d.matrix);
    d.position.x = 3.4; d.updateMatrix();
    this.flowStrips.setMatrixAt(1, d.matrix);
    this.flowStrips.instanceMatrix.needsUpdate = true;
    this.scene.add(this.flowStrips);
  }

  /**
   * Phase-8 规格3 + Phase-9 规格3：跑道左右边界霓虹实线（绿 #39ff88，亮度超 Bloom 阈值出光晕）。
   * 长 EDGE_LEN=340 覆盖 [20,-320]：雾密度 0.0055 下 z=-320（d≈333）已 96.5% 雾化 → 端点不可见，
   * 任何 distance 下边线都延伸到雾视距尽头不中断（旧 ROAD_LEN=280 在 ~-170 被雾吃断 = 用户所见「中途消失」）。
   * 静态 geometry + InstancedMesh 2 实例 = 1 draw call，勿逐帧创建。
   */
  _buildEdgeLines() {
    const geo = new THREE.BoxGeometry(0.09, 0.05, EDGE_LEN);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x0c2418, emissive: EDGE_NEON_COLOR, emissiveIntensity: EDGE_NEON_INT, roughness: 0.4,
    });
    this.edgeLines = new THREE.InstancedMesh(geo, mat, 2);
    this.edgeLines.frustumCulled = false;
    const d = new THREE.Object3D();
    d.position.set(-(ROAD_WIDTH / 2), 0.17, 20 - EDGE_LEN / 2); d.updateMatrix();   // 路缘石顶面（curb 顶 y=0.16）之上，覆盖 [20,-320]
    this.edgeLines.setMatrixAt(0, d.matrix);
    d.position.x = ROAD_WIDTH / 2; d.updateMatrix();
    this.edgeLines.setMatrixAt(1, d.matrix);
    this.edgeLines.instanceMatrix.needsUpdate = true;
    this.scene.add(this.edgeLines);
  }

  /** Phase-8 规格2：路侧微缩建筑窗户发光纹理（4×4 暖黄亮窗、55% 点亮率），打破剪影死黑 */
  _makeSideWindowTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, 64, 64);
    const warm = ['#ffcf8a', '#ffb45e', '#ffe3b0'];
    for (let gy = 0; gy < 4; gy++) {
      for (let gx = 0; gx < 4; gx++) {
        if (Math.random() < 0.55) {
          ctx.fillStyle = warm[(Math.random() * 3) | 0];
          ctx.fillRect(gx * 16 + 4, gy * 16 + 4, 8, 9);
        }
      }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /**
   * Phase-8 规格4：落地冲击波池——SHOCK_COUNT 格 InstancedMesh（1 draw call）循环复用，运行期零 new；
   * 复用障碍贴地圆环纹理（this.ringTex）保持视觉语言一致；加色混合下 instanceColor 变暗 = 淡出。
   * 2D 模式不构建 3D 场景，天然不受影响。
   */
  _buildShockPool() {
    const geo = new THREE.CircleGeometry(1, 28);
    geo.rotateX(-Math.PI / 2);                                  // 平铺 XZ 地面
    const mat = new THREE.MeshBasicMaterial({
      map: this.ringTex, color: 0xffffff, transparent: true, opacity: SHOCK_OPACITY,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.shock = new THREE.InstancedMesh(geo, mat, SHOCK_COUNT);
    this.shock.frustumCulled = false;
    this.shock.visible = false;
    this.shockT = new Float32Array(SHOCK_COUNT).fill(-1);       // <0 = 非激活
    this.shockX = new Float32Array(SHOCK_COUNT);
    this.shockZ = new Float32Array(SHOCK_COUNT);
    this.shockIdx = 0;
    this.shockEnabled = true;                                   // 降级链 L1 关闭
    this._shockDummy = new THREE.Object3D();
    this._shockCol = new THREE.Color();
    const d = this._shockDummy;
    d.position.set(0, -99, 0); d.updateMatrix();
    for (let i = 0; i < SHOCK_COUNT; i++) {
      this.shock.setMatrixAt(i, d.matrix);
      this.shock.setColorAt(i, this._shockCol.setScalar(0));
    }
    this.shock.instanceColor.needsUpdate = true;
    this.scene.add(this.shock);
  }

  /** 规格4：在落点发射一枚冲击波（池循环取格，满格覆盖最旧——对象池化，勿每次 new） */
  _spawnShock(x, z) {
    if (!this.shockEnabled) return;
    const i = this.shockIdx = (this.shockIdx + 1) % SHOCK_COUNT;
    this.shockT[i] = 0;
    this.shockX[i] = x;
    this.shockZ[i] = z;
    this.shock.visible = true;
  }

  /** 规格4：冲击波动画——easeOutQuad 放大 + instanceColor 变暗淡出，生命尽头自动回收（挂在现有单 rAF） */
  _updateShock(dt) {
    if (!this.shock.visible) return;
    const d = this._shockDummy;
    const col = this._shockCol;
    let alive = false;
    for (let i = 0; i < SHOCK_COUNT; i++) {
      if (this.shockT[i] < 0) continue;
      this.shockT[i] += dt;
      const p = this.shockT[i] / SHOCK_LIFE;
      if (p >= 1) {                                             // 动画完成 → 回收
        this.shockT[i] = -1;
        d.position.set(0, -99, 0); d.scale.setScalar(0.001); d.updateMatrix();
        this.shock.setMatrixAt(i, d.matrix);
        this.shock.setColorAt(i, col.setScalar(0));
        continue;
      }
      const ease = 1 - (1 - p) * (1 - p);                       // easeOutQuad：先快扩后缓收
      const r = SHOCK_R0 + (SHOCK_R1 - SHOCK_R0) * ease;
      d.position.set(this.shockX[i], 0.03, this.shockZ[i]);
      d.rotation.set(0, 0, 0);
      d.scale.set(r, 1, r);
      d.updateMatrix();
      this.shock.setMatrixAt(i, d.matrix);
      this.shock.setColorAt(i, col.set(SHOCK_COLOR).multiplyScalar(1 - p));   // 加色混合：变暗 = 淡出
      alive = true;
    }
    this.shock.instanceMatrix.needsUpdate = true;
    if (this.shock.instanceColor) this.shock.instanceColor.needsUpdate = true;
    if (!alive) this.shock.visible = false;
  }

  /**
   * 规格3/5/8 + Phase-9 规格1：路侧微缩景物——逐实例无限循环回收池（修复「跑远两侧全黑」）。
   * 根因（旧代码）：静态 3 份×80u 段（SCENERY_COPIES×SCENERY_PERIOD）+ group 取模滚动，世界远端覆盖 = -242+(distance%80)，
   * 随取模周期性缩到 -162，其外为永久空缺黑带；Phase-7 雾密度减半后可视深度超过覆盖深度 → 空缺带肉眼可见。
   * 新设计：struct（建筑40+灯杆24）/ foliage（树32×3段）/ lamps（灯头24）三个 InstancedMesh（draw call 数不变），
   * 全部实例直接持有世界 z，每帧 z += dz（挂现有单 rAF，与障碍同 dz）；z > SCENERY_KILL(20) 时回收
   * z -= SPAN(260)+抖动 重推最前端并重新随机化外观（规格4），运行期零分配。
   * 覆盖数学：带 [-240, 20]；雾 0.0055 下 z=-240（d≈253）已 85.5% 融入天色 → 远端无硬切断，任何 distance 两侧非空。
   */
  _buildScenery() {
    this.scenery = new THREE.Group();
    const unit = new THREE.BoxGeometry(1, 1, 1);
    unit.translate(0, 0.5, 0);                               // 底面对齐 y=0
    // Phase-8 规格2：暖黄窗户 emissiveMap——剪影不再死黑（55% 亮窗，强度 1.3 柔光不糊 Bloom）
    const mat = new THREE.MeshStandardMaterial({
      roughness: 0.85, metalness: 0.08,
      emissive: 0xffffff, emissiveMap: this._makeSideWindowTexture(), emissiveIntensity: 1.3,
    });
    // ---- 槽位状态：构造期一次创建、回收时原地改写（运行期零 new）----
    this.scnSlots = [];
    for (let i = 0; i < BUILD_N; i++) {
      this.scnSlots.push({ kind: 0, side: i % 2 ? 1 : -1, x: 0, z: 0, w: 1, h: 1, d: 1, col: new THREE.Color() });
    }
    for (let i = 0; i < POLE_N; i++) {
      this.scnSlots.push({ kind: 1, side: i % 2 ? 1 : -1, x: 0, z: 0, w: 0.1, h: 1.7, d: 0.1, hs: 1, col: new THREE.Color(0x232838) });
    }
    this.treeSlots = [];
    for (let i = 0; i < TREE_N; i++) {
      this.treeSlots.push({ side: i % 2 ? 1 : -1, x: 0, z: 0, c1: new THREE.Color(), c2: new THREE.Color() });
    }
    // ---- 三个 InstancedMesh（与旧版同为 3 个 draw call）----
    this.sceneryStruct = new THREE.InstancedMesh(unit, mat, BUILD_N + POLE_N);
    this.sceneryFoliage = new THREE.InstancedMesh(unit, mat, TREE_N * 3);
    const lampMat = new THREE.MeshStandardMaterial({
      color: 0x2a1c08, emissive: 0xffd9a0, emissiveIntensity: 3.4, roughness: 0.4,   // Phase-7 规格3：暖黄灯头
    });
    this.sceneryLamps = new THREE.InstancedMesh(new THREE.BoxGeometry(0.3, 0.15, 0.3), lampMat, POLE_N);   // 灯头加大
    this.baseLampCount = POLE_N;   // Phase-10：灯头降级减半的基线（永远从 24 重算，禁止连除）
    for (const m of [this.sceneryStruct, this.sceneryFoliage, this.sceneryLamps]) m.frustumCulled = false;
    this._scnDummy = new THREE.Object3D();
    this._scnCol = new THREE.Color();
    this.scenery.add(this.sceneryStruct, this.sceneryFoliage, this.sceneryLamps);
    this.scene.add(this.scenery);
    this._scatterScenery();                                  // 初始均匀铺满回收带
  }

  /** 建筑/灯杆外观重随机（Phase-9 规格4：宽/高/深/反照率、灯杆高度+灯头缩放≈亮度抖动，错落不重复） */
  _scnRerand(s) {
    if (s.kind === 0) {                                      // 建筑：幂分布高低错落 + 随机宽深 + HSL 反照率抖动
      s.x = s.side * (6.2 + Math.random() * 9);
      s.w = 1.2 + Math.random() * 2.2;
      s.h = 0.8 + Math.pow(Math.random(), 1.5) * 5.6;        // 0.8~6.4u（Phase-8 规格2 分布保留）
      s.d = 1.2 + Math.random() * 2.2;
      s.col.setHSL(0.6 + Math.random() * 0.08, 0.38, 0.16 + Math.random() * 0.09);
    } else {                                                 // 灯杆：x 微偏 + 高度 1.6~1.95 + 灯头缩放 0.85~1.2（亮度抖动）
      s.x = s.side * (5.3 + (Math.random() - 0.5) * 0.3);
      s.h = 1.6 + Math.random() * 0.35;
      s.hs = 0.85 + Math.random() * 0.35;
    }
  }

  /** 树槽位重随机（Phase-9 规格4）：x 位置 + 树冠两层色相/明度抖动 */
  _treeRerand(t) {
    t.x = t.side * (5.6 + Math.random() * 4.5);
    const g = 0.85 + Math.random() * 0.3;
    t.c1.setHSL(0.42, 0.42, 0.30 * g);
    t.c2.setHSL(0.40, 0.40, 0.36 * g);
  }

  /** 全量随机铺满回收带（初始构建 + reset 重开）：z 均匀 ∈ [-240, 20]，外观全随机 */
  _scatterScenery() {
    for (const s of this.scnSlots) {
      s.z = SCENERY_KILL - Math.random() * SCENERY_SPAN;
      this._scnRerand(s);
    }
    for (const t of this.treeSlots) {
      t.z = SCENERY_KILL - Math.random() * SCENERY_SPAN;
      this._treeRerand(t);
    }
    this._writeScenery(true);
  }

  /**
   * Phase-9 规格1：景物每帧推进 + 循环回收——挂现有单 rAF（update() 内 dz = speed×dt 与障碍同步）。
   * z > SCENERY_KILL（移到相机后方）→ z -= SPAN+抖动 重推最前端并重新随机化；只写 matrix/color，零 new/零 geometry。
   */
  _updateScenery(dz) {
    if (!this.scenery.visible || !(dz > 0)) return;          // 降级链 L2 关闭后跳过写入
    let recycled = false;
    for (const s of this.scnSlots) {
      s.z += dz;
      if (s.z > SCENERY_KILL) {
        s.z -= SCENERY_SPAN + Math.random() * 10;            // 重推最前端（+抖动打破等距回收）
        this._scnRerand(s);
        recycled = true;
      }
    }
    for (const t of this.treeSlots) {
      t.z += dz;
      if (t.z > SCENERY_KILL) {
        t.z -= SCENERY_SPAN + Math.random() * 10;
        this._treeRerand(t);
        recycled = true;
      }
    }
    this._writeScenery(recycled);
  }

  /** 槽位状态 → instanceMatrix（位置每帧变，矩阵每帧重写；color 仅回收/重铺时上传） */
  _writeScenery(colorDirty) {
    const d = this._scnDummy;
    d.rotation.set(0, 0, 0);
    const st = this.sceneryStruct, fl = this.sceneryFoliage, lp = this.sceneryLamps;
    for (let i = 0; i < this.scnSlots.length; i++) {
      const s = this.scnSlots[i];
      d.position.set(s.x, 0, s.z);
      d.scale.set(s.w, s.h, s.d);
      d.updateMatrix();
      st.setMatrixAt(i, d.matrix);
      if (s.kind === 1) {                                    // 灯杆槽 → 配对灯头（同 x/z，高度/缩放抖动）
        const j = i - BUILD_N;
        d.position.set(s.x, s.h + 0.06, s.z);
        d.scale.setScalar(s.hs);
        d.updateMatrix();
        if (j < lp.count) lp.setMatrixAt(j, d.matrix);       // 降级 L1 灯头减半后只写前一半
      }
      if (colorDirty) st.setColorAt(i, s.col);
    }
    for (let t = 0; t < this.treeSlots.length; t++) {
      const s = this.treeSlots[t];
      d.scale.set(0.22, 0.7, 0.22);  d.position.set(s.x, 0, s.z);    d.updateMatrix();
      fl.setMatrixAt(t * 3, d.matrix);                               // 树干
      d.scale.set(0.95, 0.65, 0.95); d.position.set(s.x, 0.55, s.z); d.updateMatrix();
      fl.setMatrixAt(t * 3 + 1, d.matrix);                           // 树冠下层
      d.scale.set(0.6, 0.5, 0.6);    d.position.set(s.x, 1.05, s.z); d.updateMatrix();
      fl.setMatrixAt(t * 3 + 2, d.matrix);                           // 树冠上层
      if (colorDirty) {
        fl.setColorAt(t * 3, this._scnCol.set(0x4a3b2a));
        fl.setColorAt(t * 3 + 1, s.c1);
        fl.setColorAt(t * 3 + 2, s.c2);
      }
    }
    st.instanceMatrix.needsUpdate = true;
    fl.instanceMatrix.needsUpdate = true;
    lp.instanceMatrix.needsUpdate = true;
    if (colorDirty) {
      if (st.instanceColor) st.instanceColor.needsUpdate = true;
      if (fl.instanceColor) fl.instanceColor.needsUpdate = true;
    }
  }

  /** 贴地发光圆环贴图（Phase-6 规格4：亮环带+内外柔边，加色混合暗处醒目；随距离缩放逻辑保留） */
  _makeRingTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    const grad = ctx.createRadialGradient(64, 64, 26, 64, 64, 62);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.45, 'rgba(255,255,255,0.25)');
    grad.addColorStop(0.62, 'rgba(255,255,255,1)');   // 亮环带
    grad.addColorStop(0.8, 'rgba(255,255,255,0.35)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  _buildDino() {
    // 规格2/8：体素拼装 3D 恐龙——85 个微小立方体躯干（InstancedMesh 单 draw call）+
    // MeshPhysicalMaterial 高反光塑料/玻璃质感（clearcoat + 暮色环境反射）+ 暖色自发光背脊与冰蓝发光眼睛（规格6 Bloom 只拾取这些）。
    // 面朝 -Z（前进方向）；y 为体素层号，×VOXEL = 世界高度，脚底 ≈ y=0。
    this.dino = new THREE.Group();
    const V = VOXEL;
    const bodyVox = [];
    const addBox = (x0, x1, y0, y1, z0, z1) => {
      for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++)
          for (let z = z0; z <= z1; z++) bodyVox.push([x, y, z]);
    };
    addBox(-1, 1, 6, 9, -1, 1);      // 躯干 3×4×3
    addBox(-1, 1, 10, 12, -3, -1);   // 头 3×3×3（前伸）
    addBox(-1, 1, 7, 9, 2, 2);       // 尾根
    addBox(-1, 1, 8, 9, 3, 3);       // 尾中
    addBox(-1, 1, 9, 9, 4, 4);       // 尾尖（上翘）
    addBox(-2, -2, 7, 7, -2, -1);    // 左小手臂
    addBox(2, 2, 7, 7, -2, -1);      // 右小手臂
    const bodyGeo = new THREE.BoxGeometry(V * 0.92, V * 0.92, V * 0.92);
    this._dinoBodyMat = new THREE.MeshPhysicalMaterial({
      color: 0x2e8f83, roughness: 0.28, metalness: 0.05,
      clearcoat: 0.9, clearcoatRoughness: 0.18, envMapIntensity: 1.3,   // 高反光塑料/玻璃质感（规格2）
    });
    const dummy = new THREE.Object3D();
    const fill = (voxList) => {
      const mesh = new THREE.InstancedMesh(bodyGeo, this._dinoBodyMat, voxList.length);
      voxList.forEach((v, i) => {
        dummy.position.set(v[0] * V, v[1] * V, v[2] * V);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      return mesh;
    };
    this.dino.add(fill(bodyVox));
    // 暖色自发光点缀：背脊 2 块 + 尾尖 1 块（规格2；emissiveIntensity 2.6 → 超 Bloom threshold）
    const glowMat = new THREE.MeshStandardMaterial({
      color: 0x1a1208, emissive: 0xffa64d, emissiveIntensity: 2.6, roughness: 0.4,
    });
    const glowMesh = new THREE.InstancedMesh(bodyGeo, glowMat, 3);
    [[0, 10, 1], [0, 10, 0], [0, 10, 4]].forEach((v, i) => {
      dummy.position.set(v[0] * V, v[1] * V, v[2] * V);
      dummy.updateMatrix();
      glowMesh.setMatrixAt(i, dummy.matrix);
    });
    glowMesh.instanceMatrix.needsUpdate = true;
    this.dino.add(glowMesh);
    // 眼睛（规格6：Bloom 只给恐龙眼睛等发光体）
    const eyeMat = new THREE.MeshStandardMaterial({
      color: 0x0a1420, emissive: 0xdff6ff, emissiveIntensity: 3.2, roughness: 0.3,
    });
    const eyeMesh = new THREE.InstancedMesh(bodyGeo, eyeMat, 2);
    [[-1, 11, -3], [1, 11, -3]].forEach((v, i) => {
      dummy.position.set(v[0] * V, v[1] * V, v[2] * V);
      dummy.updateMatrix();
      eyeMesh.setMatrixAt(i, dummy.matrix);
    });
    eyeMesh.instanceMatrix.needsUpdate = true;
    this.dino.add(eyeMesh);
    // 腿：髋部子组 + 各自小型 InstancedMesh（规格8），供跑动摆动（逻辑与 Phase-3 一致）
    const legVox = [[0, -1, 0], [0, -2, 0], [0, -3, 0], [0, -4, 0], [0, -5, 0], [0, -5.5, -1]];  // 大腿 + 前伸脚掌（局部体素单位）
    this.legL = new THREE.Group(); this.legL.position.set(-1.4 * V, 6 * V, 0);
    this.legR = new THREE.Group(); this.legR.position.set(1.4 * V, 6 * V, 0);
    for (const grp of [this.legL, this.legR]) {
      const mesh = new THREE.InstancedMesh(bodyGeo, this._dinoBodyMat, legVox.length);
      legVox.forEach((v, i) => {
        dummy.position.set(v[0] * V, v[1] * V, v[2] * V);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      grp.add(mesh);
      this.dino.add(grp);
    }
    this.scene.add(this.dino);
  }

  // ===================== Phase-13：三类 Minecraft 体素障碍（规格1/2/3 外观 + 池化） =====================
  /**
   * 程序化像素纹理基座（规格5 红线：零外部图片/零 CDN）：16×16 网格逐格上色 →
   * CanvasTexture + magFilter/minFilter = NearestFilter（保锐利方块感）+ 关 mipmap。
   * @param {string[]} cells 256 个 CSS 颜色字符串（行主序 16×16）
   */
  _makePixelTexture(cells) {
    const N = 16;
    const c = document.createElement('canvas');
    c.width = c.height = N;
    const ctx = c.getContext('2d');
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        ctx.fillStyle = cells[y * N + x];
        ctx.fillRect(x, y, 1, 1);
      }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.NearestFilter;     // 规格5：像素锐利（无线性插值模糊）
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    return tex;
  }

  /** 规格1 路障纹理：岩浆块/TNT 风——暗红硬壳底色 + 3 条随机游走熔岩裂缝（暖色红/橙危险警示） */
  _makeBarrierCells() {
    const crust = ['#5e1206', '#75190b', '#8f2410', '#6b1608'];
    const lava = ['#ff7b1e', '#ffc46b', '#e05212'];
    const cells = [];
    for (let i = 0; i < 256; i++) cells.push(crust[(Math.random() * crust.length) | 0]);
    for (let k = 0; k < 3; k++) {
      let x = (Math.random() * 16) | 0, y = (Math.random() * 16) | 0;
      for (let s = 0; s < 9; s++) {
        cells[y * 16 + x] = lava[(Math.random() * lava.length) | 0];
        x = (x + ((Math.random() * 3) | 0) - 1 + 16) % 16;
        y = (y + ((Math.random() * 3) | 0) - 1 + 16) % 16;
      }
    }
    return cells;
  }

  /** 规格2 墙体纹理：黑曜石/基岩/传送门风——冷色深紫黑底 + 7 簇紫/青发光斑块；emissiveMap 黑底只留亮斑（流光感） */
  _makeWallTextures() {
    const base = ['#0b0614', '#150b26', '#1c0f33', '#241141'];
    const spots = ['#7a3cff', '#9b5cff', '#2ee6ff'];
    const cells = [], em = [];
    for (let i = 0; i < 256; i++) {
      cells.push(base[(Math.random() * base.length) | 0]);
      em.push('#000000');
    }
    for (let k = 0; k < 7; k++) {
      const x = (Math.random() * 16) | 0, y = (Math.random() * 16) | 0;
      const col = spots[(Math.random() * spots.length) | 0];
      const n = 2 + ((Math.random() * 3) | 0);
      for (let s = 0; s < n; s++) {
        const px = (x + ((Math.random() * 3) | 0) - 1 + 16) % 16;
        const py = (y + ((Math.random() * 3) | 0) - 1 + 16) % 16;
        cells[py * 16 + px] = col;
        em[py * 16 + px] = col;
      }
    }
    return { map: this._makePixelTexture(cells), emissiveMap: this._makePixelTexture(em) };
  }

  /** 规格3 深坑纹理：虚空黑/深渊暗红噪底 + 四边 1~2px 不规则锯齿暖色发光警示条（12% 缺口 → 锯齿感）；emissiveMap 只留警示条与深处红热裂纹 */
  _makePitTextures() {
    const abyss = ['#030208', '#050310', '#0a0410', '#21070a'];
    const warn = ['#ff8a1e', '#ffb45e', '#ff5a1e'];
    const cells = [], em = [];
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        cells.push(abyss[(Math.random() * abyss.length) | 0]);
        em.push('#000000');
      }
    const inEdgeBand = (x, y) => x === 0 || y === 0 || x === 15 || y === 15 ||
      ((x === 1 || y === 1 || x === 14 || y === 14) && Math.random() < 0.45);
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        if (inEdgeBand(x, y) && Math.random() < 0.88) {
          const col = warn[(Math.random() * warn.length) | 0];
          cells[y * 16 + x] = col;
          em[y * 16 + x] = col;
        }
      }
    for (let k = 0; k < 4; k++) {
      const x = 3 + ((Math.random() * 10) | 0), y = 3 + ((Math.random() * 10) | 0);
      cells[y * 16 + x] = '#7a1f0f';
      em[y * 16 + x] = '#5e1206';
    }
    return { map: this._makePixelTexture(cells), emissiveMap: this._makePixelTexture(em) };
  }


  // ================= Phase-14：减速块 / 金币 / 怪物 程序化像素纹理与构建（16×16 NearestFilter，零外部图片） =================
  /** 粘液块：绿色半透明发光像素块（4 绿底色随机 + 10 亮斑=粘液核心）。 */
  _makeSlimeCells() {
    const base = ['#3fae49', '#2e8b3a', '#58c962', '#226b2b'];
    const cells = new Array(256).fill('');
    for (let i = 0; i < 256; i++) cells[i] = base[(Math.random() * base.length) | 0];
    for (let s = 0; s < 10; s++) {
      const x = (Math.random() * 16) | 0, y = (Math.random() * 16) | 0;
      cells[y * 16 + x] = '#b6ffbe';
    }
    return cells;
  }

  /** 细雪块：冰蓝像素面（4 蓝底色 + 14 纯白雪闪）。 */
  _makeSnowCells() {
    const base = ['#cfe9ff', '#a8d4f5', '#eaf6ff', '#7fb8e6'];
    const cells = new Array(256).fill('');
    for (let i = 0; i < 256; i++) cells[i] = base[(Math.random() * base.length) | 0];
    for (let s = 0; s < 14; s++) {
      const x = (Math.random() * 16) | 0, y = (Math.random() * 16) | 0;
      cells[y * 16 + x] = '#ffffff';
    }
    return cells;
  }

  /** 金币：金色径向像素（中心亮金 → 边缘深金，方块币面）。 */
  _makeCoinCells() {
    const cells = new Array(256).fill('');
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const d = Math.hypot(x - 7.5, y - 7.5);
        cells[y * 16 + x] = d < 3 ? '#fff0a8' : d < 6 ? '#ffd23e' : (Math.random() < 0.5 ? '#e0a416' : '#b37a0a');
      }
    }
    return cells;
  }

  /** 怪物：苦力怕风绿黑像素体 + 18 纯黑斑（体素怪物皮肤）。 */
  _makeMonsterCells() {
    const base = ['#3f7f2f', '#2d5e22', '#56a03f', '#1d4016'];
    const cells = new Array(256).fill('');
    for (let i = 0; i < 256; i++) cells[i] = base[(Math.random() * base.length) | 0];
    for (let s = 0; s < 18; s++) {
      const x = (Math.random() * 16) | 0, y = (Math.random() * 16) | 0;
      cells[y * 16 + x] = '#101408';
    }
    return cells;
  }

  /**
   * 金币池（Phase-14 规格④）：COIN_POOL 个共享几何/材质单 mesh，零热路径分配。
   * 拾取判定在 update() 金币循环（AABB，薄盒 size(0.75,0.75,0.5)）。
   */
  _buildCoinPool() {
    this.coins = [];
    const coinTex = this._makePixelTexture(this._makeCoinCells());
    const mat = new THREE.MeshStandardMaterial({
      map: coinTex, emissive: 0xffb52e, emissiveIntensity: 1.3, emissiveMap: coinTex,
      roughness: 0.35, metalness: 0.4,
    });
    const geo = new THREE.BoxGeometry(1, 1, 1);
    for (let i = 0; i < COIN_POOL; i++) {
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      m.userData = { active: false, taken: false, y: 0.9, rowId: 0 };
      this.coins.push(m);
      this.scene.add(m);
    }
  }

  /**
   * Phase-14 规格①：巨型体素怪物（常驻单例 Group，非 InstancedMesh——单实例多部件，draw call 8）。
   * 苦力怕风绿黑体素 + 双眼发光红（面向恐龙 -Z 侧）。定位/尺寸由 _updateMonster 按 chaseDistance 映射：
   * Phase-15：视觉地面距离 r∈[MONSTER_Z_FAR(1.3, chase→30), MONSTER_Z_NEAR(1.7, chase→0)]（自恐龙向相机地面投影方向偏移）+ 下沉 M_SINK——只在屏幕最下缘露头/半身，绝不遮挡恐龙与前方障碍（tests/monster_framing.mjs）。
   */
  _buildMonster() {
    const g = new THREE.Group();
    const tex = this._makePixelTexture(this._makeMonsterCells());
    const bodyMat = new THREE.MeshStandardMaterial({
      map: tex, emissive: 0x2f6b1f, emissiveIntensity: 0.5, emissiveMap: tex,
      roughness: 0.85, metalness: 0.05,
    });
    const eyeMat = new THREE.MeshStandardMaterial({
      color: 0x120806, emissive: 0xff3a1e, emissiveIntensity: 2.2, roughness: 0.6,
    });
    const box = new THREE.BoxGeometry(1, 1, 1);
    const part = (w, h, d, x, y, z, mat) => {
      const m = new THREE.Mesh(box, mat || bodyMat);
      m.scale.set(w, h, d);
      m.position.set(x, y, z);
      g.add(m);
      return m;
    };
    part(1.7, 1.7, 1.7, 0, 4.65, 0);                        // 头
    part(1.9, 2.6, 1.0, 0, 2.5, 0);                          // 躯干
    part(0.6, 1.2, 0.6, -0.62, 0.6, -0.35);                  // 左前腿
    part(0.6, 1.2, 0.6, 0.62, 0.6, -0.35);                   // 右前腿
    part(0.6, 1.2, 0.6, -0.62, 0.6, 0.35);                   // 左后腿
    part(0.6, 1.2, 0.6, 0.62, 0.6, 0.35);                    // 右后腿
    part(0.34, 0.34, 0.12, -0.42, 4.85, -0.86, eyeMat);      // 左眼（发光，-Z 面朝恐龙）
    part(0.34, 0.34, 0.12, 0.42, 4.85, -0.86, eyeMat);       // 右眼
    g.visible = false;
    this.monster = g;
    this.scene.add(g);
  }

  /** 生成一个粘液块（车道级非致命；AABB 同路障形制但走 _slow 分支，可跳过）。 */
  _spawnSlime(x, z, rowId) {
    const o = this._takeSlot('slime');
    if (!o) return;
    const u = o.userData;
    const w = BARRIER_W_MIN + Math.random() * (BARRIER_W_MAX - BARRIER_W_MIN);
    const d = BARRIER_D_MIN + Math.random() * (BARRIER_D_MAX - BARRIER_D_MIN);
    u.active = true; u.w = w; u.h = SLIME_H; u.d = d; u.rowId = rowId; u.passed = false; u.triggered = false;
    o.scale.set(w, SLIME_H, d);
    o.position.set(x, SLIME_H / 2, z);
    o.visible = true;
  }

  /** 生成一个细雪块（贴地薄板 SNOW_H=0.15 → 恐龙盒底 jumpY+0.1 < 0.15 即踩上；跳跃越过不触发）。 */
  _spawnSnow(x, z, rowId) {
    const o = this._takeSlot('snow');
    if (!o) return;
    const u = o.userData;
    const w = BARRIER_W_MIN + Math.random() * (BARRIER_W_MAX - BARRIER_W_MIN);
    const d = BARRIER_D_MIN + Math.random() * (BARRIER_D_MAX - BARRIER_D_MIN);
    u.active = true; u.w = w; u.h = SNOW_H; u.d = d; u.rowId = rowId; u.passed = false; u.triggered = false;
    o.scale.set(w, SNOW_H, d);
    o.position.set(x, SNOW_H / 2, z);
    o.visible = true;
  }

  /** 生成一排金币：单车道 count 枚沿 z 弧线排布（中间略高，跳跃轨迹可空中拾取）。 */
  _spawnCoins(x, z, count, rowId) {
    for (let i = 0; i < count; i++) {
      let slot = null;
      for (let j = 0; j < this.coins.length; j++) {
        if (!this.coins[j].userData.active) { slot = this.coins[j]; break; }
      }
      if (!slot) return;   // 池耗尽 → 本排剩余金币放弃（少币只少奖励，绝不产生死局）
      const u = slot.userData;
      u.active = true; u.taken = false; u.rowId = rowId;
      u.y = 0.9 + Math.sin(((i + 0.5) / count) * Math.PI) * 0.9;
      slot.scale.set(0.75, 0.75, 0.14);
      slot.position.set(x, u.y, z + (i - (count - 1) / 2) * COIN_SPACING);
      slot.rotation.set(0, 0, 0);
      slot.visible = true;
    }
  }

  /**
   * Phase-13：三类障碍各自对象池（BARRIER_POOL/WALL_POOL/PIT_POOL 可调，回收复用零 per-frame 分配）。
   * 共享 geometry（unit box + EdgesGeometry）+ 每类一个共享像素纹理材质 → draw call 与旧单池同量级。
   * 路障/墙保留贴地发光圆环 blob（距离线索 + WARN_DIST 变红）；深坑全宽无需 blob（发光警示条本身即线索）。
   */
  _buildObstaclePools() {
    this.obstacles = [];
    const blobTex = this.ringTex = this._makeRingTexture();   // Phase-8：圆环纹理与落地冲击波共用
    const blobGeo = new THREE.CircleGeometry(1, 24);
    blobGeo.rotateX(-Math.PI / 2);                            // 平铺 XZ 地面
    const unit = new THREE.BoxGeometry(1, 1, 1);
    const edgesGeo = new THREE.EdgesGeometry(unit);           // 轮廓线框共享 geometry（一次生成）
    this._edgeMat = new THREE.LineBasicMaterial({ color: EDGE_COLOR, transparent: true, opacity: 0.85 });
    // ---- 规格1 路障材质：岩浆块像素纹理，emissive 与 emissiveMap 同纹理（微弱自发热光）----
    const barrierTex = this._makePixelTexture(this._makeBarrierCells());
    this._barrierMat = new THREE.MeshStandardMaterial({
      map: barrierTex, emissive: 0xff6a2a, emissiveIntensity: 0.9, emissiveMap: barrierTex,
      roughness: 0.9, metalness: 0.05,
    });
    // ---- 规格2 墙体材质：黑曜石像素纹理 + 紫/青亮斑 emissiveMap（冷色『绝对跳不过去』厚重感；不透明——大盒 transparent 排序易出伪影，视觉优先实心）----
    const wallTex = this._makeWallTextures();
    this._wallMat = new THREE.MeshStandardMaterial({
      map: wallTex.map, emissive: 0x8a4bff, emissiveIntensity: 1.15, emissiveMap: wallTex.emissiveMap,
      roughness: 0.5, metalness: 0.2,
    });
    // ---- 规格3 深坑材质：虚空黑 + 边缘锯齿暖色警示条 emissiveMap（顶面盖住路面装饰使地面纹理视觉断开）----
    const pitTex = this._makePitTextures();
    this._pitMat = new THREE.MeshStandardMaterial({
      map: pitTex.map, emissive: 0xff7b1e, emissiveIntensity: 1.5, emissiveMap: pitTex.emissiveMap,
      roughness: 1, metalness: 0,
    });
    const addSlot = (kind, mat, withBlob) => {
      const g = new THREE.Group();
      const core = new THREE.Mesh(unit, mat);
      core.castShadow = kind !== 'pit';                       // 坑板贴地无需投影
      const edge = new THREE.LineSegments(edgesGeo, this._edgeMat);
      core.add(edge);                                         // 亮白轮廓（core 子节点，随组缩放）
      g.add(core);
      g.visible = false;
      let blob = null;
      if (withBlob) {
        blob = new THREE.Mesh(blobGeo, new THREE.MeshBasicMaterial({
          map: blobTex, color: RING_COLOR_FAR, transparent: true, opacity: SHADOW_OPACITY_MAX,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        blob.visible = false;
        this.scene.add(blob);                                 // 场景级：不受障碍组 (w,h,d) 非均匀缩放影响
      }
      // yFit：碰撞盒 Y 缩放——路障 0.94（判定略收窄更公平，沿用旧数学）；墙/slime/snow 1.0（墙覆盖全高；雪 0.15 薄板=贴地踩上判定语义，跳跃越过不触发）
      // Phase-14：rowId/passed/triggered —— 完美排判定 + 减速块一次性触发（同排多块只扣一次）
      g.userData = { kind, active: false, w: 1, h: 1, d: 1, yFit: kind === 'barrier' ? 0.94 : 1.0, core, edge, blob, rowId: 0, passed: false, triggered: false };
      this.obstacles.push(g);
      this.scene.add(g);
    };
    // ---- Phase-14 减速块材质：粘液块（绿半透明发光）/ 细雪块（冰蓝发光薄板）----
    const slimeTex = this._makePixelTexture(this._makeSlimeCells());
    this._slimeMat = new THREE.MeshStandardMaterial({
      map: slimeTex, emissive: 0x3dff6a, emissiveIntensity: 0.55, emissiveMap: slimeTex,
      roughness: 0.4, metalness: 0, transparent: true, opacity: 0.85,
    });
    const snowTex = this._makePixelTexture(this._makeSnowCells());
    this._snowMat = new THREE.MeshStandardMaterial({
      map: snowTex, emissive: 0x9fd8ff, emissiveIntensity: 0.6, emissiveMap: snowTex,
      roughness: 0.7, metalness: 0,
    });
    for (let i = 0; i < BARRIER_POOL; i++) addSlot('barrier', this._barrierMat, true);
    for (let i = 0; i < WALL_POOL; i++) addSlot('wall', this._wallMat, true);
    for (let i = 0; i < PIT_POOL; i++) addSlot('pit', this._pitMat, false);
    for (let i = 0; i < SLIME_POOL; i++) addSlot('slime', this._slimeMat, true);
    for (let i = 0; i < SNOW_POOL; i++) addSlot('snow', this._snowMat, true);
    this.nextSpawnAt = 30;   // 首次生成前的距离（给玩家缓冲）
  }

  /** 按类型取空闲池槽（池耗尽返回 null → 跳过生成：该排更畅通，绝不制造必死排） */
  _takeSlot(kind) {
    for (const o of this.obstacles) if (o.userData.kind === kind && !o.userData.active) return o;
    return null;
  }

  /** 规格1：低矮岩浆路障出池——高固定 BARRIER_HEIGHT(0.7u ≈ 恐龙身高 1/3)，紧贴地面，apex 5.16 ≥ 2×0.7 必须跳 */
  _spawnBarrier(x, z, rowId) {
    const o = this._takeSlot('barrier');
    if (!o) return;
    const u = o.userData;
    const w = BARRIER_W_MIN + Math.random() * (BARRIER_W_MAX - BARRIER_W_MIN);
    const d = BARRIER_D_MIN + Math.random() * (BARRIER_D_MAX - BARRIER_D_MIN);
    u.active = true; u.w = w; u.h = BARRIER_HEIGHT; u.d = d; u.rowId = rowId; u.passed = false; u.triggered = false;
    o.scale.set(w, BARRIER_HEIGHT, d);
    o.position.set(x, BARRIER_HEIGHT / 2, z);
    o.visible = true;
  }

  /** 规格2：高空黑曜石墙段出池——高固定 WALL_HEIGHT(7.5u ≥ apex+恐龙身高)，每车道一段，正面撞 = 失败，只能变道 */
  _spawnWallSeg(x, z, rowId) {
    const o = this._takeSlot('wall');
    if (!o) return;
    const u = o.userData;
    u.active = true; u.w = WALL_SEG_W; u.h = WALL_HEIGHT; u.d = WALL_SEG_D; u.rowId = rowId; u.passed = false; u.triggered = false;
    o.scale.set(WALL_SEG_W, WALL_HEIGHT, WALL_SEG_D);
    o.position.set(x, WALL_HEIGHT / 2, z);
    o.visible = true;
  }

  /** 规格3：全宽虚空深坑出池——坑板顶面 PIT_TOP_Y 盖住路面装饰（地面纹理视觉断开），长 = plan.len ∈ [4,10] 可跳越 */
  _spawnPit(len, z, rowId) {
    const o = this._takeSlot('pit');
    if (!o) return;
    const u = o.userData;
    u.active = true; u.w = PIT_WIDTH; u.h = PIT_SLAB_H; u.d = len; u.rowId = rowId; u.passed = false; u.triggered = false;
    o.scale.set(PIT_WIDTH, PIT_SLAB_H, len);
    o.position.set(0, PIT_TOP_Y - PIT_SLAB_H / 2, z);
    o.visible = true;
  }

  _buildTrail() {
    // 跳跃拖影粒子：滞空时从恐龙身后发射，暖金色加色混合被 Bloom 拾取
    const N = 90;
    this.trailN = N;
    this.trailPos = new Float32Array(N * 3);
    this.trailLife = new Float32Array(N);
    this.trailVel = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) this.trailPos[i * 3 + 1] = -999;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.trailPos, 3));
    this.trail = new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0xffc46b, size: 0.2, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.trailIdx = 0;
    this.scene.add(this.trail);
  }

  /** 规格4：撞击碎裂方块粒子池——单 InstancedMesh 48 块，_burstDebris 触发、重力+地面反弹、生命周期结束自动隐藏 */
  _buildDebris() {
    const N = 48;
    this.debrisN = N;
    const geo = new THREE.BoxGeometry(0.13, 0.13, 0.13);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.2 });
    this.debris = new THREE.InstancedMesh(geo, mat, N);
    this.debris.frustumCulled = false;
    this.debris.visible = false;
    this.debrisPos = new Float32Array(N * 3);
    this.debrisVel = new Float32Array(N * 3);
    this.debrisLife = new Float32Array(N);
    this.debrisDummy = new THREE.Object3D();
    const col = new THREE.Color();
    const palette = [0xffa64d, 0x9fd8ff, 0x26365f, 0xffd9a0];   // 暖橙/冷蓝玻璃/深色残块混合
    for (let i = 0; i < N; i++) { col.set(palette[i % palette.length]); this.debris.setColorAt(i, col); }
    this.debris.instanceColor.needsUpdate = true;
    this.scene.add(this.debris);
  }

  _burstDebris(ox, oy, oz) {
    for (let i = 0; i < this.debrisN; i++) {
      this.debrisPos[i * 3]     = ox + (Math.random() - 0.5) * 0.8;
      this.debrisPos[i * 3 + 1] = oy + (Math.random() - 0.5) * 0.8;
      this.debrisPos[i * 3 + 2] = oz + (Math.random() - 0.5) * 0.6;
      this.debrisVel[i * 3]     = (Math.random() - 0.5) * 10;
      this.debrisVel[i * 3 + 1] = 2 + Math.random() * 6;
      this.debrisVel[i * 3 + 2] = (Math.random() - 0.5) * 10;
      this.debrisLife[i] = 0.7 + Math.random() * 0.6;
    }
    this.debris.visible = true;
  }

  _updateDebris(dt) {
    if (!this.debris.visible) return;
    const d = this.debrisDummy;
    let alive = false;
    for (let i = 0; i < this.debrisN; i++) {
      if (this.debrisLife[i] <= 0) {
        d.position.set(0, -99, 0); d.scale.setScalar(0.001); d.updateMatrix();
        this.debris.setMatrixAt(i, d.matrix);
        continue;
      }
      this.debrisLife[i] -= dt;
      this.debrisVel[i * 3 + 1] -= 20 * dt;                    // 碎裂块重力
      this.debrisPos[i * 3]     += this.debrisVel[i * 3] * dt;
      this.debrisPos[i * 3 + 1] += this.debrisVel[i * 3 + 1] * dt;
      this.debrisPos[i * 3 + 2] += this.debrisVel[i * 3 + 2] * dt;
      if (this.debrisPos[i * 3 + 1] < 0.06) {                  // 地面反弹衰减
        this.debrisPos[i * 3 + 1] = 0.06;
        this.debrisVel[i * 3 + 1] *= -0.4;
        this.debrisVel[i * 3] *= 0.7;
        this.debrisVel[i * 3 + 2] *= 0.7;
      }
      d.position.set(this.debrisPos[i * 3], this.debrisPos[i * 3 + 1], this.debrisPos[i * 3 + 2]);
      d.rotation.set(this.debrisLife[i] * 7 + i, this.debrisLife[i] * 5, i * 0.7);   // 翻滚
      d.scale.setScalar(Math.max(0.01, Math.min(1, this.debrisLife[i] * 1.6)));      // 生命末期缩小消失
      d.updateMatrix();
      this.debris.setMatrixAt(i, d.matrix);
      alive = true;
    }
    this.debris.instanceMatrix.needsUpdate = true;
    if (!alive) this.debris.visible = false;
  }

  // ===================== 玩法接口 =====================
  /** 重开一局（结算面板「再来一局」/ 空格 / enterGame 首次进入） */
  reset() {
    this.distance = 0;
    this.score = 0;
    this.speed = BASE_SPEED;
    this.jumpY = 0;
    this.vy = 0;
    this.dinoX = 0;
    this.lane = 1;                                             // Phase-12：重开回中间车道
    this.shakeT = 0;
    this.blinkT = 0;
    this.crashT = 0;
    this.nextSpawnAt = 30;
    this.dino.visible = true;
    this.dino.position.set(0, 0, 0);
    this.dino.rotation.set(0, 0, 0);
    this.crashKind = 'hit';                                          // Phase-13：清坠坑动画标记
    for (const o of this.obstacles) {
      o.userData.active = false; o.visible = false;
      o.userData.passed = false; o.userData.triggered = false;       // Phase-14：清完美排/减速触发记账
      if (o.userData.blob) o.userData.blob.visible = false;          // Phase-13：深坑无 blob
    }
    // ---- Phase-14：追逐状态机 / 金币池 / 怪物 / FOV / 暗角冰霜 全部复位 ----
    this._chaseSt.chase = CHASE_INIT;
    this._chaseSt.slowT = 0;
    this._chaseSt.frenzyT = 0;
    this._chaseSt.frenzyCd = FRENZY_CD_MIN + Math.random() * FRENZY_CD_SPAN;
    this._chaseSt.dead = false;
    this._chaseEv.perfectRows = 0; this._chaseEv.coins = 0; this._chaseEv.slowEntered = false;
    this.chase = CHASE_INIT;
    this.bonusScore = 0;
    this.penaltyScore = 0;
    this.frostT = 0;
    this.dangerLevel = 0;
    this.fovBoost = 0;
    this.camera.fov = this._fovBase;
    this.camera.updateProjectionMatrix();
    for (const c of this.coins) { c.userData.active = false; c.userData.taken = false; c.visible = false; }
    this.monster.visible = false;
    this.monster.rotation.set(0, 0, 0);
    this.monsterVisZ = MONSTER_Z_NEAR + (MONSTER_Z_FAR - MONSTER_Z_NEAR) * (CHASE_INIT / CHASE_MAX);       // Phase-15：视觉缓动复位
    this.monsterVisScale = M_SCALE_NEAR + (M_SCALE_FAR - M_SCALE_NEAR) * (CHASE_INIT / CHASE_MAX);
    this.rowSeq = 0; this._curRowId = 0; this.lastRowId = 0;
    this.dirtySinceRow = false;
    this._lastPlan = null;
    this.debris.visible = false; this.debrisLife.fill(0);      // 清场上局碎裂粒子
    this.shock.visible = false; this.shockT.fill(-1);          // Phase-8：清场冲击波池
    this._scatterScenery();                                    // Phase-9：重开重新铺满路侧景物（不带上局分布）
    this.state = 'running';
    if (this.hooks.onScore) this.hooks.onScore(0, this.speed);
  }

  /** 跳跃入口：与 2D 的 dinoGame.jump(source) 同构，三通道（pose/key/pointer）汇聚 */
  jump(source) {
    if (this.state !== 'running') return;
    if (this.jumpY > 0.001 || this.vy > 0) return;       // 滞空不重复触发
    this.vy = JUMP_V0;                                   // apex = V0²/(2G) ≈ 5.16u ≥ 2×2.2u
    if (this.hooks.onJump) this.hooks.onJump(source);
  }

  isAirborne() { return this.jumpY > 0.001 || this.vy > 0; }

  /** 视角切换（规格6）：'chase' 高角度追尾（默认） | 'iso' 斜 45° 等距；运行时可来回切 */
  setCameraMode(mode) { this.camMode = mode === 'iso' ? 'iso' : 'chase'; }

  /**
   * Phase-12 规格2：变道入口——体感（肩中点 X 偏移 → pose.onLane）与键盘 A/D/←/→ 两通道汇聚于此。
   * delta=±1；clampLane 钳制 → 边界车道不可越界；dinoX 在 update() 中平滑收敛（非瞬移）。
   */
  setTargetLane(delta) {
    if (this.state !== 'running') return;
    const nl = clampLane(this.lane + (delta > 0 ? 1 : delta < 0 ? -1 : 0));
    if (nl !== this.lane) {
      this.lane = nl;
      if (this.hooks.onLane) this.hooks.onLane(nl);
    }
  }

  // ===================== 每帧推进 =====================
  update(dt) {
    if (this.state === 'running') {
      // 速度-分数曲线：跳跃参数（JUMP_V0/GRAVITY）保持常量不受影响（验收 B）
      // Phase-14：基础曲线 × 减速乘子(SLOW_MUL=0.55) × 狂飙乘子(FRENZY_SPEED_MUL=1.2)——BASE/SPEED_GAIN/MAX_BONUS 曲线本体未动（红线）
      const mul = (this._chaseSt.slowT > 0 ? SLOW_MUL : 1) * (this._chaseSt.frenzyT > 0 ? FRENZY_SPEED_MUL : 1);
      this.speed = (BASE_SPEED + Math.min(this.distance * SPEED_GAIN, SPEED_MAX_BONUS)) * mul;
      this.distance += this.speed * dt;
      this.score = Math.max(0, Math.floor(this.distance) + this.bonusScore - this.penaltyScore);   // 金币 +50/枚 · 减速 -100/次 · clamp≥0
      this._spawnObstacles();
    } else if (this.state === 'crashed') {
      this.speed *= Math.exp(-3.5 * dt);                 // 撞击后世界快速减速
      this.crashT += dt;
      if (this.crashT > 1.15 && this.state === 'crashed') {
        this.state = 'over';
        if (this.score > this.hi) { this.hi = this.score; localStorage.setItem(HI_KEY, String(this.hi)); }
        if (this.hooks.onGameOver) this.hooks.onGameOver(this.score, this.hi);
      }
    }

    // Y 轴抛物线跳跃物理
    if (this.vy !== 0 || this.jumpY > 0) {
      this.vy -= GRAVITY * dt;
      this.jumpY += this.vy * dt;
      if (this.jumpY <= 0) {
        this.jumpY = 0; this.vy = 0;
        this._spawnShock(this.dinoX, 0);   // Phase-8 规格4：落地瞬间 → 冲击波（挂在现有单 rAF）
      }
    }

    // Phase-12 规格2c：三车道平滑横移——指数阻尼单向收敛（x += Δ·min(1,dt·K)，无过冲），到位贴齐车道中心
    const laneX = LANE_X[this.lane];
    const laneDx = laneX - this.dinoX;
    if (Math.abs(laneDx) < LANE_SNAP_EPS) this.dinoX = laneX;
    else this.dinoX += laneDx * Math.min(1, dt * LANE_LERP_K);

    // 障碍推进 / 回收 / 碰撞
    this._dinoBox.setFromCenterAndSize(
      this._tmpCenter.set(this.dinoX, this.jumpY + 1.05, 0),
      this._tmpSize.set(1.15, 1.9, 0.85)
    );
    for (const o of this.obstacles) {
      if (!o.userData.active) continue;
      const u = o.userData;
      o.position.z += this.speed * dt;                   // 恐龙沿 -Z 前进 ⇔ 障碍向 +Z 迎面而来
      if (o.position.z - u.d / 2 > KILL_Z) {             // Phase-13：按后缘（深坑远缘）判定，完全越过相机才回收
        u.active = false; o.visible = false;
        if (u.blob) u.blob.visible = false;              // 线索随障碍回收（深坑无 blob）
        continue;
      }
      if (u.blob) {
        // 距离线索一（规格2）：贴地光斑随距离缩放——越远越大越淡，提供纵深参照
        const dist = Math.max(0, -o.position.z);                      // 恐龙在 z=0，障碍前方 z<0
        const ratio = Math.min(1, dist / SHADOW_FADE_DIST);
        const blobScale = Math.max(u.w, u.d) * 0.75 * (1 + SHADOW_SCALE_K * ratio);
        u.blob.position.set(o.position.x, 0.02, o.position.z);
        u.blob.scale.set(blobScale, 1, blobScale);
        u.blob.material.opacity = SHADOW_OPACITY_MAX * (1 - 0.75 * ratio);
        u.blob.visible = true;
        // Phase-6 规格4：WARN_DIST 提示合并进圆环颜色——进入最后反应距离圆环变霓虹红（不再另设底边警告线）
        u.blob.material.color.setHex(o.position.z > -WARN_DIST ? RING_COLOR_NEAR : RING_COLOR_FAR);
      }
      // Phase-14：完美排判定——整排（同 rowId）越过恐龙平面 z>0.9 且该排区间内未发生碰撞/减速（dirtySinceRow）→ chase +CHASE_PERFECT(0.5)
      if (o.position.z > 0.9 && !u.passed) {
        u.passed = true;
        if (u.rowId > this.lastRowId) {
          this.lastRowId = u.rowId;
          if (!this.dirtySinceRow) this._chaseEv.perfectRows++;
          this.dirtySinceRow = false;
        }
      }
      if (this.state !== 'running') continue;
      if (u.kind === 'pit') {
        // Phase-13 规格3：深坑 = 平置区间检测 + Y 反转语义——障碍盒 z 区间与恐龙盒 z 区间重叠 且
        // jumpY ≤ PIT_EPS（贴地）→ 坠落失败；jumpY > PIT_EPS（滞空通过）= 安全。高度 0 语义，不做 AABB。
        const half = u.d * 0.5;
        if (o.position.z + half > -DINO_HALF_DEPTH && o.position.z - half < DINO_HALF_DEPTH && this.jumpY <= PIT_EPS) {
          this._crash('pit');
        }
      } else if (u.kind === 'slime' || u.kind === 'snow') {
        // Phase-14 规格②：减速块——AABB 同路障形制但非致命分支：接触一次性触发 _slow（同排多块只扣一次）；
        // 细雪薄板 SNOW_H=0.15：恐龙盒底 jumpY+0.1 ≥ 0.15 不相交 → 跳跃越过不触发（贴地踩上判定天然成立）
        this._obsBox.setFromCenterAndSize(
          this._tmpCenter.set(o.position.x, u.h / 2, o.position.z),
          this._tmpSize.set(u.w * 0.92, u.h * u.yFit, u.d * 0.92)
        );
        if (!u.triggered && this._dinoBox.intersectsBox(this._obsBox)) {
          u.triggered = true;
          this._slow(u.kind);
        }
      } else {
        // 规格1/2/③：路障（含组合 1~3 车道，命中任一=致命）与墙沿用 AABB _crash 链路；yFit——路障 0.94、墙 1.0（全高）
        this._obsBox.setFromCenterAndSize(
          this._tmpCenter.set(o.position.x, u.h / 2, o.position.z),
          this._tmpSize.set(u.w * 0.92, u.h * u.yFit, u.d * 0.92)
        );
        if (this._dinoBox.intersectsBox(this._obsBox)) this._crash('hit');
      }
    }

    // Phase-14 规格④：金币推进/自转/拾取（独立池循环，零分配；拾取 +COIN_SCORE(50) 分 +CHASE_COIN(0.8) 追逐距离 + 复用冲击波闪光）
    for (const c of this.coins) {
      const cu = c.userData;
      if (!cu.active) continue;
      c.position.z += this.speed * dt;
      if (this.coinSpin) c.rotation.y += dt * 3.4;             // L2 降级：关自转（拾取判定不关）
      if (c.position.z > KILL_Z) { cu.active = false; c.visible = false; continue; }
      if (this.state !== 'running' || cu.taken) continue;
      this._obsBox.setFromCenterAndSize(
        this._tmpCenter.set(c.position.x, cu.y, c.position.z),
        this._tmpSize.set(0.75, 0.75, 0.5)
      );
      if (this._dinoBox.intersectsBox(this._obsBox)) {
        cu.taken = true; cu.active = false; c.visible = false;
        this.bonusScore += COIN_SCORE;
        this._chaseEv.coins++;
        this._spawnShock(c.position.x, c.position.z);
      }
    }

    // Phase-14 规格①：chaseDistance 状态机（chaseStep 纯函数步进；事件计数消费后清零）→ 归零=怪物扑杀死亡路径 / 狂飙进出 / 减速倒计时
    if (this.state === 'running') {
      chaseStep(this._chaseSt, dt, this._chaseEv, Math.random);
      this._chaseEv.perfectRows = 0; this._chaseEv.coins = 0; this._chaseEv.slowEntered = false;
      this.chase = this._chaseSt.chase;
      if (this._chaseSt.dead) this._crash('monster');          // chase≤0 → 怪物扑杀（死亡瞬间扑击 0.6s 后照常弹结算）
    }
    this._updateMonster(dt);

    // Phase-14 规格④：狂飙 FOV(+9) 平滑过渡（updateProjectionMatrix）+ 红色危险暗角等级 + 冰霜倒计时
    const fovTarget = this._chaseSt.frenzyT > 0 ? FRENZY_FOV_BOOST : 0;
    const prevFov = this.fovBoost;
    this.fovBoost += (fovTarget - this.fovBoost) * Math.min(1, dt * 2.5);
    if (Math.abs(this.fovBoost - prevFov) > 0.01) {
      this.camera.fov = this._fovBase + this.fovBoost;
      this.camera.updateProjectionMatrix();
    }
    // Phase-15：非线性危险暗角——(1-chase/30)^1.5 常驻（怪物逼近的主提示通道：chase<6u → ≥0.72 显著 + main.js 红色脉冲）；
    // 狂飙保底 0.45、减速保底 0.55；怪物扑杀死亡瞬间全红=1（chase 真归零才 Game Over，判定链路不变），结算 over 归零。
    const cdAng = Math.max(0, Math.min(1, this._chaseSt.chase / CHASE_MAX));
    this.dangerLevel = this.state === 'over' ? 0
      : (this.state === 'crashed' && this.crashKind === 'monster') ? 1
      : Math.max(Math.pow(1 - cdAng, 1.5),
          this._chaseSt.frenzyT > 0 ? 0.45 : 0,
          this._chaseSt.slowT > 0 ? 0.55 : 0);
    if (this.frostT > 0) this.frostT = Math.max(0, this.frostT - dt);

    // 恐龙姿态：跑动摆腿 / 滞空前倾 / 撞击闪烁；Phase-13：深坑坠落 = 加速下沉 + 前倾翻转（可选增强项，失败结算照常触发）
    const sinking = this.state === 'crashed' && this.crashKind === 'pit';
    this.dino.position.set(this.dinoX, sinking ? -this.crashT * this.crashT * 9 : this.jumpY, 0);
    if (this.state === 'running' || this.state === 'crashed') {
      const grounded = this.jumpY <= 0.001;
      const swing = grounded ? Math.sin(this.distance * 2.2) * 0.65 : 0.35;
      this.legL.rotation.x = swing;
      this.legR.rotation.x = -swing;
      this.dino.rotation.x = grounded ? 0 : Math.min(0.3, this.vy * -0.02 + 0.12);
      this.dino.rotation.z = Math.max(-0.25, Math.min(0.25, (this.dinoX - laneX) * 0.12));   // Phase-12：向移动方向倾斜（横移中间态可视化）
      if (sinking) this.dino.rotation.x = Math.min(1.3, this.crashT * 2.6);                  // Phase-13：坠坑前倾
    }
    if (this.blinkT > 0) {
      this.blinkT -= dt;
      this.dino.visible = Math.floor(this.blinkT * 12) % 2 === 0;   // 闪烁
      if (this.blinkT <= 0) this.dino.visible = true;
    }

    this._updateTrail(dt);
    this._updateDebris(dt);        // 规格4：碎裂粒子推进
    this._updateShock(dt);         // Phase-8 规格4：落地冲击波推进（同一单 rAF）
    this._updateScenery(this.speed * dt);   // Phase-9 规格1：路侧景物无限循环回收（与障碍同 dz，挂同一单 rAF）
    this._updateCamera(dt);

    // 分数上报（10Hz 节流）
    this.scoreTimer += dt;
    if (this.scoreTimer >= 0.1 && this.hooks.onScore) {
      this.scoreTimer = 0;
      this.hooks.onScore(this.score, this.speed);
    }
  }

  _spawnObstacles() {
    if (this.distance < this.nextSpawnAt) return;
    // Phase-13 规格4 + Phase-14：pickObstaclePlan 纯函数决定本排 {type, lanes, len, count}——六类权重、狂飙倾斜(frenzy)、减速禁坑(slowed，红线c)
    const plan = pickObstaclePlan(Math.random, this.score, {
      frenzy: this._chaseSt.frenzyT > 0,
      slowed: this._chaseSt.slowT > 0,
    });
    const rowId = ++this.rowSeq;                               // Phase-14：行号记账（完美排判定）
    // 红线 a/b：planRowGap 纯函数——间距随速度增大（反应时间恒定）；坑排自身 ≥ PIT_BUFFER_GAP(30u)；组合路障(≥2车道)后接 slime/snow 额外 +COMBO_FOLLOW_GAP(8u) 落地缓冲
    const gap = planRowGap(Math.random, plan, this._lastPlan, this.speed);
    this.nextSpawnAt = this.distance + gap;
    this._lastPlan = plan;
    const rowZ = SPAWN_Z + Math.random() * 4;                  // 同排共 z（墙/组合多段对齐成一线）
    if (plan.type === 'pit') {
      this._spawnPit(plan.len, rowZ, rowId);                   // 规格3：横跨全路，不占单车道
    } else if (plan.type === 'wall') {
      for (const lane of plan.lanes) this._spawnWallSeg(LANE_X[lane], rowZ, rowId);   // 规格2：1~2 车道段，plan 保证 ≥1 畅通车道
    } else if (plan.type === 'slime') {
      for (const lane of plan.lanes) this._spawnSlime(LANE_X[lane] + (Math.random() * 2 - 1) * SPAWN_JITTER, rowZ, rowId);   // 规格②：1~2 车道非致命
    } else if (plan.type === 'snow') {
      for (const lane of plan.lanes) this._spawnSnow(LANE_X[lane] + (Math.random() * 2 - 1) * SPAWN_JITTER, rowZ, rowId);
    } else if (plan.type === 'coin') {
      this._spawnCoins(LANE_X[plan.lanes[0]], rowZ, plan.count, rowId);   // 规格④：单车道 3~5 枚 z 向弧线
    } else {
      // 规格1 + Phase-14 规格③：组合路障 1~3 车道（三车道全占=必须跳，apex 红线数学不变；命中任一=致命）
      for (const lane of plan.lanes) {
        this._spawnBarrier(LANE_X[lane] + (Math.random() * 2 - 1) * SPAWN_JITTER, rowZ, rowId);
      }
    }
  }

  /** @param {'hit'|'pit'|'monster'} kind 'hit'=撞路障/墙/组合（闪烁+震屏）| 'pit'=深坑坠落（下沉）| 'monster'=被怪物扑杀（扑击为主视觉） */
  _crash(kind = 'hit') {
    if (this.state !== 'running') return;
    this.state = 'crashed';
    this.crashKind = kind;                              // Phase-13/14：驱动 update() 坠坑下沉 / 怪物扑击分支
    this.crashT = 0;
    this.shakeT = 0.7;                                  // 屏幕震动
    this.blinkT = kind === 'hit' ? 1.0 : 0;             // 仅撞击闪烁（坠坑=下沉、怪物扑杀=扑击为主视觉）
    // 规格4：撞击 → 方块碎裂粒子爆发（替代 Phase-3 红色波纹 triggerRipple）
    this._burstDebris(this.dinoX, this.jumpY + 1.0, -0.7);
  }

  _updateTrail(dt) {
    // 发射：滞空时每帧 2 颗
    if (this.state === 'running' && this.isAirborne()) {
      for (let k = 0; k < 2; k++) {
        const i = this.trailIdx = (this.trailIdx + 1) % this.trailN;
        this.trailPos[i * 3]     = this.dinoX + (Math.random() - 0.5) * 0.7;
        this.trailPos[i * 3 + 1] = this.jumpY + 0.6 + Math.random() * 1.0;
        this.trailPos[i * 3 + 2] = 0.6 + Math.random() * 0.5;
        this.trailVel[i * 3]     = (Math.random() - 0.5) * 0.6;
        this.trailVel[i * 3 + 1] = -0.4 - Math.random() * 0.6;
        this.trailVel[i * 3 + 2] = this.speed * 0.12 + Math.random();
        this.trailLife[i] = 0.45 + Math.random() * 0.2;
      }
    }
    let dirty = false;
    for (let i = 0; i < this.trailN; i++) {
      if (this.trailLife[i] <= 0) continue;
      this.trailLife[i] -= dt;
      if (this.trailLife[i] <= 0) { this.trailPos[i * 3 + 1] = -999; dirty = true; continue; }
      this.trailPos[i * 3]     += this.trailVel[i * 3] * dt;
      this.trailPos[i * 3 + 1] += this.trailVel[i * 3 + 1] * dt;
      this.trailPos[i * 3 + 2] += this.trailVel[i * 3 + 2] * dt;
      dirty = true;
    }
    if (dirty) this.trail.geometry.attributes.position.needsUpdate = true;
  }

  _updateCamera(dt) {
    // Phase-4 高角度追尾（规格1）：相机 = 注视点 + 球面偏移（俯角 PITCH_DEG），阻尼跟随 + 撞击震动。
    // chase：正后上方，俯角 50° → 恐龙脚下与前方一段跑道同屏；iso：斜 45° 等距（yaw 30° 偏侧）。
    if (this.shakeT > 0) this.shakeT = Math.max(0, this.shakeT - dt);
    // Phase-14 规格④：狂飙期轻微持续震屏（FRENZY_SHAKE=0.13）叠加在撞击震动之上
    const shake = (this.shakeT > 0 ? this.shakeT / 0.7 : 0) + (this._chaseSt.frenzyT > 0 ? FRENZY_SHAKE : 0);
    const cam = this.camera;
    const iso = this.camMode === 'iso';
    const pitch = (iso ? ISO_PITCH_DEG : CAM_PITCH_DEG) * Math.PI / 180;
    const yaw = (iso ? ISO_YAW_DEG : 0) * Math.PI / 180;
    const dist = iso ? ISO_DIST : CAM_DIST;
    // 注视点：恐龙脚下略前方（CAM_LOOK_AHEAD），保证脚下 + 前方跑道同屏
    const lx = this.dinoX * 0.6;
    const ly = 0.9 + this.jumpY * 0.4;
    const lz = -CAM_LOOK_AHEAD;
    // 球面坐标：x = D·cos(pitch)·sin(yaw)，y = D·sin(pitch)，z = D·cos(pitch)·cos(yaw)
    const tx = lx + dist * Math.cos(pitch) * Math.sin(yaw) + (Math.random() - 0.5) * 0.9 * shake;
    const ty = ly + dist * Math.sin(pitch) + (Math.random() - 0.5) * 0.7 * shake;
    const tz = lz + dist * Math.cos(pitch) * Math.cos(yaw) + (Math.random() - 0.5) * 0.5 * shake;
    const damp = Math.min(1, dt * 5);
    cam.position.x += (tx - cam.position.x) * damp;
    cam.position.y += (ty - cam.position.y) * damp;
    cam.position.z += (tz - cam.position.z) * damp;
    cam.lookAt(lx, ly, lz);
    // 路面纹理滚动 + 暖虚线/冷刻度线随距离取模滚动（同一 rAF 内同步，规格3；路侧景物为 Phase-9 回收池）
    this.roadTex.offset.y = this.distance / 4;         // 一格纹理 ≈ 4u
    this.flowTex.offset.y = this.distance * FLOW_UV_K; // Phase-8 规格1：流光 UV 滚动=距离×K（速度天然联动、取模无漂移）
    this.dashes.position.z = this.distance % DASH_SPACING;
    this.ticks.position.z = this.distance % TICK_SPACING;
    // Phase-9：路侧景物不再用 group 取模滚动——改为逐实例回收池（见 _updateScenery）
  }

  /**
   * Phase-10：画质档全量重算（幂等、可任意方向调用，含 0）——与 scene3d.applyQuality(level) 配对。
   * L0 = 树可见 / 灯头 24（基线）/ 障碍线框可见 / 流光可见 / 冲击波开 / 景物可见 / 霓虹边线可见（全恢复）
   * L1 = 树隐藏 + 灯头减半（基于 baseLampCount=POLE_N 重算，禁止连除）+ 障碍线框关 + 流光关 + 冲击波关；
   *      路侧景物（建筑/灯杆）与霓虹边线保持可见
   * L2 = 同 L1（不再新增剥离——签名视觉全程保留）
   * L3 = 在 L1 基础上 + 路侧景物关 + 霓虹边线关（旧 L2 行为，真正的保底档）
   * 跑道、车道分割线（Phase-12 玩法辅助）、障碍碰撞体与恐龙本体任何级别都不削减。
   * Phase-13：三类障碍本体（路障/墙/深坑虚空板 + 纹理内烘焙的锯齿发光警示条）任何降级档位全部保留
   * （玩法可见性优先）；唯一装饰性削减 = L1+ 隐藏障碍亮白线框（edge）。警示条/发光斑块烘焙在程序化
   * 纹理（非实例），不占实例数、不参与削减 → 降级链零破坏。
   * @returns {string} 当前档位说明
   */
  /**
   * Phase-14 规格① / Phase-15《神庙逃亡》式调参：chaseDistance → 视觉地面距离/scale 线性映射 + 指数平滑（MONSTER_VIS_RATE=2/s，
   * instant -6 等数值跳变在视觉上是快速但平滑地扑近，无瞬移）；自恐龙向相机地面投影方向偏移 r∈[1.3,1.7] 定位 + 下沉（M_SINK/M_SINK_ISO）——
   * 追尾/iso 两相机全 chase 区间恒只在屏幕最下缘露头/半身，绝不遮挡恐龙本体与前方障碍（几何自证 tests/monster_framing.mjs）。
   * running 狂奔上下浮动（monsterBob，L2 降级关）；怪物扑杀死亡瞬间 crashT≤LUNGE_DUR(0.6s) 扑击（浮出+压向恐龙+跃起+前倾+快速放大，屏幕全红），之后随 1.15s 原链路弹结算。
   */
  _updateMonster(dt) {
    const m = this.monster;
    if (this.state === 'idle' || this.state === 'over') { m.visible = false; return; }
    m.visible = true;
    const k = Math.max(0, Math.min(1, this._chaseSt.chase / CHASE_MAX));   // 0=扑到脸上 1=最远
    const tz = MONSTER_Z_NEAR + (MONSTER_Z_FAR - MONSTER_Z_NEAR) * k;      // 目标地面距离（chase→0=NEAR）
    const ts = M_SCALE_NEAR + (M_SCALE_FAR - M_SCALE_NEAR) * k;            // 目标缩放
    // Phase-15：视觉指数平滑（τ=0.5s）——instant -6 数值瞬间跳、视觉快速但平滑扑近（≥10 帧过渡，无瞬移）
    const a = 1 - Math.exp(-dt * MONSTER_VIS_RATE);
    this.monsterVisZ += (tz - this.monsterVisZ) * a;
    this.monsterVisScale += (ts - this.monsterVisScale) * a;
    const iso = this.camMode === 'iso';
    let r = this.monsterVisZ * (iso ? M_ISO_R_MUL : 1);        // 地面距离（自恐龙向相机地面投影方向偏移）
    let s = this.monsterVisScale * (iso ? M_ISO_SCALE_MUL : 1);
    const sink = (iso ? M_SINK_ISO : M_SINK) * s;              // 下沉：屏幕下缘只露头/半身，沉入部分被地面深度遮挡
    let y = -sink;
    let rotX = 0;
    if (this.state === 'running') {
      this.monsterBobT += dt * 9;
      if (this.monsterBob) y += Math.abs(Math.sin(this.monsterBobT)) * 0.22 * s;   // 狂奔上下浮动（随缩放）
    } else if (this.state === 'crashed' && this.crashKind === 'monster') {
      const kk = Math.min(1, this.crashT / LUNGE_DUR);                        // 扑击动画 0.6s（仅怪物扑杀时；其余死法怪物保持视觉位不抢戏）
      r += (0.35 - r) * kk;                                                   // 压向恐龙
      y = -sink * (1 - kk) + Math.sin(kk * Math.PI) * 1.8;                    // 浮出地面 + 跃起
      s *= 1 + 2.0 * kk * kk;                                                 // 快速放大（小体型怪物的扑击存在感；此刻屏幕已全红）
      rotX = -0.35 * kk * kk;
    }
    // Phase-15：位置 = 恐龙向相机地面投影方向偏移 r——追尾/iso 两相机下恒压屏幕最下缘、绝不遮挡恐龙本体（几何自证 tests/monster_framing.mjs）
    const dx = this.camera.position.x - this.dinoX;
    const dz = this.camera.position.z;
    const hd = Math.max(0.001, Math.sqrt(dx * dx + dz * dz));
    m.position.set(this.dinoX + dx * (r / hd), y, dz * (r / hd));
    m.scale.set(s, s, s);
    m.rotation.x = rotX;
  }

  /**
   * Phase-14 规格②：进入减速态（粘液块/细雪块触发，非致命）——扣 SLOW_SCORE_PENALTY(100) 分（总分 clamp≥0 见 update）、
   * 速度 ×SLOW_MUL(0.55) 持续 SLOW_DUR(2s)（乘子在 update、计时在 chaseStep.slowT）、chase instant -6 且减速期额外 -2/s、
   * 红色危险暗角（dangerLevel=0.55）；细雪另加屏幕边缘冰霜（frostT=2s，main.js 读取）。
   */
  _slow(kind) {
    if (this.state !== 'running') return;
    this.penaltyScore += SLOW_SCORE_PENALTY;
    this._chaseEv.slowEntered = true;              // chaseStep 下一帧消费：instant -6 + slowT=2
    this.dirtySinceRow = true;                     // 本排不再计『完美排』
    this.frostT = kind === 'snow' ? SLOW_DUR : 0;
    this.shakeT = Math.max(this.shakeT, 0.25);     // 轻震屏反馈
  }

  degradeScenery(level) {
    level = Math.max(0, Math.min(3, level | 0));
    const light = level >= 1;                                        // L1/L2/L3 共用的轻度剥离
    this.sceneryFoliage.visible = !light;                            // 树：L1+ 隐藏
    this.sceneryLamps.count = light ? Math.floor(this.baseLampCount / 2) : this.baseLampCount;   // 灯头：从基线 24 重算
    for (const o of this.obstacles) o.userData.edge.visible = !light;      // Phase-6：障碍发光线框
    this.flowStrips.visible = !light;                                // Phase-8：流光带
    this.shockEnabled = !light;                                      // Phase-8：落地冲击波（已发射的自然播完回收）
    this.scenery.visible = level < 3;                                // 路侧建筑/灯杆：仅 L3 关
    this.edgeLines.visible = level < 3;                              // Phase-8：霓虹边界线：仅 L3 关
    this.monsterBob = level < 2;                                     // Phase-14：L2+ 关怪物浮动（怪物本体全档位保留=玩法可见性优先）
    this.coinSpin = level < 2;                                       // Phase-14：L2+ 关金币自转（拾取判定保留）
    return ['路侧景物完整（树/灯头24/障碍线框/流光/冲击波/霓虹边线/怪物浮动/金币自转全恢复）',
            '树隐藏 + 灯头减半 + 障碍线框关 + 流光/冲击波关（景物与霓虹边线保留）',
            '同 L1 + 怪物浮动关 + 金币自转关（碰撞/拾取判定不受影响）',
            '路侧景物关 + 霓虹边线关（在 L2 基础上）'][level];
  }
}
