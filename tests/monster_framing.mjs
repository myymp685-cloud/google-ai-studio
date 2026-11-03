// Phase-15 geometry self-proof (acceptance B/C): monster framing vs dino + visual smoothing.
// Pure math, no THREE — mirrors _updateMonster/camera placement in js/runner3d.js exactly.
// Constants are CROSS-CHECKED against the shipped js/runner3d.js source below, so this
// script cannot silently drift from production values.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'runner3d.js'), 'utf8');
function shipped(name) {
  const m = SRC.match(new RegExp('export const ' + name + ' = ([0-9.]+);'));
  if (!m) { console.error('CONST_MISSING_IN_SRC ' + name); process.exit(1); }
  return parseFloat(m[1]);
}
const P = {
  CAM_PITCH: shipped('CAM_PITCH_DEG'), LOOK_AHEAD: shipped('CAM_LOOK_AHEAD'), CAM_DIST: shipped('CAM_DIST'),
  ISO_PITCH: shipped('ISO_PITCH_DEG'), ISO_YAW: shipped('ISO_YAW_DEG'), ISO_DIST: shipped('ISO_DIST'),
  R_NEAR: shipped('MONSTER_Z_NEAR'), R_FAR: shipped('MONSTER_Z_FAR'),
  S_NEAR: shipped('M_SCALE_NEAR'), S_FAR: shipped('M_SCALE_FAR'),
  SINK: shipped('M_SINK'), SINK_ISO: shipped('M_SINK_ISO'),
  ISO_R_MUL: shipped('M_ISO_R_MUL'), ISO_SMUL: shipped('M_ISO_SCALE_MUL'),
  RATE: shipped('MONSTER_VIS_RATE'), FOV_BOOST: shipped('FRENZY_FOV_BOOST'),
  FOV: 60, BOB: 0.22, CHASE_MAX: shipped('CHASE_MAX'),
};
P.FOV_FRENZY = P.FOV + P.FOV_BOOST;
console.log('shipped constants: ' + JSON.stringify(P));
const M_HEIGHT = 5.5, M_HALFW = 0.95;             // monster box (js/runner3d.js _buildMonster)
const D_HEIGHT = 2.125, D_HALF = 0.55, D_DEPTHHALF = 0.425;  // dino box (12.5 x VOXEL 0.17)
const D2R = Math.PI / 180;
const sub = (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const dot = (a, b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const norm = (a) => { const l = Math.hypot(a[0],a[1],a[2]); return [a[0]/l,a[1]/l,a[2]/l]; };
function camBasis(pos, look) {
  const f = norm(sub(look, pos));
  const r = norm(cross(f, [0, 1, 0]));
  const u = cross(r, f);
  return { f, r, u };
}
function project(p, camPos, basis, fovDeg, aspect) {
  const d = sub(p, camPos);
  const depth = dot(d, basis.f);
  if (depth <= 0.01) return null; // behind camera
  const t = Math.tan(fovDeg * D2R / 2);
  return { x: dot(d, basis.r) / (t * aspect * depth), y: dot(d, basis.u) / (t * depth), depth };
}
function camPos(mode, dinoX, jumpY) {
  const iso = mode === 'iso';
  const pitch = (iso ? P.ISO_PITCH : P.CAM_PITCH) * D2R;
  const yaw = (iso ? P.ISO_YAW : 0) * D2R;
  const dist = iso ? P.ISO_DIST : P.CAM_DIST;
  const look = [dinoX * 0.6, 0.9 + jumpY * 0.4, -P.LOOK_AHEAD];
  const pos = [
    look[0] + dist * Math.cos(pitch) * Math.sin(yaw),
    look[1] + dist * Math.sin(pitch),
    look[2] + dist * Math.cos(pitch) * Math.cos(yaw),
  ];
  return { pos, look };
}
function boxCorners(cx, cy, cz, hx, hy, hz) {
  const out = [];
  for (const sx of [-1,1]) for (const sy of [-1,1]) for (const sz of [-1,1]) out.push([cx+sx*hx, cy+sy*hy, cz+sz*hz]);
  return out;
}
function ndcYRange(corners, camPos, basis, fov, aspect) {
  let lo = Infinity, hi = -Infinity, behind = 0;
  for (const c of corners) { const p = project(c, camPos, basis, fov, aspect); if (!p) { behind++; continue; } if (p.y < lo) lo = p.y; if (p.y > hi) hi = p.y; }
  return { lo, hi, behind };
}
// monster ground placement — identical formula to _updateMonster: offset r from dino toward camera ground projection
function monsterPos(mode, dinoX, r) {
  const { pos } = camPos(mode, dinoX, 0);
  const dx = pos[0] - dinoX, dz = pos[2] - 0;
  const hd = Math.hypot(dx, dz);
  return [dinoX + dx * (r / hd), dz * (r / hd)];
}
let fails = 0;
// ---------- B. separation grid: monster NDC top < dino NDC bottom, full chase range, both cameras ----------
let worstMargin = Infinity, worstAt = '', minTop = Infinity;
for (const mode of ['default', 'iso']) {
  for (const fov of [P.FOV, P.FOV_FRENZY]) {
    for (const dinoX of [-3, 0, 3]) {
      const { pos, look } = camPos(mode, dinoX, 0);
      const basis = camBasis(pos, look);
      const dino = ndcYRange(boxCorners(dinoX, D_HEIGHT/2, 0, D_HALF, D_HEIGHT/2, D_DEPTHHALF), pos, basis, fov, 16/9);
      for (let chase = 0; chase <= P.CHASE_MAX + 0.001; chase += 0.5) {
        const k = Math.max(0, Math.min(1, chase / P.CHASE_MAX));
        const r = (P.R_NEAR + (P.R_FAR - P.R_NEAR) * k) * (mode === 'iso' ? P.ISO_R_MUL : 1);
        const s = (P.S_NEAR + (P.S_FAR - P.S_NEAR) * k) * (mode === 'iso' ? P.ISO_SMUL : 1);
        const sink = (mode === 'iso' ? P.SINK_ISO : P.SINK) * s;
        const [mx, mz] = monsterPos(mode, dinoX, r);
        const topY = -sink + (M_HEIGHT + P.BOB) * s;
        const mon = ndcYRange(boxCorners(mx, (topY + (-sink))/2, mz, M_HALFW*s, (topY+sink)/2, 0.5*s), pos, basis, fov, 16/9);
        if (mon.behind > 0) { fails++; console.log('FAIL BEHIND_CAMERA ' + mode + '/fov' + fov + '/dinoX' + dinoX + '/chase' + chase); continue; }
        const margin = dino.lo - mon.hi;
        if (margin <= 0) { fails++; console.log('FAIL OVERLAP ' + mode + '/fov' + fov + '/dinoX' + dinoX + '/chase' + chase + ' monTop=' + mon.hi.toFixed(3) + ' dinoBot=' + dino.lo.toFixed(3)); }
        if (margin < worstMargin) { worstMargin = margin; worstAt = mode + '/fov' + fov + '/dinoX' + dinoX + '/chase' + chase; }
        if (chase <= 12) { if (mon.hi < -1) { fails++; console.log('FAIL INVISIBLE ' + mode + '/dinoX' + dinoX + '/chase' + chase + ' top=' + mon.hi.toFixed(3)); } if (mon.hi < minTop) minTop = mon.hi; }
      }
    }
  }
}
console.log('GRID worstMargin=' + worstMargin.toFixed(4) + ' @' + worstAt + '  minMonsterTop(chase<=12)=' + minTop.toFixed(3) + ' (must be >0 margin and >=-1 visible)');
if (!(worstMargin > 0)) { fails++; console.log('FAIL WORST_MARGIN'); }
if (!(minTop >= -1)) { fails++; console.log('FAIL MIN_TOP_VISIBILITY'); }
// sample table (default camera, dinoX=0)
for (const chase of [0, 6, 12, 18, 24, 30]) {
  const k = chase / P.CHASE_MAX;
  const r = P.R_NEAR + (P.R_FAR - P.R_NEAR) * k, s = P.S_NEAR + (P.S_FAR - P.S_NEAR) * k, sink = P.SINK * s;
  const { pos, look } = camPos('default', 0, 0); const basis = camBasis(pos, look);
  const dino = ndcYRange(boxCorners(0, D_HEIGHT/2, 0, D_HALF, D_HEIGHT/2, D_DEPTHHALF), pos, basis, 60, 16/9);
  const [mx, mz] = monsterPos('default', 0, r);
  const topY = -sink + (M_HEIGHT + P.BOB) * s;
  const mon = ndcYRange(boxCorners(mx, (topY-sink)/2, mz, M_HALFW*s, (topY+sink)/2, 0.5*s), pos, basis, 60, 16/9);
  console.log('chase=' + chase + ' r=' + r.toFixed(3) + ' s=' + s.toFixed(3) + ' monsterNdcY=[' + mon.lo.toFixed(3) + ',' + mon.hi.toFixed(3) + '] dinoNdcY=[' + dino.lo.toFixed(3) + ',' + dino.hi.toFixed(3) + '] separated=' + (mon.hi < dino.lo));
}
// ground visible band per camera (bottom screen ray ground hit behind dino)
for (const [nm, pitchDeg] of [['default(pitch' + P.CAM_PITCH + ',look' + P.LOOK_AHEAD + ')', P.CAM_PITCH], ['iso(pitch' + P.ISO_PITCH + ',yaw' + P.ISO_YAW + ')', P.ISO_PITCH]]) {
  const pp = camPos(nm.startsWith('iso') ? 'iso' : 'default', 0, 0);
  const zHit = pp.pos[2] - pp.pos[1] / Math.tan((pitchDeg + P.FOV/2) * D2R);
  console.log('band ' + nm + ': camPos=(' + pp.pos.map(v => v.toFixed(3)).join(',') + ') bottomRayGroundHitZ=' + zHit.toFixed(3));
}
// ---------- C. smoothing: exponential ease at MONSTER_VIS_RATE, 60fps ----------
function simSmooth(name, chase0, chase1) {
  const dt = 1/60;
  const zOf = (c) => P.R_NEAR + (P.R_FAR - P.R_NEAR) * Math.max(0, Math.min(1, c / P.CHASE_MAX));
  const sOf = (c) => P.S_NEAR + (P.S_FAR - P.S_NEAR) * Math.max(0, Math.min(1, c / P.CHASE_MAX));
  const z0 = zOf(chase0), z1 = zOf(chase1), s0 = sOf(chase0), s1 = sOf(chase1);
  let vz = z0, vs = s0, frames = 0, firstStepZ = null, maxStepZ = 0, prev = z0;
  const totalZ = Math.abs(z1 - z0), totalS = Math.abs(s1 - s0);
  while (frames < 1200) {
    const a = 1 - Math.exp(-dt * P.RATE);
    vz += (z1 - vz) * a; vs += (s1 - vs) * a; frames++;
    if (firstStepZ === null) firstStepZ = Math.abs(vz - z0);
    maxStepZ = Math.max(maxStepZ, Math.abs(vz - prev)); prev = vz;
    if (totalZ > 0 && Math.abs(vz - z1) < 0.01 * totalZ) break;
    if (totalZ === 0) break;
  }
  const ok = frames >= 10 && firstStepZ < 0.1 * totalZ && maxStepZ < 0.25 * totalZ;
  if (!ok) { fails++; console.log('FAIL SMOOTH ' + name); }
  console.log('SMOOTH ' + name + ': r ' + z0.toFixed(4) + '->' + z1.toFixed(4) + ' s ' + s0.toFixed(4) + '->' + s1.toFixed(4) + ' framesTo99%=' + frames + ' firstFrameStep=' + (100*firstStepZ/totalZ).toFixed(1) + '% maxFrameStep=' + (100*maxStepZ/totalZ).toFixed(1) + '% pass=' + ok);
}
simSmooth('instant-6(chase18->12)', 18, 12);
simSmooth('full-range(chase30->0)', 30, 0);
console.log(fails === 0 ? 'FRAMING_ALL_PASS fails=0' : 'FRAMING_FAILS=' + fails);
process.exit(fails === 0 ? 0 : 1);
