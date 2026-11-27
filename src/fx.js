/* ============================================================
   DEADLIGHT // pooled combat effects
   ============================================================ */
(function () {
  "use strict";
  const DL = (window.DL = window.DL || {});

  const PARTICLE_VERT = `
    attribute float aSize;
    attribute float aAlpha;
    attribute vec3 aColor;
    varying float vAlpha;
    varying vec3 vColor;
    void main(){
      vAlpha = aAlpha;
      vColor = aColor;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = aSize * (340.0 / max(0.3, -mv.z));
      gl_Position = projectionMatrix * mv;
    }
  `;
  const PARTICLE_FRAG = `
    varying float vAlpha;
    varying vec3 vColor;
    uniform float softness;
    void main(){
      vec2 p = gl_PointCoord - 0.5;
      float d = length(p);
      if(d > 0.5) discard;
      float a = smoothstep(0.5, 0.5 - softness, d) * vAlpha;
      gl_FragColor = vec4(vColor, a);
    }
  `;

  class ParticlePool {
    constructor(scene, max, o) {
      this.max = max;
      this.gravity = o.gravity != null ? o.gravity : -9.8;
      this.drag = o.drag != null ? o.drag : 1.4;
      this.blending = o.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
      this.softness = o.softness != null ? o.softness : 0.32;
      this.count = 0;
      this.cursor = 0;
      this.particles = new Array(max);
      for (let i = 0; i < max; i++) {
        this.particles[i] = {
          alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
          life: 0, maxLife: 1, size: 1, size0: 1, size1: 0, alpha: 1, r: 1, g: 1, b: 1,
          bounce: 0, floor: 0,
        };
      }
      this.positions = new Float32Array(max * 3);
      this.colors = new Float32Array(max * 3);
      this.sizes = new Float32Array(max);
      this.alphas = new Float32Array(max);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
      geo.setAttribute("aColor", new THREE.BufferAttribute(this.colors, 3));
      geo.setAttribute("aSize", new THREE.BufferAttribute(this.sizes, 1));
      geo.setAttribute("aAlpha", new THREE.BufferAttribute(this.alphas, 1));
      geo.setDrawRange(0, 0);
      this.geometry = geo;
      this.material = new THREE.ShaderMaterial({
        uniforms: { softness: { value: this.softness } },
        vertexShader: PARTICLE_VERT,
        fragmentShader: PARTICLE_FRAG,
        transparent: true,
        depthWrite: false,
        blending: this.blending,
      });
      this.points = new THREE.Points(geo, this.material);
      this.points.frustumCulled = false;
      this.points.renderOrder = 6;
      scene.add(this.points);
    }
    emit(o) {
      const p = this.particles[this.cursor];
      this.cursor = (this.cursor + 1) % this.max;
      p.alive = true;
      p.x = o.x; p.y = o.y; p.z = o.z;
      p.vx = o.vx; p.vy = o.vy; p.vz = o.vz;
      p.life = 0;
      p.maxLife = o.life;
      p.size0 = o.size;
      p.size1 = o.size1 != null ? o.size1 : o.size * 0.2;
      p.size = o.size;
      p.r = o.r; p.g = o.g; p.b = o.b;
      p.floor = o.floor != null ? o.floor : 0.02;
      p.bounce = o.bounce || 0;
      p.alpha = o.alpha != null ? o.alpha : 1;
      return p;
    }
    update(dt) {
      const pos = this.positions, col = this.colors, siz = this.sizes, alp = this.alphas;
      let n = 0;
      for (let i = 0; i < this.max; i++) {
        const p = this.particles[i];
        if (!p.alive) continue;
        p.life += dt;
        if (p.life >= p.maxLife) { p.alive = false; continue; }
        const t = p.life / p.maxLife;
        p.vy += this.gravity * dt;
        const drag = Math.exp(-this.drag * dt);
        p.vx *= drag; p.vz *= drag; p.vy *= drag;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        if (p.y < p.floor) {
          p.y = p.floor;
          p.vy = Math.abs(p.vy) * p.bounce;
          p.vx *= 0.6; p.vz *= 0.6;
        }
        const k = n * 3;
        pos[k] = p.x; pos[k + 1] = p.y; pos[k + 2] = p.z;
        const flick = p.bounce > 0 ? 0.75 + Math.random() * 0.5 : 1;
        col[k] = p.r * flick; col[k + 1] = p.g * flick; col[k + 2] = p.b * flick;
        siz[n] = p.size0 + (p.size1 - p.size0) * t;
        alp[n] = p.alpha * (1 - t * t);
        n++;
      }
      this.count = n;
      this.geometry.setDrawRange(0, n);
      this.geometry.attributes.position.needsUpdate = true;
      this.geometry.attributes.aColor.needsUpdate = true;
      this.geometry.attributes.aSize.needsUpdate = true;
      this.geometry.attributes.aAlpha.needsUpdate = true;
    }
    clear() { this.particles.forEach((p) => (p.alive = false)); this.count = 0; this.geometry.setDrawRange(0, 0); }
    dispose() { this.geometry.dispose(); this.material.dispose(); this.points.parent && this.points.parent.remove(this.points); }
  }

  class FX {
    constructor(scene, camera, quality, audio) {
      this.scene = scene;
      this.camera = camera;
      this.audio = audio;
      this.quality = quality;
      this.time = 0;
      this.root = new THREE.Group();
      this.root.name = "fx";
      scene.add(this.root);

      this.sparks = new ParticlePool(this.root, quality.level === "low" ? 160 : 360, { additive: true, gravity: -13, drag: 1.6, softness: 0.18 });
      this.bloodPool = new ParticlePool(this.root, quality.level === "low" ? 140 : 300, { additive: false, gravity: -12, drag: 1.2, softness: 0.4 });
      this.smoke = new ParticlePool(this.root, quality.level === "low" ? 50 : 110, { additive: false, gravity: 0.45, drag: 1.1, softness: 0.5 });
      this.embers = new ParticlePool(this.root, 90, { additive: true, gravity: 0.8, drag: 0.7, softness: 0.25 });

      // Point light pool for muzzle/impact flashes.
      this.lights = [];
      for (let i = 0; i < 3; i++) {
        const l = new THREE.PointLight(0xffb066, 0, 14, 2);
        l.castShadow = false;
        this.root.add(l);
        this.lights.push({ light: l, life: 0, max: 0.05, power: 0 });
      }
      this.lightCursor = 0;

      this._makeDecals();
      this._makeTracers();
      this._makeShockwaves();
      this._makeMuzzleSmokeTexture();
    }

    _makeMuzzleSmokeTexture() {
      this.smokeTex = DL.makeRadialSprite(64, [
        [0, "rgba(255,255,255,.65)"],
        [0.45, "rgba(255,255,255,.22)"],
        [1, "rgba(255,255,255,0)"],
      ]);
    }

    _makeDecals() {
      const { canvas, ctx } = DL.makeCanvas(64, 64);
      ctx.clearRect(0, 0, 64, 64);
      const g = ctx.createRadialGradient(32, 32, 1, 32, 32, 20);
      g.addColorStop(0, "rgba(8,7,6,1)");
      g.addColorStop(0.45, "rgba(20,18,15,.85)");
      g.addColorStop(1, "rgba(30,28,25,0)");
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(32, 32, 21, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "rgba(10,9,8,.5)";
      ctx.lineWidth = 1.1;
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2 + Math.random();
        ctx.beginPath();
        ctx.moveTo(32 + Math.cos(a) * 5, 32 + Math.sin(a) * 5);
        ctx.lineTo(32 + Math.cos(a + 0.18) * (13 + Math.random() * 9), 32 + Math.sin(a + 0.18) * (13 + Math.random() * 9));
        ctx.stroke();
      }
      this.decalTex = new THREE.CanvasTexture(canvas);
      this.decalTex.colorSpace = THREE.SRGBColorSpace;
      this.decalMat = new THREE.MeshBasicMaterial({
        map: this.decalTex, transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
        color: 0x9a9488,
      });
      this.decalGeo = new THREE.PlaneGeometry(1, 1);
      this.decals = [];
      for (let i = 0; i < (this.quality.level === "low" ? 18 : 36); i++) {
        const m = new THREE.Mesh(this.decalGeo, this.decalMat.clone());
        m.visible = false;
        m.renderOrder = 1;
        this.root.add(m);
        this.decals.push({ mesh: m, life: 0, max: 20 });
      }
      this.decalCursor = 0;
    }

    _makeTracers() {
      this.tracers = [];
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
      for (let i = 0; i < 20; i++) {
        const mat = new THREE.LineBasicMaterial({
          color: 0xffcf8a, transparent: true, opacity: 0.8,
          blending: THREE.AdditiveBlending, depthWrite: false,
        });
        const line = new THREE.Line(geo.clone(), mat);
        line.visible = false;
        line.frustumCulled = false;
        this.root.add(line);
        this.tracers.push({ line, life: 0, max: 0.06 });
      }
      this.tracerCursor = 0;
    }

    _makeShockwaves() {
      this.waves = [];
      const geo = new THREE.RingGeometry(0.5, 0.65, 42);
      for (let i = 0; i < 4; i++) {
        const mat = new THREE.MeshBasicMaterial({
          color: 0xffb36b, transparent: true, opacity: 0, side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending, depthWrite: false,
        });
        const m = new THREE.Mesh(geo, mat);
        m.rotation.x = -Math.PI / 2;
        m.visible = false;
        this.root.add(m);
        this.waves.push({ mesh: m, life: 0, max: 0.75 });
      }
      this.waveCursor = 0;
    }

    flashLight(pos, color, power, duration) {
      const item = this.lights[this.lightCursor];
      this.lightCursor = (this.lightCursor + 1) % this.lights.length;
      item.light.position.copy(pos);
      item.light.color.setHex(color);
      item.light.intensity = power;
      item.life = 0;
      item.max = duration;
      item.power = power;
    }

    tracer(a, b) {
      const t = this.tracers[this.tracerCursor];
      this.tracerCursor = (this.tracerCursor + 1) % this.tracers.length;
      const arr = t.line.geometry.attributes.position.array;
      arr[0] = a.x; arr[1] = a.y; arr[2] = a.z;
      arr[3] = b.x; arr[4] = b.y; arr[5] = b.z;
      t.line.geometry.attributes.position.needsUpdate = true;
      t.line.visible = true;
      t.life = 0;
      t.line.material.opacity = 0.85;
    }

    decal(point, normal, scale) {
      const d = this.decals[this.decalCursor];
      this.decalCursor = (this.decalCursor + 1) % this.decals.length;
      const m = d.mesh;
      m.visible = true;
      m.position.copy(point).addScaledVector(normal, 0.012);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
      m.quaternion.copy(q);
      m.rotateZ(Math.random() * Math.PI * 2);
      const s = scale || DL.rand(0.09, 0.2);
      m.scale.set(s, s, s);
      d.life = 0;
      d.max = 18;
      m.material.opacity = 0.95;
    }

    impact(point, normal, type) {
      const n = normal || new THREE.Vector3(0, 1, 0);
      const sparks = type === "metal" ? 12 : 6;
      for (let i = 0; i < sparks; i++) {
        this.sparks.emit({
          x: point.x, y: point.y, z: point.z,
          vx: n.x * DL.rand(1, 4) + DL.rand(-1.8, 1.8),
          vy: n.y * DL.rand(1, 4) + DL.rand(0.2, 2.8),
          vz: n.z * DL.rand(1, 4) + DL.rand(-1.8, 1.8),
          life: DL.rand(0.18, 0.5), size: DL.rand(0.05, 0.15), size1: 0.01,
          r: 1.0, g: type === "metal" ? 0.85 : 0.6, b: type === "metal" ? 0.55 : 0.28, bounce: 0.35,
        });
      }
      for (let i = 0; i < 2; i++) {
        this.smoke.emit({
          x: point.x + n.x * 0.08, y: point.y + n.y * 0.08, z: point.z + n.z * 0.08,
          vx: n.x * DL.rand(0.2, 0.8) + DL.rand(-0.3, 0.3),
          vy: DL.rand(0.2, 0.9), vz: n.z * DL.rand(0.2, 0.8) + DL.rand(-0.3, 0.3),
          life: DL.rand(0.5, 1.1), size: DL.rand(0.15, 0.25), size1: 0.7,
          r: 0.34, g: 0.33, b: 0.3, alpha: 0.28,
        });
      }
      if (type !== "flesh" && Math.abs(n.y) < 0.9) this.decal(point, n, DL.rand(0.11, 0.2));
      this.flashLight(point, type === "metal" ? 0xffc987 : 0xffa55c, type === "metal" ? 5 : 2.4, 0.06);
    }

    blood(point, dir, headshot) {
      const count = headshot ? 26 : 12;
      for (let i = 0; i < count; i++) {
        const sp = headshot ? DL.rand(2, 6) : DL.rand(0.8, 3);
        this.bloodPool.emit({
          x: point.x, y: point.y, z: point.z,
          vx: dir.x * sp * 0.4 + DL.rand(-1.6, 1.6),
          vy: DL.rand(0.6, 3.4), vz: dir.z * sp * 0.4 + DL.rand(-1.6, 1.6),
          life: DL.rand(0.35, 1.0), size: DL.rand(0.05, 0.16), size1: 0.02,
          r: DL.rand(0.25, 0.5), g: DL.rand(0.01, 0.05), b: 0.02, bounce: 0.1,
        });
      }
      for (let i = 0; i < (headshot ? 4 : 2); i++) {
        this.smoke.emit({
          x: point.x, y: point.y, z: point.z,
          vx: DL.rand(-0.4, 0.4), vy: DL.rand(0.1, 0.6), vz: DL.rand(-0.4, 0.4),
          life: DL.rand(0.35, 0.7), size: 0.1, size1: 0.5,
          r: 0.22, g: 0.012, b: 0.01, alpha: 0.3,
        });
      }
      this.flashLight(point, 0x85100a, 1.3, 0.05);
    }

    explosion(point, radius, color) {
      const c = new THREE.Color(color || 0xffa04a);
      for (let i = 0; i < 34; i++) {
        const a = Math.random() * DL.TAU, r = Math.random();
        this.sparks.emit({
          x: point.x, y: point.y + 0.3, z: point.z,
          vx: Math.cos(a) * r * 8, vy: DL.rand(1, 7), vz: Math.sin(a) * r * 8,
          life: DL.rand(0.3, 1.0), size: DL.rand(0.08, 0.22), size1: 0.01,
          r: c.r, g: c.g, b: c.b, bounce: 0.3,
        });
      }
      for (let i = 0; i < 12; i++) {
        const a = Math.random() * DL.TAU;
        this.smoke.emit({
          x: point.x + Math.cos(a) * 0.4, y: point.y + DL.rand(0.2, 1.4), z: point.z + Math.sin(a) * 0.4,
          vx: Math.cos(a) * DL.rand(0.5, 2.4), vy: DL.rand(0.4, 2.2), vz: Math.sin(a) * DL.rand(0.5, 2.4),
          life: DL.rand(1.0, 2.4), size: DL.rand(0.5, 1.1), size1: 2.6,
          r: 0.24, g: 0.22, b: 0.2, alpha: 0.45,
        });
      }
      this.flashLight(point, color || 0xffa04a, 65, 0.22);
      const w = this.waves[this.waveCursor];
      this.waveCursor = (this.waveCursor + 1) % this.waves.length;
      w.mesh.position.copy(point); w.mesh.position.y += 0.15;
      w.mesh.scale.setScalar(0.4);
      w.mesh.visible = true;
      w.life = 0;
    }

    shockwave(point, color) {
      const w = this.waves[this.waveCursor];
      this.waveCursor = (this.waveCursor + 1) % this.waves.length;
      w.mesh.position.copy(point);
      w.mesh.position.y = 0.06;
      w.mesh.scale.setScalar(1);
      w.mesh.material.color.setHex(color || 0xb07044);
      w.mesh.visible = true;
      w.life = 0;
    }

    update(dt) {
      this.time += dt;
      this.sparks.update(dt);
      this.bloodPool.update(dt);
      this.smoke.update(dt);
      this.embers.update(dt);
      for (let i = 0; i < this.lights.length; i++) {
        const l = this.lights[i];
        if (l.power > 0) {
          l.life += dt;
          const t = l.life / l.max;
          if (t >= 1) { l.light.intensity = 0; l.power = 0; }
          else l.light.intensity = l.power * (1 - t) * (1 - t);
        }
      }
      for (let i = 0; i < this.tracers.length; i++) {
        const t = this.tracers[i];
        if (!t.line.visible) continue;
        t.life += dt;
        const k = 1 - t.life / t.max;
        if (k <= 0) t.line.visible = false;
        else t.line.material.opacity = k * 0.85;
      }
      for (let i = 0; i < this.decals.length; i++) {
        const d = this.decals[i];
        if (!d.mesh.visible) continue;
        d.life += dt;
        if (d.life > d.max) d.mesh.visible = false;
        else if (d.life > d.max - 2) d.mesh.material.opacity = ((d.max - d.life) / 2) * 0.95;
      }
      for (let i = 0; i < this.waves.length; i++) {
        const w = this.waves[i];
        if (!w.mesh.visible) continue;
        w.life += dt;
        const t = w.life / w.max;
        if (t >= 1) { w.mesh.visible = false; continue; }
        w.mesh.scale.setScalar(1 + t * 11);
        w.mesh.material.opacity = (1 - t) * 0.55;
      }
    }

    clear() {
      this.sparks.clear(); this.bloodPool.clear(); this.smoke.clear(); this.embers.clear();
      this.tracers.forEach((t) => (t.line.visible = false));
      this.decals.forEach((d) => (d.mesh.visible = false));
      this.waves.forEach((w) => (w.mesh.visible = false));
      this.lights.forEach((l) => { l.light.intensity = 0; l.power = 0; });
    }

    dispose() {
      DL.disposeObject(this.root);
      this.smokeTex && this.smokeTex.dispose();
      this.decalTex && this.decalTex.dispose();
    }
  }

  DL.FX = FX;
})();
