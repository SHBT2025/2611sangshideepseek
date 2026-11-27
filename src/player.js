/* ============================================================
   DEADLIGHT // player controller, camera, survival state
   ============================================================ */
(function () {
  "use strict";
  const DL = (window.DL = window.DL || {});

  class Player {
    constructor(o) {
      this.camera = o.camera;
      this.scene = o.scene;
      this.world = o.world;
      this.audio = o.audio;
      this.weapons = o.weapons;
      this.callbacks = o.callbacks || {};
      this.quality = o.quality;
      this.baseFov = o.baseFov || 78;
      this.sensitivity = 1;
      this.invertY = false;
      this.shakeEnabled = true;

      this.position = new THREE.Vector3(0, 0, 12);
      this.velocity = new THREE.Vector3();
      this.radius = 0.36;
      this.eyeHeight = 1.68;
      this.crouchHeight = 1.08;
      this.yaw = Math.PI;
      this.pitch = 0;
      this.stamina = 100;
      this.maxStamina = 100;
      this.health = 100;
      this.maxHealth = 100;
      this.alive = true;
      this.dead = false;
      this.medkits = 2;
      this.boards = 3;
      this.flashlightOn = true;
      this.adsT = 0;
      this.sprinting = false;
      this.crouching = false;
      this.grounded = true;
      this.verticalVelocity = 0;
      this.bobPhase = 0;
      this.bobAmt = 0;
      this.footTimer = 0;
      this.staminaDelay = 0;
      this.stepIndex = 0;
      this.lookDX = 0;
      this.lookDY = 0;
      this.recoilPitch = 0;
      this.recoilYaw = 0;
      this.shake = 0;
      this.shakeTime = 0;
      this.damageFlash = 0;
      this.healFlash = 0;
      this.flashlightFlicker = 0;
      this.time = 0;
      this.distanceWalked = 0;
      this.stats = { damageTaken: 0 };

      this.scene.add(this.camera);
      this._setupFlashlight();
    }

    _setupFlashlight() {
      const light = new THREE.SpotLight(0xffefc9, 0, 48, 0.52, 0.55, 1.35);
      light.position.set(0.10, -0.10, 0.05);
      light.castShadow = false;
      light.target.position.set(0.02, -0.18, -12);
      this.camera.add(light);
      this.camera.add(light.target);
      this.flashlight = light;
      const coneGeo = new THREE.ConeGeometry(2.2, 9, 20, 1, true);
      coneGeo.translate(0, -4.5, 0);
      coneGeo.rotateX(-Math.PI / 2);
      const coneMat = new THREE.MeshBasicMaterial({
        color: 0xffe6b0, transparent: true, opacity: 0.015,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      });
      this.cone = new THREE.Mesh(coneGeo, coneMat);
      this.cone.position.set(0.1, -0.08, -0.2);
      this.cone.rotation.x = Math.PI;
      this.camera.add(this.cone);
      this.cone.visible = false;
    }

    reset(spawn) {
      this.position.copy(spawn || new THREE.Vector3(0, 0, 12));
      this.position.y = 0;
      this.velocity.set(0, 0, 0);
      this.verticalVelocity = 0;
      this.yaw = 0;
      this.pitch = 0;
      this.health = 100;
      this.stamina = 100;
      this.alive = true;
      this.dead = false;
      this.medkits = 2;
      this.boards = 3;
      this.staminaDelay = 0;
      this.recoilPitch = 0;
      this.recoilYaw = 0;
      this.shake = 0;
      this.damageFlash = 0;
      this.flashlightOn = true;
      this.time = 0;
      this.stats.damageTaken = 0;
      this.bobPhase = 0;
      this.bobAmt = 0;
      this.footTimer = 0;
      this.camera.position.copy(this.position);
      this.camera.position.y = this.eyeHeight;
      this.camera.rotation.set(0, this.yaw, 0, "YXZ");
      this.flashlight.intensity = 46;
    }

    setSensitivity(v) { this.sensitivity = v; }
    setBaseFov(f) { this.baseFov = f; }

    onMouseDelta(dx, dy) {
      if (!this.alive) return;
      const s = 0.00215 * this.sensitivity * (this.adsT > 0.5 ? 0.62 : 1);
      this.yaw -= dx * s;
      this.pitch -= dy * s * (this.invertY ? -1 : 1);
      this.pitch = DL.clamp(this.pitch, -1.46, 1.42);
      this.lookDX = dx;
      this.lookDY = dy;
    }

    addRecoil(pitch, yaw) {
      this.recoilPitch += pitch;
      this.recoilYaw += yaw;
      this.shake = Math.min(1.4, this.shake + 0.12);
    }

    addShake(amount) {
      if (!this.shakeEnabled) return;
      this.shake = Math.min(1.8, this.shake + amount);
    }

    damage(amount, fromPos) {
      if (!this.alive || amount <= 0) return false;
      amount *= 1;
      this.health -= amount;
      this.stats.damageTaken += amount;
      this.damageFlash = Math.min(1, this.damageFlash + amount / 32);
      this.addShake(Math.min(0.85, amount / 30));
      this.audio && this.audio.play("hurt", { volume: 0.75, rate: DL.rand(0.92, 1.06) });
      if (this.callbacks.onDamage) this.callbacks.onDamage(amount, fromPos);
      if (this.health <= 0) {
        this.health = 0;
        this.alive = false;
        this.dead = true;
        this.audio && this.audio.play("defeat", { volume: 0.9 });
        if (this.callbacks.onDeath) this.callbacks.onDeath();
      }
      return true;
    }

    heal(amount) {
      if (!this.alive) return;
      this.health = Math.min(this.maxHealth, this.health + amount);
      this.healFlash = 0.7;
      this.audio && this.audio.play("heal", { volume: 0.6 });
    }

    useMedkit() {
      if (!this.alive) return false;
      if (this.medkits <= 0 || this.health >= this.maxHealth) {
        if (this.medkits <= 0) this.callbacks.onToast && this.callbacks.onToast("NO MEDKITS REMAINING");
        return false;
      }
      this.medkits--;
      this.heal(45);
      this.callbacks.onToast && this.callbacks.onToast("MEDKIT APPLIED");
      return true;
    }

    addMedkits(n) { this.medkits = Math.min(5, this.medkits + n); }
    addBoards(n) { this.boards = Math.min(8, this.boards + n); }

    _colliders() {
      const list = this.world && this.world.colliders ? this.world.colliders : [];
      return list;
    }

    _barricadeColliders() {
      const list = [];
      if (!this.world || !this.world.barricades) return list;
      for (const b of this.world.barricades) {
        if (!b || b.broken || b.blocked === false) continue;
        const pos = b.position;
        const horizontal = Math.abs(b.normal ? b.normal.x : 0) > 0.5;
        const halfW = (b.width || 6) / 2;
        const thick = b.thickness || 0.65;
        if (horizontal) {
          list.push({ minX: pos.x - thick, maxX: pos.x + thick, minZ: pos.z - halfW, maxZ: pos.z + halfW, height: 2.4, barricade: true });
        } else {
          list.push({ minX: pos.x - halfW, maxX: pos.x + halfW, minZ: pos.z - thick, maxZ: pos.z + thick, height: 2.4, barricade: true });
        }
      }
      return list;
    }

    _moveWithCollision(dx, dz) {
      const r = this.radius;
      let x = this.position.x + dx;
      let z = this.position.z + dz;
      const colliders = this._colliders();
      const bars = this._barricadeColliders();
      const all = colliders.concat(bars);
      // Resolve twice for corners.
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < all.length; i++) {
          const b = all[i];
          if (b.height != null && b.height < 0.24) continue;
          const c = DL.collideCircleAABB(x, z, r, b);
          x = c.x; z = c.z;
        }
      }
      x = DL.clamp(x, -54, 54);
      z = DL.clamp(z, -54, 54);
      this.position.x = x;
      this.position.z = z;
    }

    update(dt, input) {
      if (!this.alive) {
        this._updateCamera(dt, true);
        return;
      }
      this.time += dt;
      this.lookDX = 0; this.lookDY = 0;
      if (input.lookDX) this.onMouseDelta(input.lookDX, input.lookDY || 0);

      // Crouch / flashlight / heal / jump
      if (input.pressed) {
        if (input.pressed("KeyC")) this.crouching = !this.crouching;
        if (input.pressed("KeyF")) {
          this.flashlightOn = !this.flashlightOn;
          this.audio && this.audio.play("ui_click", { volume: 0.4, rate: 1.1 });
        }
        if (input.pressed("KeyH")) this.useMedkit();
        if (input.pressed("Space") && this.grounded) {
          this.verticalVelocity = 4.7;
          this.grounded = false;
        }
      }
      // Auto-stand if no ceiling.
      if (!this.crouching && input.isDown && input.isDown("ControlLeft")) this.crouching = true;

      const fwd = (input.isDown && input.isDown("KeyW") ? 1 : 0) - (input.isDown && input.isDown("KeyS") ? 1 : 0);
      const strafe = (input.isDown && input.isDown("KeyD") ? 1 : 0) - (input.isDown && input.isDown("KeyA") ? 1 : 0);
      const moving = fwd !== 0 || strafe !== 0;
      const wantSprint = input.isDown && input.isDown("ShiftLeft") && fwd > 0 && !this.crouching;
      const aiming = this.weapons && this.weapons.adsT > 0.32;
      this.sprinting = wantSprint && this.stamina > 2 && !aiming;
      this.adsT = this.weapons ? this.weapons.adsT : 0;

      let speed = this.crouching ? 2.15 : this.sprinting ? 7.0 : 4.35;
      if (aiming) speed *= 0.62;
      if (fwd < 0) speed *= 0.82;
      if (strafe !== 0 && fwd === 0) speed *= 0.88;

      // Stamina
      if (this.sprinting) {
        this.stamina = Math.max(0, this.stamina - 21 * dt);
        this.staminaDelay = 1.2;
      } else {
        this.staminaDelay = Math.max(0, this.staminaDelay - dt);
        if (this.staminaDelay <= 0) this.stamina = Math.min(this.maxStamina, this.stamina + 15 * dt);
      }

      // Desired velocity (camera-relative, yaw only)
      const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
      let dx = 0, dz = 0;
      if (moving) {
        const len = Math.hypot(fwd, strafe) || 1;
        const nf = fwd / len, ns = strafe / len;
        dx = (-sin * nf + cos * ns) * speed;
        dz = (-cos * nf - sin * ns) * speed;
      }
      const accel = moving ? (this.grounded ? 13 : 4) : (this.grounded ? 16 : 1.2);
      this.velocity.x = DL.damp(this.velocity.x, dx, accel, dt);
      this.velocity.z = DL.damp(this.velocity.z, dz, accel, dt);
      const horizSpeed = Math.hypot(this.velocity.x, this.velocity.z);
      if (horizSpeed < 0.03) { this.velocity.x = 0; this.velocity.z = 0; }

      // Vertical
      this.verticalVelocity -= 21 * dt;
      this.position.y += this.verticalVelocity * dt;
      if (this.position.y <= 0) {
        this.position.y = 0;
        if (!this.grounded && this.verticalVelocity < -4) {
          this.audio && this.audio.play("land", { volume: 0.55 });
          this.addShake(0.1);
        }
        this.verticalVelocity = 0;
        this.grounded = true;
      }

      this._moveWithCollision(this.velocity.x * dt, this.velocity.z * dt);

      // Head bob / footsteps
      const realSpeed = Math.hypot(this.velocity.x, this.velocity.z);
      this.bobAmt = DL.damp(this.bobAmt, Math.min(1, realSpeed / 5.2), 9, dt);
      this.bobPhase += dt * (4.6 + realSpeed * 1.28);
      if (realSpeed > 0.5) {
        this.distanceWalked += realSpeed * dt;
        this.footTimer -= dt * (this.sprinting ? 1.55 : 1);
        if (this.footTimer <= 0) {
          this.footTimer = this.crouching ? 0.72 : this.sprinting ? 0.30 : 0.46;
          this._footstep();
        }
      }

      // Flashlight fade / subtle flicker
      const targetLight = this.flashlightOn ? 46 : 0;
      let flick = 1;
      if (this.flashlightOn && Math.random() < 0.003) this.flashlightFlicker = 0.16;
      if (this.flashlightFlicker > 0) { this.flashlightFlicker -= dt; flick = 0.3 + Math.random() * 0.6; }
      this.flashlight.intensity = DL.damp(this.flashlight.intensity, targetLight * flick, 18, dt);
      if (this.cone) {
        this.cone.material.opacity = DL.damp(this.cone.material.opacity, this.flashlightOn ? 0.018 : 0, 10, dt);
        this.cone.material.opacity *= 0.9 + Math.random() * 0.2;
      }

      // Camera
      this._updateCamera(dt, false);

      // Recoil camera offsets decay
      this.recoilPitch = DL.damp(this.recoilPitch, 0, 9, dt);
      this.recoilYaw = DL.damp(this.recoilYaw, 0, 9, dt);
      this.shake = Math.max(0, this.shake - dt * 2.5);
      this.damageFlash = Math.max(0, this.damageFlash - dt * 2.2);
      this.healFlash = Math.max(0, this.healFlash - dt * 1.5);

      // Audio listener
      if (this.audio && this.audio.setListener) {
        const fwdVec = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
        this.audio.setListener(
          { x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z },
          { x: fwdVec.x, y: fwdVec.y, z: fwdVec.z },
          { x: 0, y: 1, z: 0 }
        );
      }
      if (this.callbacks.onStep) this.callbacks.onStep();
    }

    _footstep() {
      if (!this.audio) return;
      const inside = this.world && this.world.isInsideCompound ? this.world.isInsideCompound(this.position.x, this.position.z) : (Math.abs(this.position.x) < 20 && Math.abs(this.position.z) < 20);
      let sound;
      if (inside) sound = this.stepIndex % 2 ? "footstep_concrete" : "footstep_mud";
      else sound = "footstep_grass";
      this.stepIndex++;
      this.audio.play(sound, { volume: this.crouching ? 0.17 : this.sprinting ? 0.38 : 0.25, rate: DL.rand(0.88, 1.12) });
    }

    _updateCamera(dt, dead) {
      const eye = this.crouching ? this.crouchHeight : this.eyeHeight;
      const bobY = Math.abs(Math.sin(this.bobPhase)) * 0.032 * this.bobAmt * (1 - this.adsT * 0.6);
      const bobX = Math.sin(this.bobPhase * 0.5) * 0.024 * this.bobAmt * (1 - this.adsT * 0.7);
      let shakeX = 0, shakeY = 0, shakeRoll = 0;
      if (this.shakeEnabled && this.shake > 0.001) {
        const s = this.shake * this.shake;
        const t = performance.now() * 0.001;
        shakeX = (Math.sin(t * 53.1) + Math.sin(t * 31.7)) * 0.008 * s;
        shakeY = (Math.cos(t * 47.3) + Math.sin(t * 27.1)) * 0.007 * s;
        shakeRoll = Math.sin(t * 39.1) * 0.012 * s;
      }
      this.camera.position.set(
        this.position.x + bobX + shakeX,
        this.position.y + eye + bobY + shakeY - (dead ? 1.4 : 0),
        this.position.z
      );
      this.camera.rotation.order = "YXZ";
      this.camera.rotation.y = this.yaw + this.recoilYaw + shakeX * 0.5;
      this.camera.rotation.x = this.pitch + this.recoilPitch + shakeY * 0.6 - (dead ? 0.5 : 0);
      this.camera.rotation.z = shakeRoll + Math.sin(this.bobPhase * 0.5) * 0.0025 * this.bobAmt;

      // FOV: sprint widening, ADS narrowing.
      const ads = this.weapons ? this.weapons.adsT : 0;
      const weaponFov = this.weapons ? this.weapons.def.adsFov : 52;
      let targetFov = DL.lerp(this.baseFov, weaponFov, ads);
      if (this.sprinting) targetFov += 4.2;
      targetFov += this.shake * 1.5;
      this.camera.fov = DL.damp(this.camera.fov, targetFov, 8, dt);
      this.camera.updateProjectionMatrix();
    }

    getState() {
      return {
        speed: Math.hypot(this.velocity.x, this.velocity.z),
        sprinting: this.sprinting,
        crouching: this.crouching,
        grounded: this.grounded,
        adsT: this.adsT,
        lookDX: this.lookDX,
        lookDY: this.lookDY,
        dead: this.dead,
        health: this.health,
        stamina: this.stamina,
        flashlight: this.flashlightOn,
        position: this.position,
      };
    }

    getRayOrigin(out) { return out.copy(this.camera.position); }
    getForward(out) { return out.set(0, 0, -1).applyQuaternion(this.camera.quaternion); }
    isInsideCompound() {
      return Math.abs(this.position.x) < 20 && Math.abs(this.position.z) < 20;
    }
  }

  DL.Player = Player;
})();
