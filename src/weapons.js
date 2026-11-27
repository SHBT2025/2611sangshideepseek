/* ============================================================
   DEADLIGHT // first-person weapon system
   Detailed procedural viewmodels, animated handling, hitscan.
   ============================================================ */
(function () {
  "use strict";
  const DL = (window.DL = window.DL || {});
  const TAU = Math.PI * 2;

  const WEAPON_DEFS = {
    rifle: {
      id: "rifle", name: "MK-18 ASSAULT RIFLE", slot: 1, auto: true,
      rpm: 690, damage: 33, headMult: 2.7, magSize: 30,
      reserveMax: 330, reloadTime: 2.05, adsFov: 48,
      spreadHip: 0.016, spreadAds: 0.0028, spreadMove: 0.014,
      recoilPitch: 0.022, recoilYaw: 0.006, recoilKick: 0.052,
      sound: "rifle", caliber: "5.56 MM", fireMode: "AUTO", tracer: true,
    },
    pistol: {
      id: "pistol", name: "M9 SIDEARM", slot: 2, auto: false,
      rpm: 390, damage: 42, headMult: 3.0, magSize: 15,
      reserveMax: 120, reloadTime: 1.55, adsFov: 54,
      spreadHip: 0.011, spreadAds: 0.0022, spreadMove: 0.011,
      recoilPitch: 0.028, recoilYaw: 0.008, recoilKick: 0.045,
      sound: "pistol", caliber: "9 MM", fireMode: "SEMI", tracer: false,
    },
  };

  function makeMat(color, metalness, roughness, envInt) {
    return new THREE.MeshStandardMaterial({
      color, metalness, roughness,
      envMapIntensity: envInt != null ? envInt : 1.1,
    });
  }

  function makeMuzzleTexture() {
    const { canvas, ctx } = DL.makeCanvas(128, 128);
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, "rgba(255,255,240,1)");
    g.addColorStop(0.18, "rgba(255,222,150,.95)");
    g.addColorStop(0.42, "rgba(255,154,60,.5)");
    g.addColorStop(1, "rgba(255,100,20,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    ctx.save();
    ctx.translate(64, 64);
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < 8; i++) {
      ctx.rotate(Math.PI / 4);
      const grd = ctx.createLinearGradient(0, 0, 64, 0);
      grd.addColorStop(0, "rgba(255,240,190,.9)");
      grd.addColorStop(1, "rgba(255,120,30,0)");
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.moveTo(0, -2.5); ctx.lineTo(62, 0); ctx.lineTo(0, 2.5); ctx.fill();
    }
    ctx.restore();
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  class WeaponSystem {
    constructor(o) {
      this.camera = o.camera;
      this.scene = o.scene;
      this.world = o.world;
      this.horde = o.horde;
      this.fx = o.fx;
      this.audio = o.audio;
      this.callbacks = o.callbacks || {};
      this.quality = o.quality;
      this.baseFov = o.baseFov || 78;
      this.sensitivity = 1;
      this.time = 0;
      this.adsT = 0;
      this.adsTarget = 0;
      this.lowerT = 0;
      this.crosshairBloom = 0;
      this.shotsFired = 0;
      this.shotsHit = 0;
      this.headshotCount = 0;
      this.cooldown = 0;
      this.firedThisPress = false;
      this.reloading = false;
      this.reloadElapsed = 0;
      this.reloadDuration = 2;
      this.switching = false;
      this.switchElapsed = 0;
      this.switchDuration = 0.55;
      this.switchTargetId = null;
      this.magEmptyPing = false;
      this.recoil = 0;
      this.recoilVel = 0;
      this.recoilPitch = 0;
      this.recoilYaw = 0;
      this.swayX = 0;
      this.swayY = 0;
      this.bobPhase = 0;
      this.bobAmt = 0;
      this.idlePhase = Math.random() * 10;
      this.flashTimer = 0;
      this.wasFiring = false;
      this.lastShotTime = -10;

      this.weapons = {};
      for (const k in WEAPON_DEFS) {
        this.weapons[k] = {
          def: WEAPON_DEFS[k],
          mag: WEAPON_DEFS[k].id === "rifle" ? 30 : 15,
          reserve: WEAPON_DEFS[k].id === "rifle" ? 120 : 45,
          group: null,
          magMesh: null,
          boltMesh: null,
        };
      }
      this.activeId = "rifle";
      this.lastId = "pistol";
      this.raycaster = new THREE.Raycaster();
      this.raycaster.far = 90;
      this._buildViewScene();
      this._buildWeapons();
      this._emitAmmo(true);
      this._emitWeapon();
    }

    /* ---------------- viewmodel scene ---------------- */
    _buildViewScene() {
      const v = (this.viewScene = new THREE.Scene());
      this.viewCamera = new THREE.PerspectiveCamera(62, 16 / 9, 0.01, 10);
      this.viewScene.environment = this.scene.environment || null;
      this.viewScene.environmentIntensity = 0.85;
      this.viewScene.environmentIntensity = 1.1;
      const ambient = new THREE.AmbientLight(0x2a3949, 0.85);
      v.add(ambient);
      const hemi = new THREE.HemisphereLight(0x9db4c8, 0x15171a, 1.15);
      v.add(hemi);
      const key = new THREE.DirectionalLight(0xffe3c2, 3.1);
      key.position.set(-1.4, 1.7, -2.3);
      v.add(key);
      const rim = new THREE.DirectionalLight(0x7fa9bd, 0.72);
      rim.position.set(1.8, 0.8, 1.3);
      v.add(rim);
      const fill = new THREE.PointLight(0x8faec6, 2.2, 4, 2);
      fill.position.set(-0.5, -0.1, -1.15);
      v.add(fill);
      this.viewFill = fill;

      this.weaponRoot = new THREE.Group();
      this.weaponRoot.name = "weapon-root";
      v.add(this.weaponRoot);
      this.muzzleAnchor = new THREE.Group();
      this.muzzleAnchor.position.set(0, 0.04, -0.72);
      this.weaponRoot.add(this.muzzleAnchor);
    }

    _buildMaterials() {
      const scratch = DL.noiseTexture(256, 256, { base: [120, 120, 120], variance: 48, scale: 18, streak: 18, seed: 4 });
      this.scratchTex = DL.canvasTexture(scratch, 2, 2, false);
      this.scratchNormal = DL.normalMapFromHeight(scratch, 0.8);
      const scratchRough = DL.noiseTexture(256, 256, { base: [120, 120, 120], variance: 60, scale: 26, seed: 11 });
      this.roughTex = DL.canvasTexture(scratchRough, 3, 3, false);
      this.mats = {
        metal: (() => {
          const m = makeMat(0x424b51, 0.82, 0.32, 1.35);
          m.roughnessMap = this.roughTex;
          m.normalMap = this.scratchNormal;
          m.normalScale.set(0.22, 0.22);
          return m;
        })(),
        darkMetal: (() => {
          const m = makeMat(0x232a2f, 0.8, 0.42, 1.15);
          m.normalMap = this.scratchNormal;
          m.normalScale.set(0.18, 0.18);
          return m;
        })(),
        polymer: makeMat(0x292e2b, 0.18, 0.68, 0.7),
        tan: makeMat(0x4a4a3b, 0.25, 0.62, 0.7),
        glove: makeMat(0x151713, 0.05, 0.92, 0.35),
        glovePad: makeMat(0x242820, 0.1, 0.82, 0.4),
        skin: makeMat(0x6b4a37, 0.0, 0.78, 0.3),
        brass: makeMat(0xb08a3f, 0.95, 0.24, 1.7),
        lens: new THREE.MeshStandardMaterial({ color: 0x0a1a20, metalness: 0.5, roughness: 0.08, emissive: 0x0a303b, emissiveIntensity: 0.55 }),
        redDot: new THREE.MeshBasicMaterial({ color: 0xff2d16 }),
        reticle: new THREE.MeshBasicMaterial({ color: 0xff5a3a, transparent: true, opacity: 0.9 }),
        flashlightLens: new THREE.MeshStandardMaterial({ color: 0xffe6b0, emissive: 0xffc97a, emissiveIntensity: 1.3 }),
      };
    }

    _addPart(parent, geo, mat, x, y, z, rx, ry, rz) {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      if (rx) m.rotation.x = rx;
      if (ry) m.rotation.y = ry;
      if (rz) m.rotation.z = rz;
      parent.add(m);
      return m;
    }
    _box(w, h, d) { return new THREE.BoxGeometry(w, h, d); }
    _cyl(r1, r2, len, seg) { return new THREE.CylinderGeometry(r1, r2, len, seg || 12); }

    _buildWeapons() {
      this._buildMaterials();
      this._buildRifle();
      this._buildPistol();
      this._selectGroup(this.activeId);
    }

    _buildRifle() {
      const g = new THREE.Group();
      g.name = "rifle";
      this.weaponRoot.add(g);
      const M = this.mats;
      // Receiver & upper
      this._addPart(g, this._box(0.064, 0.085, 0.38), M.metal, 0, 0.015, -0.09);
      this._addPart(g, this._box(0.058, 0.036, 0.32), M.darkMetal, 0, 0.068, -0.12);
      this._addPart(g, this._box(0.072, 0.022, 0.20), M.tan, 0, -0.028, -0.20);
      // Top rail teeth
      for (let i = 0; i < 9; i++) {
        this._addPart(g, this._box(0.056, 0.008, 0.012), M.darkMetal, 0, 0.09, -0.25 + i * 0.035);
      }
      // Handguard
      this._addPart(g, this._box(0.07, 0.068, 0.28), M.polymer, 0, 0.004, -0.37);
      for (let i = 0; i < 6; i++) {
        this._addPart(g, this._box(0.073, 0.009, 0.025), M.darkMetal, 0, 0.042, -0.46 + i * 0.036);
      }
      for (let i = 0; i < 4; i++) {
        this._addPart(g, this._box(0.008, 0.026, 0.09), M.darkMetal, i % 2 ? 0.038 : -0.038, -0.01, -0.38 + (i >> 1) * 0.1);
      }
      // Barrel, gas block, muzzle brake
      this._addPart(g, this._cyl(0.012, 0.012, 0.38, 12), M.darkMetal, 0, 0.018, -0.55, Math.PI / 2, 0, 0);
      this._addPart(g, this._box(0.032, 0.042, 0.055), M.metal, 0, 0.045, -0.52);
      this._addPart(g, this._cyl(0.022, 0.024, 0.07, 12), M.metal, 0, 0.018, -0.75, Math.PI / 2, 0, 0);
      for (let i = 0; i < 3; i++) {
        this._addPart(g, this._box(0.05, 0.008, 0.009), M.darkMetal, 0, 0.018 + (i - 1) * 0.012, -0.775);
      }
      // Gas tube
      this._addPart(g, this._cyl(0.006, 0.006, 0.3, 8), M.darkMetal, 0, 0.052, -0.42, Math.PI / 2, 0, 0);
      // Stock (hidden while aiming down sights, as the eye moves ahead of the buttstock)
      const stock = new THREE.Group();
      g.add(stock);
      this.rifleStock = stock;
      this._addPart(stock, this._box(0.046, 0.07, 0.22), M.polymer, 0, 0.0, 0.20);
      this._addPart(stock, this._box(0.055, 0.095, 0.045), M.polymer, 0, -0.008, 0.31);
      this._addPart(stock, this._box(0.05, 0.03, 0.09), M.tan, 0, 0.058, 0.18);
      this._addPart(stock, this._box(0.012, 0.063, 0.05), M.metal, 0, -0.008, 0.288);
      // Grip
      this._addPart(g, this._box(0.043, 0.125, 0.055), M.polymer, 0, -0.095, 0.065, 0.28, 0, 0);
      this._addPart(g, this._box(0.045, 0.02, 0.06), M.polymer, 0, -0.16, 0.085, 0.28, 0, 0);
      // Trigger guard + trigger
      this._addPart(g, this._box(0.012, 0.008, 0.09), M.metal, 0, -0.055, 0.0);
      this._addPart(g, this._box(0.012, 0.03, 0.008), M.metal, 0, -0.045, -0.03, 0.4, 0, 0);
      this._addPart(g, this._box(0.009, 0.028, 0.008), M.darkMetal, 0, -0.038, 0.015, -0.3, 0, 0);
      // Magazine (animated)
      const mag = new THREE.Group();
      mag.position.set(0, -0.078, -0.075);
      mag.rotation.x = -0.16;
      g.add(mag);
      const magBody = this._addPart(mag, this._box(0.045, 0.17, 0.07), M.darkMetal, 0, -0.085, 0);
      magBody.rotation.x = -0.08;
      for (let i = 0; i < 4; i++) this._addPart(mag, this._box(0.048, 0.008, 0.072), M.metal, 0, -0.02 - i * 0.038, 0.004);
      this._addPart(mag, this._box(0.05, 0.012, 0.075), M.tan, 0, -0.172, 0.0);
      this.rifleMag = mag;
      // Optic
      this._addPart(g, this._box(0.045, 0.02, 0.085), M.darkMetal, 0, 0.1, -0.09);
      this._addPart(g, this._cyl(0.033, 0.033, 0.12, 16), M.darkMetal, 0, 0.13, -0.09, Math.PI / 2, 0, 0);
      this._addPart(g, this._cyl(0.039, 0.039, 0.016, 16), M.metal, 0, 0.13, -0.026, Math.PI / 2, 0, 0);
      const lensFront = this._addPart(g, this._cyl(0.028, 0.028, 0.008, 16), M.lens, 0, 0.13, -0.15, Math.PI / 2, 0, 0);
      this._addPart(g, this._cyl(0.026, 0.026, 0.008, 16), M.lens, 0, 0.13, -0.032, Math.PI / 2, 0, 0);
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.0022, 6, 6), M.redDot);
      dot.position.set(0, 0.13, -0.145);
      g.add(dot);
      this.rifleDot = dot;
      // Aiming reticle: a crisp red dot + fine cross only visible down the optic.
      const reticle = new THREE.Group();
      const rm = new THREE.MeshBasicMaterial({ color: 0xff4930, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending });
      const rDot = new THREE.Mesh(new THREE.SphereGeometry(0.0026, 7, 7), rm);
      reticle.add(rDot);
      const rh = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.0011, 0.001), rm);
      rh.position.x = 0; reticle.add(rh);
      const rv = new THREE.Mesh(new THREE.BoxGeometry(0.0011, 0.024, 0.001), rm);
      reticle.add(rv);
      reticle.position.set(0, 0.13, -0.158);
      reticle.renderOrder = 50;
      reticle.visible = false;
      g.add(reticle);
      this.rifleReticle = reticle;
      // Optic knobs
      this._addPart(g, this._cyl(0.011, 0.011, 0.012, 10), M.metal, 0.03, 0.13, -0.09, 0, 0, Math.PI / 2);
      // Flashlight
      this._addPart(g, this._cyl(0.014, 0.016, 0.09, 12), M.darkMetal, 0.048, 0.012, -0.38, Math.PI / 2, 0, 0);
      this._addPart(g, this._cyl(0.017, 0.017, 0.006, 12), M.flashlightLens, 0.048, 0.012, -0.426, Math.PI / 2, 0, 0);
      // Charging handle
      this.charging = this._addPart(g, this._box(0.055, 0.012, 0.016), M.metal, 0.036, 0.055, -0.02);
      // Sling / cable detail
      this._addPart(g, this._cyl(0.004, 0.004, 0.25, 6), M.tan, -0.036, -0.02, 0.02, 0.2, 0.2, 1.1);
      // Hands
      this._buildHands(g, "rifle");
      // Muzzle flash
      const flashTex = makeMuzzleTexture();
      this.muzzleMat = new THREE.SpriteMaterial({ map: flashTex, color: 0xffd9a0, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 });
      const flash = new THREE.Sprite(this.muzzleMat);
      flash.scale.set(0.36, 0.36, 1);
      flash.position.set(0, 0.02, -0.79);
      g.add(flash);
      this.rifleFlash = flash;
      const mflash = new THREE.PointLight(0xffb060, 0, 1.6, 2);
      mflash.position.set(0, 0.02, -0.85);
      g.add(mflash);
      this.rifleFlashLight = mflash;
      // shell eject point
      this.rifleEject = new THREE.Vector3(0.06, 0.06, -0.05);
      this.weapons.rifle.group = g;
      this.weapons.rifle.magMesh = mag;
      this.weapons.rifle.boltMesh = this.charging;
      this.weapons.rifle.muzzle = flash;
      this.weapons.rifle.flashLight = mflash;
    }

    _buildPistol() {
      const g = new THREE.Group();
      g.name = "pistol";
      this.weaponRoot.add(g);
      const M = this.mats;
      // Slide
      this._addPart(g, this._box(0.04, 0.048, 0.21), M.metal, 0, 0.045, -0.14);
      this._addPart(g, this._box(0.038, 0.026, 0.17), M.darkMetal, 0, 0.02, -0.16);
      this._addPart(g, this._box(0.042, 0.008, 0.19), M.darkMetal, 0, 0.073, -0.14);
      // Slide serrations
      for (let i = 0; i < 6; i++) this._addPart(g, this._box(0.043, 0.018, 0.004), M.darkMetal, 0, 0.05, -0.06 + i * 0.007);
      // Barrel
      this._addPart(g, this._cyl(0.011, 0.011, 0.035, 12), M.metal, 0, 0.047, -0.255, Math.PI / 2, 0, 0);
      this._addPart(g, this._cyl(0.007, 0.007, 0.01, 10), M.darkMetal, 0, 0.047, -0.273, Math.PI / 2, 0, 0);
      // Frame & trigger guard
      this._addPart(g, this._box(0.034, 0.032, 0.15), M.polymer, 0, -0.005, -0.11);
      this._addPart(g, this._box(0.008, 0.006, 0.075), M.polymer, 0, -0.038, -0.09);
      this._addPart(g, this._box(0.007, 0.03, 0.007), M.darkMetal, 0, -0.02, -0.062);
      // Grip
      this._addPart(g, this._box(0.035, 0.115, 0.055), M.polymer, 0, -0.085, -0.015, 0.18, 0, 0);
      this._addPart(g, this._box(0.037, 0.02, 0.058), M.darkMetal, 0, -0.143, -0.005, 0.18, 0, 0);
      // Magazine base
      this._addPart(g, this._box(0.03, 0.012, 0.048), M.metal, 0, -0.155, -0.006, 0.18, 0, 0);
      // Sights
      this._addPart(g, this._box(0.007, 0.014, 0.009), M.darkMetal, 0, 0.079, -0.245);
      this._addPart(g, this._box(0.028, 0.012, 0.009), M.darkMetal, 0, 0.079, -0.035);
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.0013, 6, 6), M.redDot);
      dot.position.set(0, 0.085, -0.245);
      g.add(dot);
      this.pistolDot = dot;
      // Hands
      this._buildHands(g, "pistol");
      const flashTex = makeMuzzleTexture();
      this.pistolMuzzleMat = new THREE.SpriteMaterial({ map: flashTex, color: 0xffd9a0, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 });
      const flash = new THREE.Sprite(this.pistolMuzzleMat);
      flash.scale.set(0.22, 0.22, 1);
      flash.position.set(0, 0.045, -0.31);
      g.add(flash);
      this.pistolFlash = flash;
      const fl = new THREE.PointLight(0xffb060, 0, 1.3, 2);
      fl.position.set(0, 0.045, -0.33);
      g.add(fl);
      this.pistolFlashLight = fl;
      this.weapons.pistol.group = g;
      this.weapons.pistol.magMesh = null;
      this.weapons.pistol.boltMesh = null;
      this.weapons.pistol.muzzle = flash;
      this.weapons.pistol.flashLight = fl;
    }

    _buildHands(g, type) {
      const M = this.mats;
      const glove = M.glove, pad = M.glovePad;
      const mkHand = (x, y, z, rx, ry, rz, scale) => {
        const h = new THREE.Group();
        h.position.set(x, y, z);
        h.rotation.set(rx, ry, rz);
        h.scale.setScalar(scale || 1);
        // palm
        const palm = new THREE.Mesh(new THREE.SphereGeometry(0.042, 10, 8), glove);
        palm.scale.set(1, 0.75, 1.35);
        h.add(palm);
        // back pad
        const p = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.018, 0.07), pad);
        p.position.y = 0.026;
        h.add(p);
        // fingers wrap
        for (let i = 0; i < 4; i++) {
          const f = new THREE.Mesh(new THREE.CapsuleGeometry(0.009, 0.045, 3, 6), glove);
          f.rotation.z = Math.PI / 2;
          f.position.set(0.005, 0.012, -0.03 + i * 0.02);
          f.rotation.y = 0.2;
          h.add(f);
        }
        // thumb
        const th = new THREE.Mesh(new THREE.CapsuleGeometry(0.011, 0.04, 3, 6), glove);
        th.rotation.x = 0.8;
        th.rotation.z = -0.5;
        th.position.set(-0.03, 0.005, -0.005);
        h.add(th);
        return h;
      };
      // Forearm
      const forearm = new THREE.Group();
      forearm.position.set(0.14, -0.34, 0.20);
      forearm.rotation.set(0.95, 0.18, -0.22);
      forearm.scale.setScalar(0.8);
      const skin = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.043, 0.24, 10), M.glove);
      skin.rotation.x = 0.2;
      skin.position.y = -0.1;
      forearm.add(skin);
      const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.04, 0.05, 10), pad);
      cuff.position.y = 0.02;
      forearm.add(cuff);
      g.add(forearm);

      if (type === "rifle") {
        const right = mkHand(0.0, -0.125, 0.075, 0.15, 0, 0.08, 1.0);
        g.add(right);
        const left = mkHand(-0.012, -0.055, -0.36, 0, 0, -0.35, 0.97);
        g.add(left);
        // left forearm
        const lf = new THREE.Group();
        lf.position.set(-0.15, -0.25, -0.22);
        lf.rotation.set(1.0, -0.3, 0.45);
        lf.scale.setScalar(0.78);
        const lskin = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.04, 0.22, 10), M.glove);
        lskin.rotation.x = 0.2;
        lskin.position.y = -0.09;
        lf.add(lskin);
        g.add(lf);
      } else {
        const right = mkHand(0.0, -0.095, 0.0, 0.12, 0, 0.08, 1.0);
        g.add(right);
        const left = mkHand(-0.012, -0.095, 0.005, 0.1, 0, -0.25, 0.95);
        g.add(left);
      }
    }

    _selectGroup(id) {
      for (const k in this.weapons) {
        if (this.weapons[k].group) this.weapons[k].group.visible = k === id;
      }
    }

    /* ---------------- public state ---------------- */
    get current() { return this.weapons[this.activeId]; }
    get def() { return this.weapons[this.activeId].def; }
    get adsFov() { return DL.lerp(this.baseFov, this.def.adsFov, this.adsT); }
    getAmmo() {
      const w = this.current;
      return { mag: w.mag, reserve: w.reserve, magSize: w.def.magSize, reserveMax: w.def.reserveMax, id: this.activeId, name: w.def.name };
    }
    getStats() {
      return {
        shots: this.shotsFired,
        hits: this.shotsHit,
        headshots: this.headshotCount,
        accuracy: this.shotsFired > 0 ? (this.shotsHit / this.shotsFired) * 100 : 0,
      };
    }
    _emitAmmo(force) {
      if (this.callbacks.onAmmoChange) this.callbacks.onAmmoChange(this.getAmmo(), force);
    }
    _emitWeapon() {
      if (this.callbacks.onWeaponChange) this.callbacks.onWeaponChange(this.def, this.activeId);
    }

    addAmmo(type, amount) {
      if (type === "rifle" || type === "all") {
        const w = this.weapons.rifle;
        w.reserve = Math.min(w.def.reserveMax, w.reserve + amount);
      }
      if (type === "pistol" || type === "all") {
        const w = this.weapons.pistol;
        w.reserve = Math.min(w.def.reserveMax, w.reserve + Math.ceil(amount * 0.4));
      }
      if (type === "all") {
        this.weapons.pistol.reserve = Math.min(this.weapons.pistol.def.reserveMax, this.weapons.pistol.reserve + 18);
      }
      this._emitAmmo(true);
    }

    startReload() {
      if (this.reloading || this.switching) return false;
      const w = this.current;
      if (w.mag >= w.def.magSize || w.reserve <= 0) {
        if (w.reserve <= 0) this.audio && this.audio.play("dryfire", { volume: 0.4 });
        return false;
      }
      this.reloading = true;
      this.reloadElapsed = 0;
      this.reloadDuration = w.def.reloadTime;
      this.adsTarget = 0;
      this.audio && this.audio.play("reload_out", { volume: 0.8 });
      this.callbacks.onReloadStart && this.callbacks.onReloadStart(w.def);
      return true;
    }

    switchTo(id) {
      if (!this.weapons[id] || id === this.activeId || this.switching) return false;
      this.switching = true;
      this.switchElapsed = 0;
      this.switchTargetId = id;
      this.reloading = false;
      this.audio && this.audio.play("equip", { volume: 0.65, rate: 0.9 });
      return true;
    }

    toggleWeapon() {
      this.switchTo(this.activeId === "rifle" ? "pistol" : "rifle");
    }

    /* ---------------- firing ---------------- */
    _muzzleWorld(out) {
      const cam = this.camera;
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
      return out.copy(cam.position).addScaledVector(right, 0.16).addScaledVector(up, -0.11).addScaledVector(fwd, 0.72);
    }

    fire() {
      const w = this.current;
      if (this.reloading || this.switching) return;
      if (this.cooldown > 0) return;
      if (w.mag <= 0) {
        this.audio && this.audio.play("dryfire", { volume: 0.55 });
        this.cooldown = 0.2;
        this._emitAmmo(true);
        this.callbacks.onDryfire && this.callbacks.onDryfire();
        return;
      }
      w.mag--;
      this.shotsFired++;
      this.cooldown = 60 / w.def.rpm;
      this.adsTarget = this.adsT > 0.55 ? this.adsTarget : 0;
      this.recoilVel += w.def.recoilKick * (this.adsT > 0.5 ? 0.6 : 1.0);
      this.recoilPitch += w.def.recoilPitch * (this.adsT > 0.5 ? 0.55 : 1.0) * (0.85 + Math.random() * 0.3);
      this.recoilYaw += (Math.random() - 0.5) * w.def.recoilYaw * 2;
      this.crosshairBloom = Math.min(1, this.crosshairBloom + 0.2);
      this.flashTimer = 0.055;
      this.lastShotTime = this.time;

      const spread = DL.lerp(w.def.spreadHip, w.def.spreadAds, this.adsT) * (1 + this.crosshairBloom * 1.2);
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
      const r = Math.sqrt(Math.random()) * spread;
      const a = Math.random() * TAU;
      dir.addScaledVector(right, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r).normalize();

      this.raycaster.set(this.camera.position, dir);
      const hordeMeshes = this.horde && this.horde.getAimMeshes ? this.horde.getAimMeshes() : [];
      const worldMeshes = this.world && this.world.raycastMeshes ? this.world.raycastMeshes : [];
      let best = null, bestDist = Infinity, bestKind = null;
      if (hordeMeshes && hordeMeshes.length) {
        const hits = this.raycaster.intersectObjects(hordeMeshes, false);
        if (hits.length) { best = hits[0]; bestDist = hits[0].distance; bestKind = "zombie"; }
      }
      if (worldMeshes && worldMeshes.length) {
        const hits = this.raycaster.intersectObjects(worldMeshes, false);
        if (hits.length && hits[0].distance < bestDist) { best = hits[0]; bestDist = hits[0].distance; bestKind = "world"; }
      }
      if (!best) {
        best = { point: this.camera.position.clone().addScaledVector(dir, 90), distance: 90, normal: dir.clone().negate(), object: null };
        bestKind = "air";
      }

      const muzzle = this._muzzleWorld(new THREE.Vector3());
      if (w.def.tracer) this.fx && this.fx.tracer(muzzle, best.point);

      if (bestKind === "zombie") {
        this.shotsHit++;
        const headshot = !!(best.object.userData && best.object.userData.zone === "head");
        const dmg = w.def.damage * (headshot ? w.def.headMult : 1);
        const impactDir = dir.clone();
        this.fx && this.fx.blood(best.point, dir, headshot);
        let result = null;
        if (this.horde && this.horde.handleHit) {
          result = this.horde.handleHit(best.object, dmg, headshot, best.point, impactDir);
        }
        if (headshot) {
          this.headshotCount++;
          if (result && result.killed) this.audio && this.audio.play("headshot", { volume: 0.9, rate: DL.rand(0.92, 1.08) });
          else this.audio && this.audio.play("headshot", { volume: 0.5, rate: DL.rand(0.95, 1.1) });
        } else {
          this.audio && this.audio.play("hit_flesh", { volume: 0.72, rate: DL.rand(0.9, 1.1) });
        }
        this.callbacks.onHitmarker && this.callbacks.onHitmarker(true, headshot, !!(result && result.killed));
      } else if (bestKind === "world") {
        const n = best.face ? best.face.normal.clone().transformDirection(best.object.matrixWorld) : best.normal;
        const surf = (best.object.userData && best.object.userData.surface) || "concrete";
        this.fx && this.fx.impact(best.point, n, surf);
        const snd = surf === "metal" ? "bullet_metal" : surf === "wood" ? "bullet_wood" : "bullet_concrete";
        this.audio && this.audio.play(snd, { pos: best.point, volume: 0.38, rate: DL.rand(0.92, 1.08) });
        this.callbacks.onHitmarker && this.callbacks.onHitmarker(false, false, false);
      }

      // Muzzle flash & world light
      const wGroup = w.group;
      if (w.muzzle) {
        w.muzzle.material.opacity = 1;
        w.muzzle.material.rotation = Math.random() * TAU;
        const s = DL.rand(0.26, 0.4) * (this.adsT > 0.5 ? 0.7 : 1);
        w.muzzle.scale.set(s, s, 1);
      }
      if (w.flashLight) w.flashLight.intensity = 9;
      this.fx && this.fx.flashLight(muzzle, 0xffb060, 20, 0.055);
      // Shell
      this._ejectShell();
      // Callbacks / audio
      this.audio && this.audio.play(w.def.sound, { volume: 1.0, rate: DL.rand(0.97, 1.035) });
      this.callbacks.onShoot && this.callbacks.onShoot(w.def, this.adsT);
      this.callbacks.onRecoil && this.callbacks.onRecoil(this.recoilPitch, this.recoilYaw);
      this._emitAmmo();
      if (w.mag === 0) {
        this.audio && this.audio.play("bolt", { volume: 0.25 });
      }
    }

    _ejectShell() {
      this.shells = this.shells || [];
      let item = this.shells.find((s) => !s.active);
      if (!item) {
        const geo = new THREE.CylinderGeometry(0.004, 0.004, 0.02, 7);
        const mesh = new THREE.Mesh(geo, this.mats.brass);
        mesh.rotation.z = Math.PI / 2;
        this.viewScene.add(mesh);
        item = { mesh, active: false, vel: new THREE.Vector3(), life: 0 };
        this.shells.push(item);
      }
      item.active = true;
      item.life = 0;
      item.mesh.visible = true;
      item.mesh.position.set(0.22, -0.12, -0.45);
      item.vel.set(DL.rand(0.5, 1.1), DL.rand(0.6, 1.2), DL.rand(0.15, 0.45));
      item.mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    }

    /* ---------------- update ---------------- */
    update(dt, input, playerState) {
      this.time += dt;
      this.cooldown = Math.max(0, this.cooldown - dt);
      this.crosshairBloom = DL.damp(this.crosshairBloom, 0, 5, dt);
      this.flashTimer = Math.max(0, this.flashTimer - dt);
      this.viewCamera.fov = this.camera.fov;
      this.viewCamera.aspect = window.innerWidth / window.innerHeight;
      this.viewCamera.updateProjectionMatrix();
      this.viewScene.environment = this.scene.environment || null;

      const canAct = !playerState || !playerState.dead;
      // ADS state
      this.adsTarget = canAct && input.aiming && !this.reloading && !this.switching ? 1 : 0;
      this.adsT = DL.damp(this.adsT, this.adsTarget, 11, dt);
      const isAds = this.adsT > 0.55;

      // Weapon management inputs
      if (canAct) {
        if (input.pressed && input.pressed("KeyR")) this.startReload();
        if (input.pressed && input.pressed("Digit1")) this.switchTo("rifle");
        if (input.pressed && input.pressed("Digit2")) this.switchTo("pistol");
        if (input.pressed && input.pressed("KeyQ")) this.toggleWeapon();
      }

      // Reload timeline
      if (this.reloading) {
        this.reloadElapsed += dt;
        const t = this.reloadElapsed / this.reloadDuration;
        const mag = this.current.magMesh;
        if (mag) {
          if (t > 0.08 && t < 0.35) {
            mag.visible = true;
            mag.position.y = DL.lerp(-0.078, -0.55, DL.smoothstep(0.08, 0.35, t));
            mag.rotation.z = DL.lerp(0, 0.4, DL.smoothstep(0.08, 0.35, t));
          } else if (t >= 0.35 && t < 0.62) {
            mag.visible = false;
          } else if (t >= 0.62) {
            mag.visible = true;
            const k = DL.smoothstep(0.62, 0.82, t);
            mag.position.y = DL.lerp(-0.55, -0.078, k);
            mag.rotation.z = DL.lerp(0.4, 0, k);
            if (t > 0.72 && !this._reloadClick) {
              this._reloadClick = true;
              this.audio && this.audio.play("reload_in", { volume: 0.9 });
            }
          }
        } else if (t > 0.6 && !this._reloadClick) {
          this._reloadClick = true;
          this.audio && this.audio.play("reload_in", { volume: 0.8 });
        }
        if (t >= 0.92 && !this._boltClick) {
          this._boltClick = true;
          this.audio && this.audio.play("bolt", { volume: 0.55 });
        }
        if (t >= 1) {
          const w = this.current;
          const need = w.def.magSize - w.mag;
          const take = Math.min(need, w.reserve);
          w.mag += take;
          w.reserve -= take;
          this.reloading = false;
          this._reloadClick = false;
          this._boltClick = false;
          if (mag) { mag.position.y = -0.078; mag.rotation.z = 0; mag.visible = true; }
          this._emitAmmo(true);
          this.callbacks.onReloadEnd && this.callbacks.onReloadEnd(w.def);
        }
      }

      // Weapon switch timeline
      if (this.switching) {
        this.switchElapsed += dt;
        const t = this.switchElapsed / this.switchDuration;
        if (t >= 0.5 && this.switchTargetId) {
          this.lastId = this.activeId;
          this.activeId = this.switchTargetId;
          this.switchTargetId = null;
          this._selectGroup(this.activeId);
          this.switching = false;
          this.switchElapsed = 0;
          this.adsT = 0;
          this._emitAmmo(true);
          this._emitWeapon();
          this.audio && this.audio.play("equip", { volume: 0.6, rate: 1.05 });
        }
      }
      this.lowerT = DL.damp(this.lowerT, this.switching || this.reloading ? 1 : 0, 12, dt);

      // Firing
      const trigger = canAct && input.firing && !this.switching && !this.reloading;
      if (trigger) {
        if (this.def.auto) {
          this.fire();
        } else if (!this.firedThisPress) {
          this.firedThisPress = true;
          this.fire();
        }
      }
      if (!input.firing) this.firedThisPress = false;

      if (input.pressed && input.pressed("KeyR") && this.current.mag === 0) { /* auto handled */ }

      // Recoil spring
      const springK = 240, springD = 20;
      const accel = -this.recoil * springK - this.recoilVel * springD;
      this.recoilVel += accel * dt;
      this.recoil += this.recoilVel * dt;
      this.recoilPitch = DL.damp(this.recoilPitch, 0, 28, dt);
      this.recoilYaw = DL.damp(this.recoilYaw, 0, 28, dt);

      // Sway / bob
      const lookDX = playerState ? playerState.lookDX || 0 : 0;
      const lookDY = playerState ? playerState.lookDY || 0 : 0;
      const speed = playerState ? playerState.speed || 0 : 0;
      this.swayX = DL.damp(this.swayX, DL.clamp(-lookDX * 0.0009, -0.03, 0.03), 8, dt);
      this.swayY = DL.damp(this.swayY, DL.clamp(lookDY * 0.0009, -0.03, 0.03), 8, dt);
      this.bobAmt = DL.damp(this.bobAmt, Math.min(1, speed / 6) * (isAds ? 0.25 : 1), 8, dt);
      this.bobPhase += dt * (6 + speed * 1.25);
      const bobX = Math.sin(this.bobPhase) * 0.013 * this.bobAmt;
      const bobY = Math.abs(Math.cos(this.bobPhase)) * 0.011 * this.bobAmt;
      this.idlePhase += dt;
      const breathe = Math.sin(this.idlePhase * 1.5) * 0.0022 * (1 - this.bobAmt);

      const ads = this.adsT;
      const baseX = DL.lerp(0.30, 0.0, ads);
      const baseY = DL.lerp(-0.28, -0.078, ads) + breathe;
      const baseZ = DL.lerp(-0.60, -0.72, ads);
      const lower = this.lowerT;
      const switchLower = this.switching ? Math.sin(Math.min(1, this.switchElapsed / this.switchDuration) * Math.PI) : 0;
      const sprintLower = playerState && playerState.sprinting ? 0.055 : 0;
      const t = this.weaponRoot;
      t.position.set(
        baseX + bobX * (1 - ads * 0.7) + this.swayX * (1 - ads * 0.6),
        baseY + bobY * (1 - ads * 0.7) + this.swayY * (1 - ads * 0.6) - lower * 0.11 - switchLower * 0.23 - sprintLower,
        baseZ + this.recoil + ads * 0.01
      );
      t.rotation.x = this.recoilPitch * 1.5 + this.swayY * 1.5 + lower * 0.5 + switchLower * 0.9;
      t.rotation.y = -this.recoilYaw * 1.4 + this.swayX * 2.5 + (this.switching ? 0.10 : 0) + DL.lerp(0.105, 0, ads);
      t.rotation.z = lower * 0.25 + Math.sin(this.bobPhase * 0.5) * 0.008 * this.bobAmt + DL.lerp(0.01, 0, ads);
      t.scale.setScalar(DL.lerp(0.78, 0.6, ads));
      if (this.rifleStock) this.rifleStock.visible = ads < 0.55;
      if (this.rifleReticle) this.rifleReticle.visible = ads > 0.64;

      // Muzzle flash decay
      const w = this.current;
      if (w.muzzle) {
        if (this.flashTimer <= 0) w.muzzle.material.opacity = 0;
        else w.muzzle.material.opacity = this.flashTimer / 0.055;
      }
      if (w.flashLight) w.flashLight.intensity = DL.damp(w.flashLight.intensity, 0, 55, dt);
      if (this.rifleFlashLight) this.rifleFlashLight.intensity = 0;
      if (this.pistolFlashLight) this.pistolFlashLight.intensity = 0;
      if (this.flashTimer > 0 && w.flashLight) w.flashLight.intensity = 6 * (this.flashTimer / 0.055);

      // Shell physics
      if (this.shells) {
        for (const s of this.shells) {
          if (!s.active) continue;
          s.life += dt;
          s.vel.y -= 9.8 * dt;
          s.mesh.position.addScaledVector(s.vel, dt);
          s.mesh.rotation.x += dt * 8;
          s.mesh.rotation.y += dt * 5;
          if (s.life > 1.4 || s.mesh.position.y < -1.2) { s.active = false; s.mesh.visible = false; }
        }
      }

      // fill light follows muzzle flash for weapon readability
      if (this.viewFill) {
        this.viewFill.intensity = 3.2 + (this.flashTimer > 0 ? 6 : 0) + (playerState && playerState.flashlight ? 2 : 0);
      }
    }

    onResize(w, h) {
      this.viewCamera.aspect = w / Math.max(1, h);
      this.viewCamera.updateProjectionMatrix();
    }

    dispose() {
      DL.disposeObject(this.viewScene);
      if (this.scratchTex) this.scratchTex.dispose();
      if (this.scratchNormal) this.scratchNormal.dispose();
      if (this.roughTex) this.roughTex.dispose();
    }
  }

  DL.WeaponSystem = WeaponSystem;
  DL.WEAPON_DEFS = WEAPON_DEFS;
})();
