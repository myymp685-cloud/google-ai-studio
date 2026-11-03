// js/scene3d.js
// Phase-5 视觉重构：微缩模型/写实混合风格的 3D 氛围层 ——
//   深蓝暮色天空渐变（#0a1128→#1c2b59，程序化 Canvas 纹理，规格1/10）、ACESFilmicToneMapping（规格1）、
//   暖橙主光源 DirectionalLight + 柔和阴影（规格1）、冷暖强对比、PBR 环境反射（天空渐变 → PMREM）、
//   远景方块云（InstancedMesh，规格5/8）、微缩体素城市天际线（InstancedMesh + 程序化窗户发光贴图，规格5/10）、
//   暖冷双色漂浮粒子场（保留 uRipple 波纹 / uGather 开场聚合）、FogExp2 淡雾、
//   BokehPass 移轴景深（规格6，UI 可关，规格9）+ 低强度 UnrealBloomPass（threshold 0.85 → 只拾取高亮自发光体，规格6）+ OutputPass。
// 降级链新顺序（规格9/边界）：① 关景深 → ② 减远景实例（粒子/云/天际线）→ ③ 最后关 Bloom；跑道与恐龙本体绝不削减。
// 容器 CSS 为 pointer-events:none，本层绝不拦截游戏输入。

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// 移动端（窄屏/触摸）自动降低粒子/云/天际线密度，且默认关景深、关阴影、降辉光（规格9/13）
export const IS_MOBILE = window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 760;
const PARTICLE_COUNT = IS_MOBILE ? 1200 : 4000;
const CLOUD_CLUSTERS = IS_MOBILE ? 5 : 11;    // 方块云簇数（每簇 CLOUD_BOXES 个实例）
const CLOUD_BOXES = 7;
const SKYLINE_COUNT = IS_MOBILE ? 48 : 110;   // 远景天际线楼块实例数
const BLOOM_STRENGTH = IS_MOBILE ? 0.35 : 0.45;  // Phase-7 规格5：曝光提高后回调强度，防高光过曝（Phase-6 发光体仍出晕）
const BLOOM_THRESHOLD = IS_MOBILE ? 0.75 : 0.7;  // 障碍 emissive 线性亮度 0.81/1.10 仍超阈值 → Phase-6 醒目度不回退；提亮的受光面(<0.7)不泛白
const CAM_Z_BASE = 26;
// BokehPass 移轴景深（规格6）：对焦带在恐龙/跑道平面，近远景柔化 → 桌面微缩玩具感
const DOF_DEFAULT = !IS_MOBILE;    // 规格9：移动端默认关，桌面默认开；左下角模式条可一键切换
const DOF_FOCUS_PLAY = 13.5;       // 3D 跑酷：相机距恐龙 ≈13u → 对焦带
const DOF_FOCUS_INTRO = 26;        // 开场/2D：相机 z=26 看向原点
const DOF_APERTURE = 0.0016;
const DOF_MAXBLUR = 0.0085;
// 天空/雾颜色（规格1；Phase-7 根因修复：原两色在 ACES 线性域亮度仅 0.4%~3%，肉眼≈纯黑 →
// 保留指定锚色的同时补中段与地平线亮带 + 星空，并让雾色贴近地平线色使远景自然融入而非硬切断）
const SKY_TOP = '#0a1128';       // 天顶（指定锚色）
const SKY_MID = '#16234d';       // 中段过渡（Phase-7 新增，避免渐变过窄）
const SKY_BOTTOM = '#1c2b59';    // 指定锚色
const SKY_HORIZON = '#31457c';   // 地平线亮带（Phase-7：暮色余晖，空间层次锚点）
const FOG_COLOR = 0x1c2b59;      // Phase-9 规格2：= SKY_BOTTOM 地平线锚色（天空渐变中下段）——远景物隐入夜空同色；旧 0x22345f 偏暗被用户视为「黑洞」
const FOG_DENSITY = 0.0055;      // Phase-9 规格2：0.0068 → 0.0055 再降一档（50% 雾深 121→136u、90% 雾深 217→245u），与景物回收带 [-240,20] 衔接无硬切断

