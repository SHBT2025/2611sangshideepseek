/* ============================================================
   DEADLIGHT // game director, world integration, survival loop
   ============================================================ */
(function () {
  "use strict";
  const DL = (window.DL = window.DL || {});
  const $ = (id) => document.getElementById(id);
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

  const WAVE_TITLES = [
    ["WAVE 01", "THEY KNOW YOU'RE HERE", "The treeline is moving."],
    ["WAVE 02", "CONTACT GROWS", "More of them. Faster now."],
    ["WAVE 03", "THEY LEARN", "They're testing the gates."],
    ["WAVE 04", "NOISE ATTRACTS", "Something big is in the trees."],
    ["WAVE 05", "PRESSURE RISING", "The north gate is failing."],
    ["WAVE 06", "HOLD THE LINE", "They're not stopping."],
    ["WAVE 07", "LAST LIGHT", "The forest is coming apart."],
    ["WAVE 08", "THE ABOMINATION", "Kill it. Or the beacon dies."],
  ];
  const WAVE_RADIO = [
    "Command to Outpost 13. We see movement around your perimeter. Hold until dawn.",
    "Outpost 13, thermal shows multiple contacts converging. Keep those gates up.",
    "Beacon signal is weakening. Whatever you're doing, keep doing it.",
    "We're reading a mass signature at the north treeline. You have incoming.",
    "Outpost 13, extraction is staged. Survive the night and we'll come for you.",
    "Command to 13... if you can still hear this, don't stop firing.",
    "The storm is masking our approach. Hold on. Just hold on.",
    "Final wave inbound. Command is watching your signal. Make it count.",
  ];
  const SURFACE = { concrete: "concrete", wood: "wood", metal: "metal" };

  function makeGlowTexture(color) {
    return DL.makeRadialSprite(128, [
      [0, `rgba(${color},0.85)`],
      [0.3, `rgba(${color},0.3)`],
      [1, `rgba(${color},0)`],
    ]);
  }

  /* ============================ pickups ============================ */
  class PickupManager {
    constructor({ scene, world, player, audio, ui, quality }) {
      this.scene = scene;
      this.world = world;
      this.player = player;
      this.audio = audio;
      this.ui = ui;
      this.quality = quality;
      this.items = [];
      this.nearest = null;
      this.time = 0;
      this.pool = [];
      this.glowTex = {
        ammo: makeGlowTexture("255,190,90"),
        medkit: makeGlowTexture("255,80,66"),
        boards: makeGlowTexture("190,150,100"),
        supply: makeGlowTexture("105,211,202"),
        toolkit: makeGlowTexture("120,200,255"),
      };
      this._buildMaterials();
    }

    _buildMaterials() {
      const M = {
        ammo: new THREE.MeshStandardMaterial({ color: 0x3c412d, roughness: 0.76, metalness: 0.12 }),
        ammoLabel: new THREE.MeshStandardMaterial({ color: 0xc9a33e, roughness: 0.55, metalness: 0.15, emissive: 0x4a3508, emissiveIntensity: 0.8 }),
        med: new THREE.MeshStandardMaterial({ color: 0xd8d5c9, roughness: 0.7, metalness: 0.06 }),
        medRed: new THREE.MeshStandardMaterial({ color: 0x9e2017, roughness: 0.55, emissive: 0x3a0805, emissiveIntensity: 1.1 }),
        wood: new THREE.MeshStandardMaterial({ color: 0x5a4530, roughness: 0.92, metalness: 0.0 }),
        woodLight: new THREE.MeshStandardMaterial({ color: 0x786046, roughness: 0.9 }),
        supply: new THREE.MeshStandardMaterial({ color: 0x313b3b, roughness: 0.68, metalness: 0.2 }),
        teal: new THREE.MeshStandardMaterial({ color: 0x69d3ca, roughness: 0.3, metalness: 0.6, emissive: 0x0d3b3a, emissiveIntensity: 1 }),
        rope: new THREE.MeshStandardMaterial({ color: 0x77623f, roughness: 0.95 }),
      };
      this.mats = M;
      this.boxGeo = new THREE.BoxGeometry(1, 1, 1);
      this.plankGeo = new THREE.BoxGeometry(1, 1, 1);
    }

    _mesh(mat, w, h, d, x, y, z) {
      const m = new THREE.Mesh(this.boxGeo, mat);
      m.scale.set(w, h, d);
      m.position.set(x, y, z);
      m.castShadow = false;
      m.receiveShadow = true;
      return m;
    }

    buildGroup(type) {
      const g = new THREE.Group();
      const M = this.mats;
      if (type === "ammo") {
        g.add(this._mesh(M.ammo, 0.42, 0.26, 0.3, 0, 0, 0));
        g.add(this._mesh(M.ammoLabel, 0.43, 0.045, 0.31, 0, 0.04, 0));
        g.add(this._mesh(M.ammoLabel, 0.11, 0.01, 0.08, 0.07, 0.135, 0));
        for (let i = 0; i < 4; i++) {
          const b = this._mesh(M.ammoLabel, 0.018, 0.09, 0.018, -0.12 + i * 0.03, 0.19, 0.08);
          g.add(b);
        }
      } else if (type === "medkit") {
        g.add(this._mesh(M.med, 0.38, 0.17, 0.28, 0, 0, 0));
        g.add(this._mesh(M.medRed, 0.12, 0.02, 0.05, 0, 0.095, 0));
        g.add(this._mesh(M.medRed, 0.05, 0.02, 0.13, 0, 0.095, 0));
        g.add(this._mesh(M.medRed, 0.39, 0.03, 0.06, 0, 0.012, 0));
        g.add(this._mesh(M.medRed, 0.06, 0.03, 0.29, 0, 0.012, 0));
      } else if (type === "boards") {
        for (let i = 0; i < 4; i++) {
          const p = this._mesh(i % 2 ? M.wood : M.woodLight, 0.95, 0.07, 0.2, 0, i * 0.075, (i % 2) * 0.04 - 0.02);
          p.rotation.y = (i % 2 ? 1 : -1) * 0.04;
          g.add(p);
        }
        g.add(this._mesh(M.rope, 0.055, 0.16, 0.24, -0.22, 0.11, 0.03));
        g.add(this._mesh(M.rope, 0.055, 0.16, 0.24, 0.23, 0.11, 0.03));
      } else if (type === "supply") {
        g.add(this._mesh(M.supply, 0.55, 0.34, 0.4, 0, 0, 0));
        g.add(this._mesh(M.teal, 0.56, 0.035, 0.41, 0, 0.04, 0));
        g.add(this._mesh(M.supply, 0.2, 0.1, 0.2, -0.13, 0.21, 0.06));
        g.add(this._mesh(M.ammoLabel, 0.08, 0.012, 0.06, 0.14, 0.176, 0.1));
      } else if (type === "toolkit") {
        g.add(this._mesh(M.supply, 0.46, 0.25, 0.3, 0, 0, 0));
        g.add(this._mesh(M.teal, 0.47, 0.04, 0.31, 0, 0.05, 0));
        g.add(this._mesh(M.wood, 0.18, 0.06, 0.04, 0, 0.18, 0));
      }
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.glowTex[type] || this.glowTex.ammo,
        color: 0xffffff, transparent: true, opacity: 0.5,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      glow.scale.set(1.5, 1.5, 1);
      glow.position.y = 0.18;
      g.add(glow);
      g.userData.glow = glow;
      g.userData.type = type;
      return g;
    }

    clear() {
      for (const it of this.items) { this.scene.remove(it.group); }
      this.items.length = 0;
      this.nearest = null;
    }

    spawnAt(pos, type) {
      const g = this.buildGroup(type);
      g.position.set(pos.x, 0.08, pos.z);
      g.rotation.y = Math.random() * Math.PI * 2;
      this.scene.add(g);
      const item = { group: g, type, baseY: 0.08, phase: Math.random() * 10, active: true };
      this.items.push(item);
      return item;
    }

    spawnInitial() {
      this.clear();
      const points = (this.world.pickupSpawns || []).slice();
      if (!points.length) {
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          points.push(new THREE.Vector3(Math.cos(a) * 13, 0, Math.sin(a) * 13));
        }
      }
      const types = ["ammo", "ammo", "medkit", "boards", "supply", "ammo", "boards", "medkit"];
      for (let i = 0; i < Math.min(points.length, 7); i++) {
        this.spawnAt(points[i], types[i % types.length]);
      }
    }

    refill(wave) {
      const points = (this.world.pickupSpawns || []).slice();
      if (!points.length) return;
      // Remove oldest and spawn a fresh distribution, keeping a few.
      while (this.items.length > 5) {
        const it = this.items.shift();
        this.scene.remove(it.group);
      }
      const types = ["ammo", "ammo", "boards", "medkit", "supply", "ammo", "boards"];
      for (let i = 0; i < 3; i++) {
        const p = DL.choice(points);
        this.spawnAt(p, types[(wave + i) % types.length]);
      }
    }

    update(dt) {
      this.time += dt;
      let nearest = null, nearestD = Infinity;
      const pp = this.player.position;
      for (const it of this.items) {
        it.group.rotation.y += dt * 0.35;
        it.group.position.y = it.baseY + Math.sin(this.time * 1.6 + it.phase) * 0.045;
        const glow = it.group.userData.glow;
        if (glow) glow.material.opacity = 0.32 + Math.sin(this.time * 2.4 + it.phase) * 0.15;
        const dx = it.group.position.x - pp.x, dz = it.group.position.z - pp.z;
        const d = Math.hypot(dx, dz);
        if (d < 2.35 && d < nearestD && Math.abs(pp.y - 0) < 1.4) { nearest = it; nearestD = d; }
      }
      this.nearest = nearest;
      return nearest;
    }

    collect(it) {
      if (!it || !it.active) return false;
      it.active = false;
      this.scene.remove(it.group);
      const idx = this.items.indexOf(it);
      if (idx >= 0) this.items.splice(idx, 1);
      const p = this.player;
      switch (it.type) {
        case "ammo":
          this.weaponsRef.addAmmo("rifle", 36);
          this.weaponsRef.addAmmo("pistol", 9);
          this.audio && this.audio.play("pickup_ammo", { volume: 0.72 });
          this.ui.toast("+36 RIFLE ROUNDS  /  +9 PISTOL ROUNDS");
          break;
        case "medkit":
          p.addMedkits(1);
          this.audio && this.audio.play("pickup_med", { volume: 0.72 });
          this.ui.toast("+1 MEDKIT");
          break;
        case "boards":
          p.addBoards(2);
          this.audio && this.audio.play("pickup_supply", { volume: 0.7 });
          this.ui.toast("+2 BARRICADE BOARDS");
          break;
        case "supply":
          p.addBoards(1); p.addMedkits(1);
          this.weaponsRef.addAmmo("all", 24);
          this.audio && this.audio.play("pickup_supply", { volume: 0.8 });
          this.ui.toast("SUPPLY CACHE  //  AMMO  MEDKIT  BOARDS");
          break;
        case "toolkit":
          p.addBoards(3);
          this.audio && this.audio.play("pickup_supply", { volume: 0.8 });
          this.ui.toast("+3 BARRICADE BOARDS");
          break;
      }
      return true;
    }
  }

  /* ============================ game ============================ */
  class Game {
    constructor() {
      this.state = "loading";
      this.qualityName = "high";
      this.quality = Object.assign({}, DL.Quality.high);
      this.input = new DL.Input();
      this.ui = new DL.UI();
      this.settings = this.ui.settings;
      this.qualityName = this.settings.quality;
      this.quality = Object.assign({}, DL.Quality[this.settings.quality] || DL.Quality.high);
      this.timeOfDay = this.settings.timeOfDay === "day" ? "day" : "night";
      this.time = 0;
      this.menuTime = 0;
      this.gameTime = 0;
      this.last = performance.now();
      this.wave = 1;
      this.maxWaves = 8;
      this.phase = "prep";
      this.prepTimer = 18;
      this.clearTimer = 0;
      this.extractionTimer = 0;
      this.kills = 0;
      this.headshotKills = 0;
      this.waveClearGuard = false;
      this.lightningFlash = 0;
      this.flash = 0;
      this.damageFlash = 0;
      this.fade = 0;
      this.repairHold = 0;
      this.repairTargetId = null;
      this.prompt = { on: false };
      this.barricadeState = {};
      this.generatorUnderAttack = 0;
      this.lastGeneratorHitToast = -10;
      this.lastRadio = "";
      this.raf = 0;
      this.fpsAvg = 60;
      this.adaptiveScale = 1;
      this.perfOn = false;
      this.debug = /[?&]debug=1/.test(location.search);
      this._bindUI();
      this._bindInput();
    }

    _bindUI() {
      this.ui.bindings = {
        onDeploy: () => this.startRun(),
        onResume: () => this.resume(),
        onRestart: () => this.startRun(),
        onAbandon: () => this.abandon(),
        onQuality: (q) => this.applyQuality(q),
        onTimeOfDay: (mode) => this.setTimeOfDay(mode),
        onSensitivity: (v) => { if (this.player) this.player.setSensitivity(v); },
        onVolume: (v) => { if (this.audio && this.audio.setMasterVolume) this.audio.setMasterVolume(v); },
        onFov: (v) => {
          if (this.player) this.player.setBaseFov(v);
          if (this.weapons) this.weapons.baseFov = v;
        },
        onShake: (on) => { if (this.player) this.player.shakeEnabled = on; },
        onUiClick: () => this._sfx("ui_click", { volume: 0.35 }),
        onHover: () => this._sfx("ui_hover", { volume: 0.16 }),
      };
    }

    _bindInput() {
      this.input.onLockChange = (locked, was) => {
        if (!locked && was && this.state === "playing") this.pause();
      };
      this.input.onLockError = () => {
        this.ui.toast("CLICK THE VIEW TO CAPTURE THE MOUSE");
      };
      window.addEventListener("resize", () => this.resize());
      document.addEventListener("visibilitychange", () => {
        if (document.hidden && this.state === "playing") this.pause();
      });
      const canvas = $("game");
      canvas.addEventListener("click", () => {
        if (this.state === "playing" && !this.input.locked) this.input.requestLock();
      });
      window.addEventListener("keydown", (e) => {
        if (e.code === "F3") {
          e.preventDefault();
          this.perfOn = !this.perfOn;
          if ($("perf")) $("perf").style.display = this.perfOn ? "block" : "none";
        }
      });
    }

    async init() {
      try {
        this.ui.setLoading(0.02, "VERIFYING WEBGL2");
        await nextFrame();
        const canvas = $("game");
        const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, powerPreference: "high-performance", stencil: false, depth: true });
        if (!gl) {
          this.ui.setLoading(0, "WEBGL2 UNAVAILABLE");
          $("load-label").textContent = "THIS EXPERIENCE REQUIRES WEBGL 2 / HARDWARE ACCELERATION";
          $("load-tip").textContent = "ENABLE HARDWARE ACCELERATION OR TRY A DESKTOP CHROMIUM BROWSER";
          return;
        }
        this.gl = gl;
        this.renderer = new THREE.WebGLRenderer({
          canvas, context: gl, antialias: false, powerPreference: "high-performance",
          alpha: false, stencil: false, depth: true, logarithmicDepthBuffer: false,
        });
        this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
        this.renderer.toneMapping = THREE.NoToneMapping;
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.renderer.setClearColor(0x05080b, 1);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.quality.pixelRatio));
        this.renderer.setSize(window.innerWidth, window.innerHeight, false);
        this.renderer.info.autoReset = false;

        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(78, window.innerWidth / window.innerHeight, 0.05, 520);
        this.camera.rotation.order = "YXZ";
        this.menuCamera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.05, 520);
        this.scene.add(this.menuCamera);

        this.ui.setLoading(0.08, "BUILDING HDR PIPELINE");
        await nextFrame();
        this.post = new DL.PostPipeline(this.renderer, this.scene, this.camera, this.quality);

        this.ui.setLoading(0.12, "CALIBRATING AUDIO SYNTH");
        await nextFrame();
        this.audio = new DL.AudioEngine();
        if (this.audio.setMasterVolume) this.audio.setMasterVolume(this.settings.volume);

        this.ui.setLoading(0.16, "CONSTRUCTING BLACKPINE VALLEY");
        await nextFrame();
        this.world = new DL.World({ scene: this.scene, renderer: this.renderer, quality: this.quality, audio: this.audio });
        const worldBuild = this.world.build((p, label) => {
          this.ui.setLoading(0.16 + p * 0.57, label || "BUILDING OUTPOST");
        });
        if (worldBuild && worldBuild.then) await worldBuild;
        // Keep the first contact close enough to pace the run tightly: permanent
        // forest spawns are 40-50 m out, so add a few cleared "approach" points
        // just beyond each gate.
        if (this.world.nav && this.world.spawnPoints) {
          // The permanent forest ring is scenic but far away; stage the assault
          // from the cleared approach lanes just beyond each gate so the fight
          // starts within seconds rather than after a long silent walk.
          const rng = DL.mulberry32(0x13aa77);
          this.world.spawnPoints.length = 0;
          for (const side of [1, -1]) {
            for (const x of [-8, -5.5, -3, 0, 3, 5.5, 8]) {
              const z = side * (31 + rng() * 2.5);
              const q = this.world.nav.nearestOpen(x + (rng() - 0.5) * 1.5, z, 8);
              if (q) this.world.spawnPoints.push(new THREE.Vector3(q.x, 0, q.z));
            }
          }
        }
        // Lift the deep shadows slightly for readability while keeping the night mood.
        if (this.world._ambientBase != null) this.world._ambientBase = 0.44;
        if (this.world._hemiBase != null) this.world._hemiBase = 0.5;
        this.timeOfDay = this.settings.timeOfDay === "day" ? "day" : "night";
        if (this.world.setTimeOfDay) this.world.setTimeOfDay(this.timeOfDay);
        this.ui.setTimeOfDayUI(this.timeOfDay);
        this.world.onLightning = (distance) => {
          this.lightningFlash = Math.max(this.lightningFlash, 1);
          this.flash = 1;
          this.ui.flashScreen(0.42);
          if (this.audio) {
            if (this.audio.ready && this.audio.thunder) {
              try { this.audio.thunder(distance || 1); } catch (e) {}
            } else {
              this._sfx("thunder", { volume: 0.7, rate: DL.rand(0.9, 1.05) });
            }
          }
        };
        await nextFrame();

        this.ui.setLoading(0.77, "ARMING RESPONSE TEAM");
        await nextFrame();
        this.fx = new DL.FX(this.scene, this.camera, this.quality, this.audio);
        this.player = new DL.Player({
          camera: this.camera, scene: this.scene, world: this.world, audio: this.audio,
          weapons: null, quality: this.quality, baseFov: this.settings.fov,
          callbacks: {
            onDeath: () => this._onPlayerDeath(),
            onDamage: (amount, fromPos) => this._onPlayerDamaged(amount, fromPos),
            onToast: (t) => this.ui.toast(t),
          },
        });
        this.player.setSensitivity(this.settings.sensitivity);
        this.player.shakeEnabled = this.settings.shake;
        this.player.setBaseFov(this.settings.fov);

        this.weapons = new DL.WeaponSystem({
          camera: this.camera, scene: this.scene, world: this.world, horde: null,
          fx: this.fx, audio: this.audio, quality: this.quality, baseFov: this.settings.fov,
          callbacks: {
            onAmmoChange: () => {},
            onWeaponChange: () => {},
            onRecoil: (pitch, yaw) => this.player.addRecoil(pitch, yaw),
            onHitmarker: (hit, headshot, killed) => {
              if (hit) this.ui.hitmarker(headshot, killed);
            },
            onShoot: (def) => { this.player.addShake(0.075); },
            onReloadStart: () => {},
            onReloadEnd: () => {},
            onDryfire: () => this.ui.toast("MAGAZINE EMPTY — RELOAD [R]"),
          },
        });
        this.player.weapons = this.weapons;

        this.ui.setLoading(0.86, "WAKING THE FOREST");
        await nextFrame();
        this.horde = new DL.Horde({
          scene: this.scene, world: this.world, audio: this.audio,
          getPlayer: () => this.player,
          getGenerator: () => this.world.generator,
          quality: this.quality,
          callbacks: {
            onKill: (zombie, headshot) => this._onKill(zombie, headshot),
            onPlayerHit: (zombie, damage) => this._onPlayerHit(zombie, damage),
            onGeneratorHit: (zombie, damage) => this._onGeneratorHit(zombie, damage),
            onWaveComplete: (wave) => this._queueWaveComplete(wave),
            onSpawn: () => {},
          },
        });
        this.weapons.horde = this.horde;

        this.pickups = new PickupManager({
          scene: this.scene, world: this.world, player: this.player,
          audio: this.audio, ui: this.ui, quality: this.quality,
        });
        this.pickups.weaponsRef = this.weapons;

        this.ui.setLoading(0.93, "CALIBRATING SCENE LIGHTS");
        await nextFrame();
        this._prepareMenuCamera();
        this.player.reset(this.world.playerSpawn || new THREE.Vector3(0, 0, 12));

        // Warm shaders before the first visible frame.
        this.renderer.compile(this.scene, this.menuCamera);
        this.renderer.compile(this.weapons.viewScene, this.weapons.viewCamera);
        this.ui.setLoading(1, "SYSTEM READY");
        await nextFrame();
        this.state = "menu";
        this.ui.showMenu();
        this.last = performance.now();
        window.DEADLIGHT_GAME = this;
        this._loop(this.last);
        if (this.debug) {
          this.ui.toast("DEBUG BUILD — F3 FOR STATS");
        }
      } catch (err) {
        console.error("DEADLIGHT INIT FAILURE", err);
        $("load-label").textContent = "INITIALIZATION FAILURE";
        $("load-pct").textContent = "ERR";
        $("load-tip").textContent = String(err && err.message ? err.message : err);
      }
    }

    _prepareMenuCamera() {
      const cam = this.menuCamera;
      const a = 0.72;
      cam.position.set(Math.cos(a) * 31, 3.8, Math.sin(a) * 31);
      cam.lookAt(0, 2.2, -2);
    }

    _sfx(name, opts) {
      if (!this.audio) return;
      try { this.audio.play(name, opts || {}); } catch (e) {}
    }

    setTimeOfDay(mode) {
      mode = mode === "day" ? "day" : "night";
      this.timeOfDay = mode;
      if (this.world && this.world.setTimeOfDay) this.world.setTimeOfDay(mode);
      if (this.player) this.player.flashlightOn = mode !== "day";
      this.ui.setTimeOfDayUI(mode);
    }

    startRun() {
      if (this.state === "loading") return;
      this._initAudio();
      this.state = "playing";
      this.ui.showGame();
      this.input.requestLock();
      this._resetRun();
      const day = this.timeOfDay === "day";
      if (this.world && this.world.setTimeOfDay) this.world.setTimeOfDay(this.timeOfDay);
      this.player.flashlightOn = !day;
      this.ui.banner("MISSION START", "HOLD THE LINE", day ? "PREPARE THE OUTPOST — DAYLIGHT WAVE 01 INBOUND" : "PREPARE THE OUTPOST — WAVE 01 INBOUND", 3600);
      this.ui.radio(day
        ? "Command to Outpost 13. Daylight is on your side, but the treeline is still moving. Hold the beacon through eight waves. Extraction is staged."
        : "Command to Outpost 13. The convoy isn't coming. Hold the beacon until dawn. Eight waves. That's all we ask.", 5600);
      this._sfx("wave_start", { volume: 0.8 });
      setTimeout(() => { if (this.state === "playing") this.ui.toast("WASD MOVE  •  LMB FIRE  •  RMB AIM  •  R RELOAD  •  E COLLECT"); }, 800);
    }

    _initAudio() {
      if (!this.audio || !this.audio.init) return;
      if (this.audioStarting || this.audio.ready) return;
      this.audioStarting = true;
      Promise.resolve(this.audio.init())
        .then(() => {
          if (this.audio.setMasterVolume) this.audio.setMasterVolume(this.settings.volume);
          if (this.audio.startAmbient) this.audio.startAmbient();
          if (this.audio.setTension) this.audio.setTension(0.2);
        })
        .catch((e) => console.warn("audio init failed", e));
    }

    _resetRun() {
      this.wave = 1;
      this.phase = "prep";
      this.prepTimer = 15;
      this.fade = 1;
      this.clearTimer = 0;
      this.extractionTimer = 0;
      this.waveClearGuard = false;
      this.gameTime = 0;
      this.kills = 0;
      this.headshotKills = 0;
      this.repairHold = 0;
      this.repairTargetId = null;
      this.damageFlash = 0;
      this.flash = 0;
      this.lightningFlash = 0;
      this.barricadeState = {};
      this.horde.clear();
      this.fx.clear();
      this.player.reset(this.world.playerSpawn || new THREE.Vector3(0, 0, 12));
      // Reset weapon loadout.
      const w = this.weapons;
      w.activeId = "rifle";
      w.lastId = "pistol";
      w.reloading = false; w.switching = false; w.cooldown = 0; w.adsT = 0; w.lowerT = 0;
      w.shotsFired = 0; w.shotsHit = 0; w.headshotCount = 0; w.crosshairBloom = 0;
      w.weapons.rifle.mag = 30; w.weapons.rifle.reserve = 120;
      w.weapons.pistol.mag = 15; w.weapons.pistol.reserve = 45;
      if (w._selectGroup) w._selectGroup("rifle");
      if (w._emitAmmo) w._emitAmmo(true);
      if (w._emitWeapon) w._emitWeapon();
      // Reset barricades & beacon.
      if (this.world.barricades) {
        for (const b of this.world.barricades) {
          b.health = b.maxHealth;
          b.broken = false;
          if (this.world.setBarricadeBlocked) this.world.setBarricadeBlocked(b.id, true);
          if (this.world.updateBarricadeVisual) this.world.updateBarricadeVisual(b.id);
        }
      }
      if (this.world.generator) {
        const g = this.world.generator;
        if (g.repair) g.repair(g.maxHealth);
        else g.health = g.maxHealth;
        g.broken = false;
        if (g.group) g.group.visible = true;
      }
      this.pickups.spawnInitial();
      this.ui.showGame();
      this._updateHUD();
    }

    pause() {
      if (this.state !== "playing") return;
      this.state = "paused";
      this.input.releaseLock();
      this.ui.showPause();
    }

    resume() {
      if (this.state !== "paused") return;
      this.state = "playing";
      this.ui.showGame();
      this.input.requestLock();
      this._sfx("ui_click", { volume: 0.4 });
    }

    abandon() {
      this.state = "menu";
      this.input.releaseLock();
      this.horde.clear();
      this.fx.clear();
      this.pickups.clear();
      this.ui.showMenu();
      this.player.reset(this.world.playerSpawn || new THREE.Vector3(0, 0, 12));
      this._prepareMenuCamera();
      if (this.audio && this.audio.setTension) this.audio.setTension(0.15);
    }

    _onPlayerDeath() {
      if (this.state !== "playing") return;
      this.state = "gameover";
      this.input.releaseLock();
      this.fx && this.fx.clear();
      const stats = this._stats();
      this.ui.showDeath(stats);
      this._sfx("defeat", { volume: 1 });
      const kicker = document.querySelector("#gameover .result-kicker");
      const title = document.querySelector("#gameover .result-title");
      const sub = document.querySelector("#gameover .result-sub");
      if (kicker) kicker.textContent = "SIGNAL TERMINATED // KIA";
      if (title) title.innerHTML = "THE OUTPOST<br><b>FELL SILENT</b>";
      if (sub) sub.innerHTML = "Your radio went quiet at wave <span id='death-wave'>" + String(this.wave).padStart(2, "0") + "</span>. The forest keeps what it takes.";
    }

    _onPlayerDamaged(amount, fromPos) {
      this.ui.damageIndicator();
      this.damageFlash = Math.min(1.4, this.damageFlash + amount / 34);
      if (this.player.health < 35) this.ui.radio("Your vitals are critical. Find a medkit. That is an order.", 3200);
    }

    _onKill(zombie, headshot) {
      this.kills++;
      if (headshot) this.headshotKills++;
      const name = zombie && zombie.def && zombie.def.label ? zombie.def.label : "HOSTILE";
      this.ui.feed(name + " ELIMINATED", headshot);
      if (headshot) this.ui.toast("HEADSHOT  +" + (zombie && zombie.isBoss ? "500" : "25"));
      if (zombie && zombie.def && zombie.def.key === "brute") this.player.addShake(0.4);
      if (zombie && zombie.isBoss) {
        this.ui.waveBanner("TARGET DOWN", "ABOMINATION NEUTRALIZED", "THE FOREST IS QUIET AGAIN", 4200);
        this.player.addShake(1.2);
        this._sfx("explosion", { volume: 1 });
      }
    }

    _onPlayerHit(zombie, damage) {
      if (this.state !== "playing" || !this.player || !this.player.alive) return;
      this.player.damage(damage, zombie && zombie.pos ? zombie.pos : null);
    }

    _onGeneratorHit(zombie, damage) {
      this.generatorUnderAttack = 2.2;
      this.player.addShake(0.15);
      if (this.gameTime - this.lastGeneratorHitToast > 12) {
        this.lastGeneratorHitToast = this.gameTime;
        this.ui.radio("Beacon integrity failing. They're hitting the mast. Get them off it!", 3000);
        this._sfx("generator_hit", { volume: 0.9 });
      }
    }

    _onBarricadeBroken(id) {
      this.ui.toast(id === "north" ? "NORTH GATE BREACHED" : "SOUTH GATE BREACHED");
      this.ui.radio(id === "north" ? "North gate is down! They're inside the wire!" : "South gate is down! Fall back to the beacon!", 4000);
      this.player.addShake(0.5);
      this._sfx("barricade_break", { volume: 1 });
      this.ui.feed("GATE BREACHED", true);
    }

    _queueWaveComplete(wave) {
      if (this.waveClearGuard) return;
      if (this.state !== "playing") return;
      this.waveClearGuard = true;
      this.phase = "cleared";
      this.clearTimer = 2.6;
      this._sfx("wave_end", { volume: 0.85 });
      this.ui.banner("SECTOR CLEARED", "WAVE " + String(wave).padStart(2, "0") + " REPELLED", "REGROUP — RESUPPLY — REPAIR THE GATES", 3600);
      this.ui.radio(wave < 8 ? "Command to 13: wave is breaking up. You still have a signal. Use the lull, Outpost." : "That's the last of them... beacons still burning. Extraction is inbound.", 4500);
    }

    _nextWave() {
      this.wave++;
      if (this.wave > this.maxWaves) { this._victory(); return; }
      this.phase = "prep";
      this.prepTimer = 20;
      this.waveClearGuard = false;
      this.pickups.refill(this.wave);
      this.ui.banner("INTERMISSION", "WAVE " + String(this.wave).padStart(2, "0") + " INBOUND", "COLLECT SUPPLIES — REPAIR BARRICADES", 3200);
      this.ui.radio(WAVE_RADIO[(this.wave - 1) % WAVE_RADIO.length], 4400);
    }

    _startWave(n) {
      if (this.state !== "playing") return;
      this.phase = "combat";
      this.waveClearGuard = false;
      this.wave = n;
      const info = WAVE_TITLES[Math.min(n, 8) - 1];
      this.ui.waveBanner("INCOMING", info[0], info[2], 3400);
      this.ui.radio(WAVE_RADIO[(n - 1) % WAVE_RADIO.length], 4400);
      this._sfx("wave_start", { volume: 0.9 });
      if (this.audio && this.audio.setTension) this.audio.setTension(Math.min(1, 0.25 + n * 0.1));
      try { this.horde.startWave(n); }
      catch (e) { console.error("startWave failed", e); this.ui.toast("WAVE SPAWN ERROR"); }
      this.ui.feed("WAVE " + String(n).padStart(2, "0") + " INBOUND", true);
    }

    _victory() {
      if (this.state === "victory") return;
      this.state = "victory";
      this.phase = "victory";
      this.input.releaseLock();
      this.fx && this.fx.clear();
      this.ui.showVictory(this._stats());
      const day = this.timeOfDay === "day";
      const kicker = document.querySelector("#victory .result-kicker");
      const sub = document.querySelector("#victory .result-sub");
      if (kicker) kicker.textContent = day ? "EXTRACTION CONFIRMED // DAYLIGHT" : "EXTRACTION CONFIRMED // DAWN";
      if (sub) sub.textContent = day
        ? "The beacon burned through the daylight. At 17:42, the birds went silent — then the rotors came."
        : "The beacon burned through the night. At 05:12, the birds went silent — then the rotors came.";
      this._sfx("victory", { volume: 1 });
      if (this.audio && this.audio.setTension) this.audio.setTension(0);
    }

    _gameOverBeacon() {
      if (this.state !== "playing") return;
      this.state = "gameover";
      this.input.releaseLock();
      this.fx && this.fx.clear();
      this.ui.showDeath(this._stats());
      this._sfx("defeat", { volume: 1 });
      const kicker = document.querySelector("#gameover .result-kicker");
      const title = document.querySelector("#gameover .result-title");
      const sub = document.querySelector("#gameover .result-sub");
      if (kicker) kicker.textContent = "BEACON LOST // OUTPOST OVERRUN";
      if (title) title.innerHTML = "THE OUTPOST<br><b>WENT DARK</b>";
      if (sub) sub.innerHTML = "The beacon died at wave <span id='death-wave'>" + String(this.wave).padStart(2, "0") + "</span>. Without the signal, no one will ever find you.";
    }

    _stats() {
      const w = this.weapons ? this.weapons.getStats() : { shots: 0, hits: 0, headshots: 0, accuracy: 0 };
      const t = Math.floor(this.gameTime);
      return {
        wave: this.wave,
        kills: this.kills,
        headshots: w.headshots,
        time: DL.formatTime(t),
        accuracy: Math.round(w.accuracy),
        shots: w.shots,
        hitRate: w.accuracy,
      };
    }

    /* ---------------- interactions ---------------- */
    _updateInteractions(dt) {
      const p = this.player;
      const pp = p.position;
      this.prompt = { on: false };

      const pickup = this.pickups.nearest;
      if (pickup) {
        this.prompt = { on: true, key: "E", text: "COLLECT " + this._pickupName(pickup.type), sub: "PRESS E" };
        if (this.input.pressed("KeyE")) {
          this.pickups.collect(pickup);
        }
        return;
      }

      // Barricades
      if (this.world.barricades) {
        for (const b of this.world.barricades) {
          if (!b || !b.position) continue;
          const d = Math.hypot(pp.x - b.position.x, pp.z - b.position.z);
          if (d < 4.4) {
            if (b.health < b.maxHealth || b.broken) {
              const boards = p.boards;
              if (boards <= 0) {
                this.prompt = { on: true, key: "E", text: (b.broken ? "REBUILD " : "REPAIR ") + (b.id === "north" ? "NORTH GATE" : "SOUTH GATE"), sub: "NO BOARDS — SCAVENGE SUPPLIES" };
                this.repairHold = 0;
                return;
              }
              if (this.repairTargetId !== b.id) { this.repairTargetId = b.id; this.repairHold = 0; }
              const holding = this.input.isDown("KeyE");
              if (holding) this.repairHold += dt;
              const pct = Math.min(1, this.repairHold / 1.3);
              this.prompt = {
                on: true, key: "E",
                text: (b.broken ? "REBUILD " : "REPAIR ") + (b.id === "north" ? "NORTH GATE" : "SOUTH GATE"),
                sub: "HOLD E  //  " + Math.round(pct * 100) + "%  //  " + boards + " BOARDS",
              };
              if (this.repairHold >= 1.3) {
                this.repairHold = 0;
                const cost = b.broken ? 3 : 1;
                if (p.boards >= cost) {
                  p.boards -= cost;
                  if (b.broken && this.world.setBarricadeBlocked) this.world.setBarricadeBlocked(b.id, true);
                  if (this.world.repairBarricade) this.world.repairBarricade(b.id, b.broken ? 200 : 160);
                  else {
                    b.broken = false;
                    b.health = Math.min(b.maxHealth, b.health + 200);
                  }
                  this._sfx("barricade_repair", { volume: 0.8 });
                  this.ui.toast(b.broken ? "GATE REPAIRED" : "BARRICADE REBUILT");
                } else {
                  this.ui.toast("NEED " + cost + " BOARDS");
                }
              }
              return;
            }
            // show gate status if fully intact? no prompt
          }
        }
      }

      // Beacon / start wave early
      if (this.world.generator && this.phase === "prep") {
        const g = this.world.generator;
        const d = Math.hypot(pp.x - g.position.x, pp.z - g.position.z);
        if (d < 5.2) {
          this.prompt = { on: true, key: "E", text: "CALL THE NEXT WAVE EARLY", sub: "PRESS E TO SIGNAL READY" };
          if (this.input.pressed("KeyE")) {
            this._startWave(this.wave);
          }
          return;
        }
      }
    }

    _pickupName(type) {
      return type === "ammo" ? "AMMUNITION" : type === "medkit" ? "MEDKIT" : type === "boards" ? "BARRICADE BOARDS" : type === "supply" ? "SUPPLY CACHE" : "SUPPLIES";
    }

    /* ---------------- update ---------------- */
    _updateMenu(dt) {
      this.menuTime += dt;
      const t = this.menuTime;
      const cam = this.menuCamera;
      const t2 = t * 0.05;
      cam.position.set(2.2 + Math.sin(t2) * 1.35, 2.75 + Math.sin(t * 0.11) * 0.22, 15.4 - Math.sin(t2 * 0.74) * 1.0);
      cam.lookAt(-1.8 + Math.sin(t2 * 0.6) * 0.5, 2.25 + Math.sin(t * 0.09) * 0.1, -3.2);
      this.world.update(dt, t, cam.position);
      // Cinematic menu lift: the title needs silhouettes, not a black screen.
      if (this.timeOfDay === "day") {
        if (this.world._ambient) this.world._ambient.intensity = 0.6;
        if (this.world._hemi) this.world._hemi.intensity = 1.18;
        if (this.world._moon) this.world._moon.intensity = Math.max(this.world._moon.intensity, 3.5);
      } else {
        if (this.world._ambient) this.world._ambient.intensity = 1.05;
        if (this.world._hemi) this.world._hemi.intensity = 1.05;
        if (this.world._moon) this.world._moon.intensity = Math.max(this.world._moon.intensity, 2.0);
      }
      this.fx && this.fx.update(dt);
      this.lightningFlash = Math.max(0, this.lightningFlash - dt * 4.5);
      if (this.audio && this.audio.ready) {
        try {
          this.audio.setListener({ x: cam.position.x, y: cam.position.y, z: cam.position.z }, { x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0 });
          this.audio.update(dt, { zombies: 0, wave: 0, health: 100, phase: "menu" });
        } catch (e) {}
      }
    }

    _updatePlaying(dt) {
      this.gameTime += dt;
      const p = this.player;
      if (!p) return;
      if (this.input.locked === false && this.state === "playing" && this.gameTime > 1.5 && !this.debug) {
        // Don't auto-pause immediately; pointer lock may be pending. Actual lock loss is handled by event.
      }

      // World / enemies / player
      this.world.update(dt, this.gameTime, p.position);
      if (this.phase !== "victory") {
        try { this.horde.update(dt, this.gameTime); } catch (e) { console.error("horde update", e); }
      }
      if (this.state !== "playing") return;
      p.update(dt, this.input);
      if (this.state !== "playing") return;
      this.weapons.update(dt, this.input, p.getState());
      this.fx.update(dt);
      if (this.state !== "playing") return;
      // Soft body separation: keep the camera out of a zombie's ribcage.
      if (this.horde && this.horde.zombies) {
        for (const z of this.horde.zombies) {
          if (!z || z.dead || z.state === "dying" || !z.pos) continue;
          const dx = p.position.x - z.pos.x, dz = p.position.z - z.pos.z;
          const d2 = dx * dx + dz * dz;
          const minR = 0.9 + (z.def ? (z.def.radius || 0.4) : 0.4);
          if (d2 > 0.0001 && d2 < minR * minR) {
            const d = Math.sqrt(d2);
            const push = (minR - d);
            const nx = p.position.x + (dx / d) * push;
            const nz = p.position.z + (dz / d) * push;
            if (!this.world.isBlocked || !this.world.isBlocked(nx, nz, 0.36)) {
              p.position.x = nx; p.position.z = nz;
            }
          }
        }
      }

      // World event: lightning
      this.lightningFlash = Math.max(0, this.lightningFlash - dt * 5.2);
      this.damageFlash = Math.max(0, this.damageFlash - dt * 1.8);
      this.fade = Math.max(0, this.fade - dt * 1.2);
      if (this.world.generator) {
        const gh = this.world.generator.health;
        if (gh <= 0) { this._gameOverBeacon(); return; }
      }

      // Barricade breaches
      if (this.world.barricades) {
        for (const b of this.world.barricades) {
          const was = this.barricadeState[b.id];
          if (was && !was.broken && b.broken) this._onBarricadeBroken(b.id);
          this.barricadeState[b.id] = { broken: !!b.broken, health: b.health };
        }
      }

      this.generatorUnderAttack = Math.max(0, this.generatorUnderAttack - dt);

      // Pickups and interactions
      this.pickups.update(dt);
      this._updateInteractions(dt);

      // Wave director
      if (this.phase === "prep") {
        this.prepTimer -= dt;
        if (this.prepTimer <= 0) {
          this.prepTimer = 0;
          this._startWave(this.wave);
        }
      } else if (this.phase === "combat") {
        if (this.state !== "playing") return;
        const alive = this.horde.aliveCount || 0;
        const remaining = this.horde.remainingToSpawn || 0;
        if (alive === 0 && remaining === 0) this._queueWaveComplete(this.wave);
      } else if (this.phase === "cleared") {
        this.clearTimer -= dt;
        if (this.clearTimer <= 0) {
          if (this.wave >= this.maxWaves) {
            this.phase = "extraction";
            this.extractionTimer = 5.5;
            this.ui.waveBanner("EXTRACTION", "DAWN BREAKS", "THE LINE HELD — HELICOPTERS INBOUND", 5000);
            this.ui.radio("Outpost 13, this is actual. We have your signal and we're coming in. You held the line. You held the line.", 6000);
          } else {
            this._nextWave();
          }
        }
      } else if (this.phase === "extraction") {
        this.extractionTimer -= dt;
        if (this.extractionTimer <= 0) this._victory();
      }

      // Audio state
      if (this.audio && this.audio.ready) {
        try {
          this.audio.update(dt, {
            zombies: this.horde.aliveCount || 0,
            wave: this.wave,
            health: p.health,
            phase: this.phase,
            attacking: this.generatorUnderAttack > 0,
          });
        } catch (e) {}
      }

      // Damage feedback UI
      if (this.player.damageFlash > 0.8) this.player.damageFlash = 0.8;
      this._updateHUD();
      if (this.state === "playing" && this.player.dead) this._onPlayerDeath();
    }

    _updateHUD() {
      if (!this.player || !this.hudReady()) return;
      const p = this.player;
      const w = this.weapons.getAmmo();
      const gen = this.world.generator || { health: 1, maxHealth: 1 };
      const bars = { north: 1, south: 1 };
      if (this.world.barricades) {
        for (const b of this.world.barricades) {
          if (bars[b.id] != null) bars[b.id] = DL.clamp(b.health / b.maxHealth, 0, 1);
        }
      }
      let phaseLabel = "PREPARE";
      let phaseTimeText = null;
      let hostiles = 0;
      if (this.phase === "combat") {
        phaseLabel = "WAVE ACTIVE";
        hostiles = (this.horde.aliveCount || 0) + (this.horde.remainingToSpawn || 0);
      } else if (this.phase === "cleared") phaseLabel = "SECTOR CLEAR";
      else if (this.phase === "extraction") phaseLabel = "EXTRACTION";
      const phaseTime = this.phase === "prep" ? Math.ceil(this.prepTimer) : hostiles;
      const state = {
        health: p.health,
        stamina: p.stamina,
        medkits: p.medkits,
        boards: p.boards,
        weaponId: this.weapons.activeId,
        weaponName: w.name,
        fireMode: this.weapons.def.fireMode,
        weaponSlot: this.weapons.def.slot,
        ammo: w.mag,
        reserve: w.reserve,
        magSize: w.magSize,
        yaw: p.yaw + p.recoilYaw,
        bloom: this.weapons.crosshairBloom,
        moving: p.getState().speed > 1.2,
        ads: this.weapons.adsT,
        wave: this.wave,
        phase: this.phase,
        phaseLabel,
        phaseTime,
        phaseTimeText: DL.formatTime(this.prepTimer),
        hostiles,
        waveKey: this.wave + "|" + phaseLabel,
        waveSub: "",
        generator: gen.health,
        generatorMax: gen.maxHealth,
        barricades: bars,
        structureKey: Math.round(gen.health) + "|" + Math.round(bars.north * 100) + "|" + Math.round(bars.south * 100),
        damageFlash: Math.max(this.damageFlash, p.damageFlash),
        flash: this.lightningFlash,
        prompt: this.prompt,
      };
      this.ui.hud(state);
    }

    hudReady() {
      return this.state === "playing" || this.state === "paused" || this.state === "gameover" || this.state === "victory";
    }

    _updateGameOver(dt) {
      this.lightningFlash = Math.max(0, this.lightningFlash - dt * 5);
      this.world.update(dt, this.gameTime + dt, this.player.position);
      this.fx.update(dt);
    }

    /* ---------------- rendering ---------------- */
    _render(dt) {
      if (!this.renderer) return;
      const isMenu = this.state === "menu" || this.state === "loading";
      this.post.camera = isMenu ? this.menuCamera : this.camera;
      const overlayOn = !this.debugNoWeapon && !isMenu && this.state !== "gameover" && this.state !== "victory";
      this.post.params.damage = isMenu ? 0 : DL.clamp(Math.max(this.damageFlash, this.player ? this.player.damageFlash : 0), 0, 1.2);
      this.post.params.lowHealth = isMenu || !this.player ? 0 : DL.clamp((40 - this.player.health) / 55, 0, 0.8);
      this.post.params.flash = isMenu ? this.lightningFlash * 0.5 : this.lightningFlash;
      this.post.params.fade = this.fade;
      const day = this.timeOfDay === "day";
      this.post.params.exposure = isMenu ? (day ? 1.12 : 1.72) : (day ? 0.96 : 1.3);
      this.post.update(dt);
      this.post.render(dt, overlayOn ? this.weapons.viewScene : null, overlayOn ? this.weapons.viewCamera : null);
      if (this.perfOn && $("perf")) {
        const info = this.renderer.info;
        $("perf").textContent = Math.round(this.fpsAvg) + " FPS  |  " + info.render.calls + " CALLS  |  " + (info.render.triangles / 1000).toFixed(0) + "K TRIS  |  " + this.qualityName.toUpperCase();
      }
    }

    _loop(now) {
      this.raf = requestAnimationFrame(this._loop.bind(this));
      const rawDt = (now - this.last) / 1000;
      const dt = DL.clamp(rawDt, 0, 0.05);
      this.last = now;
      this.fpsAvg = this.fpsAvg * 0.94 + (1000 / Math.max(1, rawDt)) * 0.06;
      if (this.renderer) this.renderer.info.reset();
      if (this.state === "loading") { this._render(0); return; }
      if (this.state === "menu") {
        this._updateMenu(dt);
      } else if (this.state === "playing") {
        this._updatePlaying(dt);
      } else if (this.state === "paused") {
        // keep subtle world flicker frozen, but animate post grain
      } else if (this.state === "gameover" || this.state === "victory") {
        this._updateGameOver(dt);
        this._updateHUD();
      }
      this._render(dt);
      this.input.endFrame();
    }

    resize() {
      if (!this.renderer) return;
      const w = window.innerWidth, h = window.innerHeight;
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.quality.pixelRatio) * this.adaptiveScale);
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / Math.max(1, h);
      this.camera.updateProjectionMatrix();
      this.menuCamera.aspect = w / Math.max(1, h);
      this.menuCamera.updateProjectionMatrix();
      if (this.weapons) this.weapons.onResize(w, h);
      if (this.post) this.post.setSize(w, h);
    }

    applyQuality(q) {
      this.qualityName = q;
      this.quality = Object.assign({}, DL.Quality[q] || DL.Quality.high);
      if (!this.renderer) return;
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.quality.pixelRatio));
      this.post.quality.bloom = this.quality.bloom;
      this.post.params.bloomStrength = this.quality.bloom ? 0.85 : 0;
      this.post.setSize(window.innerWidth, window.innerHeight);
      // update shadow map sizes where possible
      this.scene.traverse((o) => {
        if (o.isLight && o.shadow && o.shadow.map) {
          o.shadow.mapSize.set(this.quality.shadowMapSize, this.quality.shadowMapSize);
          if (o.shadow.map) { o.shadow.map.dispose(); o.shadow.map = null; }
          o.shadow.needsUpdate = true;
        }
      });
      this.ui.toast("GRAPHICS PRESET: " + q.toUpperCase());
    }
  }

  let booted = false;
  function boot() {
    if (booted) return;
    booted = true;
    const game = new Game();
    game.init();
  }
  window.addEventListener("DOMContentLoaded", boot);
  if (document.readyState === "complete" || document.readyState === "interactive") boot();
})();
