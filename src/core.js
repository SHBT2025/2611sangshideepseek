/* ============================================================
   DEADLIGHT // shared procedural utilities
   Classic script. Depends only on global THREE.
   ============================================================ */
(function () {
  "use strict";
  const DL = (window.DL = window.DL || {});
  const PI = Math.PI, TAU = PI * 2;

  DL.PI = PI;
  DL.TAU = TAU;
  DL.clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  DL.lerp = (a, b, t) => a + (b - a) * t;
  DL.invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
  DL.smoothstep = (a, b, x) => {
    x = DL.clamp((x - a) / (b - a), 0, 1);
    return x * x * (3 - 2 * x);
  };
  DL.damp = (a, b, lambda, dt) => DL.lerp(a, b, 1 - Math.exp(-lambda * dt));
  DL.dampVec = (v, target, lambda, dt) => {
    const t = 1 - Math.exp(-lambda * dt);
    v.x += (target.x - v.x) * t;
    v.y += (target.y - v.y) * t;
    v.z += (target.z - v.z) * t;
    return v;
  };
  DL.rand = (a = 0, b = 1) => a + Math.random() * (b - a);
  DL.randi = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
  DL.chance = (p) => Math.random() < p;
  DL.choice = (arr) => arr[(Math.random() * arr.length) | 0];
  DL.sign = (v) => (v < 0 ? -1 : 1);
  DL.mod = (a, n) => ((a % n) + n) % n;
  DL.easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  DL.easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  DL.easeOutBack = (t) => {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  };

  DL.mulberry32 = function (seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  DL.hash2 = function (x, y) {
    let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
  function vnoise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = DL.hash2(xi, yi), b = DL.hash2(xi + 1, yi);
    const c = DL.hash2(xi, yi + 1), d = DL.hash2(xi + 1, yi + 1);
    return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1;
  }
  DL.noise2 = vnoise;
  DL.fbm2 = function (x, y, octaves = 4, lac = 2, gain = 0.5) {
    let amp = 0.5, freq = 1, sum = 0, norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += vnoise(x * freq, y * freq) * amp;
      norm += amp;
      amp *= gain;
      freq *= lac;
    }
    return sum / norm;
  };
  DL.ridged2 = function (x, y, octaves = 3) {
    let amp = 0.5, freq = 1, sum = 0, norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += (1 - Math.abs(vnoise(x * freq, y * freq))) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2.1;
    }
    return sum / norm;
  };

  DL.makeCanvas = function (w, h) {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    return { canvas, ctx: canvas.getContext("2d", { willReadFrequently: true }) };
  };

  DL.canvasTexture = function (canvas, rx = 1, ry = 1, srgb = true) {
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(rx, ry);
    t.anisotropy = 4;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };

  /* Generic noisy surface. opts: base rgb array, variance, grain, streak, seed */
  DL.noiseTexture = function (w, h, opts = {}) {
    const { canvas, ctx } = DL.makeCanvas(w, h);
    const img = ctx.createImageData(w, h);
    const base = opts.base || [120, 120, 120];
    const variance = opts.variance == null ? 30 : opts.variance;
    const grain = opts.grain == null ? 18 : opts.grain;
    const scale = opts.scale || 8;
    const seed = opts.seed || 1;
    const streak = opts.streak || 0;
    const d = img.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const n =
          DL.fbm2((x / w) * scale + seed * 7.13, (y / h) * scale + seed * 3.71, 5) * 0.65 +
          DL.noise2(x * 0.11 + seed, y * 0.11) * 0.2 +
          (Math.random() - 0.5) * 0.15;
        const st = streak ? (DL.noise2(x * 0.014 + seed, y * 0.13) * streak) : 0;
        const v = n * variance + st;
        d[i] = DL.clamp(base[0] + v + (Math.random() - 0.5) * grain, 0, 255);
        d[i + 1] = DL.clamp(base[1] + v + (Math.random() - 0.5) * grain, 0, 255);
        d[i + 2] = DL.clamp(base[2] + v + (Math.random() - 0.5) * grain, 0, 255);
        d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  };

  /* Build a tangent-space normal map from a grayscale height canvas. */
  DL.normalMapFromHeight = function (srcCanvas, strength = 2.2) {
    const w = srcCanvas.width, h = srcCanvas.height;
    const sctx = srcCanvas.getContext("2d", { willReadFrequently: true });
    const src = sctx.getImageData(0, 0, w, h).data;
    const { canvas, ctx } = DL.makeCanvas(w, h);
    const out = ctx.createImageData(w, h);
    const H = (x, y) => src[((((y + h) % h) * w + ((x + w) % w)) * 4)] / 255;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = (H(x + 1, y) - H(x - 1, y)) * strength;
        const dy = (H(x, y + 1) - H(x, y - 1)) * strength;
        let nx = -dx, ny = -dy, nz = 1;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        nx /= len; ny /= len; nz /= len;
        const i = (y * w + x) * 4;
        out.data[i] = (nx * 0.5 + 0.5) * 255;
        out.data[i + 1] = (ny * 0.5 + 0.5) * 255;
        out.data[i + 2] = (nz * 0.5 + 0.5) * 255;
        out.data[i + 3] = 255;
      }
    }
    ctx.putImageData(out, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    return tex;
  };

  DL.makeRadialSprite = function (size = 128, stops = [[0, "rgba(255,255,255,1)"], [1, "rgba(255,255,255,0)"]]) {
    const { canvas, ctx } = DL.makeCanvas(size, size);
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    stops.forEach((s) => g.addColorStop(s[0], s[1]));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };

  DL.makeGlowTexture = function (size = 256, color = "180,220,255") {
    return DL.makeRadialSprite(size, [
      [0, `rgba(${color},0.95)`],
      [0.25, `rgba(${color},0.45)`],
      [0.55, `rgba(${color},0.12)`],
      [1, `rgba(${color},0)`],
    ]);
  };

  DL.disposeObject = function (obj) {
    if (!obj) return;
    obj.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => {
          if (m.map) m.map.dispose();
          if (m.normalMap) m.normalMap.dispose();
          if (m.roughnessMap) m.roughnessMap.dispose();
          if (m.metalnessMap) m.metalnessMap.dispose();
          if (m.emissiveMap) m.emissiveMap.dispose();
          if (m.alphaMap) m.alphaMap.dispose();
          m.dispose();
        });
      }
    });
  };

  DL.makeBox = function (w, h, d, mat, x = 0, y = 0, z = 0) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    return m;
  };

  DL.shadow = function (obj, cast = true, receive = true) {
    obj.castShadow = cast;
    obj.receiveShadow = receive;
    return obj;
  };

  DL.collideCircleAABB = function (x, z, r, b, out) {
    const nx = DL.clamp(x, b.minX, b.maxX);
    const nz = DL.clamp(z, b.minZ, b.maxZ);
    let dx = x - nx, dz = z - nz;
    const d2 = dx * dx + dz * dz;
    let hit = false;
    if (d2 < r * r) {
      hit = true;
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2), push = r - d;
        x += (dx / d) * push;
        z += (dz / d) * push;
      } else {
        const l = x - b.minX, rr = b.maxX - x, t = z - b.minZ, bb = b.maxZ - z;
        const m = Math.min(l, rr, t, bb);
        if (m === l) x = b.minX - r;
        else if (m === rr) x = b.maxX + r;
        else if (m === t) z = b.minZ - r;
        else z = b.maxZ + r;
      }
    }
    if (out) { out.x = x; out.z = z; out.hit = hit; return out; }
    return { x, z, hit };
  };

  DL.segmentAABB = function (x0, z0, x1, z1, b) {
    let tmin = 0, tmax = 1;
    const dx = x1 - x0, dz = z1 - z0;
    if (Math.abs(dx) < 1e-8) {
      if (x0 < b.minX || x0 > b.maxX) return false;
    } else {
      let t1 = (b.minX - x0) / dx, t2 = (b.maxX - x0) / dx;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
      if (tmin > tmax) return false;
    }
    if (Math.abs(dz) < 1e-8) {
      if (z0 < b.minZ || z0 > b.maxZ) return false;
    } else {
      let t1 = (b.minZ - z0) / dz, t2 = (b.maxZ - z0) / dz;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
      if (tmin > tmax) return false;
    }
    return true;
  };

  DL.Quality = {
    high: { level: "high", pixelRatio: 1.35, shadowMapSize: 2048, bloom: true, rainCount: 2400, treeCount: 260, grassCount: 1800, spotlightShadows: 2 },
    medium: { level: "medium", pixelRatio: 1.0, shadowMapSize: 1024, bloom: true, rainCount: 1600, treeCount: 200, grassCount: 1200, spotlightShadows: 1 },
    low: { level: "low", pixelRatio: 0.8, shadowMapSize: 512, bloom: false, rainCount: 900, treeCount: 140, grassCount: 700, spotlightShadows: 0 },
  };

  /* ---------------- Nav grid + A* ----------------
     Static obstacles block permanently; dynamic blockers are used by barricades.
     Cell size 1.25 m over an 80x80 m playable area by default. */
  class NavGrid {
    constructor(o) {
      this.minX = o.minX != null ? o.minX : -55;
      this.maxX = o.maxX != null ? o.maxX : 55;
      this.minZ = o.minZ != null ? o.minZ : -55;
      this.maxZ = o.maxZ != null ? o.maxZ : 55;
      this.cell = o.cell || 1.25;
      this.cols = Math.ceil((this.maxX - this.minX) / this.cell);
      this.rows = Math.ceil((this.maxZ - this.minZ) / this.cell);
      const n = this.cols * this.rows;
      this.static = new Uint8Array(n);
      this.dynamic = new Uint8Array(n);
      this._g = new Float32Array(n);
      this._f = new Float32Array(n);
      this._from = new Int32Array(n);
      this._seen = new Uint32Array(n);
      this._closed = new Uint32Array(n);
      this._stamp = 1;
      this._heap = [];
    }
    idx(ix, iz) { return iz * this.cols + ix; }
    cellIndexWorld(x, z) {
      const ix = Math.floor((x - this.minX) / this.cell);
      const iz = Math.floor((z - this.minZ) / this.cell);
      if (ix < 0 || iz < 0 || ix >= this.cols || iz >= this.rows) return -1;
      return iz * this.cols + ix;
    }
    worldOf(idx) {
      const ix = idx % this.cols, iz = (idx / this.cols) | 0;
      return { x: this.minX + (ix + 0.5) * this.cell, z: this.minZ + (iz + 0.5) * this.cell };
    }
    inBounds(x, z) { return x >= this.minX && x < this.maxX && z >= this.minZ && z < this.maxZ; }
    blockWorldBox(minX, maxX, minZ, maxZ, dynamic = false) {
      const arr = dynamic ? this.dynamic : this.static;
      const x0 = DL.clamp(Math.floor((minX - this.minX) / this.cell), 0, this.cols - 1);
      const x1 = DL.clamp(Math.floor((maxX - this.minX) / this.cell), 0, this.cols - 1);
      const z0 = DL.clamp(Math.floor((minZ - this.minZ) / this.cell), 0, this.rows - 1);
      const z1 = DL.clamp(Math.floor((maxZ - this.minZ) / this.cell), 0, this.rows - 1);
      for (let iz = z0; iz <= z1; iz++) for (let ix = x0; ix <= x1; ix++) arr[this.idx(ix, iz)] = 1;
    }
    blockWorldCircle(x, z, r, dynamic = false) {
      this.blockWorldBox(x - r, x + r, z - r, z + r, dynamic);
    }
    clearDynamic() { this.dynamic.fill(0); }
    blockedAt(ix, iz) {
      if (ix < 0 || iz < 0 || ix >= this.cols || iz >= this.rows) return true;
      const i = this.idx(ix, iz);
      return this.static[i] === 1 || this.dynamic[i] === 1;
    }
    isBlockedWorld(x, z) {
      const ix = Math.floor((x - this.minX) / this.cell), iz = Math.floor((z - this.minZ) / this.cell);
      return this.blockedAt(ix, iz);
    }
    nearestOpen(x, z, maxRadius = 16) {
      let cx = Math.floor((x - this.minX) / this.cell), cz = Math.floor((z - this.minZ) / this.cell);
      cx = DL.clamp(cx, 0, this.cols - 1); cz = DL.clamp(cz, 0, this.rows - 1);
      if (!this.blockedAt(cx, cz)) return { x: this.minX + (cx + 0.5) * this.cell, z: this.minZ + (cz + 0.5) * this.cell };
      for (let r = 1; r <= maxRadius; r++) {
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
            const ix = cx + dx, iz = cz + dz;
            if (!this.blockedAt(ix, iz)) return { x: this.minX + (ix + 0.5) * this.cell, z: this.minZ + (iz + 0.5) * this.cell };
          }
        }
      }
      return null;
    }
    hasLine(x0, z0, x1, z1) {
      const dx = x1 - x0, dz = z1 - z0;
      const dist = Math.hypot(dx, dz);
      const steps = Math.ceil(dist / (this.cell * 0.5));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = x0 + dx * t, z = z0 + dz * t;
        if (this.isBlockedWorld(x, z)) return false;
      }
      return true;
    }
    findPath(from, to, maxNodes = 9000) {
      if (!from || !to) return null;
      let start = this.nearestOpen(from.x, from.z, 4);
      let goal = this.nearestOpen(to.x, to.z, 6);
      if (!start || !goal) return null;
      const sx = Math.floor((start.x - this.minX) / this.cell), sz = Math.floor((start.z - this.minZ) / this.cell);
      const gx = Math.floor((goal.x - this.minX) / this.cell), gz = Math.floor((goal.z - this.minZ) / this.cell);
      const startI = this.idx(sx, sz), goalI = this.idx(gx, gz);
      if (startI === goalI) return [new THREE.Vector3(goal.x, 0, goal.z)];
      const stamp = ++this._stamp;
      const g = this._g, f = this._f, fromArr = this._from, seen = this._seen, closed = this._closed;
      const heap = this._heap;
      heap.length = 0;
      const h = (ix, iz) => {
        const dx = Math.abs(ix - gx), dz = Math.abs(iz - gz);
        return (dx + dz) * 0.98 + (Math.SQRT2 - 2) * Math.min(dx, dz) * this.cell;
      };
      const push = (i, score) => {
        heap.push({ i, f: score });
        let c = heap.length - 1;
        while (c > 0) {
          const p = (c - 1) >> 1;
          if (heap[p].f <= heap[c].f) break;
          const t = heap[p]; heap[p] = heap[c]; heap[c] = t; c = p;
        }
      };
      const pop = () => {
        const top = heap[0], last = heap.pop();
        if (heap.length) {
          heap[0] = last;
          let c = 0;
          for (;;) {
            let l = c * 2 + 1, r = l + 1, m = c;
            if (l < heap.length && heap[l].f < heap[m].f) m = l;
            if (r < heap.length && heap[r].f < heap[m].f) m = r;
            if (m === c) break;
            const t = heap[m]; heap[m] = heap[c]; heap[c] = t; c = m;
          }
        }
        return top;
      };
      seen[startI] = stamp;
      g[startI] = 0;
      f[startI] = h(sx, sz);
      fromArr[startI] = -1;
      push(startI, f[startI]);
      let expanded = 0, found = false;
      const nbr = [
        [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
        [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
      ];
      while (heap.length && expanded < maxNodes) {
        const cur = pop();
        const ci = cur.i;
        if (closed[ci] === stamp) continue;
        closed[ci] = stamp;
        if (ci === goalI) { found = true; break; }
        expanded++;
        const cx = ci % this.cols, cz = (ci / this.cols) | 0;
        for (let k = 0; k < 8; k++) {
          const nx = cx + nbr[k][0], nz = cz + nbr[k][1];
          if (this.blockedAt(nx, nz)) continue;
          if (k >= 4) {
            if (this.blockedAt(cx + nbr[k][0], cz) || this.blockedAt(cx, cz + nbr[k][1])) continue;
          }
          const ni = this.idx(nx, nz);
          if (closed[ni] === stamp) continue;
          const ng = g[ci] + nbr[k][2] * this.cell;
          if (seen[ni] !== stamp || ng < g[ni]) {
            seen[ni] = stamp;
            g[ni] = ng;
            f[ni] = ng + h(nx, nz);
            fromArr[ni] = ci;
            push(ni, f[ni]);
          }
        }
      }
      if (!found) return null;
      const raw = [];
      let cur = goalI;
      while (cur !== -1 && raw.length < 3000) {
        raw.push(cur);
        cur = fromArr[cur];
      }
      raw.reverse();
      const pts = [new THREE.Vector3(from.x, 0, from.z)];
      const wp = raw.map((i) => this.worldOf(i));
      let anchor = 0;
      for (let i = 1; i < wp.length; i++) {
        const a = wp[anchor], b = wp[i];
        if (i === wp.length - 1 || !this.hasLine(a.x, a.z, b.x, b.z)) {
          if (i > 1 || i === wp.length - 1) pts.push(new THREE.Vector3(b.x, 0, b.z));
          anchor = i;
        }
      }
      if (pts.length > 1) pts[pts.length - 1].set(to.x, 0, to.z);
      return pts;
    }
    randomOpenPoint(rng = Math.random) {
      for (let i = 0; i < 200; i++) {
        const ix = (rng() * this.cols) | 0, iz = (rng() * this.rows) | 0;
        if (!this.blockedAt(ix, iz)) {
          const p = this.worldOf(this.idx(ix, iz));
          return new THREE.Vector3(p.x, 0, p.z);
        }
      }
      return new THREE.Vector3(0, 0, 0);
    }
  }
  DL.NavGrid = NavGrid;

  /* Fire-and-forget one-shot tween helper for UI-ish values. */
  DL.spring = function (state, key, target, stiffness = 120, damping = 14, dt = 0.016) {
    state.v = state.v || {};
    const v = state.v[key] || 0;
    const accel = (target - state[key]) * stiffness - v * damping;
    state.v[key] = v + accel * dt;
    state[key] += state.v[key] * dt;
    return state[key];
  };

  DL.formatTime = function (s) {
    s = Math.max(0, Math.ceil(s));
    const m = Math.floor(s / 60);
    return m + ":" + String(s % 60).padStart(2, "0");
  };

  DL.pointInRect = (x, z, b) => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;
})();