const PARTICLE_VERT = /* glsl */`
  uniform float uTime;
  uniform float uRipple;          // 最近一次跳跃的时刻（秒）；<0 表示无波纹
  uniform float uGather;          // 1=粒子向中心聚合（加载/校准态），0=正常散布（游戏背景）
  attribute float aRand;
  varying float vRand;
  varying float vRippleGlow;
  void main() {
    vRand = aRand;
    vRippleGlow = 0.0;
    // 开场聚合：uGather=1 时所有粒子收拢到中心 8% 半径内
    vec3 pos = position * (1.0 - 0.92 * uGather);
    // 缓慢漂移
    pos.y += sin(uTime * 0.2 + aRand * 6.2831) * 0.6;
    pos.x += cos(uTime * 0.15 + aRand * 6.2831) * 0.6;
    // 跳跃波纹：从原点向外扩散的位移脉冲（波前半径 = t*14，高斯包络 + 时间衰减）
    float t = uTime - uRipple;
    if (uRipple >= 0.0 && t > 0.0 && t < 3.0) {
      float d = length(pos);
      float wave = exp(-pow(d - t * 14.0, 2.0) * 0.08) * exp(-t * 1.2);
      pos += normalize(pos + vec3(0.0001)) * wave * 3.5;
      vRippleGlow = wave;                 // 波纹强度传给片元着色器染色
    }
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_PointSize = (1.5 + aRand * 2.5) * (30.0 / max(-mv.z, 0.1));
    gl_Position = projectionMatrix * mv;
  }
`;

const PARTICLE_FRAG = /* glsl */`
  uniform float uTime;
  uniform vec3 uRippleColor;
  varying float vRand;
  varying float vRippleGlow;
  void main() {
    float dist = length(gl_PointCoord - 0.5);
    float alpha = smoothstep(0.5, 0.08, dist);
    // Phase-5 调色：冷夜深蓝 ↔ 暖橙尘埃（规格1 冷暖对比；替代旧霓虹青）
    vec3 cCool = vec3(0.16, 0.26, 0.55);
    vec3 cWarm = vec3(1.0, 0.78, 0.42);
    vec3 color = mix(cCool, cWarm, vRand);
    // 波纹染色（跳跃/校准成功 → 暖金）
    color = mix(color, uRippleColor, clamp(vRippleGlow * 1.6, 0.0, 1.0));
    // 轻微闪烁（time uniform 驱动）
    float twinkle = 0.75 + 0.25 * sin(uTime * (1.0 + vRand * 2.0) + vRand * 40.0);
    gl_FragColor = vec4(color * twinkle, alpha * (0.3 + 0.55 * vRand));
  }
`;

