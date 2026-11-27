/* ============================================================================
   DEADLIGHT // OUTPOST 13 — world module
   Night outpost, perimeter, props, forest, weather, nav/collision data.
   Classic script. Depends on global THREE (r160) + DL (core.js).
   ========================================================================== */
(function () {
  "use strict";

  const DL = window.DL;
  if (!DL) throw new Error("DEADLIGHT world: DL core missing");

  const PI = Math.PI;
  const TAU = PI * 2;

  /* Builders are attached to this local registry by the sections below so the
     whole module can stay a single readable classic script. */
  const B = {};

  /* ------------------------------------------------------------------ */
  /* geometry helpers                                                    */
  /* ------------------------------------------------------------------ */
  const _m4 = new THREE.Matrix4();
  const _quat = new THREE.Quaternion();
  const _eul = new THREE.Euler();
  const _vec = new THREE.Vector3();
  const _scl = new THREE.Vector3();

  function xf(geo, x, y, z, rx, ry, rz, sx, sy, sz) {
    _eul.set(rx || 0, ry || 0, rz || 0);
    _quat.setFromEuler(_eul);
    _vec.set(x || 0, y || 0, z || 0);
    _scl.set(sx === undefined ? 1 : sx, sy === undefined ? 1 : sy, sz === undefined ? 1 : sz);
    _m4.compose(_vec, _quat, _scl);
    geo.applyMatrix4(_m4);
    return geo;
  }

  function boxGeo(w, h, d) {
    return new THREE.BoxGeometry(w, h, d);
  }
  function cylGeo(rt, rb, h, seg, open) {
    return new THREE.CylinderGeometry(rt, rb, h, seg || 8, 1, !!open);
  }
  function sphereGeo(r, ws, hs) {
    return new THREE.SphereGeometry(r, ws || 10, hs || 7);
  }

  /* Merge pre-transformed geometries into one non-indexed buffer geometry. */
  function mergeGeos(list) {
    let total = 0;
    const parts = [];
    for (let i = 0; i < list.length; i++) {
      const src = list[i];
      const g = src.index ? src.toNonIndexed() : src;
      if (g !== src) src.dispose();
      parts.push(g);
      total += g.attributes.position.count;
    }
    let hasUv = true;
    for (let i = 0; i < parts.length; i++) if (!parts[i].attributes.uv) hasUv = false;
    const pos = new Float32Array(total * 3);
    const nor = new Float32Array(total * 3);
    const uvs = hasUv ? new Float32Array(total * 2) : null;
    let o = 0;
    for (let i = 0; i < parts.length; i++) {
      const g = parts[i];
      pos.set(g.attributes.position.array, o * 3);
      nor.set(g.attributes.normal.array, o * 3);
      if (uvs) uvs.set(g.attributes.uv.array, o * 2);
      o += g.attributes.position.count;
      g.dispose();
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
    if (uvs) out.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    out.computeBoundingSphere();
    return out;
  }

  function stdMat(opts, envInt) {
    const m = new THREE.MeshStandardMaterial(opts);
    if (envInt !== undefined) m.envMapIntensity = envInt;
    m.dithering = true;
    return m;
  }

  function mesh(parent, geo, mat, x, y, z, rx, ry, rz) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x || 0, y || 0, z || 0);
    if (rx) m.rotation.x = rx;
    if (ry) m.rotation.y = ry;
    if (rz) m.rotation.z = rz;
    if (parent) parent.add(m);
    return m;
  }

  /* ------------------------------------------------------------------ */
  /* canvas texture factory                                              */
  /* ------------------------------------------------------------------ */
  function groundAlbedo() {
    const S = 512;
    const canvas = DL.noiseTexture(S, S, {
      base: [66, 62, 51], variance: 27, grain: 13, scale: 6.2, seed: 3.7, streak: 9,
    });
    const ctx = canvas.getContext("2d");
    // damp / oil-dark patches
    for (let i = 0; i < 38; i++) {
      const x = Math.random() * S, y = Math.random() * S;
      const r = 20 + Math.random() * 100;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, "rgba(10,15,15," + (0.18 + Math.random() * 0.25).toFixed(3) + ")");
      g.addColorStop(0.65, "rgba(12,17,16,0.10)");
      g.addColorStop(1, "rgba(14,18,17,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * (0.45 + Math.random() * 0.75), Math.random() * PI, 0, TAU);
      ctx.fill();
    }
    // dry gravel scuffs
    for (let i = 0; i < 30; i++) {
      const x = Math.random() * S, y = Math.random() * S, r = 16 + Math.random() * 55;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, "rgba(122,114,94,0.10)");
      g.addColorStop(1, "rgba(122,114,94,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * 0.55, 0, 0, TAU);
      ctx.fill();
    }
    // tyre ruts
    ctx.lineCap = "round";
    for (let k = 0; k < 3; k++) {
      const baseY = S * (0.26 + k * 0.13);
      ctx.beginPath();
      for (let x = -24; x <= S + 24; x += 10) {
        const y = baseY + Math.sin(x * 0.021 + k * 2.1) * 8 + Math.sin(x * 0.0068 + k) * 14;
        if (x === -24) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = "rgba(24,26,21,0.26)";
      ctx.lineWidth = 12;
      ctx.stroke();
      ctx.strokeStyle = "rgba(118,114,96,0.10)";
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    // pebbles
    for (let i = 0; i < 1100; i++) {
      const x = Math.random() * S, y = Math.random() * S;
      const r = 0.4 + Math.random() * 1.9;
      const v = (100 + Math.random() * 78) | 0;
      ctx.fillStyle = "rgba(" + v + "," + (v - 7) + "," + (v - 18) + "," + (0.12 + Math.random() * 0.34).toFixed(2) + ")";
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fill();
    }
    // dead leaf / debris flecks
    for (let i = 0; i < 260; i++) {
      const x = Math.random() * S, y = Math.random() * S;
      ctx.fillStyle = "rgba(" + ((52 + Math.random() * 34) | 0) + "," + ((47 + Math.random() * 24) | 0) + ",30,0.35)";
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.random() * TAU);
      ctx.fillRect(0, 0, 1 + Math.random() * 3.5, 0.7 + Math.random() * 2);
      ctx.restore();
    }
    return canvas;
  }

  function groundHeight() {
    const S = 256;
    const canvas = DL.noiseTexture(S, S, {
      base: [128, 128, 128], variance: 42, grain: 18, scale: 9, seed: 8.3,
    });
    const ctx = canvas.getContext("2d");
    // wheel ruts carved down
    ctx.lineCap = "round";
    for (let k = 0; k < 3; k++) {
      const baseY = S * (0.26 + k * 0.13);
      ctx.beginPath();
      for (let x = -16; x <= S + 16; x += 8) {
        const y = baseY + Math.sin(x * 0.021 + k * 2.1) * 4 + Math.sin(x * 0.0068 + k) * 7;
        if (x === -16) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = "rgba(48,48,48,0.85)";
      ctx.lineWidth = 7;
      ctx.stroke();
    }
    // flat wet patches (water finds level)
    for (let i = 0; i < 16; i++) {
      const x = Math.random() * S, y = Math.random() * S, r = 8 + Math.random() * 30;
      ctx.fillStyle = "rgba(96,96,96,0.55)";
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * 0.7, Math.random() * PI, 0, TAU);
      ctx.fill();
    }
    // raised stones
    for (let i = 0; i < 420; i++) {
      const x = Math.random() * S, y = Math.random() * S, r = 0.5 + Math.random() * 1.9;
      ctx.fillStyle = "rgba(205,205,205,0.75)";
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fill();
    }
    return canvas;
  }

  function groundRough() {
    const S = 256;
    const canvas = DL.noiseTexture(S, S, {
      base: [142, 142, 142], variance: 30, grain: 7, scale: 7, seed: 5.5,
    });
    const ctx = canvas.getContext("2d");
    for (let i = 0; i < 30; i++) {
      const x = Math.random() * S, y = Math.random() * S, r = 10 + Math.random() * 46;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, "rgba(12,12,12,0.68)");
      g.addColorStop(0.7, "rgba(20,20,20,0.32)");
      g.addColorStop(1, "rgba(20,20,20,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * (0.4 + Math.random() * 0.7), Math.random() * PI, 0, TAU);
      ctx.fill();
    }
    return canvas;
  }

  function concreteAlbedo() {
    const S = 256;
    const canvas = DL.noiseTexture(S, S, {
      base: [114, 112, 104], variance: 16, grain: 9, scale: 5, seed: 1.7, streak: 4,
    });
    const ctx = canvas.getContext("2d");
    // formwork panel lines
    ctx.strokeStyle = "rgba(64,64,58,0.22)";
    ctx.lineWidth = 1;
    for (let i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(0, (i + 1) * 64);
      ctx.lineTo(S, (i + 1) * 64);
      ctx.stroke();
    }
    // cracks
    ctx.strokeStyle = "rgba(38,38,34,0.7)";
    for (let i = 0; i < 7; i++) {
      let x = Math.random() * S, y = Math.random() * S;
      ctx.lineWidth = 0.8 + Math.random() * 1.1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (let s = 0; s < 7; s++) {
        x += (Math.random() - 0.5) * 26;
        y += 4 + Math.random() * 15;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // rain/rust stains running down
    for (let i = 0; i < 26; i++) {
      const x = Math.random() * S, y = Math.random() * S * 0.6, h = 20 + Math.random() * 120;
      const g = ctx.createLinearGradient(0, y, 0, y + h);
      g.addColorStop(0, "rgba(44,42,36,0.30)");
      g.addColorStop(1, "rgba(44,42,36,0)");
      ctx.fillStyle = g;
      ctx.fillRect(x, y, 1 + Math.random() * 5, h);
    }
    // chips
    for (let i = 0; i < 90; i++) {
      ctx.fillStyle = "rgba(66,64,56," + (0.2 + Math.random() * 0.4).toFixed(2) + ")";
      ctx.fillRect(Math.random() * S, Math.random() * S, 1 + Math.random() * 3, 1 + Math.random() * 3);
    }
    return canvas;
  }

  function concreteHeight() {
    const S = 256;
    const canvas = DL.noiseTexture(S, S, {
      base: [128, 128, 128], variance: 26, grain: 22, scale: 6, seed: 2.9,
    });
    const ctx = canvas.getContext("2d");
    ctx.strokeStyle = "rgba(40,40,40,0.9)";
    for (let i = 0; i < 9; i++) {
      let x = Math.random() * S, y = Math.random() * S;
      ctx.lineWidth = 1 + Math.random() * 1.6;
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (let s = 0; s < 6; s++) {
        x += (Math.random() - 0.5) * 30;
        y += 4 + Math.random() * 18;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    for (let i = 0; i < 220; i++) {
      ctx.fillStyle = "rgba(200,200,200,0.5)";
      ctx.fillRect(Math.random() * S, Math.random() * S, 1 + Math.random() * 2.4, 1 + Math.random() * 2.4);
    }
    return canvas;
  }

  function corrugationTexture() {
    const S = 256;
    const canvas = DL.noiseTexture(S, S, {
      base: [92, 94, 90], variance: 15, grain: 7, scale: 4, seed: 6.1, streak: 16,
    });
    const ctx = canvas.getContext("2d");
    // vertical corrugation shading
    for (let x = 0; x < S; x += 16) {
      const g = ctx.createLinearGradient(x, 0, x + 16, 0);
      g.addColorStop(0, "rgba(20,22,22,0.34)");
      g.addColorStop(0.42, "rgba(255,255,255,0.07)");
      g.addColorStop(0.62, "rgba(255,255,255,0.10)");
      g.addColorStop(1, "rgba(16,18,18,0.34)");
      ctx.fillStyle = g;
      ctx.fillRect(x, 0, 16, S);
    }
    // rust blooms and drips
    for (let i = 0; i < 30; i++) {
      const x = Math.random() * S, y = Math.random() * S, r = 4 + Math.random() * 26;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, "rgba(118,56,20," + (0.25 + Math.random() * 0.4).toFixed(2) + ")");
      g.addColorStop(1, "rgba(118,56,20,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fill();
    }
    for (let i = 0; i < 26; i++) {
      const x = Math.random() * S, y = Math.random() * S * 0.7, h = 16 + Math.random() * 90;
      const g = ctx.createLinearGradient(0, y, 0, y + h);
      g.addColorStop(0, "rgba(104,48,18,0.42)");
      g.addColorStop(1, "rgba(104,48,18,0)");
      ctx.fillStyle = g;
      ctx.fillRect(x, y, 1 + Math.random() * 3.5, h);
    }
    return canvas;
  }

  function corrugationHeight() {
    const S = 256;
    const { canvas, ctx } = DL.makeCanvas(S, S);
    ctx.fillStyle = "#808080";
    ctx.fillRect(0, 0, S, S);
    for (let x = 0; x < S; x += 16) {
      const g = ctx.createLinearGradient(x, 0, x + 16, 0);
      g.addColorStop(0, "#2a2a2a");
      g.addColorStop(0.5, "#e6e6e6");
      g.addColorStop(1, "#2a2a2a");
      ctx.fillStyle = g;
      ctx.fillRect(x, 0, 16, S);
    }
    // dents
    for (let i = 0; i < 70; i++) {
      ctx.fillStyle = "rgba(60,60,60,0.5)";
      ctx.beginPath();
      ctx.ellipse(Math.random() * S, Math.random() * S, 2 + Math.random() * 9, 2 + Math.random() * 5, Math.random() * PI, 0, TAU);
      ctx.fill();
    }
    return canvas;
  }

  function paintAlbedo() {
    const S = 256;
    const canvas = DL.noiseTexture(S, S, {
      base: [74, 78, 56], variance: 15, grain: 8, scale: 4, seed: 9.2, streak: 8,
    });
    const ctx = canvas.getContext("2d");
    // chipped paint revealing primer
    for (let i = 0; i < 70; i++) {
      ctx.fillStyle = "rgba(50,50,44," + (0.2 + Math.random() * 0.5).toFixed(2) + ")";
      ctx.beginPath();
      ctx.ellipse(Math.random() * S, Math.random() * S, 1 + Math.random() * 7, 1 + Math.random() * 4, Math.random() * PI, 0, TAU);
      ctx.fill();
    }
    // rust bleed
    for (let i = 0; i < 24; i++) {
      const x = Math.random() * S, y = Math.random() * S, r = 3 + Math.random() * 14;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, "rgba(122,62,24,0.6)");
      g.addColorStop(1, "rgba(122,62,24,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fill();
    }
    // scratches
    ctx.strokeStyle = "rgba(158,154,136,0.35)";
    ctx.lineWidth = 1;
    for (let i = 0; i < 34; i++) {
      const x = Math.random() * S, y = Math.random() * S;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (Math.random() - 0.5) * 40, y + (Math.random() - 0.5) * 12);
      ctx.stroke();
    }
    return canvas;
  }

  function woodAlbedo() {
    const S = 256;
    const canvas = DL.noiseTexture(S, S, {
      base: [88, 68, 47], variance: 17, grain: 9, scale: 3, seed: 2.2, streak: 24,
    });
    const ctx = canvas.getContext("2d");
    // long grain
    for (let i = 0; i < 90; i++) {
      const y = Math.random() * S;
      ctx.strokeStyle = "rgba(" + ((38 + Math.random() * 30) | 0) + "," + ((28 + Math.random() * 22) | 0) + ",18," + (0.12 + Math.random() * 0.3).toFixed(2) + ")";
      ctx.lineWidth = 0.6 + Math.random() * 2.2;
      ctx.beginPath();
      ctx.moveTo(0, y);
      for (let x = 0; x <= S; x += 16) ctx.lineTo(x, y + Math.sin(x * 0.05 + i) * 1.6);
      ctx.stroke();
    }
    // knots
    for (let i = 0; i < 7; i++) {
      const x = Math.random() * S, y = Math.random() * S;
      ctx.strokeStyle = "rgba(34,24,14,0.55)";
      for (let k = 0; k < 4; k++) {
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.ellipse(x, y, 3 + k * 3.2, 2 + k * 2.1, 0.3, 0, TAU);
        ctx.stroke();
      }
    }
    // plank nails / screw heads
    for (let i = 0; i < 18; i++) {
      ctx.fillStyle = "rgba(40,34,26,0.85)";
      ctx.beginPath();
      ctx.arc(Math.random() * S, Math.random() * S, 1.5, 0, TAU);
      ctx.fill();
    }
    return canvas;
  }

  function sandbagAlbedo() {
    const S = 128;
    const canvas = DL.noiseTexture(S, S, {
      base: [108, 101, 79], variance: 20, grain: 12, scale: 5, seed: 4.8,
    });
    const ctx = canvas.getContext("2d");
    // burlap weave
    for (let i = 0; i < S; i += 4) {
      ctx.strokeStyle = "rgba(58,52,36,0.20)";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(S, i); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, S); ctx.stroke();
    }
    // dirt / damp patches
    for (let i = 0; i < 22; i++) {
      ctx.fillStyle = "rgba(34,32,22," + (0.08 + Math.random() * 0.22).toFixed(2) + ")";
      ctx.beginPath();
      ctx.ellipse(Math.random() * S, Math.random() * S, 4 + Math.random() * 18, 3 + Math.random() * 11, Math.random() * PI, 0, TAU);
      ctx.fill();
    }
    return canvas;
  }

  function barkAlbedo() {
    const S = 128;
    const canvas = DL.noiseTexture(S, S, {
      base: [46, 38, 31], variance: 16, grain: 11, scale: 5, seed: 7.4, streak: 18,
    });
    const ctx = canvas.getContext("2d");
    for (let i = 0; i < 46; i++) {
      ctx.strokeStyle = "rgba(18,14,11," + (0.25 + Math.random() * 0.4).toFixed(2) + ")";
      ctx.lineWidth = 0.8 + Math.random() * 2.4;
      const x = Math.random() * S;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      for (let y = 0; y <= S; y += 12) ctx.lineTo(x + Math.sin(y * 0.06 + i) * 3, y);
      ctx.stroke();
    }
    return canvas;
  }

  function chainlinkAlpha() {
    const S = 128;
    const { canvas, ctx } = DL.makeCanvas(S, S);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, S, S);
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2.4;
    for (let i = -S; i < S * 2; i += 30) {
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + S, S); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(i + S, 0); ctx.lineTo(i, S); ctx.stroke();
    }
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = 0.9;
    for (let i = -S; i < S * 2; i += 30) {
      ctx.beginPath(); ctx.moveTo(i + 1.4, 0); ctx.lineTo(i + S + 1.4, S); ctx.stroke();
    }
    return canvas;
  }

  function barbedAlpha() {
    const W = 256, H = 128;
    const { canvas, ctx } = DL.makeCanvas(W, H);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    // coiled concertina rings
    for (let x = 8; x < W; x += 24) {
      ctx.beginPath();
      ctx.arc(x, 64, 22, 0, TAU);
      ctx.stroke();
      // barbs
      for (let a = 0; a < 8; a++) {
        const ang = (a / 8) * TAU + x * 0.13;
        const bx = x + Math.cos(ang) * 22, by = 64 + Math.sin(ang) * 22;
        ctx.beginPath();
        ctx.moveTo(bx - 5, by - 3);
        ctx.lineTo(bx + 5, by + 3);
        ctx.moveTo(bx - 5, by + 3);
        ctx.lineTo(bx + 5, by - 3);
        ctx.stroke();
      }
    }
    // horizontal strands
    for (let r = 0; r < 3; r++) {
      const y = 22 + r * 42;
      ctx.beginPath();
      for (let x = 0; x <= W; x += 8) {
        const yy = y + Math.sin(x * 0.07 + r) * 3;
        if (x === 0) ctx.moveTo(x, yy);
        else ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }
    return canvas;
  }

  function hazardAlbedo() {
    const W = 256, H = 128;
    const { canvas, ctx } = DL.makeCanvas(W, H);
    ctx.fillStyle = "#a8862c";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#161511";
    for (let i = -H; i < W + H; i += 46) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i + 23, 0);
      ctx.lineTo(i + 23 - H, H);
      ctx.lineTo(i - H, H);
      ctx.closePath();
      ctx.fill();
    }
    // wear
    for (let i = 0; i < 500; i++) {
      ctx.fillStyle = "rgba(30,28,22," + (0.06 + Math.random() * 0.28).toFixed(2) + ")";
      ctx.fillRect(Math.random() * W, Math.random() * H, 1 + Math.random() * 5, 1 + Math.random() * 3);
    }
    for (let i = 0; i < 120; i++) {
      ctx.fillStyle = "rgba(120,112,92,0.16)";
      ctx.fillRect(Math.random() * W, Math.random() * H, 1 + Math.random() * 3, 1 + Math.random() * 2);
    }
    return canvas;
  }

  function grateAlbedo() {
    const S = 64;
    const { canvas, ctx } = DL.makeCanvas(S, S);
    ctx.fillStyle = "#17181a";
    ctx.fillRect(0, 0, S, S);
    for (let y = 4; y < S; y += 8) {
      ctx.fillStyle = "rgba(126,124,116,0.55)";
      ctx.fillRect(0, y, S, 2);
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(0, y + 2, S, 2);
    }
    return canvas;
  }

  function camoNetAlpha() {
    const S = 256;
    const { canvas, ctx } = DL.makeCanvas(S, S);
    const cols = ["#29301f", "#333a24", "#1d2318", "#3d4028"];
    for (let i = 0; i < 160; i++) {
      ctx.fillStyle = cols[(Math.random() * cols.length) | 0];
      const x = Math.random() * S, y = Math.random() * S, r = 6 + Math.random() * 26;
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * (0.4 + Math.random() * 0.8), Math.random() * PI, 0, TAU);
      ctx.fill();
    }
    // punched holes -> net look
    ctx.globalCompositeOperation = "destination-out";
    for (let i = 0; i < 320; i++) {
      const x = Math.random() * S, y = Math.random() * S, r = 1 + Math.random() * 4.5;
      ctx.globalAlpha = 0.6 + Math.random() * 0.4;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    return canvas;
  }

  function grassAlpha() {
    const W = 128, H = 256;
    const { canvas, ctx } = DL.makeCanvas(W, H);
    ctx.clearRect(0, 0, W, H);
    for (let i = 0; i < 30; i++) {
      const bx = 22 + Math.random() * (W - 44);
      const tipX = bx + (Math.random() - 0.5) * 64;
      const tipY = 26 + Math.random() * 120;
      const g = ctx.createLinearGradient(bx, H, tipX, tipY);
      const r0 = 32 + Math.random() * 16, g0 = 48 + Math.random() * 26, b0 = 22 + Math.random() * 14;
      g.addColorStop(0, "rgb(" + (r0 | 0) + "," + (g0 | 0) + "," + (b0 | 0) + ")");
      g.addColorStop(1, "rgb(" + ((r0 + 44) | 0) + "," + ((g0 + 46) | 0) + "," + ((b0 + 18) | 0) + ")");
      ctx.strokeStyle = g;
      ctx.lineWidth = 1.4 + Math.random() * 2.6;
      ctx.beginPath();
      ctx.moveTo(bx, H);
      ctx.quadraticCurveTo(bx + (tipX - bx) * 0.25, H * 0.55, tipX, tipY);
      ctx.stroke();
    }
    return canvas;
  }

  /* Sign panel: opaque painted metal sign. lines: [{text,size,y,color,dx}] */
  function signTexture(opts) {
    const W = opts.w || 256, H = opts.h || 128;
    const cc = DL.makeCanvas(W, H);
    const ctx = cc.ctx;
    const bg = opts.bg || "#2a2e26";
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (Math.random() - 0.5) * 18;
      d[i] = DL.clamp(d[i] + n, 0, 255);
      d[i + 1] = DL.clamp(d[i + 1] + n, 0, 255);
      d[i + 2] = DL.clamp(d[i + 2] + n, 0, 255);
    }
    ctx.putImageData(img, 0, 0);
    // grime at the edges
    const grime = ctx.createLinearGradient(0, 0, 0, H);
    grime.addColorStop(0, "rgba(8,10,8,0.35)");
    grime.addColorStop(0.5, "rgba(8,10,8,0)");
    grime.addColorStop(1, "rgba(8,10,8,0.45)");
    ctx.fillStyle = grime;
    ctx.fillRect(0, 0, W, H);
    const ink = opts.ink || "#c4ccb7";
    if (opts.border !== false) {
      ctx.strokeStyle = ink;
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = Math.max(2, opts.borderW || 4);
      ctx.strokeRect(8, 8, W - 16, H - 16);
      ctx.globalAlpha = 1;
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const lines = opts.lines || [];
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      ctx.font = (ln.bold === false ? "" : "bold ") + (ln.size || 22) + "px monospace";
      ctx.fillStyle = ln.color || ink;
      ctx.globalAlpha = ln.alpha == null ? 1 : ln.alpha;
      ctx.fillText(ln.text, W / 2 + (ln.dx || 0), ln.y != null ? ln.y : H * ((i + 1) / (lines.length + 1)));
    }
    ctx.globalAlpha = 1;
    // paint wear
    for (let i = 0; i < 260; i++) {
      ctx.fillStyle = bg;
      ctx.globalAlpha = 0.15 + Math.random() * 0.45;
      ctx.fillRect(Math.random() * W, Math.random() * H, 1 + Math.random() * 4, 1 + Math.random() * 2);
    }
    // scratches
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = bg;
    ctx.lineWidth = 1;
    for (let i = 0; i < 14; i++) {
      const x = Math.random() * W, y = Math.random() * H;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (Math.random() - 0.5) * 50, y + (Math.random() - 0.5) * 8);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (opts.icon) opts.icon(ctx, W, H, ink);
    return DL.canvasTexture(cc.canvas, 1, 1, true);
  }

  /* Transparent painted ground/wall decal (stencilled paint). */
  function decalTexture(opts) {
    const W = opts.w || 256, H = opts.h || 256;
    const cc = DL.makeCanvas(W, H);
    const ctx = cc.ctx;
    ctx.clearRect(0, 0, W, H);
    const paint = opts.paint || "rgba(176,178,160,0.85)";
    ctx.fillStyle = paint;
    ctx.strokeStyle = paint;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (opts.draw) {
      opts.draw(ctx, W, H, paint);
    } else {
      const lines = opts.lines || [];
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        ctx.font = (ln.bold === false ? "" : "bold ") + (ln.size || 40) + "px monospace";
        ctx.fillText(ln.text, W / 2 + (ln.dx || 0), ln.y != null ? ln.y : H * ((i + 1) / (lines.length + 1)));
      }
    }
    // paint erosion
    ctx.globalCompositeOperation = "destination-out";
    for (let i = 0; i < 900; i++) {
      ctx.globalAlpha = 0.2 + Math.random() * 0.8;
      ctx.fillStyle = "#000";
      ctx.beginPath();
      ctx.arc(Math.random() * W, Math.random() * H, 0.5 + Math.random() * 3.2, 0, TAU);
      ctx.fill();
    }
    // scratches
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1 + Math.random() * 2;
    for (let i = 0; i < 20; i++) {
      const x = Math.random() * W, y = Math.random() * H;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (Math.random() - 0.5) * 90, y + (Math.random() - 0.5) * 16);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    return DL.canvasTexture(cc.canvas, 1, 1, true);
  }

  function rippleNormal() {
    const S = 128;
    const { canvas, ctx } = DL.makeCanvas(S, S);
    const img = ctx.createImageData(S, S);
    const d = img.data;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = (y * S + x) * 4;
        const n =
          Math.sin((x / S) * TAU * 5 + Math.sin((y / S) * TAU * 2) * 2.0) * 0.5 +
          Math.sin((y / S) * TAU * 7 + Math.cos((x / S) * TAU * 3) * 2.0) * 0.5;
        const v = (n * 0.5 + 0.5) * 255;
        d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = DL.normalMapFromHeight(canvas, 1.4);
    tex.repeat.set(3, 3);
    return tex;
  }

  /* ------------------------------------------------------------------ */
  /* B.textures — build every canvas texture once                        */
  /* ------------------------------------------------------------------ */
  B.textures = function (w) {
    const T = {};
    const ground = groundAlbedo();
    T.ground = DL.canvasTexture(ground, 20, 20, true);
    T.ground.anisotropy = 8;
    T.groundN = DL.normalMapFromHeight(groundHeight(), 2.3);
    T.groundN.repeat.set(20, 20);
    T.groundN.anisotropy = 8;
    T.groundR = DL.canvasTexture(groundRough(), 20, 20, false);
    T.groundR.anisotropy = 4;

    T.concrete = DL.canvasTexture(concreteAlbedo(), 2, 2, true);
    T.concreteN = DL.normalMapFromHeight(concreteHeight(), 1.35);
    T.concreteN.repeat.set(2, 2);

    T.corrugated = DL.canvasTexture(corrugationTexture(), 1, 1, true);
    T.corrugatedN = DL.normalMapFromHeight(corrugationHeight(), 2.6);

    T.paint = DL.canvasTexture(paintAlbedo(), 1, 1, true);
    T.paintN = DL.normalMapFromHeight(concreteHeight(), 0.7);
    T.paintN.repeat.set(2, 2);

    T.wood = DL.canvasTexture(woodAlbedo(), 1, 1, true);
    T.sandbag = DL.canvasTexture(sandbagAlbedo(), 1, 1, true);
    T.bark = DL.canvasTexture(barkAlbedo(), 1, 2, true);
    T.hazard = DL.canvasTexture(hazardAlbedo(), 2, 1, true);
    T.grate = DL.canvasTexture(grateAlbedo(), 1, 1, true);

    T.chainlink = DL.canvasTexture(chainlinkAlpha(), 10, 1, false);
    T.barbed = DL.canvasTexture(barbedAlpha(), 8, 1, false);
    T.camo = DL.canvasTexture(camoNetAlpha(), 2, 2, true);
    T.grass = DL.canvasTexture(grassAlpha(), 1, 1, true);
    T.rippleN = rippleNormal();

    T.signGate = signTexture({
      w: 256, h: 128, bg: "#252a22", ink: "#c8cfb8",
      lines: [
        { text: "OUTPOST 13", size: 40, y: 42 },
        { text: "RESTRICTED AREA", size: 20, y: 76, color: "#b7a25f" },
        { text: "USE OF FORCE AUTHORIZED", size: 13, y: 102, color: "#9aa38e" },
      ],
    });
    T.signCmd = signTexture({
      w: 256, h: 96, bg: "#2b2c24", ink: "#d3cfa9",
      lines: [
        { text: "CMD-01", size: 38, y: 36 },
        { text: "COMMAND POST", size: 18, y: 70 },
      ],
    });
    T.signTower = signTexture({
      w: 192, h: 96, bg: "#262a20", ink: "#c2cbb2",
      lines: [
        { text: "OBS-13A", size: 32, y: 34 },
        { text: "WATCHTOWER", size: 16, y: 68 },
      ],
    });
    T.signContainer = signTexture({
      w: 256, h: 96, bg: "#3a4238", ink: "#c9d0bd",
      lines: [
        { text: "US ARMY 3321", size: 28, y: 34 },
        { text: "CLASSIFIED CARGO", size: 13, y: 66, color: "#b7a25f" },
      ],
    });
    T.signGen = signTexture({
      w: 256, h: 96, bg: "#33352a", ink: "#d6d2b6",
      lines: [
        { text: "GEN-04", size: 38, y: 34 },
        { text: "480V 60Hz", size: 17, y: 68 },
      ],
    });
    T.signAmmo = signTexture({
      w: 192, h: 96, bg: "#3b3a24", ink: "#d9c878",
      lines: [
        { text: "AMMUNITION", size: 22, y: 36 },
        { text: "5.56 MM", size: 20, y: 68 },
      ],
    });
    T.signDanger = signTexture({
      w: 192, h: 128, bg: "#8e7826", ink: "#17150f",
      lines: [
        { text: "DANGER", size: 34, y: 36 },
        { text: "HIGH VOLTAGE", size: 18, y: 66 },
        { text: "KEEP OUT", size: 16, y: 92 },
      ],
      icon: function (ctx, W, H) {
        ctx.strokeStyle = "#17150f";
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(W * 0.5 + 26, 34);
        ctx.lineTo(W * 0.5 + 10, 58);
        ctx.lineTo(W * 0.5 + 26, 58);
        ctx.lineTo(W * 0.5 + 12, 84);
        ctx.stroke();
      },
    });
    T.signFuel = signTexture({
      w: 160, h: 80, bg: "#38382a", ink: "#cfc9a8",
      lines: [
        { text: "FUEL", size: 24, y: 30 },
        { text: "FLAMMABLE", size: 13, y: 58, color: "#c9a24c" },
      ],
    });
    T.decal13 = decalTexture({
      w: 256, h: 256, paint: "rgba(170,172,150,0.8)",
      lines: [{ text: "13", size: 210, y: 140 }],
    });
    T.decalKeepClear = decalTexture({
      w: 256, h: 128, paint: "rgba(168,164,138,0.6)",
      lines: [
        { text: "KEEP CLEAR", size: 44, y: 48 },
        { text: "GENERATOR AREA", size: 20, y: 92 },
      ],
    });
    T.decalPad = decalTexture({
      w: 256, h: 256, paint: "rgba(198,190,120,0.55)",
      draw: function (ctx, W, H, paint) {
        ctx.strokeStyle = paint;
        ctx.lineWidth = 16;
        ctx.strokeRect(28, 28, W - 56, H - 56);
        ctx.font = "bold 160px monospace";
        ctx.fillStyle = paint;
        ctx.fillText("H", W / 2, H / 2 + 8);
      },
    });
    T.decalArrow = decalTexture({
      w: 128, h: 256, paint: "rgba(172,170,148,0.6)",
      draw: function (ctx, W, H, paint) {
        ctx.fillStyle = paint;
        ctx.beginPath();
        ctx.moveTo(W / 2, 20);
        ctx.lineTo(W - 20, 90);
        ctx.lineTo(W / 2 + 26, 90);
        ctx.lineTo(W / 2 + 26, H - 20);
        ctx.lineTo(W / 2 - 26, H - 20);
        ctx.lineTo(W / 2 - 26, 90);
        ctx.lineTo(20, 90);
        ctx.closePath();
        ctx.fill();
      },
    });
    w.T = T;
  };

  /* ------------------------------------------------------------------ */
  /* B.materials — shared PBR materials                                  */
  /* ------------------------------------------------------------------ */
  function tclone(tex, rx, ry) {
    const t = tex.clone();
    t.needsUpdate = true;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(rx, ry);
    return t;
  }

  function signMat(tex, glow) {
    return stdMat({
      map: tex,
      roughness: 0.72,
      metalness: 0.12,
      emissive: glow ? new THREE.Color(glow) : new THREE.Color(0x2a3034),
      emissiveMap: tex,
      emissiveIntensity: 0.22,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }, 0.35);
  }

  function decalMat(tex, opacity) {
    return stdMat({
      map: tex,
      transparent: true,
      opacity: opacity == null ? 0.82 : opacity,
      depthWrite: false,
      alphaTest: 0.08,
      roughness: 0.9,
      metalness: 0.0,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    }, 0.2);
  }

  B.materials = function (w) {
    const T = w.T;
    const M = {};

    const yardGround = tclone(T.ground, 7, 7);
    const yardNormal = tclone(T.groundN, 7, 7);
    const yardRough = tclone(T.groundR, 7, 7);
    const forestGround = tclone(T.ground, 1, 1);
    const forestNormal = tclone(T.groundN, 1, 1);
    const forestRough = tclone(T.groundR, 1, 1);

    M.ground = stdMat({
      map: T.ground,
      normalMap: T.groundN,
      normalScale: new THREE.Vector2(0.85, 0.85),
      roughnessMap: T.groundR,
      roughness: 1.0,
      metalness: 0.06,
      color: 0xb9b8ae,
    }, 0.9);

    M.yard = stdMat({
      map: yardGround,
      normalMap: yardNormal,
      normalScale: new THREE.Vector2(0.7, 0.7),
      roughnessMap: yardRough,
      roughness: 0.95,
      metalness: 0.12,
      color: 0x8e8d84,
    }, 1.0);

    M.forestFloor = stdMat({
      map: forestGround,
      normalMap: forestNormal,
      normalScale: new THREE.Vector2(0.8, 0.8),
      roughnessMap: forestRough,
      roughness: 1.0,
      metalness: 0.03,
      color: 0x5c5b51,
    }, 0.55);

    M.puddle = stdMat({
      color: 0x0a1216,
      roughness: 0.05,
      metalness: 0.9,
      normalMap: T.rippleN,
      normalScale: new THREE.Vector2(0.18, 0.18),
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
    }, 2.0);
    M.puddle.polygonOffset = true;
    M.puddle.polygonOffsetFactor = -3;
    M.puddle.polygonOffsetUnits = -3;
    M.puddle.renderOrder = 2;

    M.concrete = stdMat({
      map: T.concrete,
      normalMap: T.concreteN,
      normalScale: new THREE.Vector2(0.9, 0.9),
      roughness: 0.85,
      metalness: 0.04,
      color: 0xa9a79d,
    }, 0.5);

    M.concreteDark = stdMat({
      map: T.concrete,
      normalMap: T.concreteN,
      normalScale: new THREE.Vector2(1.0, 1.0),
      roughness: 0.76,
      metalness: 0.05,
      color: 0x7c7a72,
    }, 0.6);

    M.containerOlive = stdMat({
      map: T.corrugated,
      normalMap: T.corrugatedN,
      normalScale: new THREE.Vector2(1.1, 1.1),
      roughness: 0.52,
      metalness: 0.62,
      color: 0x8b9682,
    }, 1.1);

    M.containerRust = stdMat({
      map: T.corrugated,
      normalMap: T.corrugatedN,
      normalScale: new THREE.Vector2(1.1, 1.1),
      roughness: 0.58,
      metalness: 0.58,
      color: 0x9c7c60,
    }, 1.0);

    M.metalDark = stdMat({
      color: 0x2b2f2e,
      roughness: 0.4,
      metalness: 0.78,
    }, 1.2);

    M.metalRust = stdMat({
      color: 0x4c4034,
      roughness: 0.62,
      metalness: 0.5,
    }, 0.9);

    M.paint = stdMat({
      map: T.paint,
      normalMap: T.paintN,
      normalScale: new THREE.Vector2(0.5, 0.5),
      roughness: 0.5,
      metalness: 0.38,
      color: 0xc3c6b0,
    }, 1.0);

    M.wood = stdMat({
      map: T.wood,
      roughness: 0.8,
      metalness: 0.02,
      color: 0xb4a894,
    }, 0.35);

    M.woodDark = stdMat({
      map: T.wood,
      roughness: 0.86,
      metalness: 0.02,
      color: 0x6d6250,
    }, 0.25);

    M.sandbag = stdMat({
      map: T.sandbag,
      roughness: 0.95,
      metalness: 0.0,
      color: 0xb0a78a,
    }, 0.28);

    M.chainlink = stdMat({
      color: 0x3b4143,
      alphaMap: T.chainlink,
      alphaTest: 0.4,
      side: THREE.DoubleSide,
      roughness: 0.5,
      metalness: 0.62,
    }, 0.9);
    M.chainlink.alphaMap.repeat.set(10, 1);

    M.barbed = stdMat({
      color: 0x6b7173,
      alphaMap: T.barbed,
      alphaTest: 0.32,
      side: THREE.DoubleSide,
      roughness: 0.34,
      metalness: 0.82,
    }, 1.1);
    M.barbed.alphaMap.repeat.set(8, 1);

    M.hazard = stdMat({
      map: T.hazard,
      roughness: 0.62,
      metalness: 0.22,
      color: 0xc9bb8c,
    }, 0.55);

    M.grate = stdMat({
      map: T.grate,
      roughness: 0.55,
      metalness: 0.68,
      color: 0x9a9c96,
    }, 0.8);

    M.camo = stdMat({
      map: T.camo,
      alphaTest: 0.42,
      side: THREE.DoubleSide,
      roughness: 0.95,
      metalness: 0.0,
      color: 0xa5ad93,
    }, 0.18);

    M.grass = stdMat({
      map: T.grass,
      alphaTest: 0.34,
      side: THREE.DoubleSide,
      roughness: 0.9,
      metalness: 0.0,
      color: 0x9dab86,
    }, 0.2);
    M.grass.shadowSide = THREE.DoubleSide;

    M.treeTrunk = stdMat({
      map: T.bark,
      roughness: 0.92,
      metalness: 0.0,
      color: 0x8c877f,
    }, 0.14);

    M.canopy = stdMat({
      color: 0x22372c,
      roughness: 0.94,
      metalness: 0.0,
      flatShading: true,
    }, 0.12);

    M.canopyFar = stdMat({
      color: 0x131f19,
      roughness: 0.98,
      metalness: 0.0,
      flatShading: true,
    }, 0.04);

    M.snag = stdMat({
      color: 0x3a362e,
      roughness: 0.92,
      metalness: 0.0,
      flatShading: true,
    }, 0.12);

    M.bush = stdMat({
      color: 0x1d2c22,
      roughness: 0.96,
      metalness: 0.0,
      flatShading: true,
    }, 0.08);

    M.rock = stdMat({
      color: 0x3a3c37,
      roughness: 0.82,
      metalness: 0.06,
      flatShading: true,
    }, 0.35);

    M.barrel = stdMat({
      map: T.corrugated,
      normalMap: T.corrugatedN,
      normalScale: new THREE.Vector2(0.7, 0.7),
      roughness: 0.62,
      metalness: 0.55,
      color: 0x9a6a44,
    }, 0.8);

    M.ember = stdMat({
      color: 0x1a0a04,
      emissive: 0xff5c14,
      emissiveIntensity: 2.4,
      roughness: 1.0,
      metalness: 0.0,
    }, 0.0);

    M.lampCyan = stdMat({
      color: 0x0a1c1b,
      emissive: 0x46ffe2,
      emissiveIntensity: 2.5,
      roughness: 0.4,
      metalness: 0.2,
    }, 0.2);

    M.lampAmber = stdMat({
      color: 0x1d1408,
      emissive: 0xffb14e,
      emissiveIntensity: 2.2,
      roughness: 0.4,
      metalness: 0.2,
    }, 0.2);

    M.lampWhite = stdMat({
      color: 0x0e1618,
      emissive: 0xd6ecff,
      emissiveIntensity: 2.6,
      roughness: 0.35,
      metalness: 0.2,
    }, 0.2);

    M.beaconRed = stdMat({
      color: 0x1c0806,
      emissive: 0xff2a18,
      emissiveIntensity: 2.8,
      roughness: 0.5,
      metalness: 0.1,
    }, 0.1);

    M.beaconAmber = stdMat({
      color: 0x1c1206,
      emissive: 0xffa028,
      emissiveIntensity: 2.2,
      roughness: 0.5,
      metalness: 0.1,
    }, 0.1);

    M.interior = stdMat({
      color: 0x050607,
      roughness: 1.0,
      metalness: 0.0,
    }, 0.0);

    M.doorSteel = stdMat({
      map: T.corrugated,
      roughness: 0.5,
      metalness: 0.7,
      color: 0x6f766c,
    }, 1.0);

    M.ammoBox = stdMat({
      color: 0x4a4f34,
      roughness: 0.62,
      metalness: 0.4,
    }, 0.8);

    M.crate = stdMat({
      map: T.wood,
      roughness: 0.78,
      metalness: 0.05,
      color: 0x9d8f78,
    }, 0.4);

    M.spoolCable = stdMat({
      color: 0x121416,
      roughness: 0.72,
      metalness: 0.35,
    }, 0.5);

    M.signGate = signMat(T.signGate, 0x3a4650);
    M.signCmd = signMat(T.signCmd, 0x4a4432);
    M.signTower = signMat(T.signTower, 0x39402f);
    M.signContainer = signMat(T.signContainer, 0x3d463e);
    M.signGen = signMat(T.signGen, 0x4a4a32);
    M.signAmmo = signMat(T.signAmmo, 0x4a4728);
    M.signDanger = signMat(T.signDanger, 0x4a4220);
    M.signFuel = signMat(T.signFuel, 0x4a4228);

    M.decal13 = decalMat(T.decal13, 0.7);
    M.decalKeepClear = decalMat(T.decalKeepClear, 0.62);
    M.decalPad = decalMat(T.decalPad, 0.5);
    M.decalArrow = decalMat(T.decalArrow, 0.5);

    M.cableLine = new THREE.LineBasicMaterial({ color: 0x101316, transparent: true, opacity: 0.95, fog: true });

    w.M = M;
  };

  /* ------------------------------------------------------------------ */
  /* B.sky — night dome, silhouette rings                                */
  /* ------------------------------------------------------------------ */
  B.sky = function (w) {
    const skyGeo = new THREE.SphereGeometry(320, 40, 24);
    const col = function (hex) { return new THREE.Color(hex); };
    const uniforms = {
      uZenith: { value: col(0x060b12) },
      uHorizon: { value: col(0x1b303b) },
      uGround: { value: col(0x04070a) },
      uGlow: { value: col(0x46331b) },
      uCloudCol: { value: col(0x0b131b) },
      uMoonDir: { value: new THREE.Vector3(-0.48, 0.52, -0.7).normalize() },
      uMoonColor: { value: col(0xcfdff5) },
      uStarStrength: { value: 1 },
      uDiscStrength: { value: 2.2 },
      uHaloStrength: { value: 1 },
      uTime: { value: 0 },
      uFlash: { value: 0 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: uniforms,
      vertexShader: [
        "varying vec3 vDir;",
        "void main() {",
        "  vDir = position;",
        "  vec4 mv = modelViewMatrix * vec4( position, 1.0 );",
        "  gl_Position = projectionMatrix * mv;",
        "}",
      ].join("\n"),
      fragmentShader: [
        "uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uGround;",
        "uniform vec3 uGlow; uniform vec3 uCloudCol; uniform vec3 uMoonDir;",
        "uniform vec3 uMoonColor; uniform float uTime; uniform float uFlash;",
        "uniform float uStarStrength; uniform float uDiscStrength; uniform float uHaloStrength;",
        "varying vec3 vDir;",
        "float hash21( vec2 p ) { p = fract( p * vec2( 123.34, 345.45 ) ); p += dot( p, p + 34.345 ); return fract( p.x * p.y ); }",
        "float vnoise( vec2 p ) {",
        "  vec2 i = floor( p ); vec2 f = fract( p );",
        "  f = f * f * ( 3.0 - 2.0 * f );",
        "  float a = hash21( i ); float b = hash21( i + vec2( 1.0, 0.0 ) );",
        "  float c = hash21( i + vec2( 0.0, 1.0 ) ); float d = hash21( i + vec2( 1.0, 1.0 ) );",
        "  return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );",
        "}",
        "float fbm( vec2 p ) {",
        "  float s = 0.0; float a = 0.5;",
        "  for ( int i = 0; i < 5; i++ ) { s += vnoise( p ) * a; p = p * 2.03 + 11.7; a *= 0.5; }",
        "  return s;",
        "}",
        "void main() {",
        "  vec3 d = normalize( vDir );",
        "  float h = clamp( d.y, -0.25, 1.0 );",
        "  vec3 col = mix( uHorizon, uZenith, smoothstep( -0.02, 0.62, h ) );",
        "  col = mix( uGround, col, smoothstep( -0.14, 0.012, h ) );",
        "  vec2 az = normalize( d.xz + vec2( 0.0001 ) );",
        "  float glowMask = pow( clamp( 1.0 - abs( d.y ) * 5.0, 0.0, 1.0 ), 2.0 );",
        "  float side = smoothstep( -0.4, 1.0, dot( az, normalize( vec2( 0.72, -0.69 ) ) ) );",
        "  col += uGlow * glowMask * ( 0.18 + 0.82 * side );",
        "  vec2 sp = vec2( atan( d.z, d.x ) * 0.15915, asin( clamp( d.y, -1.0, 1.0 ) ) * 0.3183 ) * vec2( 260.0, 170.0 );",
        "  vec2 cell = floor( sp ); vec2 f = fract( sp ) - 0.5;",
        "  float rnd = hash21( cell );",
        "  float star = ( 1.0 - smoothstep( 0.0, 0.33, length( f ) ) ) * step( 0.974, rnd );",
        "  float tw = 0.55 + 0.45 * sin( uTime * ( 1.1 + rnd * 3.0 ) + rnd * 31.0 );",
        "  col += vec3( 0.55, 0.66, 0.9 ) * star * tw * smoothstep( 0.03, 0.4, d.y ) * 1.25 * uStarStrength;",
        "  vec2 cuv = d.xz / max( abs( d.y ) + 0.2, 0.14 );",
        "  cuv = clamp( cuv, -26.0, 26.0 ) * 0.55;",
        "  cuv.x += uTime * 0.0075; cuv.y += uTime * 0.0028;",
        "  float cl = smoothstep( 0.4, 0.86, fbm( cuv * 1.4 ) );",
        "  cl *= smoothstep( 0.0, 0.24, d.y );",
        "  col = mix( col, uCloudCol, cl * 0.74 );",
        "  float flick = uFlash * ( 0.7 + 0.3 * sin( uTime * 51.0 ) );",
        "  col += vec3( 0.5, 0.63, 0.92 ) * flick * ( 0.3 + cl * 1.7 );",
        "  float md = max( dot( d, normalize( uMoonDir ) ), 0.0 );",
        "  float disc = smoothstep( 0.99930, 0.99962, md );",
        "  float halo = pow( md, 80.0 ) * 0.5 + pow( md, 700.0 ) * 0.85;",
        "  col += uMoonColor * ( disc * uDiscStrength + halo * uHaloStrength ) * ( 1.0 - cl * 0.5 );",
        "  col += uHorizon * 0.18 * exp( -abs( d.y ) * 16.0 );",
        "  gl_FragColor = vec4( col, 1.0 );",
        "  #include <tonemapping_fragment>",
        "  #include <colorspace_fragment>",
        "}",
      ].join("\n"),
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      toneMapped: true,
    });
    const sky = new THREE.Mesh(skyGeo, mat);
    sky.renderOrder = -1000;
    sky.frustumCulled = false;
    sky.matrixAutoUpdate = false;
    sky.updateMatrix();
    w.scene.add(sky);
    w._sky = sky;
    w._skyMat = mat;
    w._skyUniforms = uniforms;

    /* distant silhouette rings: tree line, hills, mountains */
    const rng = DL.mulberry32(60413);
    const rings = [
      { r: 112, h: 9, amp: 7, color: 0x0b1318, dayColor: 0x9aafb6, seg: 118 },
      { r: 168, h: 15, amp: 12, color: 0x081016, dayColor: 0x839da8, seg: 100 },
      { r: 240, h: 26, amp: 22, color: 0x04080e, dayColor: 0x6e8794, seg: 84 },
    ];
    for (let k = 0; k < rings.length; k++) {
      const cfg = rings[k];
      const seg = cfg.seg;
      const pos = new Float32Array(seg * 6 * 3);
      const colors = new Float32Array(seg * 6 * 3);
      const dayColors = new Float32Array(seg * 6 * 3);
      const base = new THREE.Color(cfg.color);
      const bottom = base.clone().multiplyScalar(0.32);
      const dayBase = new THREE.Color(cfg.dayColor);
      const dayBottom = dayBase.clone().multiplyScalar(0.62);
      const hs = new Float32Array(seg + 1);
      for (let i = 0; i <= seg; i++) {
        const n = DL.fbm2(i * 0.19 + k * 13.7, k * 3.1, 3);
        hs[i] = cfg.h + Math.max(-0.7, n) * cfg.amp;
      }
      let p = 0, c = 0, dc = 0;
      for (let i = 0; i < seg; i++) {
        const a0 = (i / seg) * TAU, a1 = ((i + 1) / seg) * TAU;
        const x0 = Math.cos(a0) * cfg.r, z0 = Math.sin(a0) * cfg.r;
        const x1 = Math.cos(a1) * cfg.r, z1 = Math.sin(a1) * cfg.r;
        const y0 = hs[i], y1 = hs[i + 1];
        const yb = -6;
        const quad = [
          [x0, yb, z0], [x1, yb, z1], [x1, y1, z1],
          [x0, yb, z0], [x1, y1, z1], [x0, y0, z0],
        ];
        for (let v = 0; v < 6; v++) {
          pos[p++] = quad[v][0]; pos[p++] = quad[v][1]; pos[p++] = quad[v][2];
          const top = v === 2 || v === 4 || v === 5;
          const cc2 = top ? base : bottom;
          colors[c++] = cc2.r; colors[c++] = cc2.g; colors[c++] = cc2.b;
          const dcc = top ? dayBase : dayBottom;
          dayColors[dc++] = dcc.r; dayColors[dc++] = dcc.g; dayColors[dc++] = dcc.b;
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      g.computeBoundingSphere();
      const m = new THREE.Mesh(
        g,
        new THREE.MeshBasicMaterial({
          vertexColors: true,
          fog: false,
          side: THREE.DoubleSide,
          depthWrite: false,
        })
      );
      m.userData.nightColors = colors;
      m.userData.dayColors = dayColors;
      m.renderOrder = -950 + k * 2;
      m.frustumCulled = false;
      w.scene.add(m);
      (w._ridge = w._ridge || []).push(m);
    }
  };

  /* ------------------------------------------------------------------ */
  /* B.env — PMREM environment probe from the procedural sky             */
  /* ------------------------------------------------------------------ */
  B.env = function (w) {
    if (!w.renderer) return;
    const sky = w._sky;
    if (!sky) return;
    let pmrem = null;
    let rt = null;
    const temp = new THREE.Scene();
    try {
      pmrem = new THREE.PMREMGenerator(w.renderer);
      w.scene.remove(sky);
      temp.add(sky);
      rt = pmrem.fromScene(temp, 0.02, 0.1, 1000);
    } catch (err) {
      rt = null;
    } finally {
      temp.remove(sky);
      if (sky.parent !== w.scene) w.scene.add(sky);
      if (pmrem) pmrem.dispose();
    }
    if (rt) {
      w._envRT = rt;
      w.scene.environment = rt.texture;
    }
  };

  /* ------------------------------------------------------------------ */
  /* B.lights — moon, hemi, ambient                                      */
  /* ------------------------------------------------------------------ */
  B.lights = function (w) {
    const q = w.quality;
    const scene = w.scene;
    if (w.renderer && w.renderer.shadowMap && !w.renderer.shadowMap.enabled) {
      w.renderer.shadowMap.enabled = true;
    }

    const hemi = new THREE.HemisphereLight(0x36536b, 0x16130f, 0.42);
    hemi.position.set(0, 40, 0);
    scene.add(hemi);
    w._hemi = hemi;
    w._hemiBase = 0.42;

    const amb = new THREE.AmbientLight(0x22303c, 0.32);
    scene.add(amb);
    w._ambient = amb;
    w._ambientBase = 0.32;

    const moonDir = w._skyUniforms.uMoonDir.value.clone();
    const moon = new THREE.DirectionalLight(0xb6d2ea, 1.45);
    moon.position.copy(moonDir).multiplyScalar(110);
    moon.target.position.set(0, 0, 0);
    scene.add(moon.target);
    scene.add(moon);
    w._moon = moon;
    w._moonBase = 1.45;

    const sm = q.shadowMapSize || 2048;
    moon.castShadow = true;
    moon.shadow.mapSize.set(sm, sm);
    moon.shadow.camera.left = -40;
    moon.shadow.camera.right = 40;
    moon.shadow.camera.top = 42;
    moon.shadow.camera.bottom = -42;
    moon.shadow.camera.near = 1;
    moon.shadow.camera.far = 230;
    moon.shadow.bias = -0.00045;
    moon.shadow.normalBias = 0.035;
    moon.shadow.camera.updateProjectionMatrix();

    /* faint cold fill from the opposite side to shape silhouettes */
    const fill = new THREE.DirectionalLight(0x2c4256, 0.28);
    fill.position.set(40, 26, 45);
    scene.add(fill);
    w._fill = fill;
  };

  /* ------------------------------------------------------------------ */
  /* B.glows — additive halos for every lamp / beacon (one draw call)    */
  /* ------------------------------------------------------------------ */
  B.glows = function (w) {
    const list = w._glows;
    if (!list || !list.length) return;
    const n = list.length;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const phase = new Float32Array(n);
    const blink = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const g = list[i];
      pos[i * 3] = g.x; pos[i * 3 + 1] = g.y; pos[i * 3 + 2] = g.z;
      col[i * 3] = g.r; col[i * 3 + 1] = g.g; col[i * 3 + 2] = g.b;
      size[i] = g.size;
      phase[i] = g.phase;
      blink[i] = g.blink ? 1 : 0;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
    geo.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
    geo.setAttribute("aPhase", new THREE.BufferAttribute(phase, 1));
    geo.setAttribute("aBlink", new THREE.BufferAttribute(blink, 1));
    geo.computeBoundingSphere();
    const dpr = w.renderer ? w.renderer.getPixelRatio() : 1;
    const h = (w.renderer && w.renderer.domElement ? w.renderer.domElement.height : 720) * (dpr || 1);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPx: { value: h * 0.5 / Math.tan(0.61) },
      },
      vertexShader: [
        "attribute vec3 aColor; attribute float aSize; attribute float aPhase; attribute float aBlink;",
        "uniform float uTime; uniform float uPx;",
        "varying vec3 vColor; varying float vAlpha;",
        "void main() {",
        "  vec3 p = position;",
        "  p.y += sin( uTime * 1.7 + aPhase * 6.283 ) * 0.015;",
        "  vec4 mv = modelViewMatrix * vec4( p, 1.0 );",
        "  float dist = max( 0.25, -mv.z );",
        "  gl_Position = projectionMatrix * mv;",
        "  gl_PointSize = clamp( aSize * uPx / dist, 2.0, 220.0 );",
        "  float b = mix( 1.0, step( 0.7, fract( uTime * 0.62 + aPhase ) ), aBlink );",
        "  vAlpha = b * ( 0.82 + 0.18 * sin( uTime * 2.6 + aPhase * 9.0 ) );",
        "  vColor = aColor;",
        "}",
      ].join("\n"),
      fragmentShader: [
        "varying vec3 vColor; varying float vAlpha;",
        "void main() {",
        "  vec2 uv = gl_PointCoord - 0.5;",
        "  float d = length( uv );",
        "  if ( d > 0.5 ) discard;",
        "  float a = pow( max( 0.0, 1.0 - d * 2.0 ), 2.6 );",
        "  gl_FragColor = vec4( vColor * ( 0.35 + a * 0.9 ), a * vAlpha );",
        "}",
      ].join("\n"),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      fog: false,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = 8;
    w.scene.add(pts);
    w._glowPoints = pts;
    w._glowMat = mat;
  };

  /* ------------------------------------------------------------------ */
  /* instancing helpers                                                  */
  /* ------------------------------------------------------------------ */
  function makeInstanced(geo, mat, count, cast, receive) {
    const m = new THREE.InstancedMesh(geo, mat, count);
    m.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    m.castShadow = !!cast;
    m.receiveShadow = !!receive;
    m.frustumCulled = false;
    return m;
  }

  function setInst(m, i, x, y, z, rx, ry, rz, sx, sy, sz) {
    _eul.set(rx || 0, ry || 0, rz || 0);
    _quat.setFromEuler(_eul);
    _vec.set(x || 0, y || 0, z || 0);
    _scl.set(sx === undefined ? 1 : sx, sy === undefined ? 1 : sy, sz === undefined ? 1 : sz);
    _m4.compose(_vec, _quat, _scl);
    m.setMatrixAt(i, _m4);
  }

  function doneInst(m) {
    m.instanceMatrix.needsUpdate = true;
    return m;
  }

  /* ------------------------------------------------------------------ */
  /* B.ground — wet terrain, courtyard, pads, puddles, paint decals      */
  /* ------------------------------------------------------------------ */
  B.ground = function (w) {
    const M = w.M;
    const scene = w.scene;

    // outer mud flats
    const mud = new THREE.Mesh(new THREE.PlaneGeometry(210, 210, 1, 1), M.ground);
    mud.rotation.x = -PI / 2;
    mud.receiveShadow = true;
    scene.add(mud);
    w._addRay(mud);

    // dark needle-littered forest floor ring (custom world-space UVs)
    const ringGeo = new THREE.RingGeometry(23.6, 105, 96, 1);
    ringGeo.rotateX(-PI / 2);
    const rp = ringGeo.attributes.position;
    const ruv = ringGeo.attributes.uv;
    for (let i = 0; i < rp.count; i++) ruv.setXY(i, rp.getX(i) * 0.125, rp.getZ(i) * 0.125);
    const floor = new THREE.Mesh(ringGeo, M.forestFloor);
    floor.position.y = 0.004;
    floor.receiveShadow = true;
    scene.add(floor);

    // wet gravel / packed dirt courtyard
    const yard = new THREE.Mesh(new THREE.PlaneGeometry(39.4, 39.4, 1, 1), M.yard);
    yard.rotation.x = -PI / 2;
    yard.position.y = 0.009;
    yard.receiveShadow = true;
    scene.add(yard);
    w._addRay(yard);

    // concrete pads
    const pads = [
      [0, 0.07, 0, 5.6, 0.14, 4.2],
      [-11, 0.06, -7.4, 9.0, 0.12, 3.4],
      [12, 0.06, -12, 6.2, 0.12, 6.2],
      [13, 0.055, 6, 3.4, 0.11, 7.0],
      [-14, 0.055, 7, 7.0, 0.11, 3.4],
      [0, 0.05, 18.8, 9.0, 0.10, 2.6],
      [0, 0.05, -18.8, 9.0, 0.10, 2.6],
      [8.6, 0.05, 4.6, 4.2, 0.10, 3.0],
    ];
    const padMesh = makeInstanced(boxGeo(1, 1, 1), M.concreteDark, pads.length, false, true);
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      setInst(padMesh, i, p[0], p[1], p[2], 0, 0, 0, p[3], p[4], p[5]);
    }
    doneInst(padMesh);
    scene.add(padMesh);
    w._addRay(padMesh);

    // puddles (instanced, env-reflective)
    const pgeo = new THREE.CircleGeometry(1, 18);
    pgeo.rotateX(-PI / 2);
    const puddleSpots = [
      [-6.2, 14.2, 1.7, 1.1], [6.4, 10.2, 2.2, 1.3], [-12.6, 5.8, 1.3, 0.8],
      [11.4, 12.4, 1.6, 1.0], [-4.4, -2.6, 1.4, 1.0], [5.2, -6.2, 2.0, 1.2],
      [-9.6, 12.8, 1.2, 0.8], [13.2, -2.4, 1.5, 0.9], [-16.2, -1.6, 1.8, 1.0],
      [3.0, 3.4, 1.1, 0.7], [-2.4, 8.8, 1.0, 0.7], [16.6, 14.8, 1.3, 0.9],
      [0.4, 23.2, 2.6, 1.6], [-1.8, -22.6, 2.2, 1.4], [5.2, 24.6, 1.6, 1.0],
      [-7.4, -24.2, 1.8, 1.1], [22.6, 4.2, 2.0, 1.2], [-23.4, -8.6, 1.6, 1.0],
      [17.8, -21.4, 2.4, 1.4], [-17.2, 21.8, 2.1, 1.3], [9.6, -25.2, 1.5, 0.9],
    ];
    const puddles = makeInstanced(pgeo, M.puddle, puddleSpots.length, false, false);
    for (let i = 0; i < puddleSpots.length; i++) {
      const p = puddleSpots[i];
      setInst(puddles, i, p[0], 0.022, p[1], 0, (i * 1.37) % TAU, 0, p[2], 1, p[3]);
    }
    doneInst(puddles);
    scene.add(puddles);
    w._puddles = puddles;

    // painted ground decals
    const hPad = new THREE.Mesh(new THREE.PlaneGeometry(5.2, 5.2), M.decalPad);
    hPad.rotation.set(-PI / 2, 0, 0.12);
    hPad.position.set(0.4, 0.028, 10.2);
    hPad.renderOrder = 3;
    scene.add(hPad);

    const keepClear = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 2.1), M.decalKeepClear);
    keepClear.rotation.set(-PI / 2, 0, PI);
    keepClear.position.set(0, 0.028, 4.4);
    keepClear.renderOrder = 3;
    scene.add(keepClear);

    const arrow = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 2.2), M.decalArrow);
    arrow.rotation.set(-PI / 2, 0, 0);
    arrow.position.set(-4.4, 0.028, 9.4);
    arrow.renderOrder = 3;
    scene.add(arrow);

    const arrow2 = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 2.2), M.decalArrow);
    arrow2.rotation.set(-PI / 2, 0, PI);
    arrow2.position.set(4.4, 0.028, 9.4);
    arrow2.renderOrder = 3;
    scene.add(arrow2);
  };

  /* ------------------------------------------------------------------ */
  /* B.walls — concrete base + chain link + concertina + gate frames     */
  /* ------------------------------------------------------------------ */
  B.walls = function (w) {
    const M = w.M;
    const scene = w.scene;

    const runs = [
      { axis: "x", z: 20, a: -20, b: -3.5, out: 1 },
      { axis: "x", z: 20, a: 3.5, b: 20, out: 1 },
      { axis: "x", z: -20, a: -20, b: -3.5, out: -1 },
      { axis: "x", z: -20, a: 3.5, b: 20, out: -1 },
      { axis: "z", x: 20, a: -20, b: 20, out: 1 },
      { axis: "z", x: -20, a: -20, b: 20, out: -1 },
    ];

    const baseH = 1.15;
    const fenceH = 2.55;
    const fenceY = baseH + fenceH * 0.5;
    const postH = 2.75;

    /* concrete base — one instanced mesh */
    const base = makeInstanced(boxGeo(1, 1, 1), M.concrete, runs.length, true, true);
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i];
      const len = r.b - r.a;
      const mid = (r.a + r.b) * 0.5;
      if (r.axis === "x") setInst(base, i, mid, baseH * 0.5, r.z, 0, 0, 0, len, baseH, 0.55);
      else setInst(base, i, r.x, baseH * 0.5, mid, 0, 0, 0, 0.55, baseH, len);
    }
    doneInst(base);
    scene.add(base);
    base.userData.worldObj = "wall";
    w._addRay(base);

    /* fence panels */
    let panelTotal = 0;
    const runInfo = [];
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i];
      const len = r.b - r.a;
      const count = Math.max(1, Math.round(len / 2.5));
      runInfo.push({ r: r, len: len, count: count, panelW: len / count });
      panelTotal += count;
    }
    const panelGeo = new THREE.PlaneGeometry(2.5, fenceH);
    const fences = makeInstanced(panelGeo, M.chainlink, panelTotal, false, false);
    const posts = makeInstanced(cylGeo(0.055, 0.07, postH, 6), M.metalDark, panelTotal + runs.length, true, false);
    const rails = makeInstanced(boxGeo(1, 0.075, 0.075), M.metalDark, panelTotal, false, false);
    const barbed = makeInstanced(new THREE.PlaneGeometry(2.5, 0.85), M.barbed, panelTotal, false, false);
    let pi = 0, postI = 0;
    for (let ri = 0; ri < runInfo.length; ri++) {
      const info = runInfo[ri];
      const r = info.r;
      const out = r.out;
      for (let i = 0; i < info.count; i++) {
        const t = r.a + info.panelW * (i + 0.5);
        const sx = info.panelW / 2.5;
        if (r.axis === "x") {
          setInst(fences, pi, t, fenceY, r.z, 0, out > 0 ? 0 : PI, 0, sx, 1, 1);
          setInst(rails, pi, t, baseH + fenceH + 0.02, r.z, 0, 0, 0, info.panelW, 1, 1);
          setInst(barbed, pi, t, baseH + fenceH + 0.45, r.z, -0.16 * out, out > 0 ? 0 : PI, 0, sx, 1, 1);
        } else {
          setInst(fences, pi, r.x, fenceY, t, 0, out > 0 ? PI / 2 : -PI / 2, 0, sx, 1, 1);
          setInst(rails, pi, r.x, baseH + fenceH + 0.02, t, 0, PI / 2, 0, info.panelW, 1, 1);
          setInst(barbed, pi, r.x, baseH + fenceH + 0.45, t, -0.16, out > 0 ? PI / 2 : -PI / 2, 0, sx, 1, 1);
        }
        pi++;
        // posts at every panel boundary
        const pt = r.a + info.panelW * i;
        if (r.axis === "x") setInst(posts, postI, pt, baseH + postH * 0.5 - 0.1, r.z, 0, 0, 0, 1, 1, 1);
        else setInst(posts, postI, r.x, baseH + postH * 0.5 - 0.1, pt, 0, 0, 0, 1, 1, 1);
        postI++;
        if (i === info.count - 1) {
          const pt2 = r.b;
          if (r.axis === "x") setInst(posts, postI, pt2, baseH + postH * 0.5 - 0.1, r.z, 0, 0, 0, 1, 1, 1);
          else setInst(posts, postI, r.x, baseH + postH * 0.5 - 0.1, pt2, 0, 0, 0, 1, 1, 1);
          postI++;
        }
      }
    }
    doneInst(fences); doneInst(posts); doneInst(rails); doneInst(barbed);
    scene.add(fences); scene.add(posts); scene.add(rails); scene.add(barbed);

    /* corner pillars */
    const cornerPillars = makeInstanced(boxGeo(0.9, 1.5, 0.9), M.concreteDark, 4, true, true);
    const corners = [[-20, -20], [-20, 20], [20, -20], [20, 20]];
    for (let i = 0; i < 4; i++) setInst(cornerPillars, i, corners[i][0], 0.75, corners[i][1], 0, 0, 0, 1, 1, 1);
    doneInst(cornerPillars);
    scene.add(cornerPillars);

    /* gate pillars */
    const gatePillars = makeInstanced(boxGeo(0.72, 3.7, 0.72), M.concreteDark, 4, true, true);
    const gp = [[-3.85, 20], [3.85, 20], [-3.85, -20], [3.85, -20]];
    for (let i = 0; i < 4; i++) setInst(gatePillars, i, gp[i][0], 1.85, gp[i][1], 0, 0, 0, 1, 1, 1);
    doneInst(gatePillars);
    scene.add(gatePillars);
    w._addRay(gatePillars);

    /* gate header beams + signs */
    for (let side = 0; side < 2; side++) {
      const z = side === 0 ? 20 : -20;
      const out = side === 0 ? 1 : -1;
      const headerParts = [
        bgeo(8.1, 0.58, 0.62, 0, 3.72, z),
        strutGeo(new THREE.Vector3(-3.7, 3.45, z), new THREE.Vector3(-2.4, 4.15, z), 0.1, 0.1),
        strutGeo(new THREE.Vector3(3.7, 3.45, z), new THREE.Vector3(2.4, 4.15, z), 0.1, 0.1),
      ];
      const header = new THREE.Mesh(mergeGeos(headerParts), M.metalDark);
      header.castShadow = true;
      header.receiveShadow = true;
      scene.add(header);
      w._addRay(header);
      // sign
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.9, 1.45), M.signGate);
      sign.position.set(0, 3.72, z + out * 0.33);
      sign.rotation.y = out > 0 ? 0 : PI;
      scene.add(sign);
      // gate lamps (state-driven colour)
      const lampMat = new THREE.MeshStandardMaterial({
        color: 0x1a0604, emissive: 0xff2a18, emissiveIntensity: 2.4, roughness: 0.45, metalness: 0.1,
      });
      const lamp = mesh(scene, sphereGeo(0.075, 8, 6), lampMat, 3.35, 3.35, z + out * 0.32);
      w._addRoot(lamp);
      // hazard strip on header
      const strip = mesh(scene, boxGeo(7.8, 0.14, 0.04), M.hazard, 0, 3.4, z + out * 0.32);
      strip.castShadow = false;
      scene.add(strip);
      if (side === 0) w._gateLampSouth = lampMat;
      else w._gateLampNorth = lampMat;
    }

    /* permit sign + stencils on the outside of the south wall */
    const permit1 = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 1.2), M.signGate);
    permit1.position.set(-6.4, 2.05, 20.29);
    permit1.rotation.y = 0;
    scene.add(permit1);
    const dec13a = new THREE.Mesh(new THREE.PlaneGeometry(1.25, 1.25), M.decal13);
    dec13a.position.set(-8.7, 0.62, 20.30);
    scene.add(dec13a);
    const dec13b = new THREE.Mesh(new THREE.PlaneGeometry(1.25, 1.25), M.decal13);
    dec13b.position.set(-8.7, 0.62, 19.70);
    dec13b.rotation.y = PI;
    scene.add(dec13b);
    const dec13c = new THREE.Mesh(new THREE.PlaneGeometry(1.25, 1.25), M.decal13);
    dec13c.position.set(-19.70, 0.62, 8.4);
    dec13c.rotation.y = PI / 2;
    scene.add(dec13c);

    /* colliders + nav blocking for every wall run */
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i];
      let bx;
      if (r.axis === "x") bx = { minX: r.a, maxX: r.b, minZ: r.z - 0.32, maxZ: r.z + 0.32, height: 3.95 };
      else bx = { minX: r.x - 0.32, maxX: r.x + 0.32, minZ: r.a, maxZ: r.b, height: 3.95 };
      w._addSolid(bx);
    }
    const pillarBoxes = [
      { minX: -20.5, maxX: -19.5, minZ: -20.5, maxZ: -19.5, height: 2.3 },
      { minX: -20.5, maxX: -19.5, minZ: 19.5, maxZ: 20.5, height: 2.3 },
      { minX: 19.5, maxX: 20.5, minZ: -20.5, maxZ: -19.5, height: 2.3 },
      { minX: 19.5, maxX: 20.5, minZ: 19.5, maxZ: 20.5, height: 2.3 },
      { minX: -4.25, maxX: -3.45, minZ: 19.6, maxZ: 20.4, height: 3.8 },
      { minX: 3.45, maxX: 4.25, minZ: 19.6, maxZ: 20.4, height: 3.8 },
      { minX: -4.25, maxX: -3.45, minZ: -20.4, maxZ: -19.6, height: 3.8 },
      { minX: 3.45, maxX: 4.25, minZ: -20.4, maxZ: -19.6, height: 3.8 },
    ];
    for (let i = 0; i < pillarBoxes.length; i++) w._addSolid(pillarBoxes[i]);
  };

  /* ------------------------------------------------------------------ */
  /* B.gates — two wooden barricades (destructible, dynamic nav blockers) */
  /* ------------------------------------------------------------------ */
  B.gates = function (w) {
    const M = w.M;
    const scene = w.scene;
    const ids = ["south", "north"];

    for (let s = 0; s < 2; s++) {
      const id = ids[s];
      const z = s === 0 ? 20 : -20;
      const out = s === 0 ? 1 : -1;
      const group = new THREE.Group();
      group.position.set(0, 0, z);
      group.rotation.y = s === 0 ? 0 : PI;
      group.userData.worldObj = "barricadeGate";
      scene.add(group);
      w._addRoot(group);

      // support posts (merged)
      const postParts = [];
      for (let i = 0; i < 4; i++) postParts.push(bgeo(0.16, 3.05, 0.2, -3.15 + i * 2.1, 1.525, 0));
      const postMesh = new THREE.Mesh(mergeGeos(postParts), M.woodDark);
      postMesh.castShadow = true;
      postMesh.receiveShadow = true;
      group.add(postMesh);
      // diagonal braces (merged, hidden when the gate breaks)
      const braceParts = [];
      braceParts.push(bgeo(7.1, 0.19, 0.1, 0, 1.95, 0.2, 0, 0, 0.44));
      braceParts.push(bgeo(7.1, 0.19, 0.1, 0, 1.95, 0.21, 0, 0, -0.44));
      const braceMesh = new THREE.Mesh(mergeGeos(braceParts), M.woodDark);
      braceMesh.castShadow = true;
      group.add(braceMesh);
      const braces = [braceMesh];

      // planks
      const planks = [];
      const plankYs = [0.62, 1.24, 1.86, 2.48, 3.02];
      for (let i = 0; i < plankYs.length; i++) {
        const p = mesh(group, boxGeo(6.7, 0.35, 0.14), M.wood, 0, plankYs[i], 0.12 + (i % 2) * 0.02);
        p.castShadow = true;
        p.receiveShadow = true;
        planks.push({ mesh: p, y: p.position.y, z: p.position.z, rz: 0 });
      }
      // nails / bolts (merged)
      const nailParts = [];
      for (let i = 0; i < 14; i++) {
        nailParts.push(cgeo(0.035, 0.035, 0.03, 5, -2.7 + i * 0.42, 0.62 + (i % 5) * 0.62, 0.22, PI / 2, 0, 0));
      }
      const nails = new THREE.Mesh(mergeGeos(nailParts), M.metalRust);
      group.add(nails);
      // sandbag berm at the base
      const berm = mesh(group, boxGeo(6.9, 0.46, 0.95), M.sandbag, 0, 0.26, 0);
      berm.castShadow = true;
      berm.receiveShadow = true;
      // hazard tape across the top
      const tape = mesh(group, boxGeo(6.7, 0.13, 0.03), M.hazard, 0, 3.32, 0.19);
      // broken debris (merged, hidden until broken)
      const debrisParts = [];
      for (let i = 0; i < 5; i++) {
        debrisParts.push(bgeo(1.1 + Math.random() * 1.2, 0.14, 0.11,
          -2.2 + i * 1.15, 0.08, 0.5 + Math.random() * 0.7,
          0, Math.random() * PI, (Math.random() - 0.5) * 0.16));
      }
      const debrisMesh = new THREE.Mesh(mergeGeos(debrisParts), M.woodDark);
      debrisMesh.visible = false;
      group.add(debrisMesh);
      const debris = [debrisMesh];
      // invisible hit proxy for reliable bullet raycasts
      const hitMat = new THREE.MeshBasicMaterial({
        transparent: true, opacity: 0, depthWrite: false, colorWrite: false, side: THREE.DoubleSide,
      });
      const hitBox = mesh(group, boxGeo(6.9, 3.5, 0.8), hitMat, 0, 1.75, 0.12);
      hitBox.castShadow = false;
      hitBox.receiveShadow = false;

      const hitMeshes = [];
      for (let i = 0; i < planks.length; i++) hitMeshes.push(planks[i].mesh);
      for (let i = 0; i < braces.length; i++) hitMeshes.push(braces[i]);
      hitMeshes.push(hitBox);

      const b = {
        id: id,
        group: group,
        position: new THREE.Vector3(0, 0, z),
        normal: new THREE.Vector3(0, 0, out),
        width: 7,
        height: 3.5,
        health: 400,
        maxHealth: 400,
        broken: false,
        blocked: true,
        hitMeshes: hitMeshes,
        planks: planks,
        braces: braces,
        debris: debris,
        tape: tape,
        berm: berm,
        lampMat: s === 0 ? w._gateLampSouth : w._gateLampNorth,
        repairCost: 40,
        repairAmount: 130,
        collider: { minX: -3.6, maxX: 3.6, minZ: z - 0.45, maxZ: z + 0.45, height: 3.6 },
        approachOut: new THREE.Vector3(0, 0, z + out * 2.6),
        approachIn: new THREE.Vector3(0, 0, z - out * 2.6),
      };
      for (let i = 0; i < hitMeshes.length; i++) {
        hitMeshes[i].userData.barricade = id;
        hitMeshes[i].userData.worldObj = "barricade";
      }
      group.userData.barricade = id;

      w.barricades.push(b);
      w._barricadesById[id] = b;
      w._glow(0, 3.9, z, 0x8a2a1a, 0.55, false, 0.15 + s * 0.5);
    }
  };

  /* ------------------------------------------------------------------ */
  /* small merged-geometry helpers                                       */
  /* ------------------------------------------------------------------ */
  function bgeo(w, h, d, x, y, z, rx, ry, rz) {
    return xf(boxGeo(w, h, d), x || 0, y || 0, z || 0, rx || 0, ry || 0, rz || 0);
  }
  function cgeo(rt, rb, h, seg, x, y, z, rx, ry, rz) {
    return xf(cylGeo(rt, rb, h, seg), x || 0, y || 0, z || 0, rx || 0, ry || 0, rz || 0);
  }
  function strutGeo(a, b, w, d) {
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    const g = boxGeo(w, len, d);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)
    );
    g.applyMatrix4(m);
    return g;
  }

  /* ------------------------------------------------------------------ */
  /* B.bunker — command post at (-11, -12)                               */
  /* ------------------------------------------------------------------ */
  B.bunker = function (w) {
    const M = w.M;
    const scene = w.scene;
    const gx = -11, gz = -12;
    const group = new THREE.Group();
    group.position.set(gx, 0, gz);
    scene.add(group);
    w._addRoot(group);

    // main block
    const body = mesh(group, boxGeo(8, 4, 6.5), M.concrete, 0, 2, 0);
    body.castShadow = true; body.receiveShadow = true;
    w._addRay(body);
    // roof slab
    const roof = mesh(group, boxGeo(8.55, 0.32, 7.05), M.concreteDark, 0, 4.16, 0);
    roof.castShadow = true; roof.receiveShadow = true;
    w._addRay(roof);
    // parapet (merged)
    const parapetParts = [
      bgeo(8.6, 0.38, 0.22, 0, 4.48, 3.4),
      bgeo(8.6, 0.38, 0.22, 0, 4.48, -3.4),
      bgeo(0.22, 0.38, 7.0, 4.18, 4.48, 0),
      bgeo(0.22, 0.38, 7.0, -4.18, 4.48, 0),
    ];
    const parapet = new THREE.Mesh(mergeGeos(parapetParts), M.concreteDark);
    parapet.castShadow = true;
    group.add(parapet);

    // door recess + steel door
    mesh(group, boxGeo(1.8, 2.5, 0.3), M.interior, -2.0, 1.25, 3.24);
    const door = mesh(group, boxGeo(1.42, 2.32, 0.12), M.doorSteel, -2.0, 1.16, 3.37);
    door.castShadow = true;
    w._addRay(door);
    const handle = mesh(group, cylGeo(0.035, 0.035, 0.4, 6), M.metalDark, -1.42, 1.12, 3.49);
    handle.rotation.z = PI / 2;
    mesh(group, boxGeo(2.2, 0.32, 0.55), M.concreteDark, -2.0, 2.72, 3.3).castShadow = true;
    // rivets (merged)
    const rivetParts = [];
    for (let i = 0; i < 8; i++) {
      rivetParts.push(xf(new THREE.SphereGeometry(0.028, 5, 4), -2.62 + (i % 2) * 1.24, 0.32 + Math.floor(i / 2) * 0.62, 3.44));
    }
    group.add(new THREE.Mesh(mergeGeos(rivetParts), M.metalDark));
    // door lamp
    const doorLamp = mesh(group, boxGeo(0.3, 0.18, 0.2), M.lampAmber, -2.0, 3.08, 3.3);
    w._glow(gx - 2.0, 3.08, gz + 3.42, 0xffa848, 0.65, false, 0.31);
    // firing slit
    mesh(group, boxGeo(2.7, 0.42, 0.34), M.interior, 1.75, 2.55, 3.22);
    mesh(group, boxGeo(2.4, 0.09, 0.03), M.lampAmber, 1.75, 2.55, 3.42);
    // concrete steps (merged)
    const stepParts = [
      bgeo(2.5, 0.16, 0.6, -2.0, 0.08, 4.08),
      bgeo(2.5, 0.32, 0.55, -2.0, 0.16, 3.6),
      bgeo(2.5, 0.48, 0.45, -2.0, 0.24, 3.22),
    ];
    const steps = new THREE.Mesh(mergeGeos(stepParts), M.concreteDark);
    steps.receiveShadow = true;
    group.add(steps);
    // vents / pipes (merged)
    const vent = mesh(group, boxGeo(0.12, 0.62, 0.95), M.grate, 4.03, 2.5, -1.2);
    vent.rotation.y = 0;
    const pipeParts = [
      cgeo(0.09, 0.09, 3.4, 7, -3.9, 1.7, 3.36),
      cgeo(0.07, 0.07, 3.4, 7, -3.62, 1.7, 3.36),
      cgeo(0.07, 0.07, 0.6, 7, -3.76, 3.35, 3.12, PI / 2, 0, 0),
    ];
    const pipes = new THREE.Mesh(mergeGeos(pipeParts), M.metalRust);
    pipes.castShadow = true;
    group.add(pipes);

    // signs
    const cmdSign = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.82), M.signCmd);
    cmdSign.position.set(-2.0, 3.62, 3.27);
    group.add(cmdSign);
    const dangerSign = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.75), M.signDanger);
    dangerSign.position.set(-4.02, 2.3, -1.8);
    dangerSign.rotation.y = -PI / 2;
    group.add(dangerSign);
    const keepOut = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.7), M.signDanger);
    keepOut.position.set(4.02, 1.9, 1.9);
    keepOut.rotation.y = PI / 2;
    group.add(keepOut);

    // roof antenna + dish
    const mast = mesh(group, cylGeo(0.05, 0.075, 2.7, 7), M.metalDark, 2.55, 5.55, 1.0);
    mast.castShadow = true;
    const antennaParts = [
      bgeo(1.15, 0.05, 0.05, 2.55, 6.25, 1.0),
      bgeo(0.05, 0.05, 1.0, 2.55, 6.55, 1.0),
    ];
    const antennaBars = new THREE.Mesh(mergeGeos(antennaParts), M.metalDark);
    group.add(antennaBars);
    const dishGeo = new THREE.SphereGeometry(0.52, 14, 7, 0, TAU, 0, PI * 0.42);
    const dish = new THREE.Mesh(dishGeo, M.metalDark);
    dish.position.set(1.55, 5.85, 1.15);
    dish.rotation.set(-PI * 0.42, 0.5, 0);
    dish.castShadow = true;
    group.add(dish);
    const beacon = mesh(group, sphereGeo(0.075, 8, 6), M.beaconRed, 2.55, 6.95, 1.0);
    w._glow(gx + 2.55, 6.95, gz + 1.0, 0xff2a1a, 0.85, true, 0.12);
    // roof hatch
    mesh(group, boxGeo(1.15, 0.2, 1.15), M.concreteDark, -0.7, 4.42, 0.7).castShadow = true;

    // camouflage netting over the roof
    const netGeo = new THREE.PlaneGeometry(9.4, 7.4, 12, 9);
    netGeo.rotateX(-PI / 2);
    const np = netGeo.attributes.position;
    for (let i = 0; i < np.count; i++) {
      const x = np.getX(i), z = np.getZ(i);
      np.setY(i, Math.sin(x * 0.85) * 0.11 + Math.cos(z * 1.15) * 0.09 + 0.05);
    }
    netGeo.computeVertexNormals();
    const net = new THREE.Mesh(netGeo, M.camo);
    net.position.set(0, 4.95, 0);
    group.add(net);
    const netPoleParts = [];
    for (let i = 0; i < 4; i++) {
      const px = i % 2 === 0 ? -4.1 : 4.1;
      const pz = i < 2 ? -3.2 : 3.2;
      netPoleParts.push(cgeo(0.035, 0.045, 1.5, 5, px, 5.0, pz));
    }
    group.add(new THREE.Mesh(mergeGeos(netPoleParts), M.metalRust));

    // sandbag apron outside the door + roof line
    bagLine(w, gx - 3.6, gz + 4.35, gx + 4.4, gz + 3.9, 0, 2, 0.64, 0.13);
    bagLine(w, gx - 3.55, gz + 4.0, gx - 2.2, gz + 4.6, 0, 1, 0.62, 0.1);
    bagLine(w, gx - 4.6, gz - 3.35, gx + 4.6, gz - 3.35, 4.52, 1, 0.66, 0.06);

    w._addSolid({ minX: gx - 4.1, maxX: gx + 4.1, minZ: gz - 3.4, maxZ: gz + 3.3, height: 4.9 });
    w._addSolid({ minX: gx - 1.0, maxX: gx + 4.6, minZ: gz + 3.9, maxZ: gz + 4.9, height: 0.95 });
    w._addSolid({ minX: gx - 3.3, maxX: gx + 3.3, minZ: gz + 3.5, maxZ: gz + 4.9, height: 0.9 });
  };

  /* ------------------------------------------------------------------ */
  /* B.tower — watchtower at (12, -12)                                   */
  /* ------------------------------------------------------------------ */
  B.tower = function (w) {
    const M = w.M;
    const scene = w.scene;
    const gx = 12, gz = -12;
    const group = new THREE.Group();
    group.position.set(gx, 0, gz);
    scene.add(group);
    w._addRoot(group);

    const legs = 2.4;
    const frameParts = [];
    // concrete footings
    const footParts = [];
    const legPts = [
      [-legs, -legs], [legs, -legs], [-legs, legs], [legs, legs],
    ];
    for (let i = 0; i < 4; i++) {
      footParts.push(bgeo(0.62, 0.4, 0.62, legPts[i][0], 0.2, legPts[i][1]));
      frameParts.push(bgeo(0.27, 5.65, 0.27, legPts[i][0], 2.83, legPts[i][1]));
    }
    // cross bracing on four faces, two levels
    for (let side = 0; side < 4; side++) {
      const a = legPts[side], b = legPts[(side + 1) % 4];
      const aLow = new THREE.Vector3(a[0], 0.65, a[1]);
      const bHigh = new THREE.Vector3(b[0], 3.1, b[1]);
      const bLow = new THREE.Vector3(b[0], 0.65, b[1]);
      const aHigh = new THREE.Vector3(a[0], 3.1, a[1]);
      frameParts.push(strutGeo(aLow, bHigh, 0.1, 0.1));
      frameParts.push(strutGeo(bLow, aHigh, 0.1, 0.1));
      const aMid = new THREE.Vector3(a[0], 3.1, a[1]);
      const bTop = new THREE.Vector3(b[0], 5.35, b[1]);
      const bMid = new THREE.Vector3(b[0], 3.1, b[1]);
      const aTop = new THREE.Vector3(a[0], 5.35, a[1]);
      frameParts.push(strutGeo(aMid, bTop, 0.1, 0.1));
      frameParts.push(strutGeo(bMid, aTop, 0.1, 0.1));
    }
    // deck joists
    for (let i = -1; i <= 1; i++) frameParts.push(bgeo(5.4, 0.18, 0.2, 0, 5.32, i * 1.7));
    frameParts.push(bgeo(0.2, 0.18, 5.4, -1.85, 5.32, 0));
    frameParts.push(bgeo(0.2, 0.18, 5.4, 1.85, 5.32, 0));
    const frameGeo = mergeGeos(frameParts);
    const frame = new THREE.Mesh(frameGeo, M.metalRust);
    frame.castShadow = true;
    frame.receiveShadow = true;
    group.add(frame);
    w._addRay(frame);

    const footGeo = mergeGeos(footParts);
    const foot = new THREE.Mesh(footGeo, M.concreteDark);
    foot.receiveShadow = true;
    foot.castShadow = true;
    group.add(foot);

    // wooden deck
    const deck = mesh(group, boxGeo(5.9, 0.22, 5.9), M.wood, 0, 5.55, 0);
    deck.castShadow = true;
    deck.receiveShadow = true;
    w._addRay(deck);

    // railing
    const railParts = [];
    const railH = 1.4;
    const deckY = 5.66;
    for (let side = 0; side < 4; side++) {
      const vertical = side < 2;
      const sign = side % 2 === 0 ? 1 : -1;
      const off = 2.83 * sign;
      // top + mid rails
      railParts.push(vertical
        ? bgeo(5.72, 0.08, 0.08, 0, deckY + railH, off)
        : bgeo(0.08, 0.08, 5.72, off, deckY + railH, 0));
      railParts.push(vertical
        ? bgeo(5.72, 0.06, 0.06, 0, deckY + railH * 0.55, off)
        : bgeo(0.06, 0.06, 5.72, off, deckY + railH * 0.55, 0));
      // posts
      for (let k = -1; k <= 1; k++) {
        railParts.push(vertical
          ? bgeo(0.085, railH, 0.085, k * 2.7, deckY + railH * 0.5, off)
          : bgeo(0.085, railH, 0.085, off, deckY + railH * 0.5, k * 2.7));
      }
    }
    const rail = new THREE.Mesh(mergeGeos(railParts), M.woodDark);
    rail.castShadow = true;
    group.add(rail);

    // ladder (merged)
    const ladderParts = [];
    ladderParts.push(bgeo(0.07, 5.5, 0.07, -0.34, 2.75, 3.03));
    ladderParts.push(bgeo(0.07, 5.5, 0.07, 0.34, 2.75, 3.03));
    for (let i = 0; i < 12; i++) {
      ladderParts.push(bgeo(0.7, 0.05, 0.05, 0, 0.5 + i * 0.45, 3.03));
    }
    const ladder = new THREE.Mesh(mergeGeos(ladderParts), M.metalRust);
    ladder.castShadow = true;
    group.add(ladder);

    // roof posts + gable
    const roofParts = [];
    for (let i = 0; i < 4; i++) {
      const px = i % 2 === 0 ? -2.7 : 2.7;
      const pz = i < 2 ? -2.7 : 2.7;
      roofParts.push(bgeo(0.13, 2.1, 0.13, px, 7.75, pz));
    }
    roofParts.push(bgeo(7.0, 0.13, 3.8, 0, 8.42, 1.9, 0.3, 0, 0));
    roofParts.push(bgeo(7.0, 0.13, 3.8, 0, 8.42, -1.9, -0.3, 0, 0));
    roofParts.push(bgeo(7.1, 0.14, 0.18, 0, 8.95, 0));
    const roofMesh = new THREE.Mesh(mergeGeos(roofParts), M.metalRust);
    roofMesh.castShadow = true;
    group.add(roofMesh);
    w._addRay(roofMesh);

    // sandbags along the deck edge
    bagLine(w, gx - 2.8, gz - 2.75, gx + 2.8, gz - 2.75, 5.72, 1, 0.62, 0.08);
    bagLine(w, gx - 2.75, gz - 2.4, gx - 2.75, gz + 2.4, 5.72, 1, 0.62, 0.08);

    // signs and lamps
    const obsSign = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 0.85), M.signTower);
    obsSign.position.set(-2.96, 6.95, 0.9);
    obsSign.rotation.y = -PI / 2;
    group.add(obsSign);
    const workLamp = mesh(group, boxGeo(0.34, 0.2, 0.34), M.lampAmber, 2.35, 7.5, 2.35);
    w._glow(gx + 2.35, 7.5, gz + 2.35, 0xffb050, 1.25, false, 0.42);
    const beacon = mesh(group, sphereGeo(0.09, 8, 6), M.beaconRed, 0, 9.1, 0);
    w._glow(gx, 9.1, gz, 0xff2a1a, 1.0, true, 0.55);

    // colliders: legs only
    for (let i = 0; i < 4; i++) {
      w._addSolid({
        minX: gx + legPts[i][0] - 0.3, maxX: gx + legPts[i][0] + 0.3,
        minZ: gz + legPts[i][1] - 0.3, maxZ: gz + legPts[i][1] + 0.3,
        height: 5.7,
      });
    }
  };

  /* ------------------------------------------------------------------ */
  /* B.containers — shipping containers at (13, 6) and (-14, 7)          */
  /* ------------------------------------------------------------------ */
  function addContainer(w, opts) {
    const M = w.M;
    const scene = w.scene;
    const len = opts.len || 6.1;
    const ry = opts.ry || 0;
    const yBase = opts.y || 0;
    const group = new THREE.Group();
    group.position.set(opts.x, yBase, opts.z);
    group.rotation.y = ry;
    scene.add(group);
    w._addRoot(group);

    const body = mesh(group, boxGeo(2.44, 2.59, len), opts.mat, 0, 1.295, 0);
    body.castShadow = true;
    body.receiveShadow = true;
    w._addRay(body);

    // corner castings + edge rails + door hardware (merged)
    const parts = [];
    const hx = 1.22, hz = len / 2;
    for (let ix = -1; ix <= 1; ix += 2) {
      for (let iy = -1; iy <= 1; iy += 2) {
        for (let iz = -1; iz <= 1; iz += 2) {
          parts.push(bgeo(0.3, 0.3, 0.3, ix * hx, 1.295 + iy * 1.17, iz * (hz - 0.14)));
        }
      }
    }
    parts.push(bgeo(0.1, 0.16, len, hx, 1.295 + 1.26, 0));
    parts.push(bgeo(0.1, 0.16, len, -hx, 1.295 + 1.26, 0));
    parts.push(bgeo(0.1, 0.16, len, hx, 0.08, 0));
    parts.push(bgeo(0.1, 0.16, len, -hx, 0.08, 0));
    parts.push(bgeo(2.44, 0.1, 0.08, 0, 2.56, hz));
    parts.push(bgeo(2.44, 0.1, 0.08, 0, 2.56, -hz));
    if (opts.openDoor) {
      // locking bars on the far end
      for (let i = 0; i < 4; i++) parts.push(bgeo(0.06, 2.5, 0.06, -1.05 + i * 0.7, 1.3, hz + 0.03));
      // swung-open door panel
      parts.push(bgeo(1.2, 2.4, 0.07, -1.82, 1.25, hz + 0.35, 0, -1.15, 0));
      parts.push(bgeo(1.2, 2.4, 0.07, 1.82, 1.25, hz + 0.35, 0, 1.15, 0));
    }
    const detail = new THREE.Mesh(mergeGeos(parts), M.metalDark);
    detail.castShadow = true;
    group.add(detail);
    w._addRay(detail);

    // dark interior revealed through the open end
    if (opts.openDoor) {
      mesh(group, boxGeo(2.25, 2.45, 0.1), M.interior, 0, 1.3, hz - 0.12);
    }

    // stencil sign
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.98), M.signContainer);
    sign.position.set(opts.signX || 0, 1.6, opts.signZ || 0);
    sign.rotation.y = opts.signRy || 0;
    sign.position.x += opts.signOffX || 0;
    group.add(sign);

    return group;
  }

  B.containers = function (w) {
    const M = w.M;
    // container A: near east wall, long axis N-S
    addContainer(w, {
      x: 13.4, z: 6, ry: 0, mat: M.containerOlive, len: 6.1,
      signX: 0, signZ: 0.3, signRy: -PI / 2, signOffX: -1.26,
    });
    // stacked second box, slightly skewed
    addContainer(w, {
      x: 13.35, z: 6.25, ry: 0.055, y: 2.6, mat: M.containerRust, len: 5.6, stacked: true,
      signX: 0, signZ: 0, signRy: -PI / 2, signOffX: -1.26,
    });
    // container B: near west wall, long axis E-W, doors open
    addContainer(w, {
      x: -14.2, z: 7, ry: PI / 2, mat: M.containerRust, len: 6.1, openDoor: true,
      signX: 1.24, signZ: 0, signRy: PI / 2, signOffX: 0,
    });

    // colliders
    w._addSolid({ minX: 12.1, maxX: 14.7, minZ: 2.8, maxZ: 9.2, height: 5.4 });
    w._addSolid({ minX: -17.3, maxX: -11.1, minZ: 5.7, maxZ: 8.3, height: 2.75 });
  };

  /* ------------------------------------------------------------------ */
  /* B.generator — diesel generator + radio mast defence objective       */
  /* ------------------------------------------------------------------ */
  B.generator = function (w) {
    const M = w.M;
    const scene = w.scene;
    const group = new THREE.Group();
    group.position.set(0, 0, 0);
    scene.add(group);
    w._addRoot(group);

    const bodyMat = M.paint.clone();
    bodyMat.emissive = new THREE.Color(0x0d332c);
    bodyMat.emissiveIntensity = 0.4;

    // skid frame (merged)
    const skidParts = [
      bgeo(4.5, 0.2, 0.24, 0, 0.28, 0.92),
      bgeo(4.5, 0.2, 0.24, 0, 0.28, -0.92),
      bgeo(0.22, 0.2, 1.9, -2.1, 0.28, 0),
      bgeo(0.22, 0.2, 1.9, 2.1, 0.28, 0),
    ];
    const skid = new THREE.Mesh(mergeGeos(skidParts), M.metalDark);
    skid.castShadow = true;
    group.add(skid);

    // main enclosure
    const body = mesh(group, boxGeo(3.0, 1.5, 1.72), bodyMat, 0, 1.12, 0);
    body.castShadow = true;
    body.receiveShadow = true;
    w._addRay(body);
    const lid = mesh(group, boxGeo(2.86, 0.14, 1.62), M.metalRust, 0, 1.95, 0);
    lid.castShadow = true;

    // hazard stripe + cyan accent strips (merged)
    mesh(group, boxGeo(3.02, 0.2, 1.74), M.hazard, 0, 0.46, 0);
    const stripMat = M.lampCyan.clone();
    const stripParts = [
      bgeo(2.8, 0.045, 0.045, 0, 0.58, 0.9),
      bgeo(2.8, 0.045, 0.045, 0, 0.58, -0.9),
      bgeo(0.045, 0.045, 1.5, 1.52, 0.58, 0),
      bgeo(0.045, 0.045, 1.5, -1.52, 0.58, 0),
    ];
    group.add(new THREE.Mesh(mergeGeos(stripParts), stripMat));

    // radiator / fan end (+x)
    mesh(group, boxGeo(0.34, 1.36, 1.5), M.metalDark, 1.63, 1.14, 0).castShadow = true;
    const fan = mesh(group, new THREE.CircleGeometry(0.52, 18), M.grate, 1.81, 1.14, 0);
    fan.rotation.y = PI / 2;
    const fanRing = mesh(group, new THREE.TorusGeometry(0.55, 0.045, 5, 18), M.metalRust, 1.82, 1.14, 0);
    fanRing.rotation.y = PI / 2;
    fanRing.castShadow = true;
    // louvered side (-x)
    const louver = mesh(group, new THREE.PlaneGeometry(1.35, 0.95), M.grate, -1.53, 1.2, 0);
    louver.rotation.y = -PI / 2;
    louver.castShadow = false;

    // exhaust stack + rain cap (merged)
    const exhaustParts = [
      cgeo(0.09, 0.11, 1.5, 8, 1.35, 2.55, -0.55),
      cgeo(0.16, 0.1, 0.12, 8, 1.35, 3.33, -0.55),
    ];
    const stack = new THREE.Mesh(mergeGeos(exhaustParts), M.metalRust);
    stack.castShadow = true;
    group.add(stack);

    // fuel tank
    const tank = mesh(group, cylGeo(0.4, 0.4, 1.7, 12), M.containerRust, -2.4, 0.78, 0.62);
    tank.rotation.z = PI / 2;
    tank.castShadow = true;
    tank.receiveShadow = true;
    w._addRay(tank);
    const tankParts = [
      bgeo(0.1, 0.84, 0.86, -2.85, 0.78, 0.62),
      bgeo(0.1, 0.84, 0.86, -1.95, 0.78, 0.62),
      cgeo(0.1, 0.1, 0.1, 8, -2.4, 1.22, 0.62),
    ];
    const tankRig = new THREE.Mesh(mergeGeos(tankParts), M.metalDark);
    tankRig.castShadow = true;
    group.add(tankRig);
    // fuel sight glass
    mesh(group, boxGeo(0.03, 0.3, 0.07), M.lampAmber, -2.4, 1.02, 1.02);

    // control panel + screen
    mesh(group, boxGeo(0.8, 0.95, 0.16), M.metalDark, 0.55, 1.28, 0.93);
    const screenMat = M.lampCyan.clone();
    mesh(group, boxGeo(0.46, 0.28, 0.02), screenMat, 0.55, 1.44, 1.02);
    const gaugeParts = [
      xf(new THREE.CircleGeometry(0.055, 8), 0.32, 1.14, 1.02),
      xf(new THREE.CircleGeometry(0.055, 8), 0.55, 1.14, 1.02),
    ];
    group.add(new THREE.Mesh(mergeGeos(gaugeParts), M.lampAmber));
    mesh(group, new THREE.CircleGeometry(0.09, 10), M.lampCyan, 0.78, 1.14, 1.02);

    // cable conduit to the ground
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.55, 0.95, 1.03),
      new THREE.Vector3(0.85, 0.5, 1.4),
      new THREE.Vector3(0.6, 0.06, 1.9),
      new THREE.Vector3(-0.2, 0.05, 2.4),
    ]);
    const conduit = new THREE.Mesh(new THREE.TubeGeometry(curve, 16, 0.055, 6, false), M.metalDark);
    conduit.castShadow = true;
    group.add(conduit);

    // warning signs
    const genSign = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.42), M.signGen);
    genSign.position.set(-0.9, 1.55, 0.87);
    group.add(genSign);
    const danger = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.56), M.signDanger);
    danger.position.set(-1.53, 1.28, 0.55);
    danger.rotation.y = -PI / 2;
    group.add(danger);

    // amber beacon on the lid
    const beaconMat = M.beaconAmber.clone();
    const beacon = mesh(group, sphereGeo(0.1, 8, 6), beaconMat, -0.4, 2.05, 0.6);
    w._glow(0, 2.05, 0.6, 0xffa028, 0.8, false, 0.22);

    // radio mast
    const mast = mesh(group, cylGeo(0.055, 0.085, 6.6, 7), M.metalDark, 2.0, 3.4, -1.35);
    mast.castShadow = true;
    const crossParts = [];
    for (let i = 0; i < 3; i++) {
      const y = 4.9 + i * 0.72;
      crossParts.push(bgeo(1.7 - i * 0.35, 0.045, 0.045, 2.0, y, -1.35));
    }
    crossParts.push(cgeo(0.022, 0.022, 0.8, 5, 2.0, 6.75, -1.35));
    group.add(new THREE.Mesh(mergeGeos(crossParts), M.metalDark));
    const mastBeaconMat = M.lampCyan.clone();
    mesh(group, sphereGeo(0.075, 8, 6), mastBeaconMat, 2.0, 6.96, -1.35);
    w._glow(2.0, 6.96, -1.35, 0x46ffe2, 1.1, true, 0.36);
    // mast guys
    const guyPts = [];
    const top = new THREE.Vector3(2.0, 6.4, -1.35);
    const anchors = [
      new THREE.Vector3(3.5, 0.1, -0.3),
      new THREE.Vector3(0.4, 0.1, -2.6),
      new THREE.Vector3(3.6, 0.1, -2.6),
    ];
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      for (let k = 0; k < 6; k++) {
        const t0 = k / 6, t1 = (k + 1) / 6;
        const p0 = top.clone().lerp(a, t0);
        p0.y -= Math.sin(t0 * PI) * 0.12;
        const p1 = top.clone().lerp(a, t1);
        p1.y -= Math.sin(t1 * PI) * 0.12;
        guyPts.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
      }
    }
    const guyGeo = new THREE.BufferGeometry();
    guyGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(guyPts), 3));
    const guys = new THREE.LineSegments(guyGeo, M.cableLine);
    group.add(guys);

    // cyan defence light
    const light = new THREE.PointLight(0x62f0dc, 26, 16, 2);
    light.position.set(0, 2.7, 0);
    scene.add(light);
    w._addRoot(light);

    // invisible hit proxy
    const hitMat = new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0, depthWrite: false, colorWrite: false, side: THREE.DoubleSide,
    });
    const proxy = new THREE.Mesh(new THREE.BoxGeometry(4.9, 2.8, 3.2), hitMat);
    proxy.position.set(-0.2, 1.4, 0);
    group.add(proxy);

    const hitMeshes = [body, tank, louver, fan, stack, proxy];
    for (let i = 0; i < hitMeshes.length; i++) {
      hitMeshes[i].userData.generator = true;
      hitMeshes[i].userData.worldObj = "generator";
    }

    // damage sparks (burst shader) and broken smoke column
    const sparkCount = 110;
    const sPos = new Float32Array(sparkCount * 3);
    const sSeed = new Float32Array(sparkCount);
    for (let i = 0; i < sparkCount; i++) sSeed[i] = Math.random();
    const sGeo = new THREE.BufferGeometry();
    sGeo.setAttribute("position", new THREE.BufferAttribute(sPos, 3));
    sGeo.setAttribute("aSeed", new THREE.BufferAttribute(sSeed, 1));
    const dpr = w.renderer ? w.renderer.getPixelRatio() : 1;
    const pxScale = (w.renderer && w.renderer.domElement ? w.renderer.domElement.height : 720) * dpr * 0.5 / Math.tan(0.61);
    const sparkMat = new THREE.ShaderMaterial({
      uniforms: {
        uAge: { value: 99 },
        uActive: { value: 0 },
        uPx: { value: pxScale },
        uC1: { value: new THREE.Color(1.0, 0.75, 0.32) },
        uC2: { value: new THREE.Color(1.0, 0.3, 0.05) },
      },
      vertexShader: [
        "attribute float aSeed;",
        "uniform float uAge; uniform float uActive; uniform float uPx;",
        "varying float vA; varying float vMix;",
        "void main() {",
        "  float s = aSeed;",
        "  vec3 dir = normalize( vec3( sin( s * 91.7 ) * 1.3, 0.35 + abs( cos( s * 37.3 ) ) * 1.5, cos( s * 63.1 ) * 1.3 ) );",
        "  float speed = 2.0 + fract( s * 7.3 ) * 5.5;",
        "  float t = uAge;",
        "  vec3 p = dir * speed * t + vec3( 0.0, 1.2, 0.0 );",
        "  p.y -= 4.8 * t * t;",
        "  vec4 mv = modelViewMatrix * vec4( p, 1.0 );",
        "  gl_Position = projectionMatrix * mv;",
        "  gl_PointSize = clamp( ( 0.045 + fract( s * 11.0 ) * 0.05 ) * uPx / max( 0.6, -mv.z ), 1.0, 14.0 );",
        "  vA = uActive * clamp( 1.0 - uAge / 1.15, 0.0, 1.0 );",
        "  vMix = fract( s * 3.7 );",
        "}",
      ].join("\n"),
      fragmentShader: [
        "uniform vec3 uC1; uniform vec3 uC2;",
        "varying float vA; varying float vMix;",
        "void main() {",
        "  vec2 uv = gl_PointCoord - 0.5;",
        "  float d = length( uv );",
        "  if ( d > 0.5 ) discard;",
        "  float a = pow( 1.0 - d * 2.0, 1.8 );",
        "  gl_FragColor = vec4( mix( uC1, uC2, vMix ), a * vA );",
        "}",
      ].join("\n"),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      fog: false,
    });
    const sparks = new THREE.Points(sGeo, sparkMat);
    sparks.position.set(0, 0, 0);
    sparks.frustumCulled = false;
    sparks.renderOrder = 9;
    scene.add(sparks);
    w._addRoot(sparks);

    const smoke = makeEmitter(w, [new THREE.Vector3(0.2, 2.1, -0.2)], 54, {
      rise: 5.2, speed: 0.11, size: 1.0, sizeEnd: 3.4,
      windX: 0.7, windZ: 0.25,
      c1: [0.17, 0.18, 0.18], c2: [0.04, 0.045, 0.05],
      alpha: 0.42, additive: false, active: 0,
    });

    w._gen = {
      bodyMat: bodyMat,
      stripMat: stripMat,
      screenMat: screenMat,
      beaconMat: beaconMat,
      mastBeaconMat: mastBeaconMat,
      light: light,
      lightBase: 26,
      sparks: sparks,
      sparkMat: sparkMat,
      sparkAge: 99,
      flash: 0,
      smoke: smoke,
      smokeOn: 0,
    };

    const gen = {
      position: new THREE.Vector3(0, 0, 0),
      health: 1200,
      maxHealth: 1200,
      broken: false,
      hitMeshes: hitMeshes,
      group: group,
      damage: function (amount) {
        if (gen.broken) return false;
        const dmg = Math.max(0, amount || 0);
        gen.health = Math.max(0, gen.health - dmg);
        w._gen.sparkAge = 0;
        w._gen.flash = 1;
        if (gen.health <= 0) {
          gen.broken = true;
          w._gen.smokeOn = 1;
          return true;
        }
        return false;
      },
      repair: function (amount) {
        if (gen.health >= gen.maxHealth && !gen.broken) return false;
        gen.health = Math.min(gen.maxHealth, gen.health + Math.max(0, amount || 0));
        if (gen.health > 0) {
          gen.broken = false;
          w._gen.smokeOn = 0;
        }
        return true;
      },
    };
    w.generator = gen;

    w._addSolid({ minX: -3.3, maxX: 2.35, minZ: -1.65, maxZ: 1.65, height: 2.6 });
  };

  /* ------------------------------------------------------------------ */
  /* B.floodlights — four corner towers with flickering spots            */
  /* ------------------------------------------------------------------ */
  B.floodlights = function (w) {
    const M = w.M;
    const scene = w.scene;
    const q = w.quality;
    const shadowSpots = q.spotlightShadows || 0;
    const positions = [
      [-17.2, 17.2], [17.2, 17.2], [-17.2, -17.2], [17.2, -17.2],
    ];
    const housingParts = [];
    const lensParts = [];
    const cones = [];
    w._floodlights = [];

    for (let i = 0; i < 4; i++) {
      const px = positions[i][0], pz = positions[i][1];
      const toward = new THREE.Vector3(-px * 0.55, 0, -pz * 0.55);
      const yaw = Math.atan2(toward.x, toward.z);
      const headY = 7.9;

      // pole assembly
      const parts = [];
      parts.push(bgeo(0.72, 0.14, 0.72, 0, 0.07, 0));
      parts.push(cgeo(0.075, 0.115, 8.2, 8, 0, 4.17, 0));
      parts.push(bgeo(2.0, 0.09, 0.09, 0, headY, 0, 0, yaw, 0));
      parts.push(strutGeo(new THREE.Vector3(0, 7.1, 0), new THREE.Vector3(0.9, 7.88, 0), 0.07, 0.07));
      parts.push(strutGeo(new THREE.Vector3(0, 7.1, 0), new THREE.Vector3(-0.9, 7.88, 0), 0.07, 0.07));
      parts.push(bgeo(0.5, 0.5, 0.5, 0, 8.3, 0));
      const pole = new THREE.Mesh(mergeGeos(parts), M.metalDark);
      pole.position.set(px, 0, pz);
      pole.castShadow = true;
      pole.receiveShadow = true;
      scene.add(pole);
      w._addRoot(pole);
      w._addRay(pole);

      // lamp heads
      for (let k = 0; k < 2; k++) {
        const side = k === 0 ? -0.82 : 0.82;
        const ox = Math.cos(yaw) * side;
        const oz = -Math.sin(yaw) * side;
        const hx = px + ox, hz = pz + oz;
        const tilt = 0.62;
        // housing box (tilted down)
        housingParts.push(xf(boxGeo(0.44, 0.3, 0.52), hx, headY + 0.02, hz, tilt, yaw, 0));
        // lens plane at the front of the housing
        const lx = hx + Math.sin(yaw) * 0.27;
        const lz = hz + Math.cos(yaw) * 0.27;
        lensParts.push(xf(new THREE.PlaneGeometry(0.34, 0.22), lx, headY - 0.09, lz, tilt, yaw, 0));
        w._glow(hx, headY - 0.06, hz, 0xcfe8ff, 1.55, false, i * 0.21 + k * 0.07);
      }

      // spotlight + target
      const target = new THREE.Object3D();
      target.position.set(px + toward.x, 0, pz + toward.z);
      scene.add(target);
      w._addRoot(target);
      const spot = new THREE.SpotLight(
        i < 2 ? 0xbfe0ff : 0xffcf9a,
        i < 2 ? 190 : 150,
        46,
        0.62,
        0.62,
        1.5
      );
      spot.position.set(px, headY, pz);
      spot.target = target;
      if (i < shadowSpots) {
        spot.castShadow = true;
        const sm = Math.max(512, Math.floor((q.shadowMapSize || 1024) / 2));
        spot.shadow.mapSize.set(sm, sm);
        spot.shadow.camera.near = 0.8;
        spot.shadow.camera.far = 46;
        spot.shadow.bias = -0.0006;
        spot.shadow.normalBias = 0.03;
        spot.shadow.focus = 1.0;
      }
      scene.add(spot);
      w._addRoot(spot);

      // volumetric cone
      const condir = new THREE.Vector3(px + toward.x * 2, 0, pz + toward.z * 2).sub(new THREE.Vector3(px, headY, pz)).normalize();
      const coneH = 18;
      const coneGeo = new THREE.ConeGeometry(4.6, coneH, 20, 1, true);
      const coneMat = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: new THREE.Color(i < 2 ? 0x9ec8e6 : 0xe8b27a) },
          uOpacity: { value: 0.085 },
        },
        vertexShader: [
          "varying vec2 vUv;",
          "void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }",
        ].join("\n"),
        fragmentShader: [
          "uniform vec3 uColor; uniform float uOpacity;",
          "varying vec2 vUv;",
          "void main() {",
          "  float a = pow( vUv.y, 1.5 ) * uOpacity;",
          "  gl_FragColor = vec4( uColor, a );",
          "}",
        ].join("\n"),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        toneMapped: false,
        fog: false,
      });
      const cone = new THREE.Mesh(coneGeo, coneMat);
      cone.position.set(px + condir.x * coneH * 0.5, headY + condir.y * coneH * 0.5, pz + condir.z * coneH * 0.5);
      cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), condir.clone().negate());
      cone.frustumCulled = false;
      // Large camera-intersecting translucent cones read as hard black wedges from
      // inside the compound. The lamps, glow sprites and spotlights carry the mood;
      // keep the cone mesh available for tuning but out of the player's sightline.
      cone.visible = false;
      scene.add(cone);
      w._addRoot(cone);
      cones.push(cone);

      w._floodlights.push({
        light: spot,
        cone: cone,
        coneMat: coneMat,
        baseIntensity: spot.intensity,
        baseOpacity: 0.085,
        phase: i * 1.77 + 0.3,
        x: px, z: pz,
      });

      w._addSolid({ minX: px - 0.55, maxX: px + 0.55, minZ: pz - 0.55, maxZ: pz + 0.55, height: 8.2 });
    }

    const housings = new THREE.Mesh(mergeGeos(housingParts), M.metalDark);
    housings.castShadow = true;
    scene.add(housings);
    w._addRoot(housings);
    w._addRay(housings);

    const lensMat = M.lampWhite.clone();
    const lenses = new THREE.Mesh(mergeGeos(lensParts), lensMat);
    lenses.castShadow = false;
    scene.add(lenses);
    w._addRoot(lenses);
    w._floodlightLensMat = lensMat;
  };

  /* ------------------------------------------------------------------ */
  /* B.props — barrels, crates, spools, antenna, cables, debris          */
  /* ------------------------------------------------------------------ */
  B.props = function (w) {
    const M = w.M;
    const scene = w.scene;

    /* ---- two burning barrels ---- */
    w._barrelFires = [];
    w._barrelLights = [];
    const barrelPositions = [[-8.0, -3.0], [9.0, 1.4]];
    for (let i = 0; i < 2; i++) {
      const bx = barrelPositions[i][0], bz = barrelPositions[i][1];
      const g = new THREE.Group();
      g.position.set(bx, 0, bz);
      scene.add(g);
      w._addRoot(g);
      const body = mesh(g, cylGeo(0.34, 0.32, 0.92, 14, true), M.barrel, 0, 0.46, 0);
      body.castShadow = true;
      body.receiveShadow = true;
      mesh(g, cylGeo(0.3, 0.3, 0.9, 12, true), M.interior, 0, 0.47, 0);
      mesh(g, new THREE.CircleGeometry(0.3, 14), M.ember, 0, 0.9, 0).rotation.x = -PI / 2;
      const rim = mesh(g, new THREE.TorusGeometry(0.34, 0.025, 5, 16), M.metalRust, 0, 0.92, 0);
      rim.rotation.x = PI / 2;
      // bands + holes merged by material
      const bandParts = [
        xf(new THREE.TorusGeometry(0.335, 0.022, 5, 14), 0, 0.32, 0, PI / 2, 0, 0),
        xf(new THREE.TorusGeometry(0.335, 0.022, 5, 14), 0, 0.66, 0, PI / 2, 0, 0),
      ];
      g.add(new THREE.Mesh(mergeGeos(bandParts), M.metalDark));
      const holeParts = [];
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * TAU + 0.6;
        holeParts.push(bgeo(0.16, 0.1, 0.02,
          Math.cos(a) * 0.33, 0.6 + (k % 2) * 0.16, Math.sin(a) * 0.33, 0, -a, 0));
      }
      g.add(new THREE.Mesh(mergeGeos(holeParts), M.ember));
      const light = new THREE.PointLight(0xff7a30, 15, 13, 2);
      light.position.set(bx, 1.5, bz);
      scene.add(light);
      w._addRoot(light);
      w._barrelLights.push({ light: light, phase: i * 2.3 + 0.4, base: 15 });
      w._barrelFires.push(new THREE.Vector3(bx, 1.02, bz));
      w._glow(bx, 1.25, bz, 0xff7a28, 1.5, false, i * 0.73);
      w._addSolid({ minX: bx - 0.38, maxX: bx + 0.38, minZ: bz - 0.38, maxZ: bz + 0.38, height: 0.95 });
    }

    /* ---- crates ---- */
    const crateSpots = [
      [-6.2, -8.2, 1.0], [-5.35, -7.85, 0.9], [-6.0, -9.05, 0.85], [-5.2, -9.2, 0.8],
      [10.7, 2.5, 0.95], [11.15, 3.45, 0.85], [10.45, 3.15, 1.0], [10.9, 2.6, 0.7],
      [9.2, -9.9, 0.9], [8.35, -10.55, 0.8], [9.0, -10.6, 0.75],
      [-4.9, 12.9, 0.9], [-4.15, 13.5, 0.8], [5.2, -15.4, 0.85], [5.8, -14.75, 0.8],
      [-15.9, 11.2, 0.95], [14.7, -2.1, 0.8],
    ];
    const crateMesh = makeInstanced(boxGeo(1, 1, 1), M.crate, crateSpots.length, true, true);
    for (let i = 0; i < crateSpots.length; i++) {
      const c = crateSpots[i];
      setInst(crateMesh, i, c[0], c[2] * 0.5, c[1], 0, (i * 0.71) % TAU, 0, c[2], c[2], c[2] * (0.85 + (i % 3) * 0.1));
    }
    doneInst(crateMesh);
    scene.add(crateMesh);
    w._addRoot(crateMesh);
    w._addRay(crateMesh);

    w._addSolid({ minX: -6.75, maxX: -4.65, minZ: -9.6, maxZ: -7.35, height: 1.1 });
    w._addSolid({ minX: 9.9, maxX: 11.7, minZ: 2.1, maxZ: 3.95, height: 1.1 });
    w._addSolid({ minX: 7.9, maxX: 9.8, minZ: -11.1, maxZ: -9.4, height: 1.0 });

    /* ---- ammo boxes ---- */
    const ammoSpots = [
      [-6.9, -7.7, 0.34], [-6.5, -7.55, 0.3], [-7.2, -7.9, 0.28],
      [10.9, 12.2, 0.32], [11.3, 12.5, 0.3], [-15.7, 10.5, 0.3],
      [4.7, 13.9, 0.28], [5.1, 13.6, 0.26], [9.7, -8.9, 0.3], [13.4, -3.3, 0.28],
    ];
    const ammoMesh = makeInstanced(boxGeo(1, 1, 1), M.ammoBox, ammoSpots.length, true, true);
    for (let i = 0; i < ammoSpots.length; i++) {
      const a = ammoSpots[i];
      setInst(ammoMesh, i, a[0], 0.16, a[1], 0, (i * 1.13) % TAU, 0, a[2] * 1.6, 0.32, a[2] * 1.05);
    }
    doneInst(ammoMesh);
    scene.add(ammoMesh);
    w._addRoot(ammoMesh);

    // ammo sign
    const ammoSign = new THREE.Mesh(new THREE.PlaneGeometry(1.15, 0.6), M.signAmmo);
    ammoSign.position.set(-6.9, 1.15, -7.3);
    scene.add(ammoSign);
    w._addRoot(ammoSign);

    /* ---- cable spools ---- */
    const spoolSpots = [[7.2, 10.8], [-6.8, -2.8]];
    const flangeGeo = cylGeo(0.85, 0.85, 0.08, 14);
    flangeGeo.rotateX(PI / 2);
    const flangeMesh = makeInstanced(flangeGeo, M.woodDark, spoolSpots.length * 2, true, true);
    const coreGeo = cylGeo(0.42, 0.42, 0.8, 12);
    coreGeo.rotateX(PI / 2);
    const coreMesh = makeInstanced(coreGeo, M.spoolCable, spoolSpots.length, true, false);
    const wrapGeo = cylGeo(0.6, 0.6, 0.58, 12);
    wrapGeo.rotateX(PI / 2);
    const wrapMesh = makeInstanced(wrapGeo, M.spoolCable, spoolSpots.length, false, false);
    for (let i = 0; i < spoolSpots.length; i++) {
      const s = spoolSpots[i];
      setInst(flangeMesh, i * 2, s[0], 0.85, s[1] - 0.42, 0, 0, 0, 1, 1, 1);
      setInst(flangeMesh, i * 2 + 1, s[0], 0.85, s[1] + 0.42, 0, 0, 0, 1, 1, 1);
      setInst(coreMesh, i, s[0], 0.85, s[1], 0, 0, 0, 1, 1, 1);
      setInst(wrapMesh, i, s[0], 0.85, s[1], 0, 0, 0, 1, 1, 1);
      w._addSolid({ minX: s[0] - 0.9, maxX: s[0] + 0.9, minZ: s[1] - 0.95, maxZ: s[1] + 0.95, height: 1.75 });
    }
    doneInst(flangeMesh); doneInst(coreMesh); doneInst(wrapMesh);
    scene.add(flangeMesh); scene.add(coreMesh); scene.add(wrapMesh);
    w._addRoot(flangeMesh); w._addRoot(coreMesh); w._addRoot(wrapMesh);

    /* ---- radio antenna mast ---- */
    const ax = -16.8, az = -5.4;
    const radio = new THREE.Group();
    radio.position.set(ax, 0, az);
    scene.add(radio);
    w._addRoot(radio);
    mesh(radio, boxGeo(1.0, 1.3, 0.7), M.metalRust, 0, 0.65, 0).castShadow = true;
    mesh(radio, boxGeo(0.6, 0.5, 0.05), M.grate, 0.52, 0.85, 0).rotation.y = 0;
    mesh(radio, boxGeo(0.9, 0.12, 0.7), M.metalDark, 0, 1.36, 0);
    const rmast = mesh(radio, cylGeo(0.05, 0.09, 10.4, 7), M.metalDark, 0, 5.9, 0);
    rmast.castShadow = true;
    const rcrossParts = [bgeo(0.9, 0.12, 0.7, 0, 1.36, 0)];
    for (let i = 0; i < 4; i++) {
      const y = 7.4 + i * 0.72;
      rcrossParts.push(bgeo(1.9 - i * 0.35, 0.045, 0.045, 0, y, 0));
    }
    rcrossParts.push(cgeo(0.02, 0.02, 0.9, 5, 0, 11.4, 0));
    radio.add(new THREE.Mesh(mergeGeos(rcrossParts), M.metalDark));
    const rbeaconMat = M.beaconRed.clone();
    mesh(radio, sphereGeo(0.08, 8, 6), rbeaconMat, 0, 11.8, 0);
    w._glow(ax, 11.8, az, 0xff2a1a, 1.25, true, 0.68);
    // guy wires
    const rguy = [];
    const rtop = new THREE.Vector3(ax, 10.9, az);
    const anchors = [
      new THREE.Vector3(ax + 6.5, 0.1, az + 3.2),
      new THREE.Vector3(ax - 5.2, 0.1, az + 4.4),
      new THREE.Vector3(ax - 1.0, 0.1, az - 5.6),
    ];
    for (let i = 0; i < anchors.length; i++) {
      for (let k = 0; k < 8; k++) {
        const t0 = k / 8, t1 = (k + 1) / 8;
        const p0 = rtop.clone().lerp(anchors[i], t0);
        p0.y -= Math.sin(t0 * PI) * 0.2;
        const p1 = rtop.clone().lerp(anchors[i], t1);
        p1.y -= Math.sin(t1 * PI) * 0.2;
        rguy.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
      }
    }
    const rgGeo = new THREE.BufferGeometry();
    rgGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(rguy), 3));
    const guyLines = new THREE.LineSegments(rgGeo, M.cableLine);
    scene.add(guyLines);
    w._addRoot(guyLines);
    const radioSign = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.55), M.signTower);
    radioSign.position.set(ax + 0.51, 0.9, az);
    radioSign.rotation.y = PI / 2;
    scene.add(radioSign);
    w._addRoot(radioSign);
    w._addSolid({ minX: ax - 0.55, maxX: ax + 0.55, minZ: az - 0.5, maxZ: az + 0.5, height: 1.4 });

    /* ---- hanging cables ---- */
    function cable(a, b, sag) {
      const n = 14;
      const pts = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const p = new THREE.Vector3().lerpVectors(a, b, t);
        p.y -= Math.sin(t * PI) * sag;
        pts.push(p);
      }
      const arr = [];
      for (let i = 0; i < n; i++) {
        arr.push(pts[i].x, pts[i].y, pts[i].z, pts[i + 1].x, pts[i + 1].y, pts[i + 1].z);
      }
      return arr;
    }
    let cablePts = [];
    cablePts = cablePts.concat(cable(new THREE.Vector3(-11.2, 4.55, -8.4), new THREE.Vector3(11.6, 5.7, -11.4), 1.1));
    cablePts = cablePts.concat(cable(new THREE.Vector3(-15.0, 4.3, -9.4), new THREE.Vector3(-19.6, 3.7, -1.5), 0.55));
    cablePts = cablePts.concat(cable(new THREE.Vector3(12.2, 5.65, -9.2), new THREE.Vector3(19.6, 3.75, 7.2), 0.8));
    cablePts = cablePts.concat(cable(new THREE.Vector3(3.85, 3.72, 19.8), new THREE.Vector3(12.0, 5.65, -9.2), 1.3));
    const cableGeo = new THREE.BufferGeometry();
    cableGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(cablePts), 3));
    const cables = new THREE.LineSegments(cableGeo, M.cableLine);
    scene.add(cables);
    w._addRoot(cables);

    // caged work bulb hanging from the gate cable
    const bulb = mesh(scene, sphereGeo(0.1, 8, 6), M.lampAmber, 2.9, 4.6, 10.4);
    w._addRoot(bulb);
    w._glow(2.9, 4.6, 10.4, 0xffb050, 0.8, false, 0.51);

    /* ---- pallets (two, merged into one draw) ---- */
    const palletParts = [];
    for (let i = 0; i < 3; i++) palletParts.push(bgeo(1.1, 0.09, 0.14, 0, 0.06, -0.42 + i * 0.42));
    for (let i = 0; i < 5; i++) palletParts.push(bgeo(0.16, 0.05, 1.15, -0.5 + i * 0.25, 0.13, 0));
    const palletBase = mergeGeos(palletParts);
    const palletA = palletBase.clone();
    xf(palletA, 11.95, 0.05, 1.9, 0, 0.3, 0);
    const palletB = palletBase.clone();
    xf(palletB, -12.4, 0.05, 4.6, 0, -0.5, 0);
    palletBase.dispose();
    const pallets = new THREE.Mesh(mergeGeos([palletA, palletB]), M.woodDark);
    pallets.castShadow = true;
    pallets.receiveShadow = true;
    scene.add(pallets);
    w._addRoot(pallets);

    /* ---- non-burning fuel drums ---- */
    const drumSpots = [[15.3, 2.2], [15.7, 3.1], [10.9, -6.4]];
    const drumGeo = cylGeo(0.3, 0.3, 0.9, 12);
    const drums = makeInstanced(drumGeo, M.barrel, drumSpots.length, true, true);
    for (let i = 0; i < drumSpots.length; i++) {
      setInst(drums, i, drumSpots[i][0], 0.45, drumSpots[i][1], 0, i * 0.9, 0, 1, 1, 1);
    }
    doneInst(drums);
    scene.add(drums);
    w._addRoot(drums);
    const fuelSign = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.4), M.signFuel);
    fuelSign.position.set(14.1, 1.35, 2.35);
    fuelSign.rotation.y = -PI / 2;
    scene.add(fuelSign);
    w._addRoot(fuelSign);

    /* ---- ground conduit runs + junction boxes (merged) ---- */
    const conduitParts = [
      bgeo(7.6, 0.07, 0.16, -3.4, 0.045, -2.3),
      bgeo(8.0, 0.07, 0.16, 6.2, 0.045, -0.6),
      bgeo(0.5, 0.3, 0.4, -7.1, 0.15, -2.3),
      bgeo(0.5, 0.3, 0.4, 10.1, 0.15, -0.6),
    ];
    const conduits = new THREE.Mesh(mergeGeos(conduitParts), M.metalDark);
    conduits.castShadow = true;
    conduits.receiveShadow = true;
    scene.add(conduits);
    w._addRoot(conduits);

    /* ---- scattered debris ---- */
    const debrisSpots = [
      [-3.2, 16.2, 0.5], [-1.4, 17.4, 0.35], [4.2, 7.8, 0.45], [6.8, -4.2, 0.4],
      [-8.4, 8.6, 0.5], [2.2, -13.4, 0.4], [-12.8, 0.4, 0.35], [14.2, 9.9, 0.45],
      [-9.2, 16.8, 0.3], [0.8, -4.6, 0.3], [13.1, -14.2, 0.4], [-15.2, -17.4, 0.35],
      [7.8, 14.6, 0.3], [-4.4, -12.6, 0.3], [11.2, 15.8, 0.35], [-17.2, 12.4, 0.3],
    ];
    const debris = makeInstanced(boxGeo(1, 1, 1), M.woodDark, debrisSpots.length, false, true);
    for (let i = 0; i < debrisSpots.length; i++) {
      const d = debrisSpots[i];
      setInst(debris, i, d[0], 0.035, d[1], 0, (i * 1.31) % TAU, 0, d[2] * 3.2, 0.06, d[2] * 0.6);
    }
    doneInst(debris);
    scene.add(debris);
    w._addRoot(debris);
    const rubble = makeInstanced(new THREE.DodecahedronGeometry(0.22, 0), M.concreteDark, 18, false, true);
    for (let i = 0; i < 18; i++) {
      const a = (i * 2.37) % TAU;
      const r = 4 + (i % 7) * 2.4;
      setInst(rubble, i, Math.cos(a) * r, 0.1, Math.sin(a) * r, i * 0.8, i * 1.2, i * 0.4, 1, 0.7, 1);
    }
    doneInst(rubble);
    scene.add(rubble);
    w._addRoot(rubble);
  };

  /* ------------------------------------------------------------------ */
  /* B.sandbags — instanced sandbag walls + bagLine helper               */
  /* ------------------------------------------------------------------ */
  function bagLine(w, ax, az, bx, bz, y, rows, spacing, jitter) {
    const spots = (w._bagSpots = w._bagSpots || []);
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz) || 0.001;
    const n = Math.max(2, Math.round(len / (spacing || 0.62)));
    const ux = dx / len, uz = dz / len;
    for (let r = 0; r < rows; r++) {
      const off = (r % 2) * (spacing || 0.62) * 0.5;
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        const jx = (Math.random() - 0.5) * (jitter || 0.08);
        const jz = (Math.random() - 0.5) * (jitter || 0.08);
        const x = ax + dx * t + jx - uz * off;
        const z = az + dz * t + jz + ux * off;
        const yy = y + 0.2 + r * 0.27 + (Math.random() - 0.5) * 0.035;
        spots.push([
          x, yy, z,
          Math.random() * TAU,
          0.85 + Math.random() * 0.3, 0.8 + Math.random() * 0.28, 0.85 + Math.random() * 0.3,
        ]);
      }
    }
  }

  B.sandbags = function (w) {
    // emplacements declared with explicit colliders
    bagLine(w, -7.9, 17.5, -4.5, 17.5, 0, 3, 0.64, 0.14);
    bagLine(w, 4.5, 17.5, 7.9, 17.5, 0, 3, 0.64, 0.14);
    bagLine(w, -7.9, -17.5, -4.5, -17.5, 0, 3, 0.64, 0.14);
    bagLine(w, 4.5, -17.5, 7.9, -17.5, 0, 3, 0.64, 0.14);
    w._addSolid({ minX: -8.2, maxX: -4.2, minZ: 17.1, maxZ: 18.0, height: 1.05 });
    w._addSolid({ minX: 4.2, maxX: 8.2, minZ: 17.1, maxZ: 18.0, height: 1.05 });
    w._addSolid({ minX: -8.2, maxX: -4.2, minZ: -18.0, maxZ: -17.1, height: 1.05 });
    w._addSolid({ minX: 4.2, maxX: 8.2, minZ: -18.0, maxZ: -17.1, height: 1.05 });

    // generator cover
    bagLine(w, -4.5, 1.7, -4.5, -1.7, 0, 2, 0.62, 0.1);
    bagLine(w, 4.5, 1.7, 4.5, -1.7, 0, 2, 0.62, 0.1);
    w._addSolid({ minX: -4.9, maxX: -4.1, minZ: -2.0, maxZ: 2.0, height: 0.85 });
    w._addSolid({ minX: 4.1, maxX: 4.9, minZ: -2.0, maxZ: 2.0, height: 0.85 });

    // ammo corner low wall
    bagLine(w, 6.9, 3.2, 9.9, 3.2, 0, 2, 0.62, 0.1);
    w._addSolid({ minX: 6.6, maxX: 10.2, minZ: 2.85, maxZ: 3.6, height: 0.85 });

    // small pile by the tower ladder
    bagLine(w, 9.2, -15.6, 9.2, -14.2, 0, 1, 0.6, 0.1);

    const spots = w._bagSpots || [];
    const bagGeo = new THREE.IcosahedronGeometry(0.36, 1);
    const bags = makeInstanced(bagGeo, w.M.sandbag, spots.length, true, true);
    const tmpColor = new THREE.Color();
    for (let i = 0; i < spots.length; i++) {
      const s = spots[i];
      setInst(bags, i, s[0], s[1], s[2], (Math.random() - 0.5) * 0.12, s[3], (Math.random() - 0.5) * 0.1, s[4], s[5], s[6]);
      const v = 0.78 + Math.random() * 0.3;
      tmpColor.setRGB(v, v * 0.985, v * 0.94);
      bags.setColorAt(i, tmpColor);
    }
    doneInst(bags);
    if (bags.instanceColor) bags.instanceColor.needsUpdate = true;
    w.scene.add(bags);
    w._addRoot(bags);
    w._raycastBags = bags;
  };

  /* ------------------------------------------------------------------ */
  /* makeEmitter — one-draw-call procedural particle column              */
  /* ------------------------------------------------------------------ */
  function makeEmitter(w, origins, perOrigin, opts) {
    opts = opts || {};
    const total = origins.length * perOrigin;
    const pos = new Float32Array(total * 3);
    const aOrigin = new Float32Array(total * 3);
    const aSeed = new Float32Array(total);
    const aSeed2 = new Float32Array(total);
    let v = 0;
    for (let oi = 0; oi < origins.length; oi++) {
      for (let i = 0; i < perOrigin; i++) {
        aOrigin[v * 3] = origins[oi].x;
        aOrigin[v * 3 + 1] = origins[oi].y;
        aOrigin[v * 3 + 2] = origins[oi].z;
        aSeed[v] = Math.random();
        aSeed2[v] = Math.random();
        v++;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aOrigin", new THREE.BufferAttribute(aOrigin, 3));
    geo.setAttribute("aSeed", new THREE.BufferAttribute(aSeed, 1));
    geo.setAttribute("aSeed2", new THREE.BufferAttribute(aSeed2, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 9999);
    const dpr = w.renderer ? w.renderer.getPixelRatio() : 1;
    const pxScale = ((w.renderer && w.renderer.domElement ? w.renderer.domElement.height : 720) * dpr) * 0.5 / Math.tan(0.61);
    const c1 = opts.c1 || [1, 0.7, 0.3];
    const c2 = opts.c2 || [0.8, 0.2, 0.05];
    const uniforms = {
      uTime: { value: 0 },
      uActive: { value: opts.active == null ? 1 : opts.active },
      uPx: { value: pxScale },
      uRise: { value: opts.rise == null ? 3 : opts.rise },
      uSpeed: { value: opts.speed == null ? 0.3 : opts.speed },
      uSize: { value: opts.size == null ? 0.4 : opts.size },
      uSizeEnd: { value: opts.sizeEnd == null ? 1.0 : opts.sizeEnd },
      uWind: { value: new THREE.Vector2(opts.windX == null ? 0.25 : opts.windX, opts.windZ == null ? 0.1 : opts.windZ) },
      uC1: { value: new THREE.Color(c1[0], c1[1], c1[2]) },
      uC2: { value: new THREE.Color(c2[0], c2[1], c2[2]) },
      uAlpha: { value: opts.alpha == null ? 0.5 : opts.alpha },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: uniforms,
      vertexShader: [
        "attribute vec3 aOrigin; attribute float aSeed; attribute float aSeed2;",
        "uniform float uTime; uniform float uActive; uniform float uPx;",
        "uniform float uRise; uniform float uSpeed; uniform float uSize; uniform float uSizeEnd;",
        "uniform vec2 uWind;",
        "varying float vT; varying float vA; varying float vS;",
        "void main() {",
        "  float t = fract( uTime * uSpeed + aSeed );",
        "  vec3 p = aOrigin;",
        "  p.y += t * uRise;",
        "  float spread = 0.3 + t * 1.7;",
        "  p.x += ( sin( aSeed2 * 37.0 + t * 8.0 ) * 0.24 + t * uWind.x ) * spread;",
        "  p.z += ( cos( aSeed2 * 29.0 + t * 7.0 ) * 0.24 + t * uWind.y ) * spread;",
        "  vec4 mv = modelViewMatrix * vec4( p, 1.0 );",
        "  gl_Position = projectionMatrix * mv;",
        "  float sz = mix( uSize, uSizeEnd, t ) * ( 0.55 + fract( aSeed2 * 7.0 ) * 0.9 );",
        "  gl_PointSize = clamp( sz * uPx / max( 0.5, -mv.z ), 1.0, 256.0 );",
        "  vT = t;",
        "  vA = uActive * smoothstep( 0.0, 0.1, t ) * ( 1.0 - smoothstep( 0.55, 1.0, t ) );",
        "  vS = fract( aSeed * 5.3 );",
        "}",
      ].join("\n"),
      fragmentShader: [
        "uniform vec3 uC1; uniform vec3 uC2; uniform float uAlpha;",
        "varying float vT; varying float vA; varying float vS;",
        "void main() {",
        "  vec2 uv = gl_PointCoord - 0.5;",
        "  float d = length( uv );",
        "  if ( d > 0.5 ) discard;",
        "  float a = pow( 1.0 - d * 2.0, 1.7 );",
        "  vec3 col = mix( uC1, uC2, smoothstep( 0.0, 1.0, vT ) );",
        "  gl_FragColor = vec4( col, a * vA * uAlpha * ( 0.75 + vS * 0.35 ) );",
        "}",
      ].join("\n"),
      transparent: true,
      depthWrite: false,
      blending: opts.additive === false ? THREE.NormalBlending : THREE.AdditiveBlending,
      toneMapped: false,
      fog: false,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = opts.additive === false ? 6 : 7;
    w.scene.add(pts);
    w._addRoot(pts);
    w._emitters.push({ mat: mat, offset: Math.random() * 12 });
    return { points: pts, mat: mat, uniforms: uniforms };
  }

  /* ------------------------------------------------------------------ */
  /* B.forest — instanced pine forest ring, undergrowth, snags, rocks    */
  /* ------------------------------------------------------------------ */
  B.forest = function (w) {
    const M = w.M;
    const scene = w.scene;
    const q = w.quality;
    const rng = DL.mulberry32(0x5eed13);

    const treeCount = Math.max(60, q.treeCount || 200);
    const trees = [];
    let guard = 0;
    while (trees.length < treeCount && guard < treeCount * 50) {
      guard++;
      const a = rng() * TAU;
      const rr = 27 + Math.pow(rng(), 0.92) * 41;
      const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
      if (Math.abs(x) < 10.5 && z > 17) continue;
      if (Math.abs(x) < 10.5 && z < -17) continue;
      if (Math.abs(x - 13.4) < 5 && Math.abs(z - 6) < 5) continue;
      if (Math.abs(x + 14.2) < 5 && Math.abs(z - 7) < 5) continue;
      let ok = true;
      const from = Math.max(0, trees.length - 46);
      for (let i = from; i < trees.length; i++) {
        const dx = trees[i].x - x, dz = trees[i].z - z;
        if (dx * dx + dz * dz < 3.4) { ok = false; break; }
      }
      if (!ok) continue;
      trees.push({
        x: x, z: z,
        s: 0.66 + rng() * 0.64,
        rot: rng() * TAU,
        tilt: (rng() - 0.5) * 0.05,
      });
    }

    // geometry: multi-tier conifer
    const canopyGeo = mergeGeos([
      xf(new THREE.ConeGeometry(2.65, 3.5, 7, 1, true), 0, 3.05, 0),
      xf(new THREE.ConeGeometry(2.05, 3.2, 7, 1, true), 0, 4.65, 0),
      xf(new THREE.ConeGeometry(1.45, 2.9, 7, 1, true), 0, 6.05, 0),
      xf(new THREE.ConeGeometry(0.82, 2.4, 7, 1, true), 0, 7.45, 0),
    ]);
    const trunkGeo = cylGeo(0.09, 0.27, 8.0, 6, true);
    trunkGeo.translate(0, 4.0, 0);

    const trunks = makeInstanced(trunkGeo, M.treeTrunk, trees.length, false, false);
    const canopies = makeInstanced(canopyGeo, M.canopy, trees.length, true, false);
    const tmp = new THREE.Color();
    for (let i = 0; i < trees.length; i++) {
      const t = trees[i];
      setInst(trunks, i, t.x, 0, t.z, t.tilt, t.rot, 0, t.s, t.s, t.s);
      setInst(canopies, i, t.x, 0, t.z, t.tilt, t.rot, 0, t.s, t.s, t.s);
      const v = 0.68 + rng() * 0.5;
      tmp.setRGB(v * 0.82, v, v * 0.86);
      canopies.setColorAt(i, tmp);
      if (rng() < 0.16) setInst(canopies, i, t.x, 0, t.z, t.tilt, t.rot, 0, t.s, t.s * 1.04, t.s);
      // collision for trees close to the compound
      if (Math.hypot(t.x, t.z) < 38) {
        const rad = 0.42 * t.s + 0.15;
        w._addCollider({ minX: t.x - rad, maxX: t.x + rad, minZ: t.z - rad, maxZ: t.z + rad, height: 7 * t.s });
      }
    }
    doneInst(trunks);
    doneInst(canopies);
    if (canopies.instanceColor) canopies.instanceColor.needsUpdate = true;
    scene.add(trunks);
    scene.add(canopies);
    w._addRoot(trunks);
    w._addRoot(canopies);
    w._treeCount = trees.length;
    w._treePositions = trees;

    // far concealment ring (foliage only, no shadows)
    const farGeo = mergeGeos([
      xf(new THREE.ConeGeometry(3.2, 5.2, 6, 1, true), 0, 2.5, 0),
      xf(new THREE.ConeGeometry(2.4, 4.6, 6, 1, true), 0, 4.4, 0),
      xf(new THREE.ConeGeometry(1.6, 4.0, 6, 1, true), 0, 6.2, 0),
    ]);
    const farCount = 150;
    const far = makeInstanced(farGeo, M.canopyFar, farCount, false, false);
    for (let i = 0; i < farCount; i++) {
      const a = rng() * TAU;
      const rr = 62 + rng() * 42;
      const s = 0.8 + rng() * 1.0;
      setInst(far, i, Math.cos(a) * rr, 0, Math.sin(a) * rr, 0, rng() * TAU, 0, s, s, s);
    }
    doneInst(far);
    scene.add(far);
    w._addRoot(far);

    // dead snags
    const snagParts = [];
    snagParts.push(xf(cylGeo(0.05, 0.22, 7.0, 5, true), 0, 3.5, 0));
    snagParts.push(xf(cylGeo(0.03, 0.07, 2.1, 4, true), 0.55, 4.6, 0, 0, 0, -0.95));
    snagParts.push(xf(cylGeo(0.025, 0.06, 1.8, 4, true), -0.5, 5.3, 0.2, 0.7, 0, 1.0));
    snagParts.push(xf(cylGeo(0.02, 0.05, 1.4, 4, true), 0.2, 6.0, -0.4, -0.8, 0, 0.3));
    const snagGeo = mergeGeos(snagParts);
    const snagCount = 58;
    const snags = makeInstanced(snagGeo, M.snag, snagCount, true, false);
    for (let i = 0; i < snagCount; i++) {
      const a = rng() * TAU;
      const rr = 29 + rng() * 38;
      const s = 0.65 + rng() * 0.75;
      setInst(snags, i, Math.cos(a) * rr, 0, Math.sin(a) * rr, (rng() - 0.5) * 0.12, rng() * TAU, (rng() - 0.5) * 0.1, s, s, s);
    }
    doneInst(snags);
    scene.add(snags);
    w._addRoot(snags);

    // fallen logs
    const logGeo = cgeo(0.22, 0.3, 4.6, 7);
    logGeo.rotateZ(PI / 2);
    const logCount = 10;
    const logs = makeInstanced(logGeo, M.treeTrunk, logCount, true, false);
    for (let i = 0; i < logCount; i++) {
      const a = rng() * TAU;
      const rr = 31 + rng() * 32;
      setInst(logs, i, Math.cos(a) * rr, 0.24, Math.sin(a) * rr, 0, rng() * TAU, 0, 0.8 + rng() * 0.6, 1, 0.9 + rng() * 0.4);
    }
    doneInst(logs);
    scene.add(logs);
    w._addRoot(logs);

    // rocks
    const rockGeo = new THREE.DodecahedronGeometry(1, 0);
    const rockCount = 88;
    const rocks = makeInstanced(rockGeo, M.rock, rockCount, true, true);
    for (let i = 0; i < rockCount; i++) {
      const a = rng() * TAU;
      const rr = 26 + rng() * 48;
      const s = 0.3 + rng() * 1.35;
      setInst(rocks, i, Math.cos(a) * rr, s * 0.3, Math.sin(a) * rr,
        rng() * TAU, rng() * TAU, rng() * TAU, s * (0.7 + rng() * 0.8), s * (0.5 + rng() * 0.5), s * (0.7 + rng() * 0.8));
    }
    doneInst(rocks);
    scene.add(rocks);
    w._addRoot(rocks);

    // low bushes
    const bushGeo = new THREE.IcosahedronGeometry(0.85, 0);
    const bushCount = 165;
    const bushes = makeInstanced(bushGeo, M.bush, bushCount, false, false);
    const bcol = new THREE.Color();
    for (let i = 0; i < bushCount; i++) {
      const a = rng() * TAU;
      const rr = 23 + rng() * 46;
      const s = 0.55 + rng() * 1.0;
      setInst(bushes, i, Math.cos(a) * rr, s * 0.5, Math.sin(a) * rr, 0, rng() * TAU, 0, s * 1.3, s * 0.7, s * 1.3);
      const v = 0.65 + rng() * 0.55;
      bcol.setRGB(v * 0.8, v, v * 0.8);
      bushes.setColorAt(i, bcol);
    }
    doneInst(bushes);
    if (bushes.instanceColor) bushes.instanceColor.needsUpdate = true;
    scene.add(bushes);
    w._addRoot(bushes);

    // grass (cross quads), inside tufts + forest ring
    const g1 = new THREE.PlaneGeometry(0.95, 0.8);
    g1.translate(0, 0.4, 0);
    const g2 = g1.clone();
    g2.rotateY(PI / 2);
    const grassGeo = mergeGeos([g1, g2]);
    const grassOutside = Math.max(100, Math.floor((q.grassCount || 1200) * 0.88));
    const grassInside = 240;
    const grass = makeInstanced(grassGeo, M.grass, grassOutside + grassInside, false, false);
    const gcol = new THREE.Color();
    let gi = 0;
    for (let i = 0; i < grassOutside; i++) {
      let x = 0, z = 0, ok = false;
      for (let tries = 0; tries < 8 && !ok; tries++) {
        const a = rng() * TAU;
        const rr = 23.5 + rng() * 42;
        x = Math.cos(a) * rr; z = Math.sin(a) * rr;
        ok = !(Math.abs(x) < 8 && Math.abs(z) > 17);
      }
      const s = 0.6 + rng() * 0.95;
      setInst(grass, gi, x, 0, z, 0, rng() * TAU, 0, s, s * (0.8 + rng() * 0.6), s);
      const v = 0.6 + rng() * 0.6;
      gcol.setRGB(v * 0.82, v, v * 0.7);
      grass.setColorAt(gi, gcol);
      gi++;
    }
    for (let i = 0; i < grassInside; i++) {
      let x = 0, z = 0, ok = false;
      for (let tries = 0; tries < 10 && !ok; tries++) {
        x = (rng() * 2 - 1) * 18.6;
        z = (rng() * 2 - 1) * 18.6;
        if (Math.abs(x) < 4.6 && Math.abs(z) < 16.5) continue;
        if (Math.abs(x) < 3.6 && Math.abs(z) < 6) continue;
        if (Math.abs(x - 13.4) < 3 && Math.abs(z - 6) < 5) continue;
        if (Math.abs(x + 14.2) < 4 && Math.abs(z - 7) < 3) continue;
        if (Math.abs(x + 11) < 5 && Math.abs(z + 12) < 4) continue;
        if (Math.abs(x - 12) < 4 && Math.abs(z + 12) < 4) continue;
        ok = true;
      }
      if (!ok) continue;
      const s = 0.4 + rng() * 0.6;
      setInst(grass, gi, x, 0, z, 0, rng() * TAU, 0, s, s * (0.7 + rng() * 0.5), s);
      const v = 0.5 + rng() * 0.5;
      gcol.setRGB(v * 0.8, v, v * 0.68);
      grass.setColorAt(gi, gcol);
      gi++;
    }
    grass.count = gi;
    doneInst(grass);
    if (grass.instanceColor) grass.instanceColor.needsUpdate = true;
    scene.add(grass);
    w._addRoot(grass);
  };

  /* ------------------------------------------------------------------ */
  /* B.weather — rain, mist, dust, fire/smoke, lightning bolt            */
  /* ------------------------------------------------------------------ */
  B.weather = function (w) {
    const scene = w.scene;
    const q = w.quality;
    const dpr = w.renderer ? w.renderer.getPixelRatio() : 1;
    const bufH = ((w.renderer && w.renderer.domElement ? w.renderer.domElement.height : 720) * dpr);
    const pxScale = bufH * 0.5 / Math.tan(0.61);

    /* ---------- rain (shader quads following the player) ---------- */
    const dropCount = Math.max(250, q.rainCount || 1600);
    const vertCount = dropCount * 6;
    const rPos = new Float32Array(vertCount * 3);
    const rOff = new Float32Array(vertCount * 3);
    const rSpd = new Float32Array(vertCount);
    const rLen = new Float32Array(vertCount);
    const rSeed = new Float32Array(vertCount);
    const corners = [[-0.5, 0], [0.5, 0], [0.5, 1], [-0.5, 0], [0.5, 1], [-0.5, 1]];
    for (let i = 0; i < dropCount; i++) {
      const ox = Math.random() * 38 - 19;
      const oy = Math.random() * 26;
      const oz = Math.random() * 38 - 19;
      const speed = 15 + Math.random() * 13;
      const len = 0.5 + Math.random() * 0.95;
      const seed = Math.random();
      for (let k = 0; k < 6; k++) {
        const v = i * 6 + k;
        rPos[v * 3] = corners[k][0];
        rPos[v * 3 + 1] = corners[k][1];
        rPos[v * 3 + 2] = 0;
        rOff[v * 3] = ox;
        rOff[v * 3 + 1] = oy;
        rOff[v * 3 + 2] = oz;
        rSpd[v] = speed;
        rLen[v] = len;
        rSeed[v] = seed;
      }
    }
    const rainGeo = new THREE.BufferGeometry();
    rainGeo.setAttribute("position", new THREE.BufferAttribute(rPos, 3));
    rainGeo.setAttribute("aOffset", new THREE.BufferAttribute(rOff, 3));
    rainGeo.setAttribute("aSpeed", new THREE.BufferAttribute(rSpd, 1));
    rainGeo.setAttribute("aLen", new THREE.BufferAttribute(rLen, 1));
    rainGeo.setAttribute("aSeed", new THREE.BufferAttribute(rSeed, 1));
    rainGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 9999);
    const rainMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uCenter: { value: new THREE.Vector3(0, 0, 0) },
        uOpacity: { value: 1.0 },
      },
      vertexShader: [
        "attribute vec3 aOffset; attribute float aSpeed; attribute float aLen; attribute float aSeed;",
        "uniform float uTime; uniform vec3 uCenter; uniform float uOpacity;",
        "varying float vA;",
        "void main() {",
        "  vec3 box = vec3( 38.0, 26.0, 38.0 );",
        "  vec3 p;",
        "  p.x = uCenter.x + mod( aOffset.x + aSeed * 17.0, box.x ) - box.x * 0.5;",
        "  p.z = uCenter.z + mod( aOffset.z + aSeed * 29.0, box.z ) - box.z * 0.5;",
        "  float fall = mod( aOffset.y - uTime * aSpeed, box.y );",
        "  p.y = uCenter.y + box.y * 0.5 - fall;",
        "  vec4 mv = viewMatrix * vec4( p, 1.0 );",
        "  float dist = max( 0.6, -mv.z );",
        "  mv.x += position.x * 0.036;",
        "  mv.y += ( position.y - 0.5 ) * aLen;",
        "  mv.x += position.y * aLen * 0.10;",
        "  gl_Position = projectionMatrix * mv;",
        "  float vis = 1.0 - smoothstep( -1.0, 0.0, mv.z );",
        "  float nearFade = smoothstep( 2.0, 6.0, dist );",
        "  vA = 0.15 * uOpacity * nearFade * ( 1.0 - smoothstep( 8.0, 36.0, dist ) ) * ( 0.5 + aSeed * 0.8 ) * vis;",
        "}",
      ].join("\n"),
      fragmentShader: [
        "varying float vA;",
        "void main() { gl_FragColor = vec4( vec3( 0.6, 0.71, 0.84 ), vA ); }",
      ].join("\n"),
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
      toneMapped: false,
      fog: false,
    });
    const rain = new THREE.Mesh(rainGeo, rainMat);
    rain.frustumCulled = false;
    rain.renderOrder = 10;
    scene.add(rain);
    w._addRoot(rain);
    w._rainMat = rainMat;
    w._rain = rain;

    /* ---------- drifting ground mist (points) ---------- */
    const mistCount = Math.max(40, Math.round((q.rainCount || 1600) * 0.035));
    const mPos = new Float32Array(mistCount * 3);
    const mSeed = new Float32Array(mistCount);
    for (let i = 0; i < mistCount; i++) {
      mPos[i * 3] = Math.random() * 90 - 45;
      mPos[i * 3 + 1] = 0;
      mPos[i * 3 + 2] = Math.random() * 90 - 45;
      mSeed[i] = Math.random();
    }
    const mistGeo = new THREE.BufferGeometry();
    mistGeo.setAttribute("position", new THREE.BufferAttribute(mPos, 3));
    mistGeo.setAttribute("aSeed", new THREE.BufferAttribute(mSeed, 1));
    mistGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 9999);
    const mistMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uCenter: { value: new THREE.Vector3(0, 0, 0) },
        uPx: { value: pxScale },
      },
      vertexShader: [
        "attribute float aSeed;",
        "uniform float uTime; uniform vec3 uCenter; uniform float uPx;",
        "varying float vA;",
        "void main() {",
        "  vec3 p;",
        "  p.x = uCenter.x + mod( position.x + uTime * 0.42 + 45.0, 90.0 ) - 45.0;",
        "  p.z = uCenter.z + mod( position.z + uTime * 0.23 + 45.0, 90.0 ) - 45.0;",
        "  p.y = 0.25 + fract( aSeed * 3.7 ) * 1.9 + sin( uTime * 0.25 + aSeed * 10.0 ) * 0.1;",
        "  vec4 mv = viewMatrix * vec4( p, 1.0 );",
        "  gl_Position = projectionMatrix * mv;",
        "  gl_PointSize = clamp( mix( 4.5, 9.5, aSeed ) * uPx / max( 2.0, -mv.z ), 6.0, 220.0 );",
        "  vA = 0.05 * ( 0.6 + aSeed * 0.7 );",
        "}",
      ].join("\n"),
      fragmentShader: [
        "varying float vA;",
        "void main() {",
        "  vec2 uv = gl_PointCoord - 0.5;",
        "  float d = length( uv );",
        "  if ( d > 0.5 ) discard;",
        "  float a = pow( 1.0 - d * 2.0, 2.0 );",
        "  gl_FragColor = vec4( vec3( 0.62, 0.73, 0.8 ), a * vA );",
        "}",
      ].join("\n"),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      fog: false,
    });
    const mist = new THREE.Points(mistGeo, mistMat);
    mist.frustumCulled = false;
    mist.renderOrder = 5;
    scene.add(mist);
    w._addRoot(mist);
    w._mistMat = mistMat;

    /* ---------- low mist sheets (billboard planes) ---------- */
    const mistTex = DL.makeRadialSprite(128, [
      [0, "rgba(196,216,228,0.5)"],
      [0.45, "rgba(170,196,212,0.22)"],
      [0.75, "rgba(150,180,200,0.06)"],
      [1, "rgba(140,170,190,0)"],
    ]);
    const sheetDefs = [
      [0.55, 52, 0, 0, 0.06],
      [1.15, 68, -9, -8, 0.045],
      [1.95, 86, 7, 12, 0.03],
    ];
    w._mistSheets = [];
    for (let i = 0; i < sheetDefs.length; i++) {
      const sd = sheetDefs[i];
      const g = new THREE.PlaneGeometry(sd[1], sd[1]);
      g.rotateX(-PI / 2);
      const mat = new THREE.MeshBasicMaterial({
        map: mistTex,
        transparent: true,
        opacity: sd[4],
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        toneMapped: false,
        fog: false,
      });
      const m = new THREE.Mesh(g, mat);
      m.position.set(sd[2], sd[0], sd[3]);
      m.renderOrder = 4;
      m.frustumCulled = false;
      scene.add(m);
      w._addRoot(m);
      w._mistSheets.push({ mesh: m, speed: 0.008 + i * 0.004, phase: i * 2.1, baseY: sd[0] });
    }

    /* ---------- dust motes ---------- */
    const dustCount = 150;
    const dPos = new Float32Array(dustCount * 3);
    const dSeed = new Float32Array(dustCount);
    for (let i = 0; i < dustCount; i++) {
      dPos[i * 3] = Math.random() * 24 - 12;
      dPos[i * 3 + 1] = Math.random() * 3.6 + 0.2;
      dPos[i * 3 + 2] = Math.random() * 24 - 12;
      dSeed[i] = Math.random();
    }
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute("position", new THREE.BufferAttribute(dPos, 3));
    dustGeo.setAttribute("aSeed", new THREE.BufferAttribute(dSeed, 1));
    dustGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 9999);
    const dustMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uCenter: { value: new THREE.Vector3(0, 0, 0) },
        uPx: { value: pxScale },
      },
      vertexShader: [
        "attribute float aSeed;",
        "uniform float uTime; uniform vec3 uCenter; uniform float uPx;",
        "varying float vA;",
        "void main() {",
        "  vec3 p;",
        "  p.x = uCenter.x + mod( position.x + uTime * ( 0.12 + aSeed * 0.2 ) + 12.0, 24.0 ) - 12.0;",
        "  p.z = uCenter.z + mod( position.z + uTime * ( 0.08 + aSeed * 0.15 ) + 12.0, 24.0 ) - 12.0;",
        "  p.y = uCenter.y + position.y + sin( uTime * 0.4 + aSeed * 12.0 ) * 0.35;",
        "  vec4 mv = viewMatrix * vec4( p, 1.0 );",
        "  gl_Position = projectionMatrix * mv;",
        "  gl_PointSize = clamp( ( 0.05 + aSeed * 0.09 ) * uPx / max( 0.6, -mv.z ), 1.0, 10.0 );",
        "  vA = 0.32 * ( 0.4 + aSeed * 0.6 ) * ( 1.0 - smoothstep( 2.0, 9.0, length( mv.xyz ) ) );",
        "}",
      ].join("\n"),
      fragmentShader: [
        "varying float vA;",
        "void main() {",
        "  vec2 uv = gl_PointCoord - 0.5;",
        "  float d = length( uv );",
        "  if ( d > 0.5 ) discard;",
        "  float a = pow( 1.0 - d * 2.0, 2.0 );",
        "  gl_FragColor = vec4( vec3( 0.72, 0.8, 0.86 ), a * vA );",
        "}",
      ].join("\n"),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      fog: false,
    });
    const dust = new THREE.Points(dustGeo, dustMat);
    dust.frustumCulled = false;
    dust.renderOrder = 8;
    scene.add(dust);
    w._addRoot(dust);
    w._dustMat = dustMat;

    /* ---------- fire / smoke / embers for the burning barrels ---------- */
    if (w._barrelFires && w._barrelFires.length) {
      const fireOrigins = w._barrelFires.map(function (v) { return v.clone(); });
      const smokeOrigins = w._barrelFires.map(function (v) { return v.clone().setY(v.y + 1.0); });
      w._fireFx = makeEmitter(w, fireOrigins, 52, {
        rise: 1.9, speed: 0.85, size: 0.19, sizeEnd: 0.55,
        windX: 0.5, windZ: 0.16,
        c1: [1.0, 0.62, 0.16], c2: [0.42, 0.06, 0.008],
        alpha: 0.62, additive: true,
      });
      w._smokeFx = makeEmitter(w, smokeOrigins, 26, {
        rise: 3.6, speed: 0.17, size: 0.55, sizeEnd: 2.3,
        windX: 1.7, windZ: 0.5,
        c1: [0.11, 0.12, 0.12], c2: [0.03, 0.035, 0.04],
        alpha: 0.38, additive: false,
      });
      w._emberFx = makeEmitter(w, fireOrigins, 18, {
        rise: 1.6, speed: 1.5, size: 0.035, sizeEnd: 0.015,
        windX: 0.8, windZ: 0.3,
        c1: [1.0, 0.55, 0.14], c2: [1.0, 0.16, 0.02],
        alpha: 0.9, additive: true,
      });
    }

    /* ---------- lightning bolt geometry ---------- */
    const boltSegs = 46;
    const boltPos = new Float32Array(boltSegs * 2 * 3);
    const boltGeo = new THREE.BufferGeometry();
    boltGeo.setAttribute("position", new THREE.BufferAttribute(boltPos, 3));
    boltGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 60, 0), 300);
    const boltMat = new THREE.LineBasicMaterial({
      color: 0xdcefff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });
    const bolt = new THREE.LineSegments(boltGeo, boltMat);
    bolt.visible = false;
    bolt.frustumCulled = false;
    bolt.renderOrder = 9;
    scene.add(bolt);
    w._addRoot(bolt);
    w._bolt = bolt;
    w._boltGeo = boltGeo;
    w._boltSegs = boltSegs;

    if (!scene.fog) scene.fog = new THREE.FogExp2(0x0a1418, 0.0185);
    w._fog = scene.fog;
    if (w._fog.color) w._baseFogColor.copy(w._fog.color);
  };

  /* ------------------------------------------------------------------ */
  /* B.spawns — player / pickup / zombie spawn points                    */
  /* ------------------------------------------------------------------ */
  B.spawns = function (w) {
    w.playerSpawn = new THREE.Vector3(0, 0, 12);

    const candidates = [
      [-6.5, 5.2], [6.4, 5.6], [-11.4, 4.2], [11.2, 1.4],
      [-13.2, 9.4], [13.2, 11.4], [-6.2, -4.4], [6.4, -4.8],
      [-11.2, -4.6], [11.2, -6.2], [1.8, 7.4], [-2.2, 14.6],
      [-2.6, -5.4], [7.6, 7.2],
    ];
    const pickups = [];
    for (let i = 0; i < candidates.length; i++) {
      const x = candidates[i][0], z = candidates[i][1];
      if (Math.abs(x) > 18.5 || Math.abs(z) > 18.5) continue;
      if (!w.isBlocked(x, z, 0.45)) {
        pickups.push(new THREE.Vector3(x, 0, z));
      } else {
        const o = w.nav.nearestOpen(x, z, 8);
        if (o && Math.abs(o.x) < 18.5 && Math.abs(o.z) < 18.5) pickups.push(new THREE.Vector3(o.x, 0, o.z));
      }
    }
    w.pickupSpawns = pickups;

    const spawns = [];
    const count = 14;
    const trees = w._treePositions || [];
    const clearOfTrees = function (x, z) {
      for (let i = 0; i < trees.length; i++) {
        const t = trees[i];
        const dx = t.x - x, dz = t.z - z;
        if (dx * dx + dz * dz < 5.8) return false;
      }
      return true;
    };
    for (let i = 0; i < count; i++) {
      let x = 0, z = 0, placed = false;
      for (let attempt = 0; attempt < 14 && !placed; attempt++) {
        const a = (i / count) * TAU + 0.21 + DL.rand(-0.16, 0.16);
        const r = 40 + DL.rand(0, 9);
        x = Math.cos(a) * r;
        z = Math.sin(a) * r;
        if (w.isBlocked(x, z, 0.5)) continue;
        if (!clearOfTrees(x, z)) continue;
        placed = true;
      }
      if (!placed) {
        const o = w.nav.nearestOpen(Math.cos((i / count) * TAU) * 45, Math.sin((i / count) * TAU) * 45, 10);
        if (o) { x = o.x; z = o.z; }
      }
      spawns.push(new THREE.Vector3(x, 0, z));
    }
    w.spawnPoints = spawns;
  };

  /* ================================================================== */
  /* DL.World — public class                                            */
  /* ================================================================== */
  const nowMs = function () {
    if (typeof performance !== "undefined" && performance.now) return performance.now();
    return Date.now();
  };

  class World {
    constructor(opts) {
      opts = opts || {};
      if (!opts.scene) throw new Error("DEADLIGHT world: scene required");
      this.scene = opts.scene;
      this.renderer = opts.renderer || null;
      this.audio = opts.audio || null;
      this.quality = Object.assign({}, DL.Quality.high, opts.quality || {});
      if (this.quality.treeCount == null) this.quality.treeCount = 200;
      if (this.quality.grassCount == null) this.quality.grassCount = 1200;
      if (this.quality.rainCount == null) this.quality.rainCount = 1600;
      if (this.quality.shadowMapSize == null) this.quality.shadowMapSize = 2048;
      if (this.quality.spotlightShadows == null) this.quality.spotlightShadows = 2;

      this.colliders = [];
      this.raycastMeshes = [];
      this.barricades = [];
      this.generator = null;
      this.spawnPoints = [];
      this.pickupSpawns = [];
      this.playerSpawn = new THREE.Vector3(0, 0, 12);
      this.onLightning = null;

      this.nav = new DL.NavGrid({ minX: -55, maxX: 55, minZ: -55, maxZ: 55, cell: 1.25 });

      this.T = null;
      this.M = null;
      this._staticColliders = [];
      this._barricadesById = {};
      this._glows = [];
      this._emitters = [];
      this._roots = [];
      this._bagSpots = [];
      this._floodlights = [];
      this._barrelLights = [];
      this._mistSheets = [];
      this._gen = null;
      this._flash = 0;
      this._flashQueue = 0;
      this._lightningTimer = 7 + Math.random() * 11;
      this._time = 0;
      this._buildMs = 0;
      this._disposed = false;
      this._preChildren = null;
      this._builtChildren = null;
      this._envRT = null;
      this._baseFogColor = new THREE.Color(0x0a1418);
      this._flashFogColor = new THREE.Color(0x2b4356);
      this._fogColorTmp = new THREE.Color();
      this._vTmp = new THREE.Vector3();
      this.timeOfDay = "night";
      this._day = false;
      this._floodlightScale = 1;
      this._fillBase = 0.28;
      this._ambientBase = 0.44;
      this._hemiBase = 0.5;
    }

    /* ---------------- additive helpers ---------------- */
    _addRoot(obj) {
      if (obj.parent !== this.scene) this.scene.add(obj);
      this._roots.push(obj);
      return obj;
    }
    _addRay(m) {
      if (m) this.raycastMeshes.push(m);
      return m;
    }
    _addSolid(box) {
      this._staticColliders.push(box);
      this.nav.blockWorldBox(box.minX, box.maxX, box.minZ, box.maxZ);
      return box;
    }
    _addCollider(box) {
      this._staticColliders.push(box);
      return box;
    }
    _glow(x, y, z, hex, size, blink, phase) {
      const r = ((hex >> 16) & 255) / 255;
      const g = ((hex >> 8) & 255) / 255;
      const b = (hex & 255) / 255;
      this._glows.push({
        x: x, y: y, z: z,
        r: r, g: g, b: b,
        size: size == null ? 1 : size,
        blink: !!blink,
        phase: phase || 0,
      });
    }

    /* ---------------- build ---------------- */
    build(onProgress) {
      if (this._builtChildren) return;
      const t0 = nowMs();
      const pre = this.scene.children.slice();
      const prog = function (p, label) {
        if (!onProgress) return;
        try {
          onProgress(p, label || "");
        } catch (err) {
          /* progress callbacks must never break the build */
        }
      };

      prog(0.02, "INITIALIZING OUTPOST");
      B.textures(this);
      prog(0.18, "GENERATING SURFACES");
      B.materials(this);
      B.sky(this);
      prog(0.27, "LIGHTING NIGHT SKY");
      if (this.renderer && this.quality.level !== "low") B.env(this);
      B.lights(this);
      prog(0.34, "FLOODING TERRAIN");
      B.ground(this);
      prog(0.42, "RAISING PERIMETER");
      B.walls(this);
      B.gates(this);
      prog(0.5, "REINFORCING GATES");
      B.bunker(this);
      prog(0.57, "COMMAND BUNKER");
      B.tower(this);
      B.containers(this);
      prog(0.64, "WATCHTOWER + CARGO");
      B.generator(this);
      prog(0.7, "SPINNING UP GENERATOR");
      B.floodlights(this);
      B.props(this);
      prog(0.78, "SCATTERING PROPS");
      B.sandbags(this);
      prog(0.83, "STACKING SANDBAGS");
      B.glows(this);
      prog(0.87, "PLANTING FOREST");
      B.forest(this);
      prog(0.93, "OPENING THE SKIES");
      B.weather(this);
      prog(0.96, "WIRING NAVIGATION");
      this._refreshGateColliders();
      this._refreshDynamicNav();
      B.spawns(this);
      for (let i = 0; i < this.barricades.length; i++) this.updateBarricadeVisual(this.barricades[i].id);

      this._preChildren = pre;
      this._builtChildren = this.scene.children.filter(function (c) { return pre.indexOf(c) < 0; });
      this._buildMs = nowMs() - t0;
      prog(1, "WORLD READY");
    }

    /* ---------------- barricades ---------------- */
    _refreshGateColliders() {
      const arr = this.colliders;
      arr.length = 0;
      for (let i = 0; i < this._staticColliders.length; i++) arr.push(this._staticColliders[i]);
      for (let i = 0; i < this.barricades.length; i++) {
        const b = this.barricades[i];
        if (b.blocked) arr.push(b.collider);
      }
    }

    _refreshDynamicNav() {
      this.nav.clearDynamic();
      for (let i = 0; i < this.barricades.length; i++) {
        const b = this.barricades[i];
        if (!b.blocked) continue;
        const z = b.position.z;
        this.nav.blockWorldBox(-3.85, 3.85, z - 0.85, z + 0.85, true);
      }
    }

    setBarricadeBlocked(id, blocked) {
      const b = this._barricadesById[id];
      if (!b) return;
      b.blocked = !!blocked;
      this._refreshGateColliders();
      this._refreshDynamicNav();
      this.updateBarricadeVisual(id);
    }

    updateBarricadeVisual(id) {
      const b = this._barricadesById[id];
      if (!b) return;
      const frac = b.maxHealth > 0 ? DL.clamp(b.health / b.maxHealth, 0, 1) : 0;
      const shown = !b.blocked ? (b.broken ? 2 : 0) : (b.broken ? 2 : Math.ceil(frac * b.planks.length));
      for (let i = 0; i < b.planks.length; i++) {
        const p = b.planks[i];
        const vis = i < shown;
        p.mesh.visible = vis;
        if (!vis) continue;
        if (b.broken) {
          p.mesh.position.set(p.mesh.position.x, 0.17, 0.32 + i * 0.36);
          p.mesh.rotation.set(0.02, (i % 2) * 0.12, i % 2 === 0 ? -0.05 : 0.06);
        } else {
          p.mesh.position.set(p.mesh.position.x, p.y, p.z);
          p.mesh.rotation.set(0, 0, 0);
        }
      }
      for (let i = 0; i < b.braces.length; i++) {
        b.braces[i].visible = !b.broken && frac > 0.18;
      }
      if (b.tape) b.tape.visible = !b.broken && frac > 0.4;
      for (let i = 0; i < b.debris.length; i++) b.debris[i].visible = !!b.broken;
      if (b.lampMat) {
        b.lampMat.emissive.setHex(b.blocked ? 0xff2a18 : 0x2eff7a);
        b.lampMat.emissiveIntensity = 2.4;
      }
    }

    damageBarricade(id, amount) {
      const b = this._barricadesById[id];
      if (!b || b.broken) return false;
      const dmg = Math.max(0, amount || 0);
      if (dmg <= 0) return false;
      b.health = Math.max(0, b.health - dmg);
      if (b.health <= 0) {
        b.broken = true;
        this.setBarricadeBlocked(id, false);
        this.updateBarricadeVisual(id);
        return true;
      }
      this.updateBarricadeVisual(id);
      return false;
    }

    repairBarricade(id, amount) {
      const b = this._barricadesById[id];
      if (!b) return false;
      const amt = Math.max(0, amount || 0);
      if (b.health >= b.maxHealth && !b.broken) return false;
      const before = b.health;
      const wasBroken = b.broken;
      b.health = Math.min(b.maxHealth, b.health + amt);
      if (b.health > 0 && b.broken) {
        b.broken = false;
        this.setBarricadeBlocked(id, true);
      }
      this.updateBarricadeVisual(id);
      return b.health > before || (wasBroken && !b.broken);
    }

    /* ---------------- collision query ---------------- */
    isBlocked(x, z, r) {
      r = r == null ? 0.35 : r;
      for (let i = 0; i < this.barricades.length; i++) {
        const b = this.barricades[i];
        if (!b.blocked) continue;
        const c = b.collider;
        if (x + r > c.minX && x - r < c.maxX && z + r > c.minZ && z - r < c.maxZ) return true;
      }
      if (this.nav.isBlockedWorld(x, z)) return true;
      const arr = this.colliders;
      for (let i = 0; i < arr.length; i++) {
        const c = arr[i];
        if (x + r > c.minX && x - r < c.maxX && z + r > c.minZ && z - r < c.maxZ) return true;
      }
      return false;
    }

    /* ---------------- atmosphere ---------------- */
    setTimeOfDay(mode, opts) {
      mode = mode === "day" ? "day" : "night";
      const changed = this.timeOfDay !== mode;
      this.timeOfDay = mode;
      this._day = mode === "day";
      const day = this._day;
      opts = opts || {};
      const u = this._skyUniforms;

      const pal = day
        ? {
            zenith: 0x527489, horizon: 0xc2ccca, ground: 0x252d2e,
            glow: 0xc79662, cloud: 0x9cabb2,
            sunColor: 0xffedc8, star: 0, disc: 2.15, halo: 1.2,
            dir: [-0.46, 0.64, -0.62],
            sunLight: 0xffd9a8, sunBase: 3.3,
            hemiSky: 0xb2cfdf, hemiGround: 0x4a4234, hemiBase: 1.02,
            amb: 0x8fa6b4, ambBase: 0.48,
            fill: 0x7fa3be, fillBase: 0.34,
            fog: 0x9fb1b7, fogDensity: 0.009,
            rain: 0.5, flood: 0.06,
          }
        : {
            zenith: 0x060b12, horizon: 0x1b303b, ground: 0x04070a,
            glow: 0x46331b, cloud: 0x0b131b,
            sunColor: 0xcfdff5, star: 1, disc: 2.2, halo: 1,
            dir: [-0.48, 0.52, -0.7],
            sunLight: 0xb6d2ea, sunBase: 1.45,
            hemiSky: 0x36536b, hemiGround: 0x16130f, hemiBase: 0.5,
            amb: 0x22303c, ambBase: 0.44,
            fill: 0x2c4256, fillBase: 0.28,
            fog: 0x0a1418, fogDensity: 0.0185,
            rain: 1, flood: 1,
          };

      if (u) {
        u.uZenith.value.setHex(pal.zenith);
        u.uHorizon.value.setHex(pal.horizon);
        u.uGround.value.setHex(pal.ground);
        u.uGlow.value.setHex(pal.glow);
        u.uCloudCol.value.setHex(pal.cloud);
        u.uStarStrength.value = pal.star;
        u.uDiscStrength.value = pal.disc;
        u.uHaloStrength.value = pal.halo;
        u.uMoonDir.value.set(pal.dir[0], pal.dir[1], pal.dir[2]).normalize();
        u.uMoonColor.value.setHex(pal.sunColor);
        if (day) u.uMoonColor.value.multiplyScalar(2.1);
      }
      if (this._moon) {
        this._moon.color.setHex(pal.sunLight);
        this._moonBase = pal.sunBase;
        this._moon.position.copy(this._skyUniforms.uMoonDir.value).multiplyScalar(110);
        this._moon.target.position.set(0, 0, 0);
        this._moon.intensity = pal.sunBase;
      }
      if (this._hemi) {
        this._hemi.color.setHex(pal.hemiSky);
        this._hemi.groundColor.setHex(pal.hemiGround);
        this._hemiBase = pal.hemiBase;
        this._hemi.intensity = pal.hemiBase;
      }
      if (this._ambient) {
        this._ambient.color.setHex(pal.amb);
        this._ambientBase = pal.ambBase;
        this._ambient.intensity = pal.ambBase;
      }
      if (this._fill) {
        this._fill.color.setHex(pal.fill);
        this._fillBase = pal.fillBase;
        this._fill.intensity = pal.fillBase;
      }
      this._baseFogColor.setHex(pal.fog);
      if (this._fog) {
        this._fog.color.copy(this._baseFogColor);
        this._fog.density = pal.fogDensity;
      }
      this._floodlightScale = pal.flood;
      this._flash = 0;
      this._flashQueue = 0;
      this._lightningTimer = day ? 9999 : 8 + Math.random() * 10;
      if (this._bolt) this._bolt.visible = false;
      if (this._rainMat) this._rainMat.uniforms.uOpacity.value = pal.rain;

      // Distant ridge color bands need a separate palette per time of day.
      if (this._ridge) {
        for (let i = 0; i < this._ridge.length; i++) {
          const m = this._ridge[i];
          const src = day ? m.userData.dayColors : m.userData.nightColors;
          if (src && m.geometry && m.geometry.attributes.color) {
            m.geometry.attributes.color.array.set(src);
            m.geometry.attributes.color.needsUpdate = true;
          }
        }
      }

      // Rebuild the procedural sky environment probe so metals/wet surfaces
      // reflect the current sky instead of last night's darkness.
      if (changed && opts.refreshEnv !== false && this._builtChildren && this.quality.level !== "low" && this.renderer) {
        if (this._envRT) {
          this._envRT.dispose();
          this._envRT = null;
          this.scene.environment = null;
        }
        try { B.env(this); } catch (err) { /* keep the previous environment */ }
      }
      return this;
    }

    triggerLightning() {
      if (this._disposed) return;
      if (this._day) return;
      this._flash = 1;
      this._flashQueue = 1;
      this._lightningTimer = 10 + Math.random() * 20;

      const bolt = this._bolt;
      const az = Math.random() * TAU;
      const dist = 120 + Math.random() * 70;
      if (bolt && this._boltGeo) {
        const cx = Math.cos(az) * dist;
        const cz = Math.sin(az) * dist;
        const arr = this._boltGeo.attributes.position.array;
        const maxSegs = this._boltSegs || 40;
        let seg = 0;
        const main = [];
        let px = cx, py = 102, pz = cz;
        main.push([px, py, pz]);
        const steps = 20;
        for (let i = 0; i < steps; i++) {
          px += (Math.random() - 0.5) * 11;
          py -= 3.4 + Math.random() * 2.4;
          pz += (Math.random() - 0.5) * 11;
          main.push([px, py, pz]);
        }
        const pushSeg = function (a, b) {
          if (seg >= maxSegs) return;
          const o = seg * 6;
          arr[o] = a[0]; arr[o + 1] = a[1]; arr[o + 2] = a[2];
          arr[o + 3] = b[0]; arr[o + 4] = b[1]; arr[o + 5] = b[2];
          seg++;
        };
        for (let i = 0; i < main.length - 1; i++) pushSeg(main[i], main[i + 1]);
        // two branches
        for (let br = 0; br < 2; br++) {
          const idx = 5 + ((Math.random() * 9) | 0);
          let bx = main[idx][0], by = main[idx][1], bz = main[idx][2];
          const dirx = (Math.random() - 0.5) * 9;
          const dirz = (Math.random() - 0.5) * 9;
          for (let i = 0; i < 4; i++) {
            const nx = bx + dirx * (0.5 + Math.random() * 0.7);
            const ny = by - 2.2 - Math.random() * 2;
            const nz = bz + dirz * (0.5 + Math.random() * 0.7);
            pushSeg([bx, by, bz], [nx, ny, nz]);
            bx = nx; by = ny; bz = nz;
          }
        }
        this._boltGeo.setDrawRange(0, seg * 2);
        this._boltGeo.attributes.position.needsUpdate = true;
        bolt.visible = true;
      }

      const proximity = DL.clamp(1 - dist / 260, 0.15, 1);
      if (typeof this.onLightning === "function") {
        try {
          this.onLightning(proximity);
        } catch (err) {
          /* callbacks are owned by main */
        }
      }
    }

    /* ---------------- per-frame update ---------------- */
    update(dt, elapsed, playerPos) {
      if (this._disposed || !this._skyUniforms) return;
      if (dt == null) dt = 0.016;
      if (dt > 0.1) dt = 0.1;
      this._time += dt;
      const t = this._time;
      const px = playerPos ? playerPos.x : 0;
      const py = playerPos ? playerPos.y : 1.7;
      const pz = playerPos ? playerPos.z : 0;

      /* lightning schedule + flash envelope */
      if (!this._day) {
        this._lightningTimer -= dt;
        if (this._lightningTimer <= 0) this.triggerLightning();
      }
      if (this._flashQueue > 0 && this._flash < 0.45) {
        this._flash = 0.74;
        this._flashQueue--;
      }
      this._flash *= Math.exp(-dt * 5.4);
      if (this._flash < 0.002) this._flash = 0;
      const f = this._flash;

      if (this._ambient) this._ambient.intensity = this._ambientBase + f * 1.9;
      if (this._hemi) this._hemi.intensity = this._hemiBase + f * 1.15;
      if (this._moon) this._moon.intensity = this._moonBase * (1 + f * 1.5);
      this._skyUniforms.uFlash.value = f * 1.3;
      this._skyUniforms.uTime.value = t;
      if (this._fill) this._fill.intensity = (this._fillBase == null ? 0.28 : this._fillBase) + f * 0.5;

      if (f > 0 && this._fog) {
        this._fogColorTmp.copy(this._baseFogColor).lerp(this._flashFogColor, f * 0.55);
        this._fog.color.copy(this._fogColorTmp);
      } else if (this._fog) {
        this._fog.color.copy(this._baseFogColor);
      }

      if (this._bolt) {
        const vis = f > 0.06;
        this._bolt.visible = vis;
        if (vis) this._bolt.material.opacity = Math.min(1, f * 1.5);
      }

      /* weather uniforms */
      if (this._rainMat) {
        this._rainMat.uniforms.uTime.value = t;
        this._rainMat.uniforms.uCenter.value.set(px, py, pz);
      }
      if (this._mistMat) {
        this._mistMat.uniforms.uTime.value = t;
        this._mistMat.uniforms.uCenter.value.set(px, 0, pz);
      }
      if (this._dustMat) {
        this._dustMat.uniforms.uTime.value = t;
        this._dustMat.uniforms.uCenter.value.set(px, py, pz);
      }
      if (this._glowMat) this._glowMat.uniforms.uTime.value = t;
      for (let i = 0; i < this._emitters.length; i++) {
        const e = this._emitters[i];
        e.mat.uniforms.uTime.value = t + e.offset;
      }
      for (let i = 0; i < this._mistSheets.length; i++) {
        const s = this._mistSheets[i];
        s.mesh.rotation.y = t * s.speed + s.phase;
        s.mesh.position.y = s.baseY + Math.sin(t * 0.09 + s.phase) * 0.12;
      }
      if (this.T && this.T.rippleN) {
        this.T.rippleN.offset.x = Math.sin(t * 0.12) * 0.025;
        this.T.rippleN.offset.y = t * 0.024;
      }

      /* floodlight flicker */
      for (let i = 0; i < this._floodlights.length; i++) {
        const fl = this._floodlights[i];
        const n = DL.noise2(t * 1.7 + fl.phase * 9.1, fl.phase * 4.2);
        let mul = 0.87 + n * 0.11;
        if (Math.sin(t * 3.1 + fl.phase * 7.3) > 0.994) mul *= 0.35 + Math.random() * 0.3;
        fl.light.intensity = fl.baseIntensity * mul * this._floodlightScale;
        if (fl.coneMat) fl.coneMat.uniforms.uOpacity.value = fl.baseOpacity * (0.45 + mul * 0.6) * this._floodlightScale;
      }
      if (this._floodlightLensMat) {
        this._floodlightLensMat.emissiveIntensity = (2.3 + 0.35 * Math.sin(t * 8.7) + f * 2.5) * (this._day ? 0.35 : 1);
      }

      /* burning barrels */
      for (let i = 0; i < this._barrelLights.length; i++) {
        const bl = this._barrelLights[i];
        const n = DL.noise2(t * 6.5 + bl.phase * 11.3, bl.phase * 5.1);
        let target = bl.base * (0.75 + n * 0.32 + Math.random() * 0.06);
        if (f > 0.1) target += 0;
        bl.light.intensity = DL.damp(bl.light.intensity, target, 16, dt);
      }

      /* generator state */
      const gen = this.generator;
      const gs = this._gen;
      if (gen && gs) {
        const hf = gen.maxHealth > 0 ? DL.clamp(gen.health / gen.maxHealth, 0, 1) : 0;
        gs.sparkAge += dt;
        gs.sparkMat.uniforms.uAge.value = gs.sparkAge;
        gs.sparkMat.uniforms.uActive.value = gs.sparkAge < 1.2 ? 1 : 0;
        gs.flash = Math.max(0, gs.flash - dt * 4.2);
        const pulse = 0.86 + 0.14 * Math.sin(t * 2.3);
        gs.bodyMat.emissiveIntensity = gen.broken ? 0.05 : (0.16 + hf * 0.42) * pulse;
        if (gen.broken) {
          gs.light.color.setHex(0xff3b1c);
          const targetL = gs.flash > 0.25 ? 52 : 3.2 + Math.sin(t * 8.3) * 1.6 + Math.random() * 1.2;
          gs.light.intensity = DL.damp(gs.light.intensity, targetL, 8, dt);
          gs.stripMat.emissive.setHex(0xff2a18);
          gs.stripMat.emissiveIntensity = 0.45 + 0.35 * Math.abs(Math.sin(t * 7.0));
          gs.screenMat.emissiveIntensity = 0.2 + 0.6 * Math.max(0, Math.sin(t * 9.0));
          gs.beaconMat.emissiveIntensity = 0.15;
          gs.mastBeaconMat.emissiveIntensity = 0.2;
        } else {
          gs.light.color.setHex(0x62f0dc);
          gs.light.intensity = gs.lightBase * pulse * (0.93 + 0.07 * Math.sin(t * 7.1)) + gs.flash * 48;
          gs.stripMat.emissive.setHex(0x46ffe2);
          gs.stripMat.emissiveIntensity = 1.35 + 0.45 * Math.sin(t * 2.6) + gs.flash * 2.6;
          gs.screenMat.emissiveIntensity = 1.75 + 0.3 * Math.sin(t * 3.4);
          gs.beaconMat.emissiveIntensity = Math.sin(t * 3.6) > 0 ? 2.6 : 0.22;
          gs.mastBeaconMat.emissiveIntensity = Math.sin(t * 1.35 + 1.0) > 0.15 ? 2.3 : 0.35;
        }
        if (gs.smoke) {
          const u = gs.smoke.mat.uniforms.uActive;
          u.value = DL.damp(u.value, gs.smokeOn, 1.4, dt);
        }
      }

      /* beacons on tower/radio/bunker pulse through shared materials */
      if (this.M) {
        const bev = this.M.beaconRed;
        if (bev) bev.emissiveIntensity = 1.4 + 2.2 * Math.max(0, Math.sin(t * 2.2 + 0.7));
        const bam = this.M.beaconAmber;
        if (bam) bam.emissiveIntensity = 1.6 + 1.0 * Math.max(0, Math.sin(t * 2.6 + 1.4));
      }
    }

    /* ---------------- teardown ---------------- */
    dispose() {
      if (this._disposed) return;
      this._disposed = true;
      const built = this._builtChildren || [];
      for (let i = 0; i < built.length; i++) {
        const obj = built[i];
        if (obj.parent) obj.parent.remove(obj);
        DL.disposeObject(obj);
      }
      // dispose root groups not directly in scene (defensive)
      for (let i = 0; i < this._roots.length; i++) {
        const obj = this._roots[i];
        if (obj && obj.parent) obj.parent.remove(obj);
      }
      if (this._envRT) {
        this._envRT.dispose();
        this._envRT = null;
      }
      if (this.scene.environment) this.scene.environment = null;
      if (this.scene.fog && this._fog && this.scene.fog === this._fog) this.scene.fog = null;
      this.colliders.length = 0;
      this._staticColliders.length = 0;
      this.raycastMeshes.length = 0;
      this.barricades.length = 0;
      this.spawnPoints.length = 0;
      this.pickupSpawns.length = 0;
      this._glows.length = 0;
      this._emitters.length = 0;
      this._roots.length = 0;
      this._floodlights.length = 0;
      this._barrelLights.length = 0;
      this._mistSheets.length = 0;
      this._bagSpots.length = 0;
      this.generator = null;
      this._gen = null;
      this._skyUniforms = null;
    }
  }

  DL.World = World;

  /*__APPEND__*/
})();
