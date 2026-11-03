# 简历项目描述 · 体感小恐龙 DINO MOTION

> 用法：按目标岗位挑一个版本；`[[方括号]]` 是需你按实情替换的占位（实习/工作年限、投递岗位名）。
> 项目经过真实代码核对，文中数字均可在仓库内验证（见文末「数据来源」）。

---

## 一句话版本（社交 / 口头介绍）

**用 3000+ 行原生 JavaScript 做了一款「对着摄像头做动作就能玩」的 3D 跑酷小恐龙**：MediaPipe 姿态识别驱动跳跃与变道，Three.js 搭建暮色微缩场景，全程无构建、可离线运行。

---

## 简历正文（STAR，中文）

**体感 3D 跑酷小恐龙 `DINO MOTION`** ｜ 独立开发 ｜ Three.js + MediaPipe + Canvas ｜ 2025

- **项目背景**：经典 Chrome 恐龙小游戏（按键跳跃）玩法单一、门槛低，无法作为技术深度展示。将其重构为**体感 3D 跑酷**：用摄像头识别玩家站立/跳跃/左右倾身，替代键盘，并把 2D 像素风升级为 Three.js 暮色微缩世界。
- **我的工作**：
  - **体感输入链路**：接入 MediaPipe PoseLandmarker，设计**头部 Y 位移 + 上升速度双门控**的跳跃判定（`h > 阈值 0.06` 且 `v > 0.55/s`），并加入**2 秒校准基线 + 慢 EMA 漂移补偿 + 冷却重武装**，彻底解决久坐下滑误触发和「连击误判（一次起身跳 21 次）」问题，完全支持坐姿/半身入镜。
  - **体感变道**：以肩中点 X 偏移为信号，设计**死区 0.05 + 滞回 0.025 + 冷却 350ms** 三重防抖，实现左右倾身变道；与键盘 A/D 汇聚同一入口。
  - **3D 渲染与场景**：Three.js 搭建暮色天空、程序化星空/沥青/窗户纹理（零外部贴图）、110 栋微缩天际线、InstancedMesh 无限循环街景与体素恐龙（约 90 立方体 4 个 InstancedMesh）、Bokeh 移轴景深 + Bloom 辉光后处理；**单 requestAnimationFrame 驱动全部渲染**。
  - **玩法系统**：三车道六类障碍（岩浆路障/黑曜石墙/虚空深坑/粘液块/细雪块/金币）由**纯函数生成器加权随机**；加入**怪物追逐 + 狂飙期**状态机（chaseDistance 归零即被扑杀 = 第二条死亡路径）。
  - **难度与平衡（工程化红线）**：用**跳跃抛物线数学**约束障碍高度与深坑长度，用种子采样测试验证「没有生不出的必死排」；建立**双向可恢复的 FPS 自适应画质档（L0–L3）**，低帧自动降级、高帧自动升回。
- **成果 / 亮点**：
  - 纯前端**零构建、零 CDN、可完全离线**运行；手写 7 个 JS 模块共 **约 3,000 行**，配套 3 个纯函数自验脚本、共 **37 项断言全部通过**。
  - 拆出并单测了**纯函数游戏规则内核**（障碍生成 / 排间距 / 追逐状态机），使玩法平衡可被无头环境自动验证，而非只能肉眼调试。
  - 体感识别支持**半身 / 坐姿**，把「必须全身站远」的体验门槛大幅降低。

**技术栈**：JavaScript (ESModules) · Three.js (WebGL / 后处理) · MediaPipe Tasks-Vision · Canvas 2D · Node.js（零依赖静态服务与测试脚本）

---

## 简历正文（英文版）

**Motion-Controlled 3D Endless Runner — "DINO MOTION"** | Solo project | Three.js + MediaPipe | 2025

- Rebuilt the classic Chrome dino game into a **webcam-driven 3D endless runner**: pose estimation lets you jump and switch lanes by moving your body, rendered in a dusk-styled Three.js miniature world.
- **Pose input**: MediaPipe PoseLandmarker with a dual-gated jump detector (**head-Y displacement + upward velocity**), 2-second calibration baseline, slow-EMA drift compensation, and cooldown re-arming — fully playable **seated / upper-body-only**, fixing false double-triggers.
- **Lane switching**: shoulder-midpoint X offset with **dead-zone + hysteresis + cooldown** debounce; merged with keyboard input into one entry point.
- **Rendering**: procedural sky/asphalt/window textures (**zero external images**), instanced voxel dino & infinite recycled scenery, Bokeh tilt-shift DOF + Bloom, single rAF loop.
- **Gameplay**: three-lane, six obstacle types from a **pure-function weighted generator**; a **monster-chase + frenzy** state machine as a second death path.
- **Balance by math, not vibes**: jump-parabola constraints on obstacle heights / pit lengths, validated by **seed-sampled tests proving no "unwinnable" spawn row**; a **bi-directional, self-recovering FPS quality tier (L0–L3)**.
- **Result**: zero-build / zero-CDN / fully-offline front end; **~3,000 hand-written JS lines** across 7 modules, **37 passing assertions** across 3 pure-function test scripts.

---

## 30 秒自我陈述（面试开场）