/** 程序化窗户发光贴图（规格10：零外部贴图文件）：黑底 + 随机暖/冷亮窗格，用作 emissiveMap */
export function makeWindowTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000000';                       // emissiveMap 黑 = 不发光
  ctx.fillRect(0, 0, 64, 64);
  const warm = ['#ffd9a0', '#ffc46b', '#ffb45e'];
  for (let gy = 0; gy < 4; gy++) {
    for (let gx = 0; gx < 4; gx++) {
      if (Math.random() < 0.55) {                              // Phase-7 规格6：亮窗占比 45% → 55%
        ctx.fillStyle = Math.random() < 0.78 ? warm[(Math.random() * 3) | 0] : '#9fd8ff';
        ctx.fillRect(gx * 16 + 3, gy * 16 + 3, 10, 11);        // 窗格 8×9 → 10×11，远处更可读
      }
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Scene3D {
  constructor(container) {
    this.container = container;
    this.clockT = 0;
    this.degradeLevel = 0;          // Phase-10：画质档 0..3，applyQuality(level) 全量重算、双向可恢复（无单向锁）
    this.bloomEnabled = true;
    this.dofEnabled = DOF_DEFAULT;  // 规格9：一键开关（左下角 #dof-toggle）
    this.particleDrawRatio = 1;

    this.renderer = new THREE.WebGLRenderer({ antialias: !IS_MOBILE, alpha: true, powerPreference: 'high-performance' });
    this.basePixelRatio = Math.min(window.devicePixelRatio, IS_MOBILE ? 1.5 : 2);
    this.composerPR = this.basePixelRatio;   // Phase-10：composer 当前渲染像素比（L2+ 降到 ×0.65，恢复回基线）
    this.renderer.setPixelRatio(this.basePixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;   // 规格1：胶片级色调映射
    this.renderer.toneMappingExposure = 1.35;   // Phase-7 规格5：1.05 → 1.35（ACES 压暗中间调，1.05 时暮色渐变/路面几乎不可辨）
    this.renderer.shadowMap.enabled = !IS_MOBILE;              // 规格1：柔和阴影（移动端关，规格13）
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    // 天空：程序化深蓝暮色渐变（规格1 #0a1128→#1c2b59）；同图兼作 PBR 环境反射源
    this.skyTex = this._makeSkyTexture();
    this.scene.background = this.skyTex;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.skyTex.mapping = THREE.EquirectangularReflectionMapping;
    this.scene.environment = pmrem.fromEquirectangular(this.skyTex).texture;   // 冷色暮光反射（规格2 高反光材质的环境源）
    this.skyTex.mapping = THREE.UVMapping;             // background 用回普通映射
    pmrem.dispose();
    // 氛围：指数淡雾（Phase-7 规格1：密度减半 + 雾色贴近地平线 → 远处跑道/天际线自然融入背景而非硬切断）
    this.scene.fog = new THREE.FogExp2(FOG_COLOR, FOG_DENSITY);

    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 260);
    this.camera.position.set(0, 2, CAM_Z_BASE);
    this.lookTarget = new THREE.Vector3(0, 2, 0);

    this._buildLights();

    // 视差 / 跳跃弹动状态
    this.parallaxX = 0;
    this.parallaxY = 0;
    this.bounceOffset = 0;   // 弹簧位移（跳跃时上抬再弹回）
    this.bounceV = 0;

    // 开场流程状态（introFlow 驱动）
    this.gather = 1;            // 当前聚合度（1=中心聚合，0=散布背景）
    this.gatherTarget = 1;
    this.introT = 0;            // 方块云"由远及近淡入"进度 0→1
    this.introSpeed = 0.12;     // 加载期缓慢淡入
    this.pushOffset = 0;        // 校准→游戏 相机推进弹簧
    this.pushV = 0;
    this.cameraControl = true;  // false = 相机交给 runner3d（3D 跑酷追尾视角）

    this._buildParticles();
    this._buildClouds();
    this._buildSkyline();
    this._buildComposer();

    window.addEventListener('resize', () => this._resize());
  }

  /**
   * 天空纹理（规格1；Phase-7 重做）：256×256，四段渐变（天顶锚色→中段→地平线锚色→暮色余晖亮带）+ 程序化星空。
   * 根因修复：原 8×256 双色渐变线性亮度 <3%，ACES+曝光 1.05 下肉眼≈纯黑；现在亮带与星星给出可辨层次。
   */
  _makeSkyTexture() {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 256;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, SKY_TOP);        // #0a1128 天顶
    g.addColorStop(0.45, SKY_MID);     // #16234d 中段
    g.addColorStop(0.78, SKY_BOTTOM);  // #1c2b59 地平线锚色
    g.addColorStop(1, SKY_HORIZON);    // #31457c 地平线暮色余晖亮带
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
    // 星空：上半部 ~150 颗（冷暖白随机、亮度/尺寸抖动），打破天顶死黑
    for (let i = 0; i < 150; i++) {
      const x = Math.random() * 256;
      const y = Math.pow(Math.random(), 1.6) * 170;          // 偏重天顶区域
      const a = 0.25 + Math.random() * 0.65;
      const s = Math.random() < 0.12 ? 2 : 1;                // 少数亮星 2px
      ctx.fillStyle = Math.random() < 0.7
        ? `rgba(235,240,255,${a.toFixed(2)})`
        : `rgba(255,225,190,${a.toFixed(2)})`;
      ctx.fillRect(x, y, s, s);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /** 灯光（规格1）：暖橙主光（唯一 shadow map，假设④）+ 冷蓝补光 + 半球环境光 → 冷暖强对比 */
  _buildLights() {
    this.hemi = new THREE.HemisphereLight(0x4a68b8, 0x1a2440, 0.95);   // Phase-7 规格2：天空深蓝/地面暗灰，0.68 → 0.95（暮色基调保留）
    this.scene.add(this.hemi);
    // Phase-7 规格2：新增 AmbientLight（无阴影，成本≈0，全场唯一新增光源 ≤2 盏约束内）——背光面不死黑
    this.ambient = new THREE.AmbientLight(0x9fb4e8, 0.85);
    this.scene.add(this.ambient);
    this.keyLight = new THREE.DirectionalLight(0xffb45e, 3.0);   // 暖橙主光（唯一 shadow map）；Phase-7 规格4：2.5 → 3.0 强化阴影塑形
    this.keyLight.position.set(9, 15, 7);
    if (!IS_MOBILE) {
      this.keyLight.castShadow = true;                            // 单张 shadow map（假设④）
      this.keyLight.shadow.mapSize.set(1024, 1024);
      this.keyLight.shadow.camera.left = -16;
      this.keyLight.shadow.camera.right = 16;
      this.keyLight.shadow.camera.top = 16;
      this.keyLight.shadow.camera.bottom = -16;
      this.keyLight.shadow.camera.near = 4;
      this.keyLight.shadow.camera.far = 46;
      this.keyLight.shadow.bias = -0.0006;
      this.keyLight.shadow.normalBias = 0.02;
    }
    this.scene.add(this.keyLight);
    this.fillLight = new THREE.DirectionalLight(0x3f63c9, 0.7);  // 冷蓝补光（对比，Phase-6 微提）
    this.fillLight.position.set(-10, 7, -14);
    this.scene.add(this.fillLight);
    // Phase-6 规格3：跟随相机的补光——挂在 camera 节点下，开场/2D/3D 追尾/等距任何视角都从斜上方照亮跑道与障碍。
    // DirectionalLight 无阴影贴图，成本≈0；子节点随相机世界矩阵自动更新，无需每帧代码。
    this.rigLight = new THREE.DirectionalLight(0xdce8ff, 1.5);
    this.rigLight.position.set(4, 7, 5);              // 相机局部坐标：前上方偏右
    this.rigLight.target.position.set(0, -1, -13);    // 照射相机前方跑道/障碍区域
    this.camera.add(this.rigLight, this.rigLight.target);
    this.scene.add(this.camera);                      // 相机须入场景图，其子节点灯光才生效
  }

  _buildParticles() {
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(PARTICLE_COUNT * 3);
    const rands = new Float32Array(PARTICLE_COUNT);
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      positions[i * 3]     = (Math.random() - 0.5) * 120;   // x ∈ [-60, 60]
      positions[i * 3 + 1] = Math.random() * 50 - 20;       // y ∈ [-20, 30]
      positions[i * 3 + 2] = Math.random() * 70 - 60;       // z ∈ [-60, 10]
      rands[i] = Math.random();
    }
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aRand', new THREE.BufferAttribute(rands, 1));

    this.particleUniforms = {
      uTime: { value: 0 },
      uRipple: { value: -1 },        // 跳跃时刻；-1 = 无波纹（与跳跃事件联动）
      uRippleColor: { value: new THREE.Color(0xffd9a0) },   // 波纹颜色（Phase-5：暖金）
      uGather: { value: 1 },         // 初始为加载聚合态
    };
    this.particleMat = new THREE.ShaderMaterial({
      uniforms: this.particleUniforms,
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.particles = new THREE.Points(geo, this.particleMat);
    this.scene.add(this.particles);
  }

  /** 规格5：天空漂浮巨大方块云（Minecraft 式体块 + 写实体积光感）——单 InstancedMesh（规格8） */
  _buildClouds() {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xb9c6ee, roughness: 1, metalness: 0,
      transparent: true, opacity: 0,                 // 开场由 introT 淡入
      envMapIntensity: 0.5,
    });
    this.cloudMat = mat;
    this.cloudMesh = new THREE.InstancedMesh(geo, mat, CLOUD_CLUSTERS * CLOUD_BOXES);
    this.cloudMesh.frustumCulled = false;
    this.cloudData = [];
    this.cloudDummy = new THREE.Object3D();
    for (let c = 0; c < CLOUD_CLUSTERS; c++) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const boxes = [];
      for (let b = 0; b < CLOUD_BOXES; b++) {
        boxes.push({
          dx: (Math.random() - 0.5) * 9,
          dy: (Math.random() - 0.5) * 1.4,
          dz: (Math.random() - 0.5) * 5,
          sx: 3 + Math.random() * 4.5,
          sy: 1.4 + Math.random() * 1.4,
          sz: 2 + Math.random() * 3,
        });
      }
      this.cloudData.push({
        x: side * (12 + Math.random() * 42),
        y: 13 + Math.random() * 13,
        z: -30 - Math.random() * 70,
        drift: 0.35 + Math.random() * 0.5,            // 缓慢漂移
        rotY: (Math.random() - 0.5) * 0.5,
        phase: Math.random() * Math.PI * 2,
        boxes,
      });
    }
    this.scene.add(this.cloudMesh);
    this._writeCloudMatrices(0);
  }

  _writeCloudMatrices(time) {
    const d = this.cloudDummy;
    let i = 0;
    for (const c of this.cloudData) {
      const bob = Math.sin(time * 0.25 + c.phase) * 0.7;      // 轻微浮动
      const zIntro = c.z - 45 * (1 - this.introT);             // 开场"由远及近"
      d.rotation.set(0, c.rotY, 0);
      for (const b of c.boxes) {
        d.position.set(c.x + b.dx, c.y + bob + b.dy, zIntro + b.dz);
        d.scale.set(b.sx, b.sy, b.sz);
        d.updateMatrix();
        this.cloudMesh.setMatrixAt(i++, d.matrix);
      }
    }
    this.cloudMesh.instanceMatrix.needsUpdate = true;
  }

  /** 规格5：远景微缩体素城市天际线（InstancedMesh + 程序化窗户 emissiveMap，规格8/10） */
  _buildSkyline() {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);                                  // 底面对齐 y=baseY
    const winTex = makeWindowTexture();
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.85, metalness: 0.15,
      emissive: 0xffffff, emissiveMap: winTex,                 // 亮窗格 = 城市灯火（规格1 暖发光体）
      emissiveIntensity: IS_MOBILE ? 1.0 : 1.7,                // Phase-7 规格6：0.6/1.0 → 1.0/1.7，打破天际线黑暗感
      envMapIntensity: 0.25,
    });
    this.skyline = new THREE.InstancedMesh(geo, mat, SKYLINE_COUNT);
    this.skyline.frustumCulled = false;
    const d = new THREE.Object3D();
    const col = new THREE.Color();
    for (let i = 0; i < SKYLINE_COUNT; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const w = 3 + Math.random() * 7;
      const h = 4 + Math.random() * 17;
      d.position.set(side * (22 + Math.random() * 70), -10 + Math.random() * 5, -55 - Math.random() * 95);
      d.rotation.set(0, (Math.random() - 0.5) * 0.4, 0);
      d.scale.set(w, h, 3 + Math.random() * 7);
      d.updateMatrix();
      this.skyline.setMatrixAt(i, d.matrix);
      col.setHSL(0.62 + Math.random() * 0.05, 0.42, 0.15 + Math.random() * 0.09);   // Phase-7 规格6：楼体 L 0.08~0.14 → 0.15~0.24（原值在暮色光下≈纯黑剪影）
      this.skyline.setColorAt(i, col);
    }
    this.skyline.instanceMatrix.needsUpdate = true;
    this.skyline.instanceColor.needsUpdate = true;
    this.scene.add(this.skyline);
  }

  _buildComposer() {
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // 规格6（关键）：BokehPass 移轴景深——对焦带在跑道/恐龙平面，近远景模糊 → 桌面微缩玩具感
    this.bokehPass = new BokehPass(this.scene, this.camera, {
      focus: DOF_FOCUS_INTRO,
      aperture: DOF_APERTURE,
      maxblur: DOF_MAXBLUR,
    });
    this.bokehPass.enabled = this.dofEnabled;
    this.composer.addPass(this.bokehPass);
    // 辉光（Phase-6 规格5）：strength 0.55 / threshold 0.6 —— 发光障碍、边缘、窗户、灯、恐龙眼出光晕；
    // 普通受光面（线性亮度 <0.6）不触发，配合 ACESFilmic 防泛白；移轴景深与暮色氛围不变（规格6 卖点保留）
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      BLOOM_STRENGTH,   // strength
      0.5,              // radius
      BLOOM_THRESHOLD   // threshold：只给高亮自发光物体
    );
    this.composer.addPass(this.bloomPass);
    // ACESFilmic 色调映射 + sRGB 输出在 OutputPass 内完成（composer 线性 HDR 链路）
    this.composer.addPass(new OutputPass());
  }

  // ===================== 开场流程接口（introFlow 调用，API 与 Phase-2/3 完全一致） =====================
  /** 加载态：粒子向中心聚合，方块云开始由远及近缓慢淡入 */
  setLoading(on) {
    this.gatherTarget = on ? 1 : 0;
    this.introSpeed = on ? 0.12 : 0.5;
  }
  /** 加载完成：粒子场向四周散开，方块云加速就位 */
  finishLoading() {
    this.gatherTarget = 0;
    this.introSpeed = 0.5;
  }
  /** 校准态：粒子重新轻微收拢为"聚集态" */
  enterCalib() { this.gatherTarget = 0.35; }
  /** 校准→游戏过渡：相机轻微推进（弹簧回位）+ 粒子从聚集态重新散开为背景视差层 */
  playTransition() {
    this.gatherTarget = 0;
    this.pushV = -16;    // z 轴推进初速度（弹簧 k=40 → 约推进 2.5 单位后弹回）
  }

  /** 跳跃/校准事件 → 记录波纹时刻与颜色（shader 按距原点距离做位移脉冲；Phase-5 默认暖金） */
  triggerRipple(color = 0xffd9a0) {
    this.particleUniforms.uRippleColor.value.set(color);
    this.particleUniforms.uRipple.value = this.clockT;
  }

  /** 3D 跑酷模式接管相机；2D/开场流程归还相机（视差+弹动恢复） */
  setCameraControl(on) { this.cameraControl = !!on; }

  /** 规格9：景深一键开关（左下角 #dof-toggle）。dofEnabled = 用户偏好；L1+ 强制关，applyQuality(0) 按偏好恢复（Phase-10） */
  setDof(on) {
    this.dofEnabled = !!on;
    this.bokehPass.enabled = this.dofEnabled && this.degradeLevel === 0;
  }

  /** 跳跃事件 → 相机上抬初速度（弹簧随后弹回） */
  jumpBounce() {
    this.bounceV = 7.5;
  }

  /** 视差目标，x/y ∈ [-1, 1]（鼠标或姿态关键点归一化坐标） */
  setParallaxTarget(x, y) {
    this.parallaxX = x;
    this.parallaxY = y;
  }

  update(dt) {
    this.clockT += dt;
    this.particleUniforms.uTime.value = this.clockT;

    // 开场：粒子聚合/散开阻尼插值
    this.gather += (this.gatherTarget - this.gather) * Math.min(1, dt * 0.9);
    this.particleUniforms.uGather.value = this.gather;

    // 开场：方块云由远及近淡入
    if (this.introT < 1) {
      this.introT = Math.min(1, this.introT + dt * this.introSpeed);
      this.cloudMat.opacity = 0.88 * this.introT;
    }

    // 方块云：缓慢漂移 + 轻微浮动（规格5；每帧重写实例矩阵，~77 实例开销可忽略）
    for (const c of this.cloudData) {
      c.x += c.drift * dt;
      if (c.x > 78) c.x = -78;
      if (c.x < -78) c.x = 78;
    }
    this._writeCloudMatrices(this.clockT);

    // 跳跃弹动：阻尼弹簧（上抬再弹回）
    const k = 55, c = 7;
    this.bounceV += (-k * this.bounceOffset - c * this.bounceV) * dt;
    this.bounceOffset += this.bounceV * dt;

    // 校准→游戏 相机推进：阻尼弹簧（推进再回位）
    const kp = 40, cp = 7;
    this.pushV += (-kp * this.pushOffset - cp * this.pushV) * dt;
    this.pushOffset += this.pushV * dt;

    // 相机视差：阻尼插值逼近目标（3D 跑酷模式下由 runner3d 接管，跳过）
    if (this.cameraControl) {
      const targetX = this.parallaxX * 2.4;
      const targetY = 2 + (-this.parallaxY * 1.5) + this.bounceOffset;
      const damp = Math.min(1, dt * 3);
      this.camera.position.x += (targetX - this.camera.position.x) * damp;
      this.camera.position.y += (targetY - this.camera.position.y) * damp;
      this.camera.position.z = CAM_Z_BASE + this.pushOffset;
      this.camera.lookAt(this.lookTarget);
    }

    // 景深对焦带跟随模式：开场/2D 看原点（26u），3D 跑酷看恐龙（≈13.5u）
    if (this.bokehPass.enabled) {
      const focusTarget = this.cameraControl ? DOF_FOCUS_INTRO : DOF_FOCUS_PLAY;
      const fu = this.bokehPass.uniforms['focus'];
      fu.value += (focusTarget - fu.value) * Math.min(1, dt * 2);
    }

    if (this.bloomPass.enabled || this.bokehPass.enabled) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  /**
   * Phase-10：画质档全量重算（幂等、可任意方向调用，含 0）——取代旧 Math.max 单向锁 degrade()。
   * 旧 degrade 名已删除，main.js 调用点同步改为 applyQuality（按简报二选一，注明于此）。
   * 路侧景物部分见 runner3d.degradeScenery(level)（同为幂等重算）。跑道障碍与恐龙本体任何级别绝不削减。
   *   L0 = 粒子全量 + 云全量 + 天际线可见 + Bloom 开（全分辨率）+ rigLight 1.5 + ambient 0.85 + 景深按用户 #dof-toggle 偏好恢复
   *   L1 = 景深关 + 粒子×0.5 + 方块云×0.5（同 Phase-5）
   *   L2 = 粒子×0.25 + 云关 + 天际线关 + Bloom 保留但后处理链渲染分辨率 ×0.65 + rigLight 1.0 + ambient 0.7
   *        （分辨率方案：composer.setPixelRatio(base×0.65)——Bloom 多级 mip 一并降采样，最终仍由 renderer 全分辨率输出上采样；
   *          签名辉光在 L2 绝不关闭）
   *   L3 = 在 L2 基础上 + Bloom 关 + rigLight 关 + ambient 0.45（真正的保底档）
   * @returns {string} 当前档位说明
   */
  applyQuality(level) {
    level = Math.max(0, Math.min(3, level | 0));
    this.degradeLevel = level;
    const total = this.particles.geometry.getAttribute('position').count;

    // 粒子：L0 全量 / L1 半量 / L2+ 四分之一
    this.particleDrawRatio = level >= 2 ? 0.25 : level === 1 ? 0.5 : 1;
    this.particles.geometry.setDrawRange(0, Math.floor(total * this.particleDrawRatio));

    // 方块云：L0 全簇 / L1 半簇 / L2+ 关
    this.cloudMesh.visible = level < 2;
    this.cloudMesh.count = level >= 1
      ? Math.max(1, Math.floor(CLOUD_CLUSTERS / 2)) * CLOUD_BOXES
      : CLOUD_CLUSTERS * CLOUD_BOXES;

    // 天际线：L2+ 才关
    this.skyline.visible = level < 2;

    // Bloom：L2 保留（半分辨率），仅 L3 关
    this.bloomEnabled = level < 3;
    this.bloomPass.enabled = this.bloomEnabled;
    const pr = level >= 2 ? this.basePixelRatio * 0.65 : this.basePixelRatio;
    if (this.composerPR !== pr) { this.composerPR = pr; this.composer.setPixelRatio(pr); }

    // 跟随光/环境光：L2 调暗不关；L3 才关跟随光、环境光降到 0.45
    this.rigLight.visible = level < 3;
    this.rigLight.intensity = level >= 2 ? 1.0 : 1.5;
    this.ambient.intensity = level >= 3 ? 0.45 : level === 2 ? 0.7 : 0.85;

    // 景深：L1+ 强制关；L0 按用户偏好恢复
    this.bokehPass.enabled = this.dofEnabled && level === 0;

    return ['完整画质（Bloom/天际线/云/跟随光全开，景深按用户设置）',
            '景深关 + 粒子×0.5 + 方块云×0.5',
            '景深关 + 粒子×0.25 + 云/天际线关 + 后处理分辨率×0.65（Bloom 保留）+ 跟随光 1.0 + 环境光 0.7',
            'Bloom 关 + 跟随光关 + 环境光 0.45（在 L2 基础上）'][level];
  }

  _resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.bokehPass.uniforms['aspect'].value = w / h;
  }
}
