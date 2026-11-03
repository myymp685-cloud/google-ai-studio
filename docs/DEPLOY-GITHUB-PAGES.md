# 部署到 GitHub Pages（在线 Demo）

目标：把 `dino-motion/` 变成一个**可点开的在线 Demo**，简历里直接放链接。
本项目的结构已经**天然适配 Pages 子路径**，不需要改任何代码。

---

## 0. 为什么能直接上 Pages（先确认这三点）

| 检查项 | 结论 |
|---|---|
| 是否依赖构建（webpack/vite） | 否，纯静态 `index.html` + 原生 ES Module |
| 是否用了以 `/` 开头的绝对路径 | 否，全部是 `./js/…`、`./vendor/…` 相对路径（已用 `grep` 全量核对） |
| 第三方库怎么来 | 本地 `vendor/` 自带 Three.js、MediaPipe WASM、姿态模型、字体，**无 CDN** |

所以站点挂在 `https://<用户名>.github.io/dino-motion/` 这种**二级子路径**下也能正常加载。

---

## 1. 前置准备

- 一个 GitHub 账号。
- Git（`git --version` 能输出版本即可）。
- 确认 `vendor/` 完整（约 46.7 MB，566 个文件）。缺了就先跑一次 `下载本地依赖.bat` / `download-vendor.ps1`。

> ⚠️ **不要提交**这两个本地工具：`cloudflared.exe`（54 MB）、`cpolar_amd64.msi`（8 MB）。
> 它们只用于本机临时内网穿透，已经在 `.gitignore` 里被忽略。

---

## 2. 建仓库并推送

### 方式 A：命令行（推荐，最省事）

```bash
# 在 dino-motion 目录内执行
git init
git add .
git commit -m "feat: 体感 3D 跑酷小恐龙 DINO MOTION（纯前端零构建）"

# 用 gh 建远程仓库（没装 gh 就用方式 B）
gh repo create dino-motion --public --source=. --remote=origin --push
```

### 方式 B：网页建仓库 + 手动 push

1. GitHub → **New repository** → 名称填 `dino-motion` → **Public** → 不要勾选任何初始化文件（README/gitignore 都不要，本地已有）→ Create。
2. 复制仓库地址，然后：

```bash
git remote add origin https://github.com/<你的用户名>/dino-motion.git
git branch -M main
git push -u origin main
```

> 仓库必须 **Public**，否则 Pages 需要付费账号才能对外访问。
> 仓库名 `dino-motion` 会决定访问路径，最后 URL 是 `https://<用户名>.github.io/dino-motion/`。

---

## 3. 打开 Pages

1. 仓库 → **Settings** → 左侧 **Pages**。
2. **Build and deployment**
   - Source：**Deploy from a branch**
   - Branch：**main**，目录选 **`/ (root)`** → **Save**
3. 等 1～2 分钟，页面顶部会出现
   `Your site is live at https://<用户名>.github.io/dino-motion/`
4. 首次部署可能再等 1～3 分钟（GitHub 侧构建排队）。之后每次 `git push` 到 `main` 会自动重新发布。

> 另：根目录已放一个空的 `.nojekyll` 文件，用来**跳过 Jekyll 处理**——
> 否则 `vendor/` 下带下划线开头的文件/目录会被 Jekyll 静默剔除，导致 WASM 或模型 404。

---

## 4. 部署后自检清单（务必逐条过）

打开 `https://<用户名>.github.io/dino-motion/`，按顺序确认：

- [ ] 开场加载环能走到 **100%**（说明 Three.js、字体、WASM 都从正确的相对路径取到了）。
- [ ] 出现「DINO JUMP」标题，点「跳过摄像头」能进入 3D 跑酷。
- [ ] 浏览器控制台 **没有 404**（F12 → Console）。若 `vendor/...` 报 404，检查 `.nojekyll` 是否已提交、大小写是否与仓库一致。
- [ ] **体感功能**：点「校准」后浏览器弹出摄像头授权 → 说明 HTTPS 生效（Pages 默认就是 HTTPS，这是体感能用的前提；`file://` 打开是拿不到摄像头的）。
- [ ] 键盘空格能跳、A/D 能变道；左下角切「2D 模式」正常。
- [ ] 手机浏览器打开也不白屏（移动端默认关景深，性能会好一截）。

---

## 5. 让 README 直接显示动图

README 顶部已经引用：

```markdown
![DINO MOTION 实机演示](assets/demo/dino-motion-demo.gif)
```

GitHub 对 README 内图片的硬上限是 **10 MB**，本 GIF 约 **6 MB / 760×475 / 8 秒**，可以直接渲染。
如果以后想更小：

```bash
# 需要 ffmpeg。本机用 npm 临时装过 ffmpeg-static（不写入 package.json）：
npm i ffmpeg-static --no-save
node -e "console.log(require('ffmpeg-static'))"   # 打印 exe 路径
# 再用该 exe 重新生成，例如把 fps 调低、宽度调小：
# <exe> -framerate 6 -i frames/f%04d.png -vf "scale=640:-1,palettegen=max_colors=80" palette.png
```

---

## 6. 常见问题

| 现象 | 原因 / 解法 |
|---|---|
| 页面 404 | Pages 还没构建完，或分支/目录选错（必须是 `main` + `/ (root)`）。等 1～3 分钟再刷新。 |
| 白屏 + 控制台 `Failed to load module script` / importmap 报错 | 通常是有文件提交漏了（`vendor/three/three.module.js` 不在）。`git ls-files vendor | Measure-Object` 核对文件数应约 566。 |
| `three/addons/...` 404 | importmap 里的 `three/addons/` 映射到 `./vendor/three/jsm/`，确认该目录已提交。 |
| 摄像头按钮无反应 | 不是 HTTPS，或用户在地址栏拒绝了权限；点地址栏左侧图标重新允许。 |
| 体感不动 | 姿态模型 `.task` 加载失败（看 Network 是否 200）。模型在 `vendor/` 内，与 CDN 无关。 |
| 想换成自定义域名 | Settings → Pages → Custom domain，注意同步 DNS 的 CNAME 记录。 |

---

## 7. 可选：用 GitHub Actions 发布（进阶）

如果以后把源码拆成需要构建的形态，可改用
**Settings → Pages → Source = GitHub Actions**，用官方 `actions/configure-pages` + `actions/upload-pages-artifact` + `actions/deploy-pages` 三步流水线。
当前纯静态站点**不需要**这么做，Branch 方式更简单、更快。

---

## 8. 完成后写进简历的形态

> **体感小恐龙 DINO MOTION** — 纯前端体感 3D 跑酷
> 🎮 在线试玩：https://<用户名>.github.io/dino-motion/
> 💻 源码：https://github.com/<用户名>/dino-motion

一句话：「MediaPipe 姿态识别驱动 Three.js 三人称跑酷，零构建、零 CDN、可离线，手写约 3,400 行 JS。」
