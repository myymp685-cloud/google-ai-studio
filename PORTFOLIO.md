# DINO MOTION — 简历项目包装包

本目录是把「体感小恐龙」这个游戏包装成**可写进简历、可在技术面展开**的项目材料。

## 文件清单

| 文件 | 用途 |
|---|---|
| `RESUME.md` | 核心交付物：中/英文简历描述、30 秒自述、常见追问与答案、数据来源、换岗适配建议 |
| `package.json` | 项目元信息 + `npm start` / `npm test` 入口 |
| `scripts/serve.mjs` | 零依赖本地静态服务器（摄像头需 localhost/HTTPS），已做目录穿越防护 |
| `scripts/run-tests.mjs` | 测试跑手：逐个执行 `tests/*.mjs` 并聚合退出码 |
| `README.md` | 项目原有完整技术文档（Phase 2–15），顶部已接入实机演示 GIF |
| `docs/DEPLOY-GITHUB-PAGES.md` | GitHub Pages 部署步骤 + 自检清单 + 常见问题（照着做即可上线） |
| `docs/preview-3d.png` / `preview-2d.png` / `preview-loading.png` | 实机截图（3D 等距视角 / 2D 兜底模式 / 加载页） |
| `assets/demo/dino-motion-demo.gif` | 8 秒实机跑动动图，README 顶部直接展示 |
| `scripts/capture-shots.mjs` | 无头 Chromium（CDP）实跑截图 + 录制 screencast 原始帧的脚本 |
| `scripts/measure.mjs` | 无依赖指标采集：首屏传输体积 / DCL / load / rAF 帧率 / WebGL 渲染器（`node scripts/measure.mjs <url>`） |

## 项目速览（可直接粘进求职平台）

> **体感 3D 跑酷小恐龙 DINO MOTION** — 摄像头姿态驱动、纯前端零构建
> 技术栈：原生 JS（ES Modules + importmap）· Three.js r160（WebGL2）· MediaPipe Tasks-Vision PoseLandmarker（+WASM）· Canvas 2D 程序化纹理
> 规模：7 模块 3,639 行，业务代码 gzip 后 75 KB，37 项断言全绿
> 实测：首屏 30 请求全同源、零 CDN，gzip 传输 8.5 MB / load 2.1 s；单帧渲染 7 ms；输入→跳跃 ≤1 帧（≈16 ms）
> 在线 Demo：<https://myymp685-cloud.github.io/google-ai-studio/> · 源码：<https://github.com/myymp685-cloud/google-ai-studio>

## 快速验证（面试现场可演示）

```bash
cd dino-motion
npm start        # 打开 http://localhost:8000 ，允许摄像头
npm test         # 3 个纯函数自验脚本，37 项断言，应全部 PASS
```

> 无需 `npm install`——零依赖。

## 推荐用法

1. 先看 `RESUME.md` 的「一句话版本」定调，再按目标岗位选「中文 / 英文」正文。
2. 把 `[[方括号]]` 占位替换成你的真实信息（年限、岗位名）。
3. 按「还差什么」补 **在线 Demo + GIF**——这是投入产出最高的一步。
4. 面试前过一遍「常见追问 & 答案」，数字都能在本文档「数据来源」表里复核。
