/* ============================================================
   DEADLIGHT // input, HUD, menus and settings
   ============================================================ */
(function () {
  "use strict";
  const DL = (window.DL = window.DL || {});
  const $ = (id) => document.getElementById(id);

  class Input {
    constructor() {
      this.keys = new Set();
      this.pressedKeys = new Set();
      this.firing = false;
      this.aiming = false;
      this.lookDX = 0;
      this.lookDY = 0;
      this.locked = false;
      this.enabled = false;
      this.onLockChange = null;
      this._bind();
    }
    _bind() {
      window.addEventListener("keydown", (e) => {
        if (e.code === "Tab") e.preventDefault();
        if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault();
        if (!this.keys.has(e.code)) this.pressedKeys.add(e.code);
        this.keys.add(e.code);
      });
      window.addEventListener("keyup", (e) => this.keys.delete(e.code));
      window.addEventListener("blur", () => {
        this.keys.clear();
        this.firing = false;
        this.aiming = false;
      });
      document.addEventListener("mousemove", (e) => {
        if (!this.locked) return;
        this.lookDX += e.movementX || 0;
        this.lookDY += e.movementY || 0;
      });
      document.addEventListener("mousedown", (e) => {
        if (!this.locked) return;
        if (e.button === 0) this.firing = true;
        if (e.button === 2) this.aiming = true;
      });
      document.addEventListener("mouseup", (e) => {
        if (e.button === 0) this.firing = false;
        if (e.button === 2) this.aiming = false;
      });
      document.addEventListener("contextmenu", (e) => e.preventDefault());
      document.addEventListener("pointerlockchange", () => {
        const was = this.locked;
        this.locked = !!document.pointerLockElement;
        if (!this.locked) { this.firing = false; this.aiming = false; this.keys.clear(); }
        if (this.onLockChange) this.onLockChange(this.locked, was);
      });
      document.addEventListener("pointerlockerror", () => {
        if (this.onLockError) this.onLockError();
      });
    }
    requestLock() {
      const canvas = $("game");
      if (document.pointerLockElement === canvas) return;
      try {
        const p = canvas.requestPointerLock({ unadjustedMovement: false });
        if (p && p.catch) p.catch(() => {});
      } catch (e) {
        try { canvas.requestPointerLock(); } catch (e2) {}
      }
    }
    releaseLock() {
      if (document.pointerLockElement) document.exitPointerLock();
    }
    isDown(code) { return this.keys.has(code); }
    pressed(code) { return this.pressedKeys.has(code); }
    get anyKey() { return this.keys.size > 0; }
    endFrame() {
      this.pressedKeys.clear();
      this.lookDX = 0;
      this.lookDY = 0;
    }
  }

  class UI {
    constructor() {
      this.screens = ["loading", "menu", "manual", "settings", "pause", "gameover", "victory"];
      this.currentScreen = "loading";
      this.hudVisible = false;
      this.cache = {};
      this.bindings = {};
      this._overlayReturn = "menu";
      this._toastTimer = 0;
      this._radioTimer = 0;
      this._bannerTimer = 0;
      this._waveTimer = 0;
      this._hitTimer = 0;
      this._lastAmmoKey = "";
      this._lastHealth = -1;
      this._lastStamina = -1;
      this._lastPrompt = "";
      this._loadSettings();
      this._buildCompass();
      this._bind();
    }

    _bind() {
      const click = (id, fn) => { const el = $(id); if (el) el.addEventListener("click", fn); };
      click("btn-deploy", () => this.bindings.onDeploy && this.bindings.onDeploy());
      click("btn-manual", () => this.openOverlay("manual", this.currentScreen === "pause" ? "pause" : "menu"));
      click("btn-settings", () => this.openOverlay("settings", this.currentScreen === "pause" ? "pause" : "menu"));
      click("btn-resume", () => this.bindings.onResume && this.bindings.onResume());
      click("btn-pause-settings", () => this.openOverlay("settings", "pause"));
      click("btn-restart", () => this.bindings.onRestart && this.bindings.onRestart());
      click("btn-abandon", () => this.bindings.onAbandon && this.bindings.onAbandon());
      click("btn-death-retry", () => this.bindings.onRestart && this.bindings.onRestart());
      click("btn-death-menu", () => this.bindings.onAbandon && this.bindings.onAbandon());
      click("btn-win-again", () => this.bindings.onRestart && this.bindings.onRestart());
      click("btn-win-menu", () => this.bindings.onAbandon && this.bindings.onAbandon());
      click("settings-done", () => this.closeOverlay());
      document.querySelectorAll("[data-close]").forEach((el) => {
        el.addEventListener("click", () => this.closeOverlay());
      });

      // Time-of-day picker on the start menu
      document.querySelectorAll(".tod-card").forEach((btn) => {
        btn.addEventListener("click", () => {
          const mode = btn.dataset.tod === "day" ? "day" : "night";
          if (this.settings.timeOfDay === mode) return;
          this.settings.timeOfDay = mode;
          this.setTimeOfDayUI(mode);
          this._saveSettings();
          this.bindings.onTimeOfDay && this.bindings.onTimeOfDay(mode);
          this.bindings.onUiClick && this.bindings.onUiClick();
        });
      });

      // Menu / overlay keyboard
      window.addEventListener("keydown", (e) => {
        if (e.code === "Escape") {
          if (this.currentScreen === "manual" || this.currentScreen === "settings") this.closeOverlay();
        }
      });

      // Settings widgets
      const qualitySeg = $("quality-seg");
      qualitySeg.querySelectorAll("button").forEach((b) => {
        b.addEventListener("click", () => {
          qualitySeg.querySelectorAll("button").forEach((x) => x.classList.remove("on"));
          b.classList.add("on");
          const q = b.dataset.q;
          $("quality-out").textContent = q.toUpperCase();
          this.settings.quality = q;
          this._saveSettings();
          this.bindings.onQuality && this.bindings.onQuality(q);
          if (this.bindings.onUiClick) this.bindings.onUiClick();
        });
      });
      const sens = $("sens");
      sens.addEventListener("input", () => {
        const v = parseInt(sens.value, 10) / 100;
        $("sens-out").textContent = v.toFixed(2);
        this.settings.sensitivity = v;
        this.bindings.onSensitivity && this.bindings.onSensitivity(v);
      });
      sens.addEventListener("change", () => this._saveSettings());
      const vol = $("volume");
      vol.addEventListener("input", () => {
        const v = parseInt(vol.value, 10) / 100;
        $("volume-out").textContent = Math.round(v * 100) + "%";
        this.settings.volume = v;
        this.bindings.onVolume && this.bindings.onVolume(v);
      });
      vol.addEventListener("change", () => this._saveSettings());
      const fov = $("fov");
      fov.addEventListener("input", () => {
        const v = parseInt(fov.value, 10);
        $("fov-out").textContent = v + "°";
        this.settings.fov = v;
        this.bindings.onFov && this.bindings.onFov(v);
      });
      fov.addEventListener("change", () => this._saveSettings());
      const shakeSeg = $("shake-seg");
      shakeSeg.querySelectorAll("button").forEach((b) => {
        b.addEventListener("click", () => {
          shakeSeg.querySelectorAll("button").forEach((x) => x.classList.remove("on"));
          b.classList.add("on");
          const on = b.dataset.shake === "1";
          $("shake-out").textContent = on ? "ON" : "OFF";
          this.settings.shake = on;
          this._saveSettings();
          this.bindings.onShake && this.bindings.onShake(on);
          if (this.bindings.onUiClick) this.bindings.onUiClick();
        });
      });
      // hover sounds
      document.querySelectorAll(".btn").forEach((b) => {
        b.addEventListener("mouseenter", () => this.bindings.onHover && this.bindings.onHover());
      });
      // apply initial saved controls
      this._applySettingsToWidgets();
    }

    _defaultSettings() {
      return { quality: "high", sensitivity: 1, volume: 0.78, fov: 78, shake: true, timeOfDay: "night" };
    }
    _loadSettings() {
      this.settings = this._defaultSettings();
      try {
        const raw = localStorage.getItem("deadlight-settings");
        if (raw) Object.assign(this.settings, JSON.parse(raw));
      } catch (e) {}
    }
    _saveSettings() {
      try { localStorage.setItem("deadlight-settings", JSON.stringify(this.settings)); } catch (e) {}
    }
    _applySettingsToWidgets() {
      const q = $("quality-seg");
      if (q) q.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.q === this.settings.quality));
      if ($("quality-out")) $("quality-out").textContent = this.settings.quality.toUpperCase();
      if ($("sens")) $("sens").value = Math.round(this.settings.sensitivity * 100);
      if ($("sens-out")) $("sens-out").textContent = this.settings.sensitivity.toFixed(2);
      if ($("volume")) $("volume").value = Math.round(this.settings.volume * 100);
      if ($("volume-out")) $("volume-out").textContent = Math.round(this.settings.volume * 100) + "%";
      if ($("fov")) $("fov").value = this.settings.fov;
      if ($("fov-out")) $("fov-out").textContent = this.settings.fov + "°";
      const sh = $("shake-seg");
      if (sh) sh.querySelectorAll("button").forEach((b) => b.classList.toggle("on", (b.dataset.shake === "1") === this.settings.shake));
      if ($("shake-out")) $("shake-out").textContent = this.settings.shake ? "ON" : "OFF";
      this.setTimeOfDayUI(this.settings.timeOfDay === "day" ? "day" : "night");
    }

    setTimeOfDayUI(mode) {
      const day = mode === "day";
      document.querySelectorAll(".tod-card").forEach((btn) => {
        const on = btn.dataset.tod === (day ? "day" : "night");
        btn.classList.toggle("on", on);
        btn.setAttribute("aria-pressed", on ? "true" : "false");
      });
      document.body.classList.toggle("day-mode", day);
      const clock = $("menu-clock");
      if (clock) clock.textContent = day ? "CLASSIFIED // SITE 13 // 06:12 LOCAL" : "CLASSIFIED // SITE 13 // 03:47 LOCAL";
      const live = $("menu-live");
      if (live) live.innerHTML = "<span class=\"dot\"></span> " + (day ? "FIRST LIGHT — HOSTILES ACTIVE" : "SIGNAL LOST — HOSTILES ACTIVE");
      const tagline = $("menu-tagline");
      if (tagline) tagline.innerHTML = day
        ? "First light broke over the valley.<br>The dead never went to sleep."
        : "The outpost went dark at midnight.<br>Something came back with it.";
      const copy = $("menu-side-copy");
      if (copy) copy.textContent = day
        ? "The evacuation convoy is gone. The radio mast is our only lifeline. Hold the outpost through the daylight until extraction. The forest is awake."
        : "The evacuation convoy is gone. The radio mast is our only lifeline. Defend the beacon, barricade the gates, and survive eight waves until extraction. The forest does not stop.";
      const vis = $("menu-visibility");
      if (vis) vis.textContent = day ? "High / Drizzle" : "Low / Rain";
      const meta = $("menu-meta");
      if (meta) meta.innerHTML = day
        ? "ONE OUTPOST &nbsp;•&nbsp; EIGHT WAVES &nbsp;•&nbsp; HOLD UNTIL EXTRACTION"
        : "ONE OUTPOST &nbsp;•&nbsp; EIGHT WAVES &nbsp;•&nbsp; HOLD UNTIL DAWN";
    }

    _buildCompass() {
      const inner = $("compass-inner");
      if (!inner) return;
      const labels = { 0: "N", 45: "NE", 90: "E", 135: "SE", 180: "S", 225: "SW", 270: "W", 315: "NW" };
      const PX = 4.6;
      for (let d = -90; d <= 450; d += 5) {
        const norm = DL.mod(d, 360);
        const major = norm % 15 === 0;
        const el = document.createElement("div");
        el.className = "compass-tick" + (major ? " major" : "");
        el.style.left = (d * PX) + "px";
        inner.appendChild(el);
        if (major && labels[norm] != null) {
          const lab = document.createElement("div");
          lab.className = "compass-az";
          lab.style.left = (d * PX) + "px";
          lab.textContent = labels[norm];
          if (norm % 90 === 0) lab.style.color = "var(--amber)";
          inner.appendChild(lab);
        }
      }
      this._compassPX = PX;
    }

    setLoading(p, label) {
      const pct = Math.round(DL.clamp(p, 0, 1) * 100);
      if ($("load-fill")) $("load-fill").style.width = pct + "%";
      if ($("load-pct")) $("load-pct").textContent = pct + "%";
      if (label && $("load-label")) $("load-label").textContent = label.toUpperCase();
    }

    showScreen(name) {
      this.currentScreen = name;
      this.screens.forEach((s) => {
        const el = $(s);
        if (el) el.classList.toggle("hidden", s !== name);
      });
      if ($("hud")) $("hud").classList.add("hidden");
      if (name === "menu") {
        $("menu").classList.remove("hidden");
      }
    }

    showMenu() {
      this.showScreen("menu");
      this.hudVisible = false;
      if ($("hud")) $("hud").classList.add("hidden");
    }

    showGame() {
      this.currentScreen = "game";
      this.screens.forEach((s) => { const el = $(s); if (el) el.classList.add("hidden"); });
      if ($("hud")) $("hud").classList.remove("hidden");
      this.hudVisible = true;
    }

    openOverlay(name, returnTo) {
      this._overlayReturn = returnTo || this.currentScreen;
      this._overlayWasGame = this.currentScreen === "game" || this.currentScreen === "pause";
      this.currentScreen = name;
      this.screens.forEach((s) => { const el = $(s); if (el) el.classList.toggle("hidden", s !== name); });
      if (name === "settings") this._applySettingsToWidgets();
    }
    closeOverlay() {
      if (this.currentScreen === "settings") {
        this._saveSettings();
        if (this._overlayReturn === "pause") this.showPause();
        else this.showMenu();
      } else if (this.currentScreen === "manual") {
        if (this._overlayReturn === "pause") this.showPause();
        else this.showMenu();
      }
    }

    showPause() {
      this.showScreen("pause");
      if ($("hud")) $("hud").classList.add("hidden");
      this.hudVisible = false;
    }
    hidePause() { this.showGame(); }

    showDeath(stats) {
      this._clearTransient();
      this.showScreen("gameover");
      $("death-wave").textContent = String(stats.wave).padStart(2, "0");
      $("death-kills").textContent = stats.kills;
      $("death-headshots").textContent = stats.headshots;
      $("death-time").textContent = stats.time;
      $("death-accuracy").textContent = stats.accuracy + "%";
    }
    showVictory(stats) {
      this._clearTransient();
      this.showScreen("victory");
      $("win-kills").textContent = stats.kills;
      $("win-headshots").textContent = stats.headshots;
      $("win-time").textContent = stats.time;
      $("win-accuracy").textContent = stats.accuracy + "%";
    }
    _clearTransient() {
      ["toast", "radio", "objective-banner", "wave-banner", "interact", "low-health"].forEach((id) => {
        const el = $(id);
        if (el) el.classList.remove("on");
      });
      const warn = $("hud-warning");
      if (warn) warn.classList.remove("on");
    }

    hud(state) {
      if (!this.hudVisible) return;
      const hp = Math.max(0, Math.ceil(state.health));
      if (hp !== this._lastHealth) {
        this._lastHealth = hp;
        $("health-num").textContent = hp;
        $("health-num").classList.toggle("crit", hp <= 30);
        $("health-bar").style.transform = "scaleX(" + DL.clamp(hp / 100, 0, 1) + ")";
        $("health-bar").style.background = hp <= 30 ? "linear-gradient(90deg,#7d1008,#d32b17)" : "";
        $("low-health").classList.toggle("on", hp <= 32 && hp > 0);
      }
      const st = Math.round(state.stamina);
      if (st !== this._lastStamina) {
        this._lastStamina = st;
        $("stamina-bar").style.transform = "scaleX(" + DL.clamp(st / 100, 0, 1) + ")";
      }
      if (state.medkits !== this.cache.medkits) {
        this.cache.medkits = state.medkits;
        $("medkits").textContent = String(state.medkits).padStart(2, "0");
      }
      if (state.boards !== this.cache.boards) {
        this.cache.boards = state.boards;
        $("barricade-kits").textContent = String(state.boards).padStart(2, "0");
      }
      // Ammo panel
      const ammoKey = state.weaponId + ":" + state.ammo + ":" + state.reserve;
      if (ammoKey !== this._lastAmmoKey) {
        this._lastAmmoKey = ammoKey;
        $("ammo-mag").textContent = String(state.ammo).padStart(2, "0");
        $("ammo-reserve").textContent = String(state.reserve).padStart(3, "0");
        $("weapon-name").textContent = state.weaponName;
        $("fire-mode").textContent = state.fireMode;
        $("weapon-slot").textContent = "0" + state.weaponSlot;
        $("ammo-mag").classList.toggle("low", state.ammo <= 6 && state.ammo > 0);
        $("ammo-mag").classList.toggle("empty", state.ammo === 0);
        const pips = $("ammo-pips");
        const total = 10;
        const filled = Math.ceil((state.ammo / Math.max(1, state.magSize)) * total);
        let html = "";
        for (let i = 0; i < total; i++) html += "<i class=\"" + (i < filled ? "on" : "") + "\"></i>";
        pips.innerHTML = html;
      }
      // Wave / phase (update 4x/sec)
      if (state.waveKey !== this.cache.waveKey) {
        this.cache.waveKey = state.waveKey;
        $("wave-label").textContent = "WAVE " + String(state.wave).padStart(2, "0");
        $("phase-label").textContent = state.phaseLabel;
        $("wave-sub").innerHTML = state.waveSub;
      }
      if (state.phaseTime !== this.cache.phaseTime) {
        this.cache.phaseTime = state.phaseTime;
        if (state.phaseTimeText != null) {
          const sub = $("wave-sub");
          if (state.phase === "prep") sub.innerHTML = "NEXT WAVE <b>" + state.phaseTimeText + "</b>";
          else if (state.phase === "combat") sub.innerHTML = "HOSTILES <b>" + state.hostiles + "</b>";
        }
      }
      // Base integrity
      const genPct = DL.clamp(state.generator / state.generatorMax, 0, 1);
      const north = state.barricades.north, south = state.barricades.south;
      if (state.structureKey !== this.cache.structureKey) {
        this.cache.structureKey = state.structureKey;
        const set = (id, pct, txt) => {
          const bar = $(id);
          bar.style.width = Math.round(pct * 100) + "%";
          bar.className = pct <= 0.25 ? "crit" : pct <= 0.55 ? "warn" : "";
        };
        set("obj-gen", genPct); set("obj-north", north); set("obj-south", south);
        $("obj-gen-pct").textContent = Math.round(genPct * 100) + "%";
        $("obj-north-pct").textContent = Math.round(north * 100) + "%";
        $("obj-south-pct").textContent = Math.round(south * 100) + "%";
      }
      // This must run every frame: a reset restores identical percentages and
      // would otherwise leave the previous "under attack" warning latched on.
      $("hud-warning").classList.toggle("on", genPct < 0.45);
      // Compass
      const heading = DL.mod((-state.yaw * 180) / Math.PI, 360);
      if ($("compass-inner")) $("compass-inner").style.transform = "translateX(" + (-heading * this._compassPX) + "px)";
      // Crosshair spread / ads
      const spread = 1 + (state.bloom || 0) * 4 + (state.moving ? 2.2 : 0);
      const ch = $("crosshair");
      if (ch) {
        ch.style.opacity = state.ads > 0.75 ? "0.04" : "1";
        const gap = (5 + spread * 2.2).toFixed(1);
        const lines = ch.children;
        // order: top, bottom, left, right, dot
        if (lines[0]) lines[0].style.transform = "translateY(" + (-gap) + "px)";
        if (lines[1]) lines[1].style.transform = "translateY(" + gap + "px)";
        if (lines[2]) lines[2].style.transform = "translateX(" + (-gap) + "px)";
        if (lines[3]) lines[3].style.transform = "translateX(" + gap + "px)";
      }
      // Prompt (only when changed)
      const promptKey = state.prompt && state.prompt.on ? state.prompt.text + "|" + state.prompt.sub : "";
      if (promptKey !== this._lastPrompt) {
        this._lastPrompt = promptKey;
        const el = $("interact");
        if (state.prompt && state.prompt.on) {
          el.classList.add("on");
          $("interact-key").textContent = state.prompt.key || "E";
          $("interact-text").textContent = state.prompt.text;
          $("interact-sub").textContent = state.prompt.sub || "";
        } else el.classList.remove("on");
      }
      // Damage vignette
      const wash = $("damage-wash");
      if (wash) wash.style.opacity = String(DL.clamp(state.damageFlash || 0, 0, 1) * 0.9);
      if ($("flash-wash")) $("flash-wash").style.opacity = String(DL.clamp(state.flash || 0, 0, 1) * 0.55);
    }

    hitmarker(headshot, killed) {
      const el = $("hitmarker");
      if (!el) return;
      el.classList.add("on");
      el.classList.toggle("head", !!headshot);
      el.style.opacity = "1";
      clearTimeout(this._hitTimer);
      this._hitTimer = setTimeout(() => { el.style.opacity = "0"; el.classList.remove("head"); }, killed ? 170 : 110);
    }

    damageIndicator() {
      const el = $("dmg-ring");
      if (!el) return;
      el.classList.remove("on");
      void el.offsetWidth;
      el.classList.add("on");
    }

    toast(text, duration = 2200) {
      const el = $("toast");
      if (!el) return;
      el.textContent = text;
      el.classList.add("on");
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => el.classList.remove("on"), duration);
    }

    radio(text, duration = 4200) {
      const el = $("radio");
      if (!el) return;
      $("radio-text").textContent = text;
      el.classList.add("on");
      clearTimeout(this._radioTimer);
      this._radioTimer = setTimeout(() => el.classList.remove("on"), duration);
    }

    banner(kick, main, sub, duration = 3000) {
      const el = $("objective-banner");
      if (!el) return;
      $("banner-kick").textContent = kick;
      $("banner-main").textContent = main;
      $("banner-sub").textContent = sub || "";
      el.classList.add("on");
      clearTimeout(this._bannerTimer);
      this._bannerTimer = setTimeout(() => el.classList.remove("on"), duration);
    }

    waveBanner(kick, title, sub, duration = 3400) {
      const el = $("wave-banner");
      if (!el) return;
      $("wb-kick").textContent = kick;
      $("wb-title").textContent = title;
      $("wb-sub").textContent = sub || "";
      el.classList.add("on");
      clearTimeout(this._waveTimer);
      this._waveTimer = setTimeout(() => el.classList.remove("on"), duration);
    }

    feed(text, highlight) {
      const feed = $("kill-feed");
      if (!feed) return;
      const row = document.createElement("div");
      row.className = "feed-row";
      row.innerHTML = highlight ? "<b>" + text + "</b>" : text;
      feed.prepend(row);
      requestAnimationFrame(() => row.classList.add("on"));
      setTimeout(() => { row.classList.remove("on"); setTimeout(() => row.remove(), 250); }, 2600);
      while (feed.children.length > 5) feed.lastChild.remove();
    }

    flashScreen(amount = 0.4) {
      const f = $("flash-wash");
      if (!f) return;
      f.style.opacity = String(amount);
      setTimeout(() => (f.style.opacity = "0"), 90);
    }

    update(dt) {
      if ($("perf") && this.cache.showPerf) {
        // handled by game
      }
    }
  }

  DL.Input = Input;
  DL.UI = UI;
})();