> 我做了一个体感 3D 跑酷小恐龙。核心难点是**把「人」变成可靠的游戏输入**：摄像头信号很抖，我用头部位移加速度双门控做跳跃、用肩部横移加三重防抖做变道，还专门解决了久坐姿势下滑导致的误触发。玩法这边我把障碍生成、追逐状态机都写成了**纯函数**，这样跳跃可达、坑长、排间距这些平衡红线可以**用数学和种子测试自动验证**，而不是靠手动试。整个项目零构建、可离线，我把它当一次「前端性能 + 交互 + 游戏性」的综合练手。

---

## 常见追问 & 答案（提前背熟）

**Q：为什么零构建、不用打包工具？**
A：项目目标是「双击即玩、可离线、易部署到任意静态托管」。用浏览器原生 ESM + importmap 直接加载本地 vendor 依赖（Three.js / MediaPipe），省掉构建链和 CDN 依赖。代价是引入了 importmap 必须带前导 `/` 的坑（写成 `vendor/...` 会被当成裸模块报 `Failed to resolve module specifier "three"`），已在 README 记录。

**Q：体感识别信号抖，你怎么保证手感？**
A：四层：① 信号源选**头部 Y**而不是髋部，对点头/低头更稳、半身可用；② **速度门控**区分「快速起身（>1/s）」和「慢速后靠漂移（<0.3/s）」；③ **校准基线 + 慢 EMA** 补偿久坐下滑；④ **冷却 + 回基线重武装**，杜绝连击。阈值和冷却都做了 UI 滑块可实时调。

**Q：怎么保证障碍不会生成「必死排」？**
A：把生成逻辑写成**纯函数** `pickObstaclePlan`（rng 可注入），再写种子采样测试跑 4000 排验证：① 深坑长度上限 ≤ 最慢速度下的满跳距离×安全系数（落地余量 ≥4.57u）；② 黑曜石墙高 ≥ 跳跃最高点 + 恐龙身高（永不翻越）；③ 墙/组合路障**恒留至少一条畅通车道**；④ 减速态禁止生成深坑。这些是「红线」，测试一跑就知道有没有被破坏。

**Q：性能怎么优化？**
A：InstancedMesh 把上百栋建筑/几十体素/大量装饰压成个位数 draw call；纹理全程序化生成（零图片请求）；对象池复用障碍/金币/粒子，热路径零 new；**FPS 自适应画质档**：低于 24fps 持续 5 秒降一级，高于 42fps 持续 4 秒升回，且任何档位都保留「障碍本身 + 恐龙 + Bloom 辉光」这些签名视觉。

**Q：最大的技术难点是什么？**
A：两件。一是**输入信噪比**——把不可靠的人体信号变成可靠的二元游戏事件；二是**可验证的游戏平衡**——用纯函数 + 采样测试把「手感」的一部分变成可断言的数学红线。

---

## 数据来源（可复核，避免面试被追问翻车）

| 指标 | 数值 | 来源 |
|---|---|---|
| 手写 JS 模块行数（7 个） | 352+184+1664+253+366+493+73 = **3,385 行** | 逐文件 `Measure-Object -Line`；显式导出 94 个（runner3d 79 / pose 9 / scene3d 3 / perf 1 / introFlow 2） |
| CSS 行数 | 451 | `css/style.css` |
| 测试脚本 | 3 个，**37 项断言全 PASS** | `node scripts/run-tests.mjs`：chase 20 + sample 17 + framing（网格+平滑全 PASS） |
| 障碍类型 | 6 类（barrier/wall/pit/slime/snow/coin） | `PLAN_WEIGHTS`，权重合计=1 |
| 开发阶段 | Phase 2–15 共 14 个迭代 | 源码内 `Phase-N` 注释统计 |
| 第三方依赖 | 已本地化 566 文件 / 46.7MB | `vendor/`（three 556 / mediapipe 5 + models 1 + fonts 4） |

> ⚠️ 注意「3,385 行」是**手写模块**，不含 `vendor/` 第三方库。面试说「约 3000 行手写代码」是准确且保守的表述。

---

## 换岗适配建议

- **前端 / Web 开发**：突出「零构建工程化、importmap、模块拆分、性能档、可离线部署」，弱化 AI 部分。
- **图形 / WebGL**：突出 Three.js 后处理（Bloom/Bokeh/ACES）、InstancedMesh、程序化纹理、无限循环场景、draw call 控制。
- **AI / 感知应用**：突出 MediaPipe 姿态、信号滤波（双门控 + EMA + 滞回）、人机交互鲁棒性。
- **游戏 / 玩法**：突出纯函数生成器、平衡红线数学、状态机、对象池、可自动验证的玩法内核。

---

## 还差什么（让它更「能打」）

> ✅ 已完成（2026-11）：**在线 Demo 部署手册**（[docs/DEPLOY-GITHUB-PAGES.md](docs/DEPLOY-GITHUB-PAGES.md)）、**实机演示 GIF**（`assets/demo/dino-motion-demo.gif`，760×475 / 8 秒 / 6 MB，已接入 README 顶部）、高分辨率截图（`docs/preview-*.png`）。剩下的只差你填 GitHub 用户名并推送。

按投入产出排序，仍可选补：

1. **真正把 Pages 打开**（10 分钟）：按手册走一遍，把生成的链接填进简历与 README 占位。
2. **一件式可运行仓库**：GitHub Actions 跑 `npm test`、README 顶部放构建徽章；`vendor/` 是否入库按团队习惯取舍（入库=可离线，忽略=仓库更小）。
3. **可视化数值面板**（可选）：把 chase / speed / 当前障碍权重实时打到 debug 层，面试可现场演示「测试与运行时一致」。
