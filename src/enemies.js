/* ============================================================
   DEADLIGHT // OUTPOST 13 — HORDE
   Procedural zombies, skeletal procedural animation, A* navigation,
   barricade/generator assault AI, 8-wave director with boss.
   Classic script, depends on global THREE + DL (core.js).
   Public API: DL.Horde
   ============================================================ */
(function () {
  "use strict";

  const DL = (window.DL = window.DL || {});
  const PI = Math.PI;
  const TAU = PI * 2;

  /* ---------------- scratch objects (module level, never per-frame alloc) ---------------- */
  const _mat4 = new THREE.Matrix4();
  const _quat = new THREE.Quaternion();
  const _euler = new THREE.Euler();
  const _pos = new THREE.Vector3();
  const _scl = new THREE.Vector3();
  const _color = new THREE.Color();
  const _v1 = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const _v3 = new THREE.Vector3();
  const _v4 = new THREE.Vector3();
  const WHITE = new THREE.Color(1, 1, 1);

  function shortAngle(a, b) {
    let d = (b - a) % TAU;
    if (d > PI) d -= TAU;
    if (d < -PI) d += TAU;
    return d;
  }
  function rand(a, b) {
    return a + Math.random() * (b - a);
  }
  function clamp(v, a, b) {
    return v < a ? a : v > b ? b : v;
  }

  /* ============================================================
     Geometry assembly
     We merge several primitives into ONE BufferGeometry per animated
     body segment, with per-part vertex colors. This keeps draw calls
     low while packing real procedural detail (tatters, ribs, straps,
     claws, gore) into the same mesh.
     ============================================================ */
  function part(arr, geo, x, y, z, color, rx, ry, rz, sx, sy, sz) {
    _euler.set(rx || 0, ry || 0, rz || 0);
    _quat.setFromEuler(_euler);
    _pos.set(x || 0, y || 0, z || 0);
    _scl.set(sx == null ? 1 : sx, sy == null ? 1 : sy, sz == null ? 1 : sz);
    _mat4.compose(_pos, _quat, _scl);
    arr.push({ geo: geo, m: _mat4.clone(), c: color || WHITE });
  }

  function mergeParts(parts) {
    let count = 0;
    const prep = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const g = p.geo.index ? p.geo.toNonIndexed() : p.geo.clone();
      g.applyMatrix4(p.m);
      const pos = g.attributes.position.array;
      const nor = g.attributes.normal ? g.attributes.normal.array : null;
      const uv = g.attributes.uv ? g.attributes.uv.array : null;
      prep.push({ pos: pos, nor: nor, uv: uv, c: p.c });
      count += pos.length / 3;
      g.dispose();
    }
    const positions = new Float32Array(count * 3);
    const normals = new Float32Array(count * 3);
    const uvs = new Float32Array(count * 2);
    const colors = new Float32Array(count * 3);
    let v = 0;
    for (let i = 0; i < prep.length; i++) {
      const pr = prep[i];
      positions.set(pr.pos, v * 3);
      if (pr.nor) normals.set(pr.nor, v * 3);
      else for (let k = 0; k < pr.pos.length; k += 3) { normals[v * 3 + k] = 0; normals[v * 3 + k + 1] = 1; normals[v * 3 + k + 2] = 0; }
      if (pr.uv) uvs.set(pr.uv, v * 2);
      const c = pr.c;
      const n = pr.pos.length / 3;
      for (let k = 0; k < n; k++) {
        colors[(v + k) * 3] = c.r;
        colors[(v + k) * 3 + 1] = c.g;
        colors[(v + k) * 3 + 2] = c.b;
      }
      v += n;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    return geo;
  }

  /* ============================================================
     Zombie type definitions
     prop.*   body proportions in metres (model faces +Z)
     anim.*   procedural gait tuning
     ============================================================ */
  /* ============================================================
     Zombie type definitions
     palette.*  decayed, desaturated colours (vertex-coloured; no
                bright/neon tints — keeps them dark under flashlight)
     prop.*     body proportions in metres (model faces +Z)
     anim.*     procedural gait tuning
     ============================================================ */
  const ZDEF = {
    walker: {
      key: "walker", label: "WALKER", idx: 1,
      hp: 100, speed: 1.35, radius: 0.38, damage: 10,
      attackRange: 1.55, cooldown: 1.4, windup: 0.4, recover: 0.32,
      turn: 5.5, mass: 1, barricadeMul: 0.40, genMul: 1.0, hpWave: 1.0, dmgWave: 1.0,
      cloth: 0x453f33, cloth2: 0x2f2c24, skin: 0x5e5850, skin2: 0x494247,
      bone: 0x84755d, blood: 0x2c0a07, gore: 0x570f0b,
      eye: 0xff9a3c, eyeInt: 1.55,
      ribs: false, shriek: false, slam: false, boss: false,
      prop: {
        hipY: 0.90, thigh: 0.46, shin: 0.42, hipHalf: 0.10, legR: 0.085,
        torsoH: 0.60, chestW: 0.40, waistW: 0.27, chestD: 0.24,
        shoulderX: 0.20, shoulderY: 0.53, upperArm: 0.345, foreArm: 0.34,
        armR: 0.065, headR: 0.140, neck: 0.075, lean: 0.16, hunch: 0.05,
      },
      anim: { armAmp: 0.40, shBase: -1.02, shOut: 0.12, elbowBase: -0.95, hipTwist: 0.12, torsoTwist: 0.12, torsoRoll: 0.05, headLurch: 0.10, bob: 0.030, stride: 1.9, legAmp: 0.55, kneeAmp: 0.75, legBias: 0.02 },
    },
    runner: {
      key: "runner", label: "RUNNER", idx: 2,
      hp: 80, speed: 3.05, radius: 0.34, damage: 8,
      attackRange: 1.6, cooldown: 1.0, windup: 0.3, recover: 0.26,
      turn: 8.5, mass: 0.85, barricadeMul: 0.35, genMul: 0.8, hpWave: 1.0, dmgWave: 1.0,
      cloth: 0x2e2d29, cloth2: 0x201f1c, skin: 0x545047, skin2: 0x423e44,
      bone: 0x7e7159, blood: 0x290a07, gore: 0x4f120d,
      eye: 0xff5a20, eyeInt: 1.75,
      ribs: false, shriek: false, slam: false, boss: false,
      prop: {
        hipY: 0.99, thigh: 0.50, shin: 0.47, hipHalf: 0.09, legR: 0.075,
        torsoH: 0.56, chestW: 0.32, waistW: 0.22, chestD: 0.19,
        shoulderX: 0.17, shoulderY: 0.49, upperArm: 0.40, foreArm: 0.38,
        armR: 0.052, headR: 0.118, neck: 0.11, lean: 0.42, hunch: 0.09,
      },
      anim: { armAmp: 0.75, shBase: -1.30, shOut: 0.16, elbowBase: -1.55, hipTwist: 0.18, torsoTwist: 0.16, torsoRoll: 0.07, headLurch: 0.07, bob: 0.045, stride: 2.6, legAmp: 0.72, kneeAmp: 1.0, legBias: 0.02 },
    },
    brute: {
      key: "brute", label: "BRUTE", idx: 3,
      hp: 450, speed: 1.02, radius: 0.66, damage: 28,
      attackRange: 2.15, cooldown: 1.9, windup: 0.55, recover: 0.5,
      turn: 3.0, mass: 3.2, barricadeMul: 3.0, genMul: 2.4, hpWave: 0.62, dmgWave: 1.0,
      cloth: 0x26221d, cloth2: 0x191614, skin: 0x4d3a30, skin2: 0x382b24,
      bone: 0x8a7a60, blood: 0x2e0a07, gore: 0x4c100c,
      eye: 0xff2a10, eyeInt: 2.1,
      ribs: true, shriek: false, slam: false, boss: false,
      prop: {
        hipY: 0.97, thigh: 0.49, shin: 0.46, hipHalf: 0.17, legR: 0.15,
        torsoH: 0.82, chestW: 0.76, waistW: 0.46, chestD: 0.44,
        shoulderX: 0.44, shoulderY: 0.74, upperArm: 0.46, foreArm: 0.44,
        armR: 0.13, headR: 0.145, neck: 0.02, lean: 0.26, hunch: 0.07,
      },
      anim: { armAmp: 0.22, shBase: -0.50, shOut: 0.42, elbowBase: -0.42, hipTwist: 0.07, torsoTwist: 0.08, torsoRoll: 0.11, headLurch: 0.06, bob: 0.050, stride: 1.45, legAmp: 0.46, kneeAmp: 0.50, legBias: 0.03 },
    },
    screamer: {
      key: "screamer", label: "SCREAMER", idx: 4,
      hp: 70, speed: 1.55, radius: 0.30, damage: 6,
      attackRange: 1.55, cooldown: 1.8, windup: 0.38, recover: 0.3,
      turn: 6.5, mass: 0.8, barricadeMul: 0.30, genMul: 0.8, hpWave: 1.0, dmgWave: 1.0,
      cloth: 0x565750, cloth2: 0x3e3f38, skin: 0x625d55, skin2: 0x514b4d,
      bone: 0x82765f, blood: 0x2c0b08, gore: 0x45120c,
      eye: 0xcfe8ff, eyeInt: 1.4,
      ribs: false, shriek: true, slam: false, boss: false, keepDistance: 11,
      prop: {
        hipY: 0.96, thigh: 0.49, shin: 0.45, hipHalf: 0.085, legR: 0.065,
        torsoH: 0.62, chestW: 0.25, waistW: 0.18, chestD: 0.16,
        shoulderX: 0.13, shoulderY: 0.55, upperArm: 0.42, foreArm: 0.40,
        armR: 0.045, headR: 0.140, neck: 0.12, lean: 0.06, hunch: 0.025,
      },
      anim: { armAmp: 0.30, shBase: -0.85, shOut: 0.26, elbowBase: -1.15, hipTwist: 0.10, torsoTwist: 0.10, torsoRoll: 0.08, headLurch: 0.13, bob: 0.030, stride: 1.85, legAmp: 0.52, kneeAmp: 0.70, legBias: 0.02 },
    },
    boss: {
      key: "boss", label: "ABOMINATION", idx: 5,
      hp: 3500, speed: 1.5, radius: 1.05, damage: 42,
      attackRange: 3.4, cooldown: 1.8, windup: 0.5, recover: 0.55,
      turn: 2.6, mass: 8, barricadeMul: 4.0, genMul: 3.0, hpWave: 0, dmgWave: 0,
      cloth: 0x181513, cloth2: 0x0f0d0b, skin: 0x3b2a21, skin2: 0x2a1d16,
      bone: 0x77694f, blood: 0x2e0906, gore: 0x480e08,
      eye: 0xff1804, eyeInt: 2.2,
      ribs: true, shriek: false, slam: true, boss: true,
      prop: {
        hipY: 1.38, thigh: 0.72, shin: 0.64, hipHalf: 0.26, legR: 0.24,
        torsoH: 1.14, chestW: 1.08, waistW: 0.64, chestD: 0.62,
        shoulderX: 0.58, shoulderY: 1.00, upperArm: 0.66, foreArm: 0.62,
        armR: 0.19, headR: 0.19, neck: 0.05, lean: 0.22, hunch: 0.09,
      },
      anim: { armAmp: 0.20, shBase: -0.55, shOut: 0.36, elbowBase: -0.50, hipTwist: 0.06, torsoTwist: 0.06, torsoRoll: 0.08, headLurch: 0.05, bob: 0.055, stride: 1.30, legAmp: 0.42, kneeAmp: 0.45, legBias: 0.03 },
    },
  };

  /* Exact wave roster totals: 8, 12, 16, 22, 28, 34, 40, boss+24 */
  const WAVES = {
    1: [["walker", 8]],
    2: [["walker", 9], ["runner", 3]],
    3: [["walker", 10], ["runner", 5], ["screamer", 1]],
    4: [["walker", 12], ["runner", 7], ["brute", 2], ["screamer", 1]],
    5: [["walker", 14], ["runner", 9], ["brute", 4], ["screamer", 1]],
    6: [["walker", 16], ["runner", 11], ["brute", 6], ["screamer", 1]],
    7: [["walker", 18], ["runner", 12], ["brute", 8], ["screamer", 2]],
    8: [["walker", 10], ["runner", 9], ["brute", 3], ["screamer", 2], ["boss", 1]],
  };

  /* ============================================================
     buildGeoms — one geometry set per (type, variant).
     Bodies are assembled from curved tapered tubes, joint knobs and
     layered cloth shells; clothing, tatters, gore and bone are packed
     into the few animated body segments (vertex colours, shared
     materials). Three structural variants per type keep the horde
     from looking cloned.
     ============================================================ */
  function buildGeoms(def, variant) {
    const P = def.prop;
    const V = ((variant % 3) + 3) % 3;
    const rng = DL.mulberry32((def.idx * 104729 + V * 7919 + 17) >>> 0);
    const created = [];
    const out = {};

    /* ---------- primitive factories (tracked for disposal) ---------- */
    function box(w, h, d) { const g = new THREE.BoxGeometry(w, h, d); created.push(g); return g; }
    function sph(r, ws, hs) {
      const mw = r >= 0.12 ? 7 : r >= 0.055 ? 6 : 5;
      const mh = r >= 0.12 ? 5 : r >= 0.055 ? 5 : 4;
      const g = new THREE.SphereGeometry(r, Math.min(ws || mw, mw), Math.min(hs || mh, mh));
      created.push(g);
      return g;
    }
    function cyl(rt, rb, h, seg, open) { const g = new THREE.CylinderGeometry(rt, rb, h, Math.min(seg || 7, 8), 1, !!open); created.push(g); return g; }
    function tube(len, rTop, rBot, seg, bendX, bendZ, hs) {
      const g = new THREE.CylinderGeometry(rTop, rBot, len, Math.min(seg || 7, 8), Math.min(hs || 2, 2), true);
      g.translate(0, -len * 0.5, 0);
      const pos = g.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const t = DL.clamp(-pos.getY(i) / len, 0, 1);
        const k = t * t;
        pos.setX(i, pos.getX(i) + bendX * k);
        pos.setZ(i, pos.getZ(i) + bendZ * k);
      }
      g.computeVertexNormals();
      created.push(g);
      return g;
    }
    function ribbon(wTop, wBot, len, thick) {
      const g = new THREE.CylinderGeometry(wTop * 0.5, wBot * 0.5, len, 4, 1, true);
      g.rotateY(PI * 0.25);
      g.translate(0, -len * 0.5, 0);
      g.scale(1, 1, thick / Math.max(0.02, Math.max(wTop, wBot)));
      created.push(g);
      return g;
    }

    /* ---------- palette helpers ---------- */
    function tint(hex, jitter) {
      _color.setHex(hex);
      const k = 1 + (rng() - 0.5) * 2 * (jitter == null ? 0.12 : jitter);
      return _color.clone().multiplyScalar(k);
    }
    function shade(hex, k) { _color.setHex(hex); return _color.clone().multiplyScalar(k); }
    function mixC(a, b, k) {
      const ca = new THREE.Color(a);
      return ca.lerp(new THREE.Color(b), k);
    }
    const clothC = function () { return tint(def.cloth, 0.16); };
    const cloth2C = function () { return tint(def.cloth2, 0.18); };
    const skinC = function () { return tint(def.skin, 0.10); };
    const bruiseC = function () { return mixC(def.skin, def.skin2, 0.35 + rng() * 0.5); };
    const boneC = function () { return tint(def.bone, 0.08); };
    const bloodC = function () { return shade(def.blood, 0.8 + rng() * 0.6); };
    const goreC = function () { return shade(def.gore, 0.8 + rng() * 0.7); };
    const darkC = function () { return shade(def.cloth2, 0.45); };

    /* ---------- per-type / per-variant wardrobe ---------- */
    const isWalker = def.key === "walker";
    const isRunner = def.key === "runner";
    const isBrute = def.key === "brute";
    const isScreamer = def.key === "screamer";
    const isBoss = !!def.boss;
    const F = {
      coat: false, poncho: false, vest: false, waistJacket: false, suspenders: false,
      hoodDown: false, hoodUp: false, belt: false, tears: 2,
      pants: true, barefootR: false, sleeves: 1.0,
      longHair: false, mattedHair: true, brokenJaw: false, hugeJaw: false,
      bigArmR: false, boneGrowth: false, backSpikes: false, apron: false,
      gown: false, gownTorn: false, strait: false, bandageR: false, wristWraps: false,
      ribs: isBrute || isBoss, chainStrap: false, bossCape: false,
    };
    if (isWalker) {
      if (V === 0) { F.coat = true; F.hoodDown = true; F.belt = true; F.tears = 3; F.mattedHair = true; }
      else if (V === 1) { F.vest = true; F.waistJacket = true; F.suspenders = true; F.tears = 4; F.mattedHair = false; F.brokenJaw = true; F.sleeves = 0.0; }
      else { F.poncho = true; F.hoodDown = true; F.belt = true; F.barefootR = true; F.tears = 3; F.mattedHair = false; F.longHair = true; F.sleeves = 0.55; }
    } else if (isRunner) {
      if (V === 0) { F.hoodUp = true; F.sleeves = 1.0; F.wristWraps = true; F.belt = true; }
      else if (V === 1) { F.waistJacket = true; F.belt = true; F.tears = 3; F.sleeves = 0.45; F.bandageR = true; }
      else { F.vest = true; F.belt = true; F.tears = 3; F.sleeves = 0.35; F.bandageR = true; F.wristWraps = true; }
    } else if (isBrute) {
      if (V === 0) { F.boneGrowth = true; F.apron = true; F.pants = true; F.tears = 1; }
      else if (V === 1) { F.bigArmR = true; F.apron = true; F.chainStrap = true; F.pants = true; F.tears = 1; }
      else { F.backSpikes = true; F.apron = false; F.pants = false; F.bellyWound = true; F.tears = 2; }
    } else if (isScreamer) {
      if (V === 0) { F.gown = true; F.longHair = true; F.mattedHair = true; }
      else if (V === 1) { F.gownTorn = true; F.hugeJaw = true; F.longHair = true; F.mattedHair = false; }
      else { F.gownTorn = true; F.strait = true; F.hugeJaw = true; F.mattedHair = false; }
    } else if (isBoss) {
      F.bossCape = true; F.backSpikes = true; F.hugeJaw = true; F.ribs = true; F.boneGrowth = true;
    }

    /* ---------- limb asymmetry per variant ---------- */
    let armLenL = 1, armLenR = 1, armRadL = 1, armRadR = 1;
    let thighLenL = 1, thighLenR = 1, shinLenL = 1, shinLenR = 1;
    if (V === 0) { armLenR = 1.05; }
    else if (V === 1) { armLenL = 1.07; thighLenR = 0.975; armRadL = 1.06; }
    else { armLenR = 1.11; armLenL = 0.955; thighLenL = 1.015; }
    if (F.bigArmR) { armLenR = 1.12; armRadR = 1.70; }
    if (isBoss) { armLenR = 1.06; armRadR = 1.15; }

    /* ---------- proportions ---------- */
    const H = P.torsoH;
    const chestR = P.chestW * 0.5;
    const waistR = P.waistW * 0.5;
    const hipR = P.waistW * 0.56;
    const depth = P.chestD / Math.max(0.05, P.chestW);
    const hunch = P.hunch == null ? 0.05 : P.hunch;
    const zAt = function (y) { const f = DL.clamp(y / H, 0, 1); return hunch * f * f; };
    const frontAt = function (y) {
      const rr = y < H * 0.4 ? hipR + (waistR - hipR) * (y / (H * 0.4))
        : waistR + (chestR - waistR) * ((y - H * 0.4) / (H * 0.6));
      return zAt(y) + rr * depth;
    };

    const thighL = P.thigh * thighLenL;
    const thighR = P.thigh * thighLenR;
    const shinL = P.shin * shinLenL;
    const shinR = P.shin * shinLenR;
    const upLenL = P.upperArm * armLenL;
    const upLenR = P.upperArm * armLenR;
    const foreLenL = P.foreArm * armLenL;
    const foreLenR = P.foreArm * armLenR;

    /* ---------- small builders ---------- */
    function strip(arr, x, y, z, wTop, wBot, len, rx, ry, rz, colorFn) {
      part(arr, ribbon(wTop, wBot, len, 0.010 + rng() * 0.010), x, y, z, colorFn(), rx, ry, rz);
    }
    function ragRing(arr, y, rx, rz, count, lenMin, lenMax, colorFn, zOff) {
      for (let i = 0; i < count; i++) {
        const a = (i / count) * TAU + rng() * 0.35;
        const len = lenMin + rng() * (lenMax - lenMin);
        strip(arr, Math.sin(a) * rx, y, (zOff || 0) + Math.cos(a) * rz, 0.05 + rng() * 0.05, 0.02, len, 0.03 + (rng() - 0.5) * 0.18, a, (rng() - 0.5) * 0.25, colorFn);
      }
    }
    function clothShell(arr, y, h, rTop, rBot, depthScale, colorFn, zOff) {
      part(arr, cyl(rTop, rBot, h, 10, true), 0, y, (zOff || 0) + zAt(y), colorFn(), 0, 0, 0, 1, 1, depth * (depthScale == null ? 1 : depthScale));
    }
    function fleshTear(arr, x, y, z, s) {
      part(arr, sph(s, 7, 5), x, y, z, bloodC(), 0, 0, 0, 1.4, 1.0, 0.30);
      part(arr, sph(s * 0.55, 6, 5), x, y, z + s * 0.10, goreC(), 0, 0, 0, 1.2, 1.0, 0.30);
    }

    /* ================= TORSO BODY ================= */
    const tParts = [];
    part(tParts, cyl(hipR, hipR * 0.90, H * 0.20, 9, true), 0, H * 0.10, zAt(H * 0.10), skinC(), 0, 0, 0, 1, 1, depth * 1.04);
    part(tParts, cyl(waistR * 1.04, hipR * 0.94, H * 0.24, 9, true), 0, H * 0.32, zAt(H * 0.32), skinC(), 0, 0, 0, 1, 1, depth * 0.90);
    part(tParts, cyl(chestR, waistR * 1.04, H * 0.40, 10, true), 0, H * 0.63, zAt(H * 0.63), skinC(), 0, 0, 0, 1, 1, depth);
    part(tParts, sph(chestR * 0.80, 10, 6), 0, H * 0.88, zAt(H * 0.88), skinC(), 0, 0, 0, 1.32, 0.62, depth * 1.05);
    part(tParts, sph(chestR * 0.34, 8, 6), -P.shoulderX * 0.88, H * 0.91, zAt(H * 0.91), skinC(), 0, 0, 0, 1.25, 0.80, depth * 1.20);
    part(tParts, sph(chestR * 0.34, 8, 6), P.shoulderX * 0.88, H * 0.91, zAt(H * 0.91), skinC(), 0, 0, 0, 1.25, 0.80, depth * 1.20);
    if (isBrute || isBoss) {
      part(tParts, sph(waistR * 1.42, 10, 7), 0, H * 0.44, zAt(H * 0.44) + P.chestD * 0.06, skinC(), 0, 0, 0, 1.05, 0.92, depth * 1.12);
      part(tParts, sph(chestR * 0.52, 9, 7), -chestR * 0.42, H * 0.72, zAt(H * 0.72) + P.chestD * 0.28, skinC(), 0, 0, 0, 1.0, 0.78, 0.55);
      part(tParts, sph(chestR * 0.52, 9, 7), chestR * 0.42, H * 0.72, zAt(H * 0.72) + P.chestD * 0.28, skinC(), 0, 0, 0, 1.0, 0.78, 0.55);
    }
    // exposed spine knobs
    for (let i = 0; i < 6; i++) {
      const f = 0.38 + i * 0.085;
      const y = H * f;
      const rr = waistR + (chestR - waistR) * Math.max(0, (f - 0.38) / 0.58);
      part(tParts, sph(P.waistW * 0.075 + i * 0.0015, 6, 5), 0, y, zAt(y) - rr * depth * 0.88, bruiseC(), 0, 0, 0, 1.15, 1.45, 0.85);
    }

    /* ================= CLOTHING LAYERS ================= */
    const cParts = [];

    if (isWalker) {
      if (V === 0) {
        // long ragged coat
        clothShell(cParts, H * 0.79, H * 0.16, chestR * 1.10, chestR * 1.24, 1.06, cloth2C);
        clothShell(cParts, H * 0.58, H * 0.36, chestR * 1.06, waistR * 1.10, 1.02, clothC);
        clothShell(cParts, H * 0.24, H * 0.34, waistR * 1.10, hipR * 1.20, 1.02, clothC);
        const coatAngles = [-0.55, 0.55, PI, -2.0, 2.0];
        for (let i = 0; i < coatAngles.length; i++) {
          const a = coatAngles[i];
          const px = Math.sin(a) * chestR * 0.85;
          const pz = zAt(H * 0.8) + Math.cos(a) * depth * chestR * 0.95;
          const len = H * (0.95 + rng() * 0.18);
          part(cParts, ribbon(chestR * 0.82, chestR * 0.56, len, 0.020), px, H * 0.82, pz, clothC(), 0.10 + rng() * 0.07, a, (rng() - 0.5) * 0.14);
          if (rng() < 0.8) strip(cParts, px * 1.06, H * 0.82 - len * 0.9, pz, 0.05, 0.02, H * (0.16 + rng() * 0.2), 0.24, a, (rng() - 0.5) * 0.2, cloth2C);
        }
        // collar + hood bunched behind neck
        ragRing(cParts, H * 0.90, chestR * 0.72, depth * chestR * 0.72, 9, 0.05, 0.14, cloth2C, zAt(H * 0.9));
        part(cParts, sph(chestR * 0.45, 8, 6), 0, H * 0.93, zAt(H * 0.93) - depth * chestR * 0.7, cloth2C(), 0, 0, 0, 1.45, 0.55, 0.90);
        part(cParts, ribbon(chestR * 0.8, chestR * 0.3, H * 0.42, 0.022), 0, H * 0.92, zAt(H * 0.92) - depth * chestR * 0.86, cloth2C(), 0.26, PI, 0);
        F.belt = true;
      } else if (V === 1) {
        // torn vest over bare chest, jacket tied at the waist
        clothShell(cParts, H * 0.66, H * 0.30, chestR * 1.07, waistR * 1.08, 1.03, clothC);
        part(cParts, ribbon(chestR * 0.42, chestR * 0.6, H * 0.62, 0.016), -chestR * 0.5, H * 0.86, frontAt(H * 0.8) * 0.94, clothC(), 0.12, 0.5, 0.18);
        part(cParts, ribbon(chestR * 0.42, chestR * 0.6, H * 0.62, 0.016), chestR * 0.5, H * 0.86, frontAt(H * 0.8) * 0.94, clothC(), 0.12, -0.5, -0.18);
        // tied jacket mass at the waist
        part(cParts, sph(waistR * 1.1, 8, 6), -waistR * 0.55, H * 0.36, frontAt(H * 0.36) * 0.92, cloth2C(), 0, 0, 0, 1.2, 0.85, 0.75);
        strip(cParts, -waistR * 0.9, H * 0.33, frontAt(H * 0.33) * 0.85, 0.16, 0.05, H * 0.55, 0.12, 0.3, 0.15, cloth2C);
        strip(cParts, -waistR * 0.5, H * 0.32, frontAt(H * 0.33) * 0.9, 0.14, 0.04, H * 0.42, 0.2, -0.25, -0.12, cloth2C);
        // suspenders
        strip(cParts, -chestR * 0.35, H * 0.6, frontAt(H * 0.7), 0.055, 0.05, H * 0.7, 0.04, 0.0, 0.16, cloth2C);
        strip(cParts, chestR * 0.35, H * 0.6, frontAt(H * 0.7), 0.055, 0.05, H * 0.7, 0.04, 0.0, -0.16, cloth2C);
        ragRing(cParts, H * 0.12, hipR * 1.02, depth * hipR, 8, 0.10, 0.30, clothC, zAt(H * 0.1));
      } else {
        // torn poncho draped over the left shoulder
        part(cParts, ribbon(chestR * 1.2, chestR * 1.5, H * 1.05, 0.024), -chestR * 0.35, H * 0.90, zAt(H * 0.9) + frontAt(H * 0.9) * 0.1, clothC(), 0.10, 0.22, 0.42);
        part(cParts, ribbon(chestR * 1.1, chestR * 1.35, H * 0.95, 0.022), -chestR * 0.3, H * 0.88, zAt(H * 0.88) - depth * chestR * 0.55, cloth2C(), -0.10, 0.18, -0.5);
        clothShell(cParts, H * 0.42, H * 0.34, waistR * 1.10, hipR * 1.16, 1.02, clothC);
        ragRing(cParts, H * 0.12, hipR * 1.02, depth * hipR, 10, 0.12, 0.32, clothC, zAt(H * 0.1));
        part(cParts, sph(chestR * 0.4, 8, 6), 0, H * 0.93, zAt(H * 0.93) - depth * chestR * 0.72, cloth2C(), 0, 0, 0, 1.35, 0.5, 0.85);
        F.belt = true;
      }
    } else if (isRunner) {
      if (V === 0) {
        // hoodie
        clothShell(cParts, H * 0.70, H * 0.34, chestR * 1.14, waistR * 1.16, 1.04, clothC);
        clothShell(cParts, H * 0.24, H * 0.30, waistR * 1.16, hipR * 1.20, 1.03, clothC);
        clothShell(cParts, H * 0.87, H * 0.12, chestR * 1.18, chestR * 1.30, 1.06, cloth2C);
        ragRing(cParts, H * 0.15, hipR * 1.12, depth * hipR * 1.1, 9, 0.04, 0.14, clothC, zAt(H * 0.13));
        // front pocket + drawstrings
        part(cParts, box(chestR * 0.8, H * 0.10, 0.02), 0, H * 0.34, frontAt(H * 0.34) + 0.012, cloth2C());
        strip(cParts, -chestR * 0.18, H * 0.78, frontAt(H * 0.8) + 0.02, 0.025, 0.015, H * 0.24, 0.06, 0, 0.12, cloth2C);
        strip(cParts, chestR * 0.18, H * 0.78, frontAt(H * 0.8) + 0.02, 0.025, 0.015, H * 0.20, 0.06, 0, -0.12, cloth2C);
        fleshTear(cParts, chestR * 0.55, H * 0.55, frontAt(H * 0.55) + 0.006, 0.055);
      } else if (V === 1) {
        // open jacket, bare chest
        clothShell(cParts, H * 0.24, H * 0.28, waistR * 1.10, hipR * 1.14, 1.02, clothC);
        part(cParts, ribbon(chestR * 0.55, chestR * 0.7, H * 0.72, 0.018), -chestR * 0.62, H * 0.88, frontAt(H * 0.85) * 0.92, clothC(), 0.12, 0.55, 0.2);
        part(cParts, ribbon(chestR * 0.55, chestR * 0.7, H * 0.72, 0.018), chestR * 0.62, H * 0.88, frontAt(H * 0.85) * 0.92, clothC(), 0.12, -0.55, -0.2);
        part(cParts, ribbon(chestR * 1.15, chestR * 1.3, H * 0.66, 0.018), 0, H * 0.88, zAt(H * 0.86) - depth * chestR * 0.8, cloth2C(), -0.14, 0, 0);
        part(cParts, sph(waistR * 1.25, 8, 6), waistR * 0.7, H * 0.42, frontAt(H * 0.42) * 0.9, cloth2C(), 0, 0, 0, 1.1, 0.8, 0.6);
        fleshTear(cParts, -chestR * 0.3, H * 0.62, frontAt(H * 0.62) + 0.008, 0.06);
        fleshTear(cParts, chestR * 0.45, H * 0.5, frontAt(H * 0.5) + 0.006, 0.045);
      } else {
        // tank top + taped ribs
        clothShell(cParts, H * 0.6, H * 0.5, chestR * 1.05, waistR * 1.10, 1.02, clothC);
        clothShell(cParts, H * 0.88, H * 0.10, chestR * 1.06, chestR * 1.1, 1.03, cloth2C);
        part(cParts, box(chestR * 1.2, H * 0.09, 0.02), 0, H * 0.62, frontAt(H * 0.62) + 0.012, cloth2C(), 0, 0, 0.28);
        part(cParts, box(chestR * 1.2, H * 0.09, 0.02), 0, H * 0.52, frontAt(H * 0.52) + 0.012, cloth2C(), 0, 0, -0.24);
        ragRing(cParts, H * 0.14, hipR * 1.05, depth * hipR, 7, 0.05, 0.16, cloth2C, zAt(H * 0.12));
      }
    } else if (isBrute) {
      // ragged waist apron / loincloth, chain strap, bone growths
      if (F.apron) {
        clothShell(cParts, H * 0.36, H * 0.16, waistR * 1.12, waistR * 1.16, 1.02, cloth2C);
        strip(cParts, 0, H * 0.34, frontAt(H * 0.34) * 0.94, 0.34, 0.22, H * 0.42, 0.06, 0, 0, clothC);
        strip(cParts, -waistR * 0.7, H * 0.34, frontAt(H * 0.34) * 0.9, 0.20, 0.10, H * 0.3, 0.05, 0.3, 0.14, clothC);
        ragRing(cParts, H * 0.14, hipR * 1.12, depth * hipR * 1.1, 8, 0.08, 0.26, cloth2C, zAt(H * 0.13));
      }
      if (F.chainStrap) {
        for (let i = 0; i < 9; i++) {
          const tt = i / 8;
          const y = H * (0.92 - tt * 0.5);
          const x = -chestR * (0.85 - tt * 0.55);
          const z = frontAt(y) * 0.92 * (1 - tt * 0.1);
          part(cParts, box(0.05, 0.045, 0.05), x, y, z, shade(0x3a3833, 1), 0.2, 0, 0.4);
        }
      }
      if (F.boneGrowth) {
        part(cParts, cyl(0.001, 0.10, 0.42, 5), -P.shoulderX * 1.02, H * 0.95, zAt(H * 0.95), boneC(), -0.5, 0, 0.6);
        part(cParts, cyl(0.001, 0.07, 0.30, 5), -P.shoulderX * 0.7, H * 0.99, zAt(H * 0.99) - 0.1, boneC(), -0.9, 0, 0.9);
      }
      if (F.backSpikes) {
        for (let i = 0; i < 5; i++) {
          const f = 0.42 + i * 0.1;
          const y = H * f;
          part(tParts, cyl(0.001, 0.05 + rng() * 0.03, 0.16 + rng() * 0.16, 5), (rng() - 0.5) * chestR * 0.3, y, frontAt(y) * -0.85, boneC(), -1.25 - rng() * 0.3, 0, 0);
        }
      }
    } else if (isScreamer) {
      if (F.gown) {
        // long hospital gown
        clothShell(cParts, H * 0.72, H * 0.34, chestR * 1.22, chestR * 1.16, 1.06, clothC);
        clothShell(cParts, H * 0.28, H * 0.34, waistR * 1.5, hipR * 1.9, 1.05, clothC);
        part(cParts, cyl(hipR * 1.95, hipR * 2.4, H * 0.9, 10, true), 0, -H * 0.32, zAt(H * 0.1), clothC(), 0, 0, 0, 1, 1, depth * 1.05);
        ragRing(cParts, -H * 0.7, hipR * 2.2, depth * hipR * 2.2, 12, 0.10, 0.38, clothC, 0);
        // hospital wristband
        part(cParts, cyl(P.armR * 1.1, P.armR * 1.1, 0.035, 8, true), -P.shoulderX * 0.9, H * 0.2, frontAt(H * 0.2) * 0.4, shade(0x8d8d7a, 1));
        // blood down the front
        strip(cParts, 0.02, H * 0.6, frontAt(H * 0.6) + 0.012, 0.10, 0.05, H * 0.5, 0.02, 0, 0.05, bloodC);
      } else if (F.gownTorn) {
        // torn gown: panels hanging, exposed back
        clothShell(cParts, H * 0.7, H * 0.28, chestR * 1.2, chestR * 1.12, 1.05, clothC);
        strip(cParts, -chestR * 0.6, H * 0.86, frontAt(H * 0.8) * 0.94, chestR * 0.9, chestR * 1.2, H * 1.15, 0.06, 0.2, 0.18, clothC);
        strip(cParts, chestR * 0.5, H * 0.86, frontAt(H * 0.8) * 0.94, chestR * 0.7, chestR * 0.9, H * 0.95, 0.05, -0.3, -0.1, clothC);
        strip(cParts, 0, H * 0.86, zAt(H * 0.86) - depth * chestR * 0.8, chestR * 1.0, chestR * 1.3, H * 1.1, -0.08, 0, 0, cloth2C);
        ragRing(cParts, H * 0.15, hipR * 1.6, depth * hipR * 1.6, 9, 0.1, 0.32, clothC, zAt(H * 0.1));
        fleshTear(cParts, -chestR * 0.4, H * 0.6, frontAt(H * 0.6) + 0.008, 0.05);
      }
      if (F.strait) {
        for (let i = 0; i < 3; i++) {
          const y = H * (0.42 + i * 0.16);
          part(cParts, cyl(chestR * 1.3, chestR * 1.34, H * 0.07, 10, true), 0, y, zAt(y), cloth2C(), 0, 0, 0, 1, 1, depth * 1.12);
        }
        // straps crossing the back
        strip(cParts, 0, H * 0.6, zAt(H * 0.6) - depth * chestR * 0.85, 0.18, 0.10, H * 0.8, -0.25, PI, 0, cloth2C);
        part(cParts, cyl(P.armR * 1.4, P.armR * 1.4, 0.05, 8, true), -P.shoulderX * 1.6, H * 0.2, 0, cloth2C());
      }
    } else if (isBoss) {
      // charred coat remnants over one shoulder, chain scraps
      part(cParts, ribbon(P.chestW * 0.9, P.chestW * 1.2, H * 0.9, 0.03), -P.shoulderX * 0.7, H * 0.94, zAt(H * 0.9) + 0.02, clothC(), 0.12, 0.3, 0.42);
      part(cParts, ribbon(P.chestW * 0.8, P.chestW * 1.0, H * 0.8, 0.025), -P.shoulderX * 0.6, H * 0.92, zAt(H * 0.9) - P.chestD * 0.6, cloth2C(), -0.1, 0.25, -0.5);
      strip(cParts, 0, H * 0.9, zAt(H * 0.9) - P.chestD * 0.55, 0.4, 0.2, H * 0.7, -0.05, PI, 0.1, clothC);
      for (let i = 0; i < 4; i++) {
        const a = rng() * TAU;
        strip(cParts, Math.sin(a) * P.chestW * 0.4, H * 0.2, zAt(H * 0.2) + Math.cos(a) * P.chestD * 0.4, 0.06, 0.02, H * (0.12 + rng() * 0.16), 0.05, a, 0, clothC);
      }
    }
    // belt (walker/runner)
    if (F.belt) {
      part(cParts, cyl(waistR * 1.20, waistR * 1.20, H * 0.055, 10, true), 0, H * 0.41, zAt(H * 0.41), shade(def.cloth2, 0.55), 0, 0, 0, 1, 1, depth * 1.06);
      part(cParts, box(waistR * 0.30, 0.045, 0.028), 0, H * 0.41, frontAt(H * 0.41) + 0.012, boneC());
      part(cParts, box(waistR * 0.30, 0.10, 0.07), -waistR * 0.85, H * 0.38, frontAt(H * 0.38) * 0.9, darkC());
    }
    // hanging tatters at the hem
    if (isWalker || isRunner || isScreamer) {
      ragRing(cParts, H * 0.12, hipR * 1.06, depth * hipR, 7 + F.tears, 0.08, 0.34, clothC, zAt(H * 0.1));
    }
    // exposed flesh through torn cloth
    if (isWalker || isRunner) {
      for (let i = 0; i < F.tears; i++) {
        const a = -1.1 + rng() * 2.2;
        const y = H * (0.3 + rng() * 0.42);
        fleshTear(cParts, Math.sin(a) * chestR * 0.62, y, frontAt(y) + 0.004, 0.035 + rng() * 0.03);
      }
    }
    // merge body + clothing into the single torso mesh
    for (let i = 0; i < cParts.length; i++) tParts.push(cParts[i]);
    out.torso = mergeParts(tParts);

    /* ================= GORE (separate wet material) ================= */
    let gParts = null;
    if (F.ribs) {
      gParts = [];
      const woundY = H * (isBoss ? 0.66 : 0.64);
      const fz = frontAt(woundY) + 0.006;
      // exposed tissue mass
      part(gParts, sph(chestR * (isBoss ? 0.72 : 0.62), 10, 8), 0, woundY, fz - chestR * 0.18, goreC(), 0, 0, 0, 1.0, 1.25, 0.35);
      // rib bars
      const rows = isBoss ? 5 : 4;
      for (let i = 0; i < rows; i++) {
        const y = woundY - H * 0.14 + i * H * (0.30 / rows);
        const w = chestR * (1.6 - Math.abs(i - (rows - 1) * 0.5) * 0.22);
        part(gParts, box(w, 0.026, 0.030), 0, y, fz + 0.014, boneC(), 0, 0, (i % 2 ? 0.20 : -0.20));
        part(gParts, box(w * 0.55, 0.024, 0.028), 0, y - H * 0.012, fz + 0.02, boneC(), 0, 0, (i % 2 ? 0.15 : -0.15));
      }
      // sternum
      part(gParts, box(0.035, H * 0.30, 0.032), 0, woundY - H * 0.02, fz + 0.024, boneC());
      // organ blobs
      for (let i = 0; i < 3; i++) {
        part(gParts, sph(0.05 + rng() * 0.05, 6, 5), (rng() - 0.5) * chestR * 0.9, woundY + (rng() - 0.5) * H * 0.16, fz - 0.01, goreC(), 0, 0, 0, 1.2, 1.0, 0.6);
      }
      if (F.bellyWound) {
        const by = H * 0.42;
        part(gParts, sph(waistR * 0.8, 9, 7), 0, by, frontAt(by) - waistR * 0.1, goreC(), 0, 0, 0, 1.0, 0.85, 0.4);
        for (let i = 0; i < 3; i++) part(gParts, sph(0.045 + rng() * 0.04, 6, 5), (rng() - 0.5) * waistR, by + (rng() - 0.5) * H * 0.12, frontAt(by) + 0.02, goreC(), 0, 0, 0, 1.3, 1.0, 0.5);
      }
    }
    if (gParts) out.gore = mergeParts(gParts);

    /* ================= HEAD ================= */
    const hParts = [];
    const R = P.headR;
    const neckLen = Math.max(0.04, P.neck);
    part(hParts, cyl(R * 0.40, R * 0.54, neckLen, 7, true), 0, neckLen * 0.52, R * 0.05, skinC(), 0.18, 0, 0);
    for (let i = 0; i < 3; i++) {
      part(hParts, sph(R * 0.095, 6, 5), 0, neckLen * (0.3 + i * 0.26), -R * 0.28 + R * 0.03 * i, boneC(), 0.1, 0, 0, 1.25, 0.8, 0.7);
    }
    const skY = neckLen + R * 0.90;
    const skZ = R * 0.08;
    part(hParts, sph(R, 10, 7), 0, skY, skZ, skinC(), 0, 0, 0, 0.84, 1.02, 1.06);
    part(hParts, sph(R * 0.72, 8, 6), 0, skY + R * 0.24, skZ - R * 0.28, skinC(), 0, 0, 0, 0.92, 0.72, 1.02);
    part(hParts, box(R * 1.02, R * 0.20, R * 0.30), 0, skY + R * 0.25, skZ + R * 0.62, skinC(), 0.22, 0, 0);
    part(hParts, box(R * 0.30, R * 0.36, R * 0.56), -R * 0.44, skY - R * 0.08, skZ + R * 0.36, skinC(), 0, 0.28, -0.12);
    part(hParts, box(R * 0.30, R * 0.36, R * 0.56), R * 0.44, skY - R * 0.08, skZ + R * 0.36, skinC(), 0, -0.28, 0.12);
    part(hParts, box(R * 0.34, R * 0.30, R * 0.22), -R * 0.28, skY + R * 0.04, skZ + R * 0.56, shade(0x0b0908, 1), 0.1, 0.15, 0);
    part(hParts, box(R * 0.34, R * 0.30, R * 0.22), R * 0.28, skY + R * 0.04, skZ + R * 0.56, shade(0x0b0908, 1), 0.1, -0.15, 0);
    part(hParts, box(R * 0.18, R * 0.30, R * 0.28), 0, skY - R * 0.18, skZ + R * 0.72, skinC(), 0.32, 0, 0);
    part(hParts, box(R * 0.66, R * 0.34, R * 0.42), 0, skY - R * 0.32, skZ + R * 0.54, skinC(), 0.12, 0, 0);
    part(hParts, box(R * 0.54, R * 0.22, R * 0.18), 0, skY - R * 0.44, skZ + R * 0.58, shade(0x0a0706, 1));
    for (let i = 0; i < 4; i++) part(hParts, box(R * 0.10, R * 0.13, R * 0.10), (i - 1.5) * R * 0.16, skY - R * 0.38, skZ + R * 0.63, boneC());
    const jawDrop = F.hugeJaw ? 0.75 : F.brokenJaw ? 0.45 : 0.10;
    const jawY = skY - R * 0.60 - R * jawDrop * 0.35;
    const jawZ = skZ + R * 0.34;
    part(hParts, box(R * 0.58, R * 0.26, R * 0.62), 0, jawY, jawZ, skinC(), 0.10 + jawDrop * 0.5, 0, 0);
    part(hParts, box(R * 0.26, R * 0.20, R * 0.26), 0, jawY - R * 0.06, jawZ + R * 0.30, skinC(), 0.15, 0, 0);
    if (F.hugeJaw || F.brokenJaw) {
      part(hParts, box(R * 0.52, R * 0.34, R * 0.20), 0, skY - R * 0.50, skZ + R * 0.52, shade(0x080505, 1));
      for (let i = 0; i < 4; i++) part(hParts, box(R * 0.09, R * 0.12, R * 0.10), (i - 1.5) * R * 0.15, jawY + R * 0.16, jawZ + R * 0.28, boneC());
    }
    part(hParts, box(R * 0.14, R * 0.28, R * 0.18), -R * 0.88, skY - R * 0.02, skZ - R * 0.06, skinC(), 0, 0.25, 0.12);
    part(hParts, box(R * 0.14, R * 0.28, R * 0.18), R * 0.88, skY - R * 0.02, skZ - R * 0.06, skinC(), 0, -0.25, -0.12);
    // hair / hood
    if (F.longHair) {
      for (let i = 0; i < 9; i++) {
        const a = -1.25 + (i / 8) * 2.5;
        part(hParts, ribbon(R * 0.16, R * 0.05, R * (2.4 + rng() * 1.8), 0.008), Math.sin(a) * R * 0.55, skY + R * 0.55, skZ - Math.cos(a) * R * 0.34, darkC(), 0.18, a, 0.05);
      }
    } else if (F.mattedHair) {
      for (let i = 0; i < 7; i++) {
        const a = -1.5 + (i / 6) * 3.0;
        part(hParts, box(R * 0.20, R * 0.10, R * 0.24), Math.sin(a) * R * 0.60, skY + R * 0.76, skZ - Math.cos(a) * R * 0.28, darkC(), (rng() - 0.5) * 0.4, a, 0);
      }
    }
    if (V === 1 || isScreamer) {
      part(hParts, sph(R * 0.34, 7, 5), R * 0.2, skY + R * 0.80, skZ - R * 0.10, bloodC(), 0, 0, 0, 1.3, 0.4, 1.1);
    }
    if (F.hoodUp) {
      part(hParts, cyl(R * 1.25, R * 1.5, R * 0.95, 9, true), 0, skY + R * 0.45, skZ - R * 0.30, cloth2C(), 0.5, 0, 0);
      part(hParts, sph(R * 1.05, 9, 6), 0, skY + R * 0.55, skZ - R * 0.35, clothC(), 0, 0, 0, 1.15, 0.85, 1.1);
      for (let i = 0; i < 7; i++) {
        const a = -1.3 + (i / 6) * 2.6;
        part(hParts, ribbon(R * 0.20, R * 0.08, R * 0.7, 0.010), Math.sin(a) * R * 0.95, skY + R * 0.60, skZ + Math.cos(a) * R * 0.52, clothC(), 0.5, a, 0.2);
      }
    }
    if (isBoss) {
      for (let s = -1; s <= 1; s += 2) {
        part(hParts, cyl(0.001, R * 0.34, R * 1.8, 6), s * R * 0.62, skY + R * 0.55, skZ - R * 0.12, boneC(), -0.35, 0, -s * 0.95);
        part(hParts, cyl(0.001, R * 0.16, R * 0.9, 5), s * R * 0.82, skY + R * 0.05, skZ - R * 0.30, boneC(), -0.8, 0, -s * 1.2);
        part(hParts, cyl(0.001, R * 0.12, R * 0.55, 5), s * R * 0.30, jawY, jawZ + R * 0.44, boneC(), 1.6, 0, 0);
      }
    }
    out.head = mergeParts(hParts);

    /* ---------- EYES ---------- */
    const eParts = [];
    const eyeR = isBoss ? R * 0.32 : R * 0.165;
    const eyeY = skY + R * 0.04;
    const eyeZ = skZ + R * 0.63;
    part(eParts, sph(eyeR, 8, 6), -R * 0.27, eyeY, eyeZ, WHITE, 0, 0, 0, 1, 0.82, 1);
    part(eParts, sph(eyeR, 8, 6), R * 0.27, eyeY, eyeZ, WHITE, 0, 0, 0, 1, 0.82, 1);
    out.eyes = mergeParts(eParts);

    /* ---------- BOSS CHEST CORE ---------- */
    if (isBoss) {
      const cParts = [];
      const coreY = H * 0.64;
      const coreZ = frontAt(coreY) + 0.03;
      part(cParts, sph(P.chestW * 0.13, 10, 8), 0, coreY, coreZ, WHITE);
      part(cParts, cyl(P.chestW * 0.19, P.chestW * 0.19, 0.04, 12), 0, coreY, coreZ - 0.01, WHITE, PI / 2, 0, 0);
      part(cParts, cyl(0.001, P.chestW * 0.07, P.chestW * 0.45, 5), 0, coreY - H * 0.16, coreZ - 0.03, WHITE, 0, 0, 0.2);
      out.core = mergeParts(cParts);
    }

    /* ================= UPPER ARM (pivot at shoulder, extends -Y) ================= */
    function buildUpperArm(side, len, radScale) {
      const ar = P.armR * radScale;
      const L = len;
      const parts = [];
      // deltoid + shoulder joint
      part(parts, sph(ar * 1.75, 9, 7), 0, 0.01, 0, skinC(), 0, 0, 0, 1.1, 0.95, 1.05);
      // curved upper-arm flesh
      part(parts, tube(L * 0.94, ar * 1.08, ar * 0.82, 8, side * 0.010, 0.014, 3), 0, -L * 0.02, 0, skinC());
      part(parts, sph(ar * 1.12, 8, 6), 0, -L * 0.36, 0.012, skinC(), 0, 0, 0, 0.85, 1.45, 0.9);
      // torn sleeve
      if (F.sleeves > 0) {
        const sl = L * 0.60 * F.sleeves;
        part(parts, cyl(ar * 1.42, ar * 1.22, sl, 8, true), 0, -sl * 0.5, 0, clothC());
        part(parts, cyl(ar * 1.24, ar * 1.10, L * 0.09, 8, true), 0, -sl - L * 0.035, 0, cloth2C());
        for (let i = 0; i < 3; i++) {
          const a = rng() * TAU;
          part(parts, ribbon(ar * 0.34, ar * 0.12, L * (0.14 + rng() * 0.14), 0.010), Math.cos(a) * ar * 1.1, -sl - L * 0.02, Math.sin(a) * ar * 1.1, cloth2C(), (rng() - 0.5) * 0.2, a, 0);
        }
      } else if (F.bandageR && side === 1) {
        for (let i = 0; i < 3; i++) {
          part(parts, cyl(ar * 1.18, ar * 1.12, L * 0.10, 8, true), 0, -L * (0.30 + i * 0.16), 0, shade(0x8a8878, 1 + rng() * 0.15));
        }
      }
      if (F.strait && side === 1) {
        part(parts, cyl(ar * 1.5, ar * 1.45, L * 0.4, 8, true), 0, -L * 0.5, 0, cloth2C());
      }
      // elbow knob + torn flesh
      part(parts, sph(ar * 0.86, 8, 6), 0, -L, 0, skinC());
      if (isBrute || isBoss) {
        part(parts, cyl(0.001, ar * 0.30, ar * 1.3, 5), side * ar * 0.9, -L * 0.6, -ar * 0.2, boneC(), -0.3, 0, -side * 0.5);
      }
      return mergeParts(parts);
    }
    out.upperL = buildUpperArm(-1, upLenL, armRadL);
    out.upperR = buildUpperArm(1, upLenR, armRadR);

    /* ================= FOREARM + CLAW HAND ================= */
    function buildForearm(side, len, radScale) {
      const ar = P.armR * radScale;
      const L = len;
      const parts = [];
      part(parts, tube(L * 0.92, ar * 0.98, ar * 0.64, 8, 0.006, 0.012, 3), 0, -L * 0.02, 0, skinC());
      part(parts, sph(ar * 1.00, 8, 6), 0, -L * 0.32, 0.010, skinC(), 0, 0, 0, 0.9, 1.35, 0.9);
      // wrist bones / wrap
      part(parts, sph(ar * 0.55, 7, 5), 0, -L * 0.96, 0, boneC());
      if (F.wristWraps || (F.bandageR && side === 1)) {
        for (let i = 0; i < 2; i++) part(parts, cyl(ar * 1.15, ar * 1.1, L * 0.06, 8, true), 0, -L * (0.72 + i * 0.10), 0, shade(0x86846f, 1 + rng() * 0.2));
      }
      if (F.strait && side === 1) {
        part(parts, cyl(ar * 1.7, ar * 1.6, L * 0.16, 8, true), 0, -L * 0.82, 0, cloth2C());
      }
      // palm
      part(parts, box(ar * 1.40, L * 0.16, ar * 0.95), 0, -L * 1.03, ar * 0.10, skinC(), 0.14, 0, 0);
      // fingers + claws
      for (let f = 0; f < 4; f++) {
        const fx = (f - 1.5) * ar * 0.38;
        const fl = L * (0.11 + ((f === 1 || f === 2) ? 0.05 : 0));
        part(parts, box(ar * 0.22, fl, ar * 0.20), fx, -L * 1.08 - fl * 0.25, ar * 0.24, skinC(), 0.42 + f * 0.05, 0, (f - 1.5) * 0.06);
        part(parts, box(ar * 0.15, fl * 0.75, ar * 0.15), fx, -L * 1.08 - fl * 0.85, ar * 0.42, boneC(), 0.95, 0, 0);
      }
      // thumb
      part(parts, box(ar * 0.22, L * 0.14, ar * 0.20), -side * ar * 0.92, -L * 0.99, ar * 0.20, skinC(), 0.45, side * 0.85, 0);
      // hanging torn cuff rag
      if (F.sleeves > 0 && rng() < 0.7) {
        part(parts, ribbon(ar * 0.5, ar * 0.15, L * 0.22, 0.010), side * ar * 0.7, -L * 0.1, -ar * 0.4, cloth2C(), 0.2, rng() * TAU, 0.3);
      }
      return mergeParts(parts);
    }
    out.foreL = buildForearm(-1, foreLenL, armRadL);
    out.foreR = buildForearm(1, foreLenR, armRadR);

    /* ================= THIGH ================= */
    function buildThigh(side, len) {
      const lr = P.legR;
      const L = len;
      const parts = [];
      part(parts, sph(lr * 1.50, 9, 7), 0, 0, 0, skinC(), 0, 0, 0, 1.05, 1.0, 1.05);
      part(parts, tube(L * 0.95, lr * 1.28, lr * 0.90, 8, side * 0.006, 0.008, 3), 0, -L * 0.02, 0, skinC());
      if (F.pants) {
        part(parts, cyl(lr * 1.40, lr * 1.16, L * 0.78, 8, true), 0, -L * 0.44, 0, clothC());
        part(parts, cyl(lr * 1.22, lr * 1.04, L * 0.06, 8, true), 0, -L * 0.83, 0, cloth2C());
        for (let i = 0; i < 3; i++) {
          const a = rng() * TAU;
          part(parts, ribbon(lr * 0.5, lr * 0.15, L * (0.10 + rng() * 0.14), 0.010), Math.cos(a) * lr * 1.05, -L * 0.82, Math.sin(a) * lr * 1.05, cloth2C(), (rng() - 0.5) * 0.25, a, 0);
        }
      } else {
        // torn shorts / rag
        part(parts, cyl(lr * 1.32, lr * 1.24, L * 0.30, 8, true), 0, -L * 0.17, 0, clothC());
        ragRing(parts, -L * 0.30, lr * 1.2, lr * 1.2, 5, 0.05, 0.14, cloth2C, 0);
      }
      // exposed knee bone
      part(parts, sph(lr * 0.80, 8, 6), 0, -L, 0, boneC(), 0, 0, 0, 1, 0.82, 1);
      return mergeParts(parts);
    }
    out.thighL = buildThigh(-1, thighL);
    out.thighR = buildThigh(1, thighR);

    /* ================= SHIN + FOOT ================= */
    function buildShin(side, len, barefoot) {
      const lr = P.legR;
      const L = len;
      const parts = [];
      part(parts, tube(L * 0.92, lr * 0.92, lr * 0.60, 7, 0.004, 0.010, 3), 0, 0, 0, skinC());
      // shin bone ridge
      part(parts, box(lr * 0.30, L * 0.62, lr * 0.18), 0, -L * 0.45, lr * 0.55, bruiseC(), 0.03, 0, 0);
      if (F.pants && !barefoot) {
        part(parts, cyl(lr * 1.10, lr * 0.96, L * 0.46, 8, true), 0, -L * 0.24, 0, clothC());
        for (let i = 0; i < 3; i++) {
          const a = rng() * TAU;
          part(parts, ribbon(lr * 0.4, lr * 0.12, L * (0.08 + rng() * 0.12), 0.010), Math.cos(a) * lr * 1.02, -L * 0.46, Math.sin(a) * lr * 1.02, cloth2C(), (rng() - 0.5) * 0.2, a, 0);
        }
      }
      if (barefoot) {
        // exposed ankle + bare foot with toes
        part(parts, sph(lr * 0.42, 6, 5), 0, -L * 0.88, 0, boneC());
        part(parts, box(lr * 1.9, L * 0.14, lr * 2.9), 0, -L * 0.97, lr * 0.72, skinC(), 0.04, 0, 0);
        for (let i = 0; i < 5; i++) part(parts, box(lr * 0.28, lr * 0.22, lr * 0.44), (i - 2) * lr * 0.38, -L * 0.99, lr * 1.95, skinC(), 0, 0, 0);
      } else {
        // worn combat boot
        part(parts, cyl(lr * 1.10, lr * 1.02, L * 0.30, 7, true), 0, -L * 0.76, 0, darkC());
        part(parts, box(lr * 2.0, L * 0.15, lr * 3.0), 0, -L * 0.95, lr * 0.70, darkC(), 0.02, 0, 0);
        part(parts, sph(lr * 0.9, 7, 5), 0, -L * 0.89, lr * 1.15, darkC(), 0, 0, 0, 1.0, 0.8, 1.25);
        part(parts, box(lr * 2.1, L * 0.05, lr * 3.1), 0, -L * 1.01, lr * 0.70, shade(0x14100c, 1));
        for (let i = 0; i < 2; i++) part(parts, box(lr * 1.0, L * 0.02, 0.02), 0, -L * 0.70 - i * L * 0.07, lr * 1.16, shade(0x6b6355, 1));
      }
      return mergeParts(parts);
    }
    out.shinL = buildShin(-1, shinL, false);
    out.shinR = buildShin(1, shinR, F.barefootR);

    /* ---------- joint metadata consumed by makeModel / animation ---------- */
    out.meta = {
      hipY: P.hipY,
      torsoH: H,
      headY: H * 0.985,
      headZ: hunch + 0.02,
      hipXL: P.hipHalf,
      hipXR: P.hipHalf * (V === 2 ? 1.05 : 1),
      thighL: thighL, thighR: thighR, shinL: shinL, shinR: shinR,
      shoulderXL: P.shoulderX * (V === 2 ? 0.97 : 1),
      shoulderXR: P.shoulderX * (V === 1 ? 1.02 : 1),
      shoulderYL: P.shoulderY,
      shoulderYR: P.shoulderY + (V === 1 ? 0.012 : 0),
      shoulderZL: zAt(P.shoulderY) + 0.01,
      shoulderZR: zAt(P.shoulderY) + 0.01,
      upperL: upLenL, upperR: upLenR,
      neck: neckLen, headR: R,
    };

    for (let i = 0; i < created.length; i++) created[i].dispose();
    return out;
  }

  /* ============================================================
     makeModel — builds the joint hierarchy from cached geometries.
     Reuses geometry/material; only Groups + Meshes are allocated,
     and those are pooled by the Horde.
     ============================================================ */
  function makeModel(def, geoms, mats, opts) {
    const M = geoms.meta;
    const P = def.prop;
    const cast = opts.castShadows || def.boss;
    const group = new THREE.Group();
    group.name = "z_" + def.key;
    group.userData.zombie = null;
    group.userData.zone = null;

    const hips = new THREE.Group();
    hips.position.set(0, M.hipY, -0.02);
    group.add(hips);

    const torso = new THREE.Group();
    hips.add(torso);

    const meshes = [];
    const hitMeshes = [];

    function addMesh(geo, mat, parent, x, y, z, zone, isHit) {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x || 0, y || 0, z || 0);
      m.castShadow = cast;
      m.receiveShadow = false;
      m.userData.zone = zone || null;
      m.userData.zombie = null;
      parent.add(m);
      if (isHit) hitMeshes.push(m);
      else meshes.push(m);
      return m;
    }

    const torsoMesh = addMesh(geoms.torso, mats.body, torso, 0, 0, 0, "torso", true);
    torsoMesh.name = "torso";
    if (geoms.gore && mats.gore) {
      const goreMesh = addMesh(geoms.gore, mats.gore, torso, 0, 0, 0, null, false);
      goreMesh.name = "gore";
      goreMesh.castShadow = cast;
    }

    const head = new THREE.Group();
    head.position.set(0, M.headY, M.headZ);
    torso.add(head);
    const headMesh = addMesh(geoms.head, mats.skin, head, 0, 0, 0, "head", true);
    headMesh.name = "head";
    const eyeMesh = addMesh(geoms.eyes, mats.eye, head, 0, 0, 0, null, false);
    eyeMesh.castShadow = false;
    if (geoms.core && mats.core) {
      const core = addMesh(geoms.core, mats.core, torso, 0, 0, 0, null, false);
      core.name = "core";
      core.castShadow = false;
    }

    function buildArm(side, geoUpper, geoFore, shX, shY, shZ, upperLen) {
      const sh = new THREE.Group();
      sh.position.set(side * shX, shY, shZ);
      torso.add(sh);
      addMesh(geoUpper, mats.cloth, sh, 0, 0, 0, "limb", true);
      const el = new THREE.Group();
      el.position.y = -upperLen;
      sh.add(el);
      addMesh(geoFore, mats.skin, el, 0, 0, 0, "limb", true);
      return { sh: sh, el: el };
    }
    const armL = buildArm(-1, geoms.upperL, geoms.foreL, M.shoulderXL, M.shoulderYL, M.shoulderZL, M.upperL);
    const armR = buildArm(1, geoms.upperR, geoms.foreR, M.shoulderXR, M.shoulderYR, M.shoulderZR, M.upperR);
    // forearms do not need to cast shadows: keeps the shadow pass cheap
    armL.el.children[0].castShadow = !!def.boss;
    armR.el.children[0].castShadow = !!def.boss;

    function buildLeg(side, geoThigh, geoShin, hipX, thighLen) {
      const th = new THREE.Group();
      th.position.set(side * hipX, 0, 0);
      hips.add(th);
      addMesh(geoThigh, mats.cloth, th, 0, 0, 0, "limb", true);
      const kn = new THREE.Group();
      kn.position.y = -thighLen;
      th.add(kn);
      addMesh(geoShin, mats.cloth, kn, 0, 0, 0, "limb", true);
      return { th: th, kn: kn };
    }
    const legL = buildLeg(-1, geoms.thighL, geoms.shinL, M.hipXL, M.thighL);
    const legR = buildLeg(1, geoms.thighR, geoms.shinR, M.hipXR, M.thighR);
    legL.kn.children[0].castShadow = !!def.boss;
    legR.kn.children[0].castShadow = !!def.boss;

    /* generous invisible hit boxes for the two vital zones */
    const headProxy = new THREE.Mesh(opts.unitSphere, opts.proxyMat);
    headProxy.visible = false;
    headProxy.position.set(0, M.neck * 0.55 + M.headR * 0.92, M.headR * 0.30);
    headProxy.scale.set(M.headR * 1.62, M.headR * 1.76, M.headR * 1.58);
    headProxy.userData.zone = "head";
    headProxy.userData.zombie = null;
    head.add(headProxy);
    hitMeshes.push(headProxy);

    const torsoProxy = new THREE.Mesh(opts.unitBox, opts.proxyMat);
    torsoProxy.visible = false;
    torsoProxy.position.set(0, M.torsoH * 0.52, M.headZ * 0.5 + 0.02);
    torsoProxy.scale.set(P.chestW * 1.02, M.torsoH * 1.0, P.chestD * 1.5);
    torsoProxy.userData.zone = "torso";
    torsoProxy.userData.zombie = null;
    torso.add(torsoProxy);
    hitMeshes.push(torsoProxy);

    return {
      key: def.key,
      def: def,
      group: group,
      hips: hips,
      torso: torso,
      head: head,
      eye: null,
      core: null,
      gore: null,
      shL: armL.sh, elL: armL.el,
      shR: armR.sh, elR: armR.el,
      thL: legL.th, knL: legL.kn,
      thR: legR.th, knR: legR.kn,
      meshes: meshes,
      hitMeshes: hitMeshes,
      P: P,
      meta: M,
    };
  }

  function resetModelPose(m) {
    const M = m.meta;
    m.group.position.set(0, 0, 0);
    m.group.rotation.set(0, 0, 0);
    m.hips.position.set(0, M.hipY, -0.02);
    m.hips.rotation.set(0, 0, 0);
    m.torso.position.set(0, 0, 0);
    m.torso.rotation.set(0, 0, 0);
    m.head.position.set(0, M.headY, M.headZ);
    m.head.rotation.set(0, 0, 0);
    m.shL.position.set(-M.shoulderXL, M.shoulderYL, M.shoulderZL);
    m.shR.position.set(M.shoulderXR, M.shoulderYR, M.shoulderZR);
    m.shL.rotation.set(0, 0, 0);
    m.shR.rotation.set(0, 0, 0);
    m.elL.position.set(0, -M.upperL, 0);
    m.elR.position.set(0, -M.upperR, 0);
    m.elL.rotation.set(0, 0, 0);
    m.elR.rotation.set(0, 0, 0);
    m.thL.position.set(-M.hipXL, 0, 0);
    m.thR.position.set(M.hipXR, 0, 0);
    m.thL.rotation.set(0, 0, 0);
    m.thR.rotation.set(0, 0, 0);
    m.knL.position.set(0, -M.thighL, 0);
    m.knR.position.set(0, -M.thighR, 0);
    m.knL.rotation.set(0, 0, 0);
    m.knR.rotation.set(0, 0, 0);
  }

  /* ============================================================
     DL.Horde
     ============================================================ */
  class Horde {
    constructor(opts) {
      opts = opts || {};
      this.scene = opts.scene || null;
      this.world = opts.world || {};
      this.audio = opts.audio || null;
      this.getPlayer = typeof opts.getPlayer === "function" ? opts.getPlayer : null;
      this.getGenerator = typeof opts.getGenerator === "function" ? opts.getGenerator : null;
      this.callbacks = opts.callbacks || {};
      this.quality = opts.quality || { level: "high" };
      this._level = this.quality.level || "high";
      this._cap = this._level === "low" ? 16 : this._level === "medium" ? 20 : 24;
      this._castShadows = this._level !== "low";

      this._wave = 0;
      this.zombies = [];
      this._aliveCount = 0;
      this._totalInWave = 0;
      this._spawnedCount = 0;
      this._queue = [];
      this._spawnClock = 0;
      this._spawnGapTimer = 0;
      this._waveActive = false;
      this._waveCompleteFired = false;

      this._elapsed = 0;
      this._pathBudget = 0;
      this._aim = [];
      this._aimDirty = true;

      this._modelPools = { walker: [], runner: [], brute: [], screamer: [], boss: [] };
      this._geomCache = {};
      this._geoms = [];
      this._mats = [];
      this._texs = [];
      this._matsByType = {};
      this._variantCounter = 0;

      this._fx = [];
      this._fxIndex = 0;
      this._lastSound = {};
      this._ambientCd = 4;
      this._disposed = false;

      this._buildAssets();
      // Pre-build every geometry variant behind the loading screen so no zombie
      // spawn ever incurs a geometry-build hitch mid-wave.
      for (const typeKey in ZDEF) {
        for (let variant = 0; variant < 3; variant++) this._getGeomSet(typeKey, variant);
      }
    }

    /* ---------------- procedural textures / materials ---------------- */
    /* ---------------- procedural textures / materials ---------------- */
    _buildAssets() {
      const rng = DL.mulberry32(0x51a7c0de);
      const TEX = 256;

      /* decayed, stained cloth */
      const clothCanvas = DL.noiseTexture(TEX, TEX, { base: [174, 166, 150], variance: 46, grain: 30, scale: 4, seed: 5, streak: 16 });
      const cctx = clothCanvas.getContext("2d", { willReadFrequently: true });
      cctx.globalAlpha = 0.16;
      cctx.strokeStyle = "#0c0b08";
      cctx.lineWidth = 1;
      for (let y = 2; y < TEX; y += 3) {
        cctx.beginPath();
        cctx.moveTo(0, y);
        cctx.lineTo(TEX, y);
        cctx.stroke();
      }
      cctx.globalAlpha = 0.09;
      for (let x = 2; x < TEX; x += 4) {
        cctx.beginPath();
        cctx.moveTo(x, 0);
        cctx.lineTo(x, TEX);
        cctx.stroke();
      }
      cctx.globalAlpha = 1;
      this._drawGrime(cctx, TEX, TEX, rng, 12);
      this._drawBlood(cctx, TEX, TEX, rng, 18);
      this._drawMud(cctx, TEX, TEX, rng, 9);

      /* bruised, necrotic skin */
      const skinCanvas = DL.noiseTexture(TEX, TEX, { base: [176, 168, 154], variance: 40, grain: 30, scale: 6, seed: 12 });
      const sctx = skinCanvas.getContext("2d", { willReadFrequently: true });
      this._drawVeins(sctx, TEX, TEX, rng, 24);
      this._drawBruises(sctx, TEX, TEX, rng, 11);
      this._drawRot(sctx, TEX, TEX, rng, 7);
      this._drawBlood(sctx, TEX, TEX, rng, 9);

      const clothTex = DL.canvasTexture(clothCanvas, 2, 2, true);
      const skinTex = DL.canvasTexture(skinCanvas, 2, 2, true);
      clothTex.anisotropy = 8;
      skinTex.anisotropy = 8;
      const clothNorm = DL.normalMapFromHeight(clothCanvas, 2.6);
      clothNorm.wrapS = clothNorm.wrapT = THREE.RepeatWrapping;
      clothNorm.repeat.set(2, 2);
      const skinNorm = DL.normalMapFromHeight(skinCanvas, 2.9);
      skinNorm.wrapS = skinNorm.wrapT = THREE.RepeatWrapping;
      skinNorm.repeat.set(2, 2);
      this._texs.push(clothTex, skinTex, clothNorm, skinNorm);

      /* shared body materials — vertex colours carry type palette + grime */
      this._clothMat = new THREE.MeshStandardMaterial({
        map: clothTex, normalMap: clothNorm, normalScale: new THREE.Vector2(1.8, 1.8),
        vertexColors: true, roughness: 0.95, metalness: 0.02,
        color: 0xdedad2, envMapIntensity: 0.28,
      });
      this._skinMat = new THREE.MeshStandardMaterial({
        map: skinTex, normalMap: skinNorm, normalScale: new THREE.Vector2(1.65, 1.65),
        vertexColors: true, roughness: 0.86, metalness: 0.02,
        color: 0xdedad2, envMapIntensity: 0.26,
      });
      this._goreMat = new THREE.MeshStandardMaterial({
        map: skinTex, normalMap: skinNorm, normalScale: new THREE.Vector2(1.6, 1.6),
        vertexColors: true, roughness: 0.5, metalness: 0.06,
        color: 0xe8e4dc, envMapIntensity: 0.22,
      });
      this._mats.push(this._clothMat, this._skinMat, this._goreMat);

      for (const key in ZDEF) {
        const def = ZDEF[key];
        const eye = new THREE.MeshStandardMaterial({
          color: 0x050404, emissive: def.eye, emissiveIntensity: def.eyeInt,
          roughness: 0.35, metalness: 0.0,
        });
        this._mats.push(eye);
        const mats = {
          cloth: this._clothMat,
          skin: this._skinMat,
          gore: this._goreMat,
          eye: eye,
          core: null,
          body: def.key === "brute" || def.boss ? this._skinMat : this._clothMat,
        };
        if (def.boss) {
          mats.core = new THREE.MeshStandardMaterial({
            color: 0x120603, emissive: 0xff3306, emissiveIntensity: 2.4,
            roughness: 0.42, metalness: 0.1,
          });
          this._mats.push(mats.core);
        }
        this._matsByType[key] = mats;
      }

      this._proxyMat = new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide });
      this._mats.push(this._proxyMat);
      this._unitSphere = new THREE.SphereGeometry(1, 8, 6);
      this._unitBox = new THREE.BoxGeometry(1, 1, 1);
      this._geoms.push(this._unitSphere, this._unitBox);

      this._fxGeo = new THREE.RingGeometry(0.86, 1, 48, 1);
      this._geoms.push(this._fxGeo);
    }

    _drawBlood(ctx, w, h, rng, count) {
      ctx.save();
      for (let i = 0; i < count; i++) {
        const x = rng() * w;
        const y = rng() * h;
        const r = 5 + rng() * w * 0.11;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, "rgba(48,9,7,0.92)");
        g.addColorStop(0.55, "rgba(36,7,5,0.55)");
        g.addColorStop(1, "rgba(24,5,4,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.fill();
        const drips = 2 + ((rng() * 5) | 0);
        for (let d = 0; d < drips; d++) {
          const dx = x + (rng() - 0.5) * r * 1.6;
          const dy = y + r * (0.2 + rng() * 0.5);
          const dh = r * (0.6 + rng() * 2.6);
          ctx.strokeStyle = "rgba(38,7,5,0.62)";
          ctx.lineWidth = 1 + rng() * 2.0;
          ctx.beginPath();
          ctx.moveTo(dx, dy);
          ctx.lineTo(dx + (rng() - 0.5) * 2, dy + dh);
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    _drawMud(ctx, w, h, rng, count) {
      ctx.save();
      for (let i = 0; i < count; i++) {
        const x = rng() * w;
        const y = rng() * h;
        const r = 8 + rng() * w * 0.15;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, "rgba(30, 25, 17,0.62)");
        g.addColorStop(0.6, "rgba(26, 21, 14,0.3)");
        g.addColorStop(1, "rgba(22, 18, 12,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }

    _drawGrime(ctx, w, h, rng, count) {
      ctx.save();
      for (let i = 0; i < count; i++) {
        const x = rng() * w;
        const y = rng() * h;
        const r = 14 + rng() * w * 0.24;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, "rgba(26, 22, 16,0.5)");
        g.addColorStop(0.55, "rgba(22, 19, 14,0.24)");
        g.addColorStop(1, "rgba(20, 17, 12,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.fill();
      }
      // vertical filth streaks
      const streak = 4 + ((rng() * 6) | 0);
      for (let i = 0; i < streak; i++) {
        const x = rng() * w;
        const y = rng() * h * 0.5;
        const len = h * (0.2 + rng() * 0.6);
        ctx.strokeStyle = "rgba(22, 18, 13,0.22)";
        ctx.lineWidth = 1 + rng() * 3.5;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + (rng() - 0.5) * 10, y + len);
        ctx.stroke();
      }
      ctx.restore();
    }

    _drawVeins(ctx, w, h, rng, count) {
      ctx.save();
      ctx.strokeStyle = "rgba(38, 30, 44,0.42)";
      for (let i = 0; i < count; i++) {
        let x = rng() * w;
        let y = rng() * h;
        ctx.lineWidth = 0.7 + rng() * 1.3;
        ctx.beginPath();
        ctx.moveTo(x, y);
        const seg = 3 + ((rng() * 3) | 0);
        for (let s = 0; s < seg; s++) {
          x += (rng() - 0.5) * 34;
          y += (rng() - 0.5) * 34;
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    _drawBruises(ctx, w, h, rng, count) {
      ctx.save();
      for (let i = 0; i < count; i++) {
        const x = rng() * w;
        const y = rng() * h;
        const r = 10 + rng() * 30;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, "rgba(56, 44, 56,0.5)");
        g.addColorStop(0.5, "rgba(48, 38, 48,0.28)");
        g.addColorStop(1, "rgba(42, 34, 42,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.fill();
        // mottled spots
        for (let k = 0; k < 4; k++) {
          const rr = 1.5 + rng() * 5;
          ctx.fillStyle = "rgba(38, 30, 40,0.3)";
          ctx.beginPath();
          ctx.arc(x + (rng() - 0.5) * r * 1.4, y + (rng() - 0.5) * r * 1.4, rr, 0, TAU);
          ctx.fill();
        }
      }
      ctx.restore();
    }

    _drawRot(ctx, w, h, rng, count) {
      ctx.save();
      for (let i = 0; i < count; i++) {
        const x = rng() * w;
        const y = rng() * h;
        const r = 8 + rng() * 22;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, "rgba(40, 40, 28,0.6)");
        g.addColorStop(0.45, "rgba(34, 34, 24,0.34)");
        g.addColorStop(1, "rgba(30, 30, 22,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.fill();
        for (let k = 0; k < 5; k++) {
          const rr = 1 + rng() * 3.5;
          ctx.fillStyle = "rgba(22, 20, 16,0.45)";
          ctx.beginPath();
          ctx.arc(x + (rng() - 0.5) * r * 1.3, y + (rng() - 0.5) * r * 1.3, rr, 0, TAU);
          ctx.fill();
        }
      }
      ctx.restore();
    }

    /* ---------------- lightweight world accessors ---------------- */
    _getPlayer() {
      if (!this.getPlayer) return null;
      const p = this.getPlayer();
      if (!p || p.alive === false) return null;
      return p;
    }

    _getGenerator() {
      let gen = null;
      if (this.getGenerator) gen = this.getGenerator();
      if (!gen && this.world) gen = this.world.generator;
      if (!gen || gen.broken) return null;
      return gen;
    }

    _nav() {
      return (this.world && this.world.nav) || null;
    }

    _worldBlocked(x, z, r) {
      const nav = this._nav();
      if (nav && nav.isBlockedWorld && nav.isBlockedWorld(x, z)) return true;
      const w = this.world;
      if (w && typeof w.isBlocked === "function") {
        if (w.isBlocked(x, z, r)) return true;
      }
      return false;
    }

    /* ---------------- wave director ---------------- */
    startWave(waveNumber) {
      if (this._disposed) return;
      const n = Math.max(1, Math.floor(waveNumber || 1));
      this._clearInternal();
      this._wave = n;

      const list = this._composeWave(n);
      const rng = DL.mulberry32((0x51ed + n * 7919) >>> 0);
      for (let i = list.length - 1; i > 0; i--) {
        const j = (rng() * (i + 1)) | 0;
        const t = list[i];
        list[i] = list[j];
        list[j] = t;
      }
      const bossAt = list.indexOf("boss");
      if (bossAt >= 0) {
        list.splice(bossAt, 1);
        const at = Math.min(list.length, Math.max(1, Math.round(list.length * 0.45)));
        list.splice(at, 0, "boss");
      }

      const interval = this._spawnIntervalFor(n);
      let t = 0.9;
      this._queue.length = 0;
      for (let i = 0; i < list.length; i++) {
        this._queue.push({ type: list[i], at: t });
        t += interval * (0.72 + rng() * 0.56);
      }
      this._totalInWave = list.length;
      this._spawnedCount = 0;
      this._spawnClock = 0;
      this._spawnGapTimer = 0;
      this._waveActive = true;
      this._waveCompleteFired = false;
      this._pathBudget = 0;
    }

    _composeWave(n) {
      const table = WAVES[n];
      const list = [];
      if (table) {
        for (let i = 0; i < table.length; i++) {
          const entry = table[i];
          for (let k = 0; k < entry[1]; k++) list.push(entry[0]);
        }
      } else {
        const extra = n - 8;
        const gen = [
          ["walker", 20 + extra * 4],
          ["runner", 14 + extra * 3],
          ["brute", 10 + extra * 2],
          ["screamer", 3],
        ];
        for (let i = 0; i < gen.length; i++) {
          for (let k = 0; k < gen[i][1]; k++) list.push(gen[i][0]);
        }
      }
      return list;
    }

    _spawnIntervalFor(n) {
      if (n >= 8) return 0.62;
      return 2.0 - (n - 1) * 0.19;
    }

    _hpScale(def, wave) {
      const w = Math.max(1, wave);
      return 1 + 0.13 * (w - 1) * (def.hpWave == null ? 1 : def.hpWave);
    }

    _dmgScale(def, wave) {
      const w = Math.max(1, wave);
      return Math.min(1.8, 1 + 0.07 * (w - 1) * (def.dmgWave == null ? 1 : def.dmgWave));
    }

    _rollTarget(def) {
      const r = Math.random();
      if (def.boss) return r < 0.82 ? "player" : "generator";
      if (def.key === "brute") return r < 0.40 ? "player" : r < 0.68 ? "generator" : "barricade";
      if (def.key === "runner") return r < 0.86 ? "player" : r < 0.96 ? "generator" : "barricade";
      if (def.key === "screamer") return r < 0.85 ? "player" : "generator";
      return r < 0.68 ? "player" : r < 0.88 ? "generator" : "barricade";
    }

    _updateSpawner(dt) {
      if (!this._waveActive) return;
      this._spawnClock += dt;
      if (this._spawnGapTimer > 0) this._spawnGapTimer -= dt;
      let guard = 0;
      while (this._queue.length && this._spawnGapTimer <= 0 && this._aliveCount < this._cap && guard < 6) {
        const item = this._queue[0];
        if (item.at > this._spawnClock) break;
        this._queue.shift();
        this._spawnZombie(item.type);
        this._spawnGapTimer = 0.16;
        guard++;
      }
    }

    _pickSpawnPoint() {
      const pts = this.world && this.world.spawnPoints;
      const player = this._getPlayer();
      let x = 0;
      let z = 0;
      for (let attempt = 0; attempt < 10; attempt++) {
        if (pts && pts.length) {
          const p = pts[(Math.random() * pts.length) | 0];
          x = p.x + rand(-2.5, 2.5);
          z = p.z + rand(-2.5, 2.5);
        } else {
          const a = Math.random() * TAU;
          const r = 34 + Math.random() * 12;
          x = Math.cos(a) * r;
          z = Math.sin(a) * r;
        }
        if (player && player.position) {
          const dx = x - player.position.x;
          const dz = z - player.position.z;
          if (dx * dx + dz * dz < 18 * 18) continue;
        }
        const nav = this._nav();
        if (nav && nav.nearestOpen) {
          const q = nav.nearestOpen(x, z, 8);
          if (q) { x = q.x; z = q.z; }
        }
        return { x: x, z: z };
      }
      return { x: x, z: z };
    }

    _spawnZombie(typeKey) {
      const def = ZDEF[typeKey] || ZDEF.walker;
      const model = this._acquireModel(typeKey);
      const sp = this._pickSpawnPoint();
      const player = this._getPlayer();
      const yaw = player && player.position
        ? Math.atan2(player.position.x - sp.x, player.position.z - sp.z)
        : Math.atan2(-sp.x, -sp.z);

      model.group.position.set(sp.x, 0, sp.z);
      model.group.rotation.set(0, yaw, 0);
      model.group.visible = true;

      // per-zombie body asymmetry: no two instances share the same stance
      const M = model.meta;
      const as = {
        phaseL: rand(-0.35, 0.35), phaseR: rand(-0.35, 0.35),
        armAmpL: rand(0.82, 1.12), armAmpR: rand(0.82, 1.12),
        armBaseL: rand(-0.14, 0.14), armBaseR: rand(-0.14, 0.14),
        legAmpL: rand(0.85, 1.10), legAmpR: rand(0.85, 1.10),
        hunch: rand(-0.03, 0.05), tilt: rand(-0.05, 0.05), twist: rand(-0.08, 0.08),
        headTilt: rand(-0.07, 0.09), headX: rand(-0.012, 0.012), headY: rand(-0.012, 0.012),
        hipX: rand(-0.012, 0.012),
        shLX: rand(-0.010, 0.010), shRX: rand(-0.010, 0.010),
        shLY: rand(-0.015, 0.010), shRY: rand(-0.010, 0.015),
        dragSide: Math.random() < 0.5 ? -1 : 1,
        stride: rand(0.92, 1.08),
      };
      model.hips.position.x = as.hipX;
      model.shL.position.x = -M.shoulderXL + as.shLX;
      model.shR.position.x = M.shoulderXR + as.shRX;
      model.shL.position.y = M.shoulderYL + as.shLY;
      model.shR.position.y = M.shoulderYR + as.shRY;
      model.head.position.x = as.headX;
      model.head.position.y = M.headY + as.headY;

      const z = {
        type: def.key,
        def: def,
        model: model,
        group: model.group,
        pos: model.group.position,
        position: model.group.position,
        yaw: yaw,
        asym: as,
        tgt: new THREE.Vector3(sp.x, 0, sp.z),
        path: null,
        pathIndex: 0,
        pathGoal: new THREE.Vector3(sp.x, 0, sp.z),
        state: "spawning",
        stateT: 0,
        spawnDur: def.boss ? 2.2 : def.key === "brute" ? 1.15 : 0.85,
        hp: 0,
        maxHp: 0,
        damage: 0,
        speed: def.speed,
        radius: def.radius,
        alive: true,
        dead: false,
        attackCd: rand(0.6, 1.6),
        atkT: 0,
        atkKind: null,
        atkTarget: null,
        struck: false,
        repathCd: rand(0.15, 0.7),
        staggerT: 0,
        staggerMax: 0.3,
        headSnap: 0,
        walkPhase: rand(0, TAU),
        phaseOff: rand(0, TAU),
        buffTimer: 0,
        aggroCd: rand(0, 0.4),
        screamCd: rand(3, 8),
        shriekT: 0,
        slamCd: rand(4, 7),
        slamT: 0,
        slamPhase: 0,
        roarCd: rand(6, 12),
        roarT: 0,
        targetKind: this._rollTarget(def),
        targetRef: null,
        barricade: null,
        dyingT: 0,
        deathPitch: Math.random() < 0.5 ? 1 : -1,
        deathRoll: rand(-0.4, 0.4),
        sepX: 0,
        sepZ: 0,
        stuckT: 0,
        strafeT: 0,
        strafeSign: Math.random() < 0.5 ? 1 : -1,
        lastHitSound: 0,
        hitFlash: 0,
        isBoss: !!def.boss,
      };
      z.maxHp = Math.max(1, Math.round(def.hp * this._hpScale(def, this._wave)));
      z.hp = z.maxHp;
      z.damage = def.damage * this._dmgScale(def, this._wave);

      for (let i = 0; i < model.hitMeshes.length; i++) model.hitMeshes[i].userData.zombie = z;
      model.group.userData.zombie = z;

      if (this.scene) this.scene.add(model.group);
      this.zombies.push(z);
      this._aliveCount++;
      this._spawnedCount++;
      this._aimDirty = true;

      if (def.boss) {
        this._sound("brute_roar", z.pos, { volume: 1.0, rate: 0.82 });
        this._fxRing(z.pos.x, z.pos.z, 1.2, 9, 1.6, 0xff2a0a, 0.55);
      } else if (Math.random() < 0.45) {
        this._sound("zombie_growl", z.pos, { volume: 0.5, rate: 0.72 + Math.random() * 0.55 });
      }

      const cb = this.callbacks;
      if (cb.onSpawn) cb.onSpawn(z);
      if (def.boss && cb.onBossSpawn) cb.onBossSpawn(z);
    }

    _destroyZombie(z) {
      if (z.model) {
        const model = z.model;
        if (model.group.parent) model.group.parent.remove(model.group);
        for (let i = 0; i < model.hitMeshes.length; i++) model.hitMeshes[i].userData.zombie = null;
        model.group.userData.zombie = null;
        const pool = this._modelPools[z.type];
        if (pool && pool.length < 32) pool.push(model);
      }
      z.model = null;
      z.group = null;
      z.pos = null;
      z.position = null;
      z.alive = false;
      z.dead = true;
    }

    /* ---------------- model cache / pooling ---------------- */
    _getGeomSet(typeKey, variant) {
      const key = typeKey + ":" + variant;
      let set = this._geomCache[key];
      if (!set) {
        set = buildGeoms(ZDEF[typeKey], variant);
        this._geomCache[key] = set;
        for (const k in set) {
          const g = set[k];
          if (g && g.isBufferGeometry) this._geoms.push(g);
        }
      }
      return set;
    }

    _makeModel(typeKey, variant) {
      return makeModel(ZDEF[typeKey], this._getGeomSet(typeKey, variant), this._matsByType[typeKey], {
        unitSphere: this._unitSphere,
        unitBox: this._unitBox,
        proxyMat: this._proxyMat,
        castShadows: this._castShadows,
      });
    }

    _acquireModel(typeKey) {
      const pool = this._modelPools[typeKey];
      let model = pool.length ? pool.pop() : null;
      if (!model) {
        const variant = this._variantCounter % 3;
        this._variantCounter++;
        model = this._makeModel(typeKey, variant);
      }
      resetModelPose(model);
      return model;
    }

    /* ---------------- aim / query API ---------------- */
    _rebuildAim() {
      this._aim.length = 0;
      for (let i = 0; i < this.zombies.length; i++) {
        const z = this.zombies[i];
        if (z.dead || z.state === "dying" || !z.model) continue;
        const hs = z.model.hitMeshes;
        for (let k = 0; k < hs.length; k++) this._aim.push(hs[k]);
      }
      this._aimDirty = false;
    }

    getAimMeshes() {
      if (this._aimDirty) this._rebuildAim();
      return this._aim;
    }

    get aliveCount() { return this._aliveCount; }
    get remainingToSpawn() { return this._queue.length; }
    get totalInWave() { return this._totalInWave; }
    get spawnedCount() { return this._spawnedCount; }
    get wave() { return this._wave; }
    get boss() {
      for (let i = 0; i < this.zombies.length; i++) {
        const z = this.zombies[i];
        if (z.isBoss && !z.dead) return z;
      }
      return null;
    }

    /* ---------------- teardown ---------------- */
    _clearInternal() {
      for (let i = this.zombies.length - 1; i >= 0; i--) this._destroyZombie(this.zombies[i]);
      this.zombies.length = 0;
      this._aliveCount = 0;
      this._queue.length = 0;
      this._totalInWave = 0;
      this._spawnedCount = 0;
      this._spawnClock = 0;
      this._spawnGapTimer = 0;
      this._waveActive = false;
      this._waveCompleteFired = false;
      this._pathBudget = 0;
      this._aim.length = 0;
      this._aimDirty = true;
    }

    clear() {
      if (this._disposed) return;
      this._clearInternal();
      this._wave = 0;
    }

    dispose() {
      if (this._disposed) return;
      this._clearInternal();
      this._wave = 0;
      for (let i = 0; i < this._geoms.length; i++) {
        if (this._geoms[i] && this._geoms[i].dispose) this._geoms[i].dispose();
      }
      for (let i = 0; i < this._mats.length; i++) {
        if (this._mats[i] && this._mats[i].dispose) this._mats[i].dispose();
      }
      for (let i = 0; i < this._texs.length; i++) {
        if (this._texs[i] && this._texs[i].dispose) this._texs[i].dispose();
      }
      for (let i = 0; i < this._fx.length; i++) {
        const f = this._fx[i];
        if (f.mesh && f.mesh.parent) f.mesh.parent.remove(f.mesh);
        if (f.mat) f.mat.dispose();
      }
      this._geoms.length = 0;
      this._mats.length = 0;
      this._texs.length = 0;
      this._fx.length = 0;
      this._geomCache = {};
      this._modelPools = { walker: [], runner: [], brute: [], screamer: [], boss: [] };
      this._disposed = true;
    }

    /* ============================================================
       MAIN UPDATE
       ============================================================ */
    update(dt, elapsed) {
      if (this._disposed) return;
      if (elapsed != null) this._elapsed = elapsed;
      if (!(dt > 0)) dt = 0;
      if (dt > 0.09) dt = 0.09;
      this._pathBudget = 5;

      this._updateSpawner(dt);

      const zs = this.zombies;
      for (let i = 0; i < zs.length; i++) {
        zs[i].sepX = 0;
        zs[i].sepZ = 0;
      }
      this._separate();
      for (let i = zs.length - 1; i >= 0; i--) {
        const z = zs[i];
        this._updateZombie(z, dt);
        if (z.removeMe) {
          this._destroyZombie(z);
          const last = zs.pop();
          if (last !== z) zs[i] = last;
        }
      }
      this._updateFx(dt);
      this._ambientAudio(dt);
      this._checkWaveComplete();
    }

    _distXZ(a, b) {
      const dx = a.x - b.x;
      const dz = a.z - b.z;
      return Math.sqrt(dx * dx + dz * dz);
    }

    _hasLine(a, b) {
      const nav = this._nav();
      if (nav && nav.hasLine) return nav.hasLine(a.x, a.z, b.x, b.z);
      return true;
    }

    /* geometric eye-line used for close-range aggro: walls and intact gates block it */
    _clearLine(a, b) {
      const w = this.world;
      if (!w) return true;
      const list = w.barricades;
      if (list) {
        for (let i = 0; i < list.length; i++) {
          const br = list[i];
          if (!br || br.broken || !br.collider) continue;
          if (DL.segmentAABB(a.x, a.z, b.x, b.z, br.collider)) return false;
        }
      }
      const cols = w.colliders;
      if (cols) {
        for (let i = 0; i < cols.length; i++) {
          const c = cols[i];
          if (!c) continue;
          if (c.height != null && c.height < 1.3) continue;
          if (DL.segmentAABB(a.x, a.z, b.x, b.z, c)) return false;
        }
      }
      return true;
    }

    _separate() {
      const zs = this.zombies;
      for (let i = 0; i < zs.length; i++) {
        const a = zs[i];
        if (a.dead || a.state === "dying" || a.state === "spawning") continue;
        const ap = a.pos;
        for (let j = i + 1; j < zs.length; j++) {
          const b = zs[j];
          if (b.dead || b.state === "dying" || b.state === "spawning") continue;
          const dx = b.pos.x - ap.x;
          const dz = b.pos.z - ap.z;
          const minD = a.radius + b.radius;
          const d2 = dx * dx + dz * dz;
          if (d2 > minD * minD) continue;
          if (d2 < 1e-6) {
            a.sepX -= 0.02;
            b.sepX += 0.02;
            continue;
          }
          const d = Math.sqrt(d2);
          const push = (minD - d) / d;
          const wa = (b.radius / minD) * 0.5;
          const wb = (a.radius / minD) * 0.5;
          a.sepX -= dx * push * wa;
          a.sepZ -= dz * push * wa;
          b.sepX += dx * push * wb;
          b.sepZ += dz * push * wb;
        }
      }
    }

    /* ============================================================
       ZOMBIE STATE MACHINE
       ============================================================ */
    _updateZombie(z, dt) {
      z.stateT += dt;

      if (z.state === "spawning") {
        this._animate(z, dt);
        if (z.stateT >= z.spawnDur) {
          z.state = "seek";
          z.stateT = 0;
          z.repathCd = rand(0.1, 0.5);
        }
        return;
      }
      if (z.state === "dying") {
        this._updateDying(z, dt);
        return;
      }

      if (z.attackCd > 0) z.attackCd -= dt;
      if (z.repathCd > 0) z.repathCd -= dt;
      if (z.screamCd > 0) z.screamCd -= dt;
      if (z.slamCd > 0) z.slamCd -= dt;
      if (z.roarCd > 0) z.roarCd -= dt;
      if (z.buffTimer > 0) z.buffTimer -= dt;
      if (z.strafeT > 0) z.strafeT -= dt;
      if (z.aggroCd > 0) z.aggroCd -= dt;
      if (z.headSnap > 0) z.headSnap = Math.max(0, z.headSnap - dt * 4.4);
      if (z.hitFlash > 0) z.hitFlash = Math.max(0, z.hitFlash - dt * 5.5);

      if (z.state === "stagger") {
        z.staggerT -= dt;
        this._animate(z, dt);
        if (z.staggerT <= 0) {
          z.state = "seek";
          z.stateT = 0;
        }
        return;
      }

      if (z.state === "attack") {
        this._updateAttack(z, dt);
        this._animate(z, dt);
        return;
      }

      if (z.state === "shriek") {
        z.shriekT += dt;
        this._animate(z, dt);
        if (z.shriekT >= 0.55 && !z.shriekDone) {
          z.shriekDone = true;
          this._doShriek(z);
        }
        if (z.shriekT >= 1.15) {
          z.state = "seek";
          z.stateT = 0;
          z.shriekDone = false;
          z.attackCd = Math.max(z.attackCd, 0.45);
        }
        return;
      }

      if (z.state === "roar") {
        z.roarT += dt;
        this._animate(z, dt);
        if (z.roarT >= 1.3) {
          z.state = "seek";
          z.stateT = 0;
        }
        return;
      }

      if (z.state === "slam") {
        z.slamT += dt;
        this._animate(z, dt);
        if (z.slamT >= 1.25 && !z.slamDone) {
          z.slamDone = true;
          this._doSlam(z);
        }
        if (z.slamT >= 2.15) {
          z.state = "seek";
          z.stateT = 0;
          z.slamDone = false;
          z.slamCd = rand(8.5, 12.5);
          z.attackCd = Math.max(z.attackCd, 0.4);
        }
        return;
      }

      /* ------------ seek ------------ */
      this._resolveTarget(z);
      const player = this._getPlayer();
      // close-range aggro: a zombie right next to the player drops its objective
      if (player && player.position && z.targetKind !== "player" && z.aggroCd <= 0) {
        z.aggroCd = 0.3;
        const pd = this._distXZ(z.pos, player.position);
        const aggroR = z.isBoss ? 11 : 3.6;
        if (pd < aggroR && this._clearLine(z.pos, player.position)) {
          z.targetKind = "player";
          z.targetRef = player;
          z.barricade = null;
          z.path = null;
          z.repathCd = 0;
          z.tgt.copy(player.position);
          z.tgt.y = 0;
        }
      }
      const tgt = z.tgt;
      const dist = this._distXZ(z.pos, tgt);

      if (z.isBoss) {
        if (z.slamCd <= 0 && dist < 7.6) {
          z.state = "slam";
          z.stateT = 0;
          z.slamT = 0;
          z.slamDone = false;
          z.path = null;
          this._fxRing(z.pos.x, z.pos.z, 0.9, 6.4, 1.25, 0xff4a12, 0.6);
          this._sound("brute_roar", z.pos, { volume: 0.9, rate: 0.9 });
          return;
        }
        if (z.roarCd <= 0 && dist < 26) {
          z.state = "roar";
          z.stateT = 0;
          z.roarT = 0;
          z.roarCd = rand(11, 17);
          z.path = null;
          this._sound("brute_roar", z.pos, { volume: 1.0, rate: 0.8 });
          this._alertNearby(z, 16, 6);
          return;
        }
      } else if (z.def.shriek && z.screamCd <= 0 && dist < 26 && player) {
        z.state = "shriek";
        z.stateT = 0;
        z.shriekT = 0;
        z.shriekDone = false;
        z.screamCd = rand(8, 14);
        z.path = null;
        this._sound("zombie_scream", z.pos, { volume: 0.85, rate: 0.9 + Math.random() * 0.25 });
        this._fxRing(z.pos.x, z.pos.z, 0.6, 9, 1.25, 0xbfe6ff, 0.4);
        return;
      }

      if (this._canAttack(z, dist)) {
        this._beginAttack(z);
        return;
      }

      this._seekMove(z, dt, dist);
      this._animate(z, dt);
    }

    /* ---------------- target selection ---------------- */
    _nearestIntactBarricade(pos) {
      const list = this.world && this.world.barricades;
      if (!list || !list.length) return null;
      let best = null;
      let bestD = Infinity;
      for (let i = 0; i < list.length; i++) {
        const b = list[i];
        if (!b || b.broken || !b.position) continue;
        const dx = b.position.x - pos.x;
        const dz = b.position.z - pos.z;
        const d = dx * dx + dz * dz;
        if (d < bestD) {
          bestD = d;
          best = b;
        }
      }
      return best;
    }

    _barricadeReach(z) {
      return 1.15 + z.radius + 0.9;
    }

    /* distance from a zombie to the gate segment (not just its centre) */
    _barricadeDist(z, b) {
      const nx = b.normal ? b.normal.x : 0;
      const nz = b.normal ? b.normal.z : 1;
      const tx = -nz;
      const tz = nx;
      const w = b.width || 3;
      const dx = z.pos.x - b.position.x;
      const dz = z.pos.z - b.position.z;
      let along = dx * tx + dz * tz;
      if (along < -w * 0.5) along = -w * 0.5;
      else if (along > w * 0.5) along = w * 0.5;
      const ex = dx - tx * along;
      const ez = dz - tz * along;
      return Math.sqrt(ex * ex + ez * ez);
    }

    /* writes the best standing spot in front of the gate segment into z.tgt */
    _barricadeTarget(z, b) {
      const nx = b.normal ? b.normal.x : 0;
      const nz = b.normal ? b.normal.z : 1;
      const tx = -nz;
      const tz = nx;
      const w = b.width || 3;
      const dx = z.pos.x - b.position.x;
      const dz = z.pos.z - b.position.z;
      let along = dx * tx + dz * tz;
      if (along < -w * 0.5) along = -w * 0.5;
      else if (along > w * 0.5) along = w * 0.5;
      const side = dx * nx + dz * nz >= 0 ? 1 : -1;
      const off = 1.35 + z.radius;
      z.tgt.set(b.position.x + tx * along + nx * off * side, 0, b.position.z + tz * along + nz * off * side);
    }

    _resolveTarget(z) {
      z.targetRef = null;
      z.barricade = null;
      const kind = z.targetKind;

      if (kind === "player") {
        const p = this._getPlayer();
        if (p && p.position) {
          z.targetRef = p;
          z.tgt.copy(p.position);
          z.tgt.y = 0;
          return;
        }
      } else if (kind === "generator") {
        const gen = this._getGenerator();
        if (gen && gen.position) {
          z.targetRef = gen;
          z.tgt.copy(gen.position);
          z.tgt.y = 0;
          return;
        }
      } else {
        let b = z.barricade;
        if (!b || b.broken) {
          b = this._nearestIntactBarricade(z.pos);
          z.barricade = b;
        }
        if (b && b.position) {
          z.targetRef = b;
          this._barricadeTarget(z, b);
          return;
        }
      }

      // fallback chain: player -> generator -> barricade -> base
      const p = this._getPlayer();
      if (p && p.position) {
        z.targetKind = "player";
        z.targetRef = p;
        z.tgt.copy(p.position);
        z.tgt.y = 0;
        return;
      }
      const gen = this._getGenerator();
      if (gen && gen.position) {
        z.targetKind = "generator";
        z.targetRef = gen;
        z.tgt.copy(gen.position);
        z.tgt.y = 0;
        return;
      }
      const b = this._nearestIntactBarricade(z.pos);
      if (b && b.position) {
        z.targetKind = "barricade";
        z.barricade = b;
        z.targetRef = b;
        z.tgt.copy(b.position);
        z.tgt.y = 0;
        return;
      }
      z.tgt.set(0, 0, 0);
    }

    _retarget(z) {
      const player = this._getPlayer();
      const gen = this._getGenerator();
      let kind = this._rollTarget(z.def);
      if (kind === "player" && !player) kind = gen ? "generator" : "barricade";
      if (kind === "generator" && !gen) kind = player ? "player" : "barricade";
      if (kind === "barricade" && !this._nearestIntactBarricade(z.pos)) {
        kind = player ? "player" : gen ? "generator" : "player";
      }
      z.targetKind = kind;
      z.targetRef = null;
      z.barricade = null;
      z.path = null;
      z.repathCd = rand(0.08, 0.25);
      if (z.state !== "slam" && z.state !== "roar") {
        z.state = "seek";
        z.stateT = 0;
      }
    }

    /* ---------------- pathing ---------------- */
    _repath(z) {
      z.repathCd = rand(1.2, 2.4);
      if (this._pathBudget <= 0) {
        z.repathCd = 0.08;
        return;
      }
      const nav = this._nav();
      if (!nav || !nav.findPath) {
        z.path = null;
        return;
      }
      if (nav.hasLine && nav.hasLine(z.pos.x, z.pos.z, z.tgt.x, z.tgt.z)) {
        z.path = null;
        z.pathGoal.copy(z.tgt);
        return;
      }
      this._pathBudget--;
      const p = nav.findPath(z.pos, z.tgt);
      if (p && p.length) {
        z.path = p;
        z.pathIndex = 0;
        z.pathGoal.copy(z.tgt);
        return;
      }
      z.path = null;
      if (z.targetKind !== "barricade") {
        const b = this._nearestIntactBarricade(z.pos);
        if (b) {
          z.targetKind = "barricade";
          z.barricade = b;
          z.targetRef = b;
          z.repathCd = 0.1;
        }
      } else {
        z.repathCd = rand(0.3, 0.6);
      }
    }

    /* ---------------- movement + attack ---------------- */
    _tryMove(z, dx, dz) {
      const r = Math.max(0.22, z.radius * 0.9);
      const px = z.pos.x;
      const pz = z.pos.z;
      const nx = px + dx;
      const nz = pz + dz;
      if (!this._worldBlocked(nx, nz, r)) {
        z.pos.x = nx;
        z.pos.z = nz;
        z.pos.y = 0;
        return true;
      }
      if (!this._worldBlocked(nx, pz, r)) {
        z.pos.x = nx;
        z.pos.y = 0;
        return true;
      }
      if (!this._worldBlocked(px, nz, r)) {
        z.pos.z = nz;
        z.pos.y = 0;
        return true;
      }
      const perpX = -dz * 0.8;
      const perpZ = dx * 0.8;
      if (!this._worldBlocked(px + perpX, pz + perpZ, r)) {
        z.pos.x = px + perpX;
        z.pos.z = pz + perpZ;
        z.pos.y = 0;
        return true;
      }
      if (!this._worldBlocked(px - perpX, pz - perpZ, r)) {
        z.pos.x = px - perpX;
        z.pos.z = pz - perpZ;
        z.pos.y = 0;
        return true;
      }
      return false;
    }

    _seekMove(z, dt, dist) {
      const def = z.def;

      if (z.targetKind === "barricade" && z.barricade && z.barricade.broken) {
        this._retarget(z);
        return;
      }
      // already in clawing range of the gate: hold position and face it instead of jostling
      if (z.targetKind === "barricade" && z.barricade && !z.barricade.broken) {
        if (this._barricadeDist(z, z.barricade) <= this._barricadeReach(z)) {
          const b = z.barricade;
          const fy = Math.atan2(b.position.x - z.pos.x, b.position.z - z.pos.z);
          z.yaw += shortAngle(z.yaw, fy) * Math.min(1, dt * def.turn);
          z.group.rotation.y = z.yaw;
          z.path = null;
          this._animate(z, dt);
          return;
        }
      }
      if (z.path && this._distXZ(z.tgt, z.pathGoal) > 3.2) z.repathCd = Math.min(z.repathCd, 0.04);
      if (z.repathCd <= 0) this._repath(z);

      let ux = 0;
      let uz = 0;
      const path = z.path;
      if (path && path.length) {
        while (z.pathIndex < path.length - 1 && this._distXZ(z.pos, path[z.pathIndex]) < 0.85) z.pathIndex++;
        const wp = path[z.pathIndex];
        ux = wp.x - z.pos.x;
        uz = wp.z - z.pos.z;
        if (z.pathIndex >= path.length - 1 && this._distXZ(z.pos, wp) < 0.95) {
          z.path = null;
          z.repathCd = Math.max(z.repathCd, 0.2);
        }
      }
      if (!path || (ux === 0 && uz === 0)) {
        ux = z.tgt.x - z.pos.x;
        uz = z.tgt.z - z.pos.z;
      }
      let len = Math.hypot(ux, uz);
      if (len < 1e-4) {
        this._animate(z, dt);
        return;
      }
      ux /= len;
      uz /= len;

      // screamer: orbit at range instead of closing
      if (def.keepDistance) {
        if (dist < def.keepDistance - 4) {
          ux = -ux;
          uz = -uz;
        } else if (dist < def.keepDistance + 2) {
          const sx = -uz * z.strafeSign;
          const sz = ux * z.strafeSign;
          ux = ux * 0.2 + sx * 0.8;
          uz = uz * 0.2 + sz * 0.8;
          len = Math.hypot(ux, uz) || 1;
          ux /= len;
          uz /= len;
        }
      }
      // unstick strafe
      if (z.strafeT > 0) {
        const tx = ux;
        ux = -uz * z.strafeSign;
        uz = tx * z.strafeSign;
      }
      // local separation
      ux += z.sepX * 1.2;
      uz += z.sepZ * 1.2;
      len = Math.hypot(ux, uz) || 1;
      ux /= len;
      uz /= len;

      let speed = z.speed;
      if (z.buffTimer > 0) speed *= 1.22;
      if (def.key === "runner" && dist < 9 && dist > 1.8) speed *= 1.32;
      if (def.keepDistance && dist < def.keepDistance + 1) speed *= 0.75;
      if (z.hitFlash > 0) speed *= 0.9;

      const step = speed * dt;
      const moved = this._tryMove(z, ux * step, uz * step);
      if (moved) {
        z.stuckT = Math.max(0, z.stuckT - dt * 2);
      } else {
        z.stuckT += dt;
        if (z.stuckT > 0.55) {
          z.stuckT = 0;
          z.repathCd = 0;
          z.strafeT = 0.7;
          z.strafeSign = -z.strafeSign;
        }
      }

      let fx = ux;
      let fz = uz;
      if (z.targetRef && z.targetRef.position) {
        fx = z.targetRef.position.x - z.pos.x;
        fz = z.targetRef.position.z - z.pos.z;
      }
      if (Math.abs(fx) > 1e-4 || Math.abs(fz) > 1e-4) {
        z.yaw += shortAngle(z.yaw, Math.atan2(fx, fz)) * Math.min(1, dt * def.turn);
        z.group.rotation.y = z.yaw;
      }
    }

    _canAttack(z, dist) {
      if (z.attackCd > 0) return false;
      const def = z.def;
      if (z.targetKind === "barricade") {
        const b = z.barricade;
        if (!b || b.broken || !b.position) return false;
        return this._barricadeDist(z, b) <= this._barricadeReach(z);
      }
      if (!z.targetRef || !z.targetRef.position) return false;
      const pad = z.targetKind === "player" ? 0.25 : 0.75;
      return dist <= def.attackRange + pad;
    }

    _beginAttack(z) {
      z.state = "attack";
      z.stateT = 0;
      z.atkT = 0;
      z.struck = false;
      z.path = null;
      if (z.targetKind === "barricade" && z.barricade && !z.barricade.broken) {
        z.atkKind = "barricade";
        z.atkTarget = z.barricade;
      } else if (z.targetKind === "generator" && this._getGenerator()) {
        z.atkKind = "generator";
        z.atkTarget = this._getGenerator();
      } else {
        z.atkKind = "player";
        z.atkTarget = this._getPlayer();
      }
    }

    _updateAttack(z, dt) {
      z.atkT += dt;
      const def = z.def;
      const tgt = z.atkTarget;
      if (tgt && tgt.position) {
        const fx = tgt.position.x - z.pos.x;
        const fz = tgt.position.z - z.pos.z;
        if (Math.abs(fx) > 1e-4 || Math.abs(fz) > 1e-4) {
          z.yaw += shortAngle(z.yaw, Math.atan2(fx, fz)) * Math.min(1, dt * def.turn * 0.9);
          z.group.rotation.y = z.yaw;
        }
      }
      if (!z.struck && z.atkT >= def.windup) {
        z.struck = true;
        this._applyAttack(z);
      }
      if (z.atkT >= def.windup + def.recover) {
        z.state = "seek";
        z.stateT = 0;
        z.attackCd = def.cooldown * (0.9 + Math.random() * 0.25);
      }
    }

    _applyAttack(z) {
      const def = z.def;
      this._sound("zombie_attack", z.pos, { volume: 0.6, rate: 0.82 + Math.random() * 0.42 });

      if (z.atkKind === "barricade") {
        const b = z.atkTarget;
        if (!b || b.broken || !b.position) {
          this._retarget(z);
          return;
        }
        const reach = this._barricadeReach(z) + 0.35;
        if (this._barricadeDist(z, b) > reach) return;
        const dmg = z.damage * (def.barricadeMul || 1);
        let broke = false;
        if (this.world && typeof this.world.damageBarricade === "function") {
          broke = this.world.damageBarricade(b.id, dmg);
        }
        if (!broke && b.health != null && b.health <= 0) broke = true;
        if (broke) {
          b.broken = true;
          this._retarget(z);
        }
        return;
      }

      if (z.atkKind === "generator") {
        const gen = this._getGenerator();
        if (!gen || !gen.position) {
          this._retarget(z);
          return;
        }
        if (this._distXZ(z.pos, gen.position) > def.attackRange + 1.6) return;
        if (this._distXZ(z.pos, gen.position) > def.attackRange * 0.9 && !this._hasLine(z.pos, gen.position)) return;
        const dmg = z.damage * (def.genMul || 1);
        if (typeof gen.damage === "function") gen.damage(dmg);
        if (this.callbacks.onGeneratorHit) this.callbacks.onGeneratorHit(z, dmg);
        return;
      }

      const p = this._getPlayer();
      if (!p || !p.position) {
        this._retarget(z);
        return;
      }
      const pd = this._distXZ(z.pos, p.position);
      if (pd > def.attackRange + 1.3) return;
      if (pd > def.attackRange * 0.9 && !this._hasLine(z.pos, p.position)) return;
      const dmg = z.damage * (z.buffTimer > 0 ? 1.15 : 1);
      if (this.callbacks.onPlayerHit) this.callbacks.onPlayerHit(z, dmg);
    }

    /* ---------------- special behaviours ---------------- */
    _alertNearby(z, radius, seconds) {
      const zs = this.zombies;
      for (let i = 0; i < zs.length; i++) {
        const o = zs[i];
        if (o === z || o.dead || o.state === "dying") continue;
        const d = this._distXZ(z.pos, o.pos);
        if (d > radius) continue;
        o.buffTimer = Math.max(o.buffTimer, seconds * (1 - (d / radius) * 0.5));
        o.repathCd = Math.min(o.repathCd, 0.25);
      }
    }

    _doShriek(z) {
      this._alertNearby(z, 22, 7);
      this._fxRing(z.pos.x, z.pos.z, 0.5, 14, 1.4, 0xbfe6ff, 0.45);
      this._sound("zombie_scream", z.pos, { volume: 1.0, rate: 0.95 });
    }

    _doSlam(z) {
      const R = 6.4;
      this._fxRing(z.pos.x, z.pos.z, 1.2, R * 1.6, 0.55, 0xff7a22, 0.95);
      this._fxRing(z.pos.x, z.pos.z, 0.5, R, 0.8, 0xff4010, 0.5);
      this._sound("brute_roar", z.pos, { volume: 1.0, rate: 1.05 });
      const player = this._getPlayer();
      if (player && player.position) {
        if (this._distXZ(z.pos, player.position) < R) {
          const dmg = 58 * (z.buffTimer > 0 ? 1.1 : 1);
          if (this.callbacks.onPlayerHit) this.callbacks.onPlayerHit(z, dmg);
        }
      }
      const gen = this._getGenerator();
      if (gen && gen.position && this._distXZ(z.pos, gen.position) < R + 1.5) {
        const dmg = z.damage * (z.def.genMul || 1);
        if (typeof gen.damage === "function") gen.damage(dmg);
        if (this.callbacks.onGeneratorHit) this.callbacks.onGeneratorHit(z, dmg);
      }
      const list = this.world && this.world.barricades;
      if (list && this.world && typeof this.world.damageBarricade === "function") {
        for (let i = 0; i < list.length; i++) {
          const b = list[i];
          if (!b || b.broken || !b.position) continue;
          if (this._distXZ(z.pos, b.position) < R + 2) {
            const broke = this.world.damageBarricade(b.id, 180);
            if (broke || (b.health != null && b.health <= 0)) b.broken = true;
          }
        }
      }
    }

    /* ============================================================
       COMBAT — entry point used by the weapon raycast
       ============================================================ */
    handleHit(mesh, damage, headshot, hitPoint, direction) {
      const result = { killed: false, killedZombie: null, damage: 0 };
      if (!mesh || this._disposed) return result;
      let obj = mesh;
      let z = null;
      while (obj) {
        if (obj.userData && obj.userData.zombie) {
          z = obj.userData.zombie;
          break;
        }
        obj = obj.parent;
      }
      if (!z || z.dead || z.state === "dying") return result;

      const zone = (mesh.userData && mesh.userData.zone) || "torso";
      const isHead = headshot === true || zone === "head";
      // weapons.js already folds its own head multiplier into `damage` before calling
      // handleHit, so only apply the internal x2.6 when the caller did not flag a headshot.
      let mul = 1;
      if (isHead) mul = headshot === true ? 1 : 2.6;
      else if (zone === "limb") mul = 0.85;
      const dealt = Math.max(1, (damage == null ? 1 : damage) * mul);
      z.hp -= dealt;
      result.damage = dealt;

      z.headSnap = Math.max(z.headSnap, isHead ? 1 : 0.22);
      z.hitFlash = 1;
      if (direction && (direction.x || direction.z)) {
        const fwd = direction.x * Math.sin(z.yaw) + direction.z * Math.cos(z.yaw);
        z.deathPitch = fwd > 0 ? 1 : -1;
      }

      if (!z.def.boss) {
        const resist = z.def.key === "brute" ? 0.4 : 1;
        const amt = Math.min(0.5, (dealt / Math.max(1, z.maxHp)) * 2.4) * resist;
        const minAmt = z.def.key === "brute" ? 0.10 : 0.05;
        if (amt > minAmt) {
          z.staggerT = Math.max(z.staggerT, amt);
          z.staggerMax = z.staggerT;
          z.state = "stagger";
          z.stateT = 0;
          z.path = null;
          z.attackCd = Math.max(z.attackCd, 0.3);
        }
      } else {
        z.staggerT = 0;
      }

      if (this._elapsed - z.lastHitSound > 1.1 && Math.random() < 0.25) {
        z.lastHitSound = this._elapsed;
        this._sound("zombie_growl", z.pos, { volume: 0.4, rate: 1.1 + Math.random() * 0.4 });
      }

      if (z.hp <= 0) {
        this._kill(z, isHead);
        result.killed = true;
        result.killedZombie = z;
      }
      return result;
    }

    _kill(z, headshot) {
      if (z.dead || z.state === "dying") return;
      z.hp = 0;
      z.state = "dying";
      z.stateT = 0;
      z.dyingT = 0;
      z.alive = false;
      z.dead = true;
      z.removeMe = false;
      z.attackCd = 0;
      z.path = null;
      z.group.position.y = 0;
      this._aliveCount = Math.max(0, this._aliveCount - 1);
      this._aimDirty = true;
      this._sound("zombie_death", z.pos, { volume: 0.85, rate: 0.8 + Math.random() * 0.4 });
      if (z.isBoss) {
        this._fxRing(z.pos.x, z.pos.z, 1.5, 14, 1.8, 0xff3a12, 0.7);
        this._sound("brute_roar", z.pos, { volume: 1.0, rate: 0.7 });
      }
      const cb = this.callbacks;
      if (cb.onKill) cb.onKill(z, !!headshot);
    }

    /* ============================================================
       DEATH / SPAWN / GAIT ANIMATION
       ============================================================ */
    _updateDying(z, dt) {
      z.dyingT += dt;
      const boss = !!z.def.boss;
      const fallDur = boss ? 1.7 : 0.85;
      const f = Math.min(1, z.dyingT / fallDur);
      const e = DL.easeOutCubic(f);
      const m = z.model;
      z.group.rotation.x = z.deathPitch * e * (PI * 0.5 - 0.02);
      z.group.rotation.z += (z.deathRoll * e - z.group.rotation.z) * Math.min(1, dt * 3);
      m.hips.position.y = z.def.prop.hipY * (1 - e * 0.55);
      m.hips.rotation.x = z.deathPitch * e * 0.15;
      const tw = z.dyingT * 9;
      m.shL.rotation.x = -0.5 - Math.sin(tw) * 0.5 * (1 - e);
      m.shR.rotation.x = -0.5 + Math.cos(tw * 0.8) * 0.5 * (1 - e);
      m.shL.rotation.z = 0.4 * e;
      m.shR.rotation.z = -0.4 * e;
      m.elL.rotation.x = -0.4 - 0.5 * e;
      m.elR.rotation.x = -0.3 - 0.6 * e;
      m.thL.rotation.x = 0.25 * e;
      m.thR.rotation.x = -0.15 * e;
      m.knL.rotation.x = 0.3 * e;
      m.knR.rotation.x = 0.5 * e;
      m.head.rotation.x = 0.25 * e + Math.sin(tw) * 0.1 * (1 - e);

      const sinkStart = fallDur + (boss ? 1.2 : 0.55);
      if (z.dyingT > sinkStart) {
        const sink = z.dyingT - sinkStart;
        z.group.position.y = -sink * (boss ? 0.55 : 0.8);
        if (sink > (boss ? 4.4 : 2.8)) z.removeMe = true;
      }
    }

    _animate(z, dt) {
      const def = z.def;
      const A = def.anim;
      const P = def.prop;
      const m = z.model;
      const M = m.meta;
      const as = z.asym;
      const now = this._elapsed;
      const state = z.state;
      const moving = state === "seek" || state === "spawning";

      z.walkPhase += dt * A.stride * as.stride * (moving ? 1 : 0.22) * (z.buffTimer > 0 ? 1.18 : 1);
      const p = z.walkPhase;
      const s = Math.sin(p);
      const c = Math.cos(p);
      const sL = Math.sin(p + as.phaseL);
      const sR = Math.sin(p + PI + as.phaseR);
      const lean = P.lean + as.hunch;

      /* ---- legs: uneven, dragging stride; hips drop to keep feet grounded ---- */
      const legAmp = A.legAmp;
      const dragL = as.dragSide < 0 ? 0.55 : 1;
      const dragR = as.dragSide > 0 ? 0.55 : 1;
      let thLx, thRx, knLx, knRx;
      if (moving) {
        thLx = -sL * legAmp * as.legAmpL * dragL;
        thRx = -sR * legAmp * as.legAmpR * dragR;
        knLx = 0.10 + Math.max(0, sL) * A.kneeAmp * dragL;
        knRx = 0.10 + Math.max(0, sR) * A.kneeAmp * dragR;
      } else {
        thLx = -0.14;
        thRx = 0.09;
        knLx = 0.20;
        knRx = 0.12;
      }
      m.thL.rotation.x = thLx;
      m.thR.rotation.x = thRx;
      m.knL.rotation.x = knLx;
      m.knR.rotation.x = knRx;

      const maxTh = Math.max(Math.abs(thLx), Math.abs(thRx));
      const strideDrop = (M.thighL + M.shinL) * (1 - Math.cos(Math.min(0.95, maxTh))) * 0.92;
      m.hips.rotation.x = -0.05;
      m.hips.rotation.y = s * A.hipTwist * (moving ? 1 : 0.25);
      m.hips.rotation.z = c * 0.035 + (moving ? 0 : Math.sin(now * 0.8 + z.phaseOff) * 0.02);
      m.hips.position.y = M.hipY - strideDrop + (moving ? Math.abs(s) * A.bob * 0.35 : Math.sin(now * 2.1 + z.phaseOff) * 0.012);

      /* ---- torso: hunched sway + shoulder roll ---- */
      let torsoX = lean + (moving ? Math.sin(p * 2) * 0.022 : Math.sin(now * 1.3 + z.phaseOff) * 0.022);
      m.torso.rotation.x = torsoX;
      m.torso.rotation.y = (moving ? -s * A.torsoTwist : Math.sin(now * 0.9 + z.phaseOff) * A.torsoTwist * 0.35) + as.twist;
      m.torso.rotation.z = (moving ? c * A.torsoRoll * 1.4 : Math.sin(now * 1.1 + z.phaseOff) * 0.03) + as.tilt;

      /* ---- head: counter-tilt, lurch, slow idle scanning ---- */
      let headX = -lean * 0.72 + (moving ? Math.sin(p * 2 + 0.6) * A.headLurch : Math.sin(now * 0.8 + z.phaseOff) * A.headLurch * 0.6) - z.headSnap * 0.9 + as.headTilt;
      let headY = moving ? Math.sin(p + 0.9) * A.headLurch * 0.8 : Math.sin(now * 0.33 + z.phaseOff) * 0.28;
      let headZ = 0;

      /* ---- arms: forward-reaching base pose with uneven pumping ---- */
      let shXL = A.shBase + as.armBaseL + (moving ? sL * A.armAmp * as.armAmpL : Math.sin(now * 1.5 + z.phaseOff) * A.armAmp * 0.22);
      let shXR = A.shBase + as.armBaseR + (moving ? sR * A.armAmp * as.armAmpR : Math.sin(now * 1.55 + z.phaseOff + 1.7) * A.armAmp * 0.22);
      let elXL = A.elbowBase - Math.max(0, -sL) * 0.30 * (moving ? 1 : 0.4);
      let elXR = A.elbowBase - Math.max(0, -sR) * 0.30 * (moving ? 1 : 0.4);
      let shZL = -A.shOut;
      let shZR = A.shOut;

      if (state === "attack") {
        const w = def.windup;
        const windupX = -2.55;
        const strikeX = -1.18;
        let armX;
        if (z.atkT < w) {
          const k = DL.easeOutCubic(Math.min(1, z.atkT / w));
          armX = A.shBase + (windupX - A.shBase) * k;
          elXL = A.elbowBase - 1.2 * k;
          elXR = A.elbowBase - 1.2 * k;
          torsoX = lean - 0.20 * k;
          headX = -lean * 0.72 - 0.22 * k;
          shZL = -A.shOut - 0.20 * k;
          shZR = A.shOut + 0.20 * k;
        } else {
          const t1 = Math.min(1, (z.atkT - w) / Math.max(0.01, def.recover));
          const sw = DL.easeOutCubic(Math.min(1, t1 * 2.4));
          const back = DL.easeInOutCubic(Math.max(0, (t1 - 0.45) / 0.55));
          armX = DL.lerp(DL.lerp(windupX, strikeX, sw), A.shBase, back);
          elXL = DL.lerp(DL.lerp(A.elbowBase - 1.2, A.elbowBase - 0.1, sw), A.elbowBase, back);
          elXR = DL.lerp(DL.lerp(A.elbowBase - 1.2, A.elbowBase - 0.1, sw), A.elbowBase, back);
          torsoX = lean + (-0.20 + 0.55 * sw) * (1 - back);
          headX = -lean * 0.72 - 0.22 + 0.55 * sw * (1 - back);
        }
        shXL = armX;
        shXR = armX;
      } else if (state === "stagger") {
        const k = clamp(z.staggerT / Math.max(0.001, z.staggerMax), 0, 1);
        torsoX = lean - 0.40 * k;
        headX = -lean * 0.72 - 0.60 * k;
        headZ = Math.sin(now * 17) * 0.09 * k;
        shXL = A.shBase - 0.95 * k;
        shXR = A.shBase - 0.65 * k;
        shZL = -A.shOut - 0.32 * k;
        shZR = A.shOut + 0.32 * k;
        elXL = A.elbowBase - 0.4 * k;
        elXR = A.elbowBase - 0.5 * k;
        m.torso.rotation.z += Math.sin(now * 18) * 0.05 * k;
      } else if (state === "shriek") {
        const k = Math.sin(clamp(z.shriekT / 1.15, 0, 1) * PI);
        headX = -0.95 - 0.35 * k;
        torsoX = lean - 0.30 * k;
        shXL = A.shBase - 2.0 * k;
        shXR = A.shBase - 2.0 * k;
        shZL = -A.shOut - 0.55 * k;
        shZR = A.shOut + 0.55 * k;
        elXL = A.elbowBase - 0.7 * k;
        elXR = A.elbowBase - 0.7 * k;
      } else if (state === "roar") {
        const k = Math.sin(clamp(z.roarT / 1.3, 0, 1) * PI);
        headX = -0.80 - 0.30 * k;
        torsoX = lean + 0.14 * k;
        shXL = A.shBase - 1.4 * k;
        shXR = A.shBase - 1.4 * k;
        shZL = -A.shOut - 0.62 * k;
        shZR = A.shOut + 0.62 * k;
        elXL = A.elbowBase - 0.55 * k;
        elXR = A.elbowBase - 0.55 * k;
      } else if (state === "slam") {
        if (z.slamT < 1.25) {
          const k = DL.easeOutCubic(clamp(z.slamT / 1.25, 0, 1));
          shXL = A.shBase - 2.9 * k;
          shXR = A.shBase - 2.9 * k;
          elXL = A.elbowBase - 1.0 * k;
          elXR = A.elbowBase - 1.0 * k;
          shZL = -A.shOut - 0.38 * k;
          shZR = A.shOut + 0.38 * k;
          torsoX = lean - 0.34 * k;
          headX = -lean * 0.72 - 0.28 * k;
          m.hips.position.y = M.hipY + 0.12 * k;
        } else {
          const k = DL.easeOutCubic(clamp((z.slamT - 1.25) / 0.26, 0, 1));
          shXL = A.shBase - 2.9 + 2.5 * k;
          shXR = A.shBase - 2.9 + 2.5 * k;
          elXL = A.elbowBase - 1.0 + 0.85 * k;
          elXR = A.elbowBase - 1.0 + 0.85 * k;
          torsoX = lean - 0.34 + 0.62 * k;
          headX = -lean * 0.72 - 0.28 + 0.42 * k;
          m.hips.position.y = M.hipY + 0.12 - 0.2 * k;
        }
      } else if (state === "spawning") {
        const k = DL.easeOutCubic(clamp(z.stateT / z.spawnDur, 0, 1));
        const r = 1 - k;
        z.group.position.y = -r * (z.isBoss ? 2.7 : z.def.key === "brute" ? 2.0 : 1.75);
        shXL = A.shBase - 2.4 * r;
        shXR = A.shBase - 2.2 * r;
        shZL = -A.shOut - 0.45 * r;
        shZR = A.shOut + 0.45 * r;
        torsoX = lean + 0.38 * r;
        headX = -lean * 0.72 - 0.55 * r;
        elXL = A.elbowBase - 0.5 * r;
        elXR = A.elbowBase - 0.7 * r;
      }

      m.shL.rotation.x = shXL;
      m.shR.rotation.x = shXR;
      m.shL.rotation.z = shZL + (moving ? 0 : Math.sin(now * 1.2 + z.phaseOff) * 0.02);
      m.shR.rotation.z = shZR - (moving ? 0 : Math.sin(now * 1.2 + z.phaseOff + 0.7) * 0.02);
      m.elL.rotation.x = elXL;
      m.elR.rotation.x = elXR;
      m.torso.rotation.x = torsoX;
      m.head.rotation.x = headX;
      m.head.rotation.y = headY;
      m.head.rotation.z = headZ;
    }

    /* ============================================================
       FX / AUDIO
       ============================================================ */
    _initFx() {
      for (let i = 0; i < 10; i++) {
        const mat = new THREE.MeshBasicMaterial({
          color: 0xffffff, transparent: true, opacity: 0, depthWrite: false,
          blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(this._fxGeo, mat);
        mesh.rotation.x = -PI / 2;
        mesh.visible = false;
        mesh.renderOrder = 5;
        mesh.frustumCulled = false;
        if (this.scene) this.scene.add(mesh);
        this._fx.push({ mesh: mesh, mat: mat, life: 0, maxLife: 1, r0: 1, r1: 1, opacity: 0, active: false });
      }
    }

    _fxRing(x, z, r0, r1, life, colorHex, opacity) {
      if (!this._fx.length) this._initFx();
      const f = this._fx[this._fxIndex % this._fx.length];
      this._fxIndex++;
      f.active = true;
      f.life = 0;
      f.maxLife = life > 0 ? life : 1;
      f.r0 = r0;
      f.r1 = r1;
      f.opacity = opacity;
      f.mat.color.setHex(colorHex);
      f.mat.opacity = opacity;
      f.mesh.visible = true;
      f.mesh.position.set(x, 0.05, z);
      f.mesh.scale.set(r0, r0, 1);
    }

    _updateFx(dt) {
      for (let i = 0; i < this._fx.length; i++) {
        const f = this._fx[i];
        if (!f.active) continue;
        f.life += dt;
        const k = Math.min(1, f.life / f.maxLife);
        const r = DL.lerp(f.r0, f.r1, DL.easeOutCubic(k));
        f.mesh.scale.set(r, r, 1);
        f.mat.opacity = f.opacity * (1 - k) * (1 - k * 0.3);
        if (k >= 1) {
          f.active = false;
          f.mesh.visible = false;
          f.mat.opacity = 0;
        }
      }
    }

    _sound(name, pos, opts) {
      const a = this.audio;
      if (!a || typeof a.play !== "function") return;
      const gap = name === "zombie_growl" ? 1.8
        : name === "zombie_attack" ? 0.09
        : name === "zombie_death" ? 0.14
        : name === "zombie_scream" ? 0.6
        : 2.0;
      const last = this._lastSound[name] == null ? -999 : this._lastSound[name];
      if (this._elapsed - last < gap) return;
      this._lastSound[name] = this._elapsed;
      const o = { pos: pos };
      if (opts) {
        if (opts.volume != null) o.volume = opts.volume;
        if (opts.rate != null) o.rate = opts.rate;
      }
      if (o.rate == null) o.rate = 0.85 + Math.random() * 0.3;
      try {
        a.play(name, o);
      } catch (err) { /* audio must never stall the horde */ }
    }

    _ambientAudio(dt) {
      if (!this.audio) return;
      this._ambientCd -= dt;
      if (this._ambientCd > 0) return;
      this._ambientCd = rand(2.6, 6.0);
      const zs = this.zombies;
      if (!zs.length) return;
      const player = this._getPlayer();
      for (let i = 0; i < 5; i++) {
        const z = zs[(Math.random() * zs.length) | 0];
        if (!z || z.dead || z.state === "dying") continue;
        if (player && player.position && this._distXZ(z.pos, player.position) > 46) continue;
        this._sound("zombie_growl", z.pos, { volume: 0.35, rate: 0.7 + Math.random() * 0.5 });
        return;
      }
    }

    _checkWaveComplete() {
      if (!this._waveActive || this._waveCompleteFired) return;
      if (this._queue.length > 0 || this._aliveCount > 0) return;
      if (this._spawnedCount < this._totalInWave) return;
      this._waveCompleteFired = true;
      this._waveActive = false;
      if (this.callbacks.onWaveComplete) this.callbacks.onWaveComplete(this._wave);
    }

  }

  DL.Horde = Horde;
})();
