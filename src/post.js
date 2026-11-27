/* ============================================================
   DEADLIGHT // HDR post-processing pipeline
   Threshold -> dual-scale separable bloom -> filmic composite.
   ============================================================ */
(function () {
  "use strict";
  const DL = (window.DL = window.DL || {});
  const FULLSCREEN_VERT = `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
  `;

  const THRESHOLD_FRAG = `
    uniform sampler2D tDiffuse;
    uniform float threshold;
    uniform float knee;
    varying vec2 vUv;
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float br = max(c.r, max(c.g, c.b));
      float soft = clamp(br - threshold + knee, 0.0, 2.0 * knee);
      soft = soft * soft / (4.0 * knee + 0.0001);
      float contrib = max(soft, br - threshold) / max(br, 0.0001);
      gl_FragColor = vec4(c * contrib, 1.0);
    }
  `;

  const BLUR_FRAG = `
    uniform sampler2D tDiffuse;
    uniform vec2 direction;
    uniform vec2 resolution;
    varying vec2 vUv;
    void main(){
      vec2 texel = 1.0 / resolution;
      vec2 d = direction * texel;
      vec3 c = texture2D(tDiffuse, vUv).rgb * 0.227027;
      c += texture2D(tDiffuse, vUv + d * 1.384615).rgb * 0.316216;
      c += texture2D(tDiffuse, vUv - d * 1.384615).rgb * 0.316216;
      c += texture2D(tDiffuse, vUv + d * 3.230769).rgb * 0.070270;
      c += texture2D(tDiffuse, vUv - d * 3.230769).rgb * 0.070270;
      gl_FragColor = vec4(c, 1.0);
    }
  `;

  const COMPOSITE_FRAG = `
    uniform sampler2D tScene;
    uniform sampler2D tBloom1;
    uniform sampler2D tBloom2;
    uniform vec2 resolution;
    uniform float time;
    uniform float exposure;
    uniform float bloomStrength;
    uniform float damage;
    uniform float lowHealth;
    uniform float flash;
    uniform float fade;
    uniform float grainAmount;
    uniform float aberration;
    varying vec2 vUv;

    float hash(vec2 p){
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }
    vec3 acesFilm(vec3 x){
      return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
    }
    void main(){
      vec2 uv = vUv;
      vec2 centered = uv - 0.5;
      float r2 = dot(centered, centered);

      // Radial chromatic aberration, strongest at the edges.
      vec2 ab = centered * (aberration + r2 * 0.006);
      vec3 col;
      col.r = texture2D(tScene, uv + ab).r;
      col.g = texture2D(tScene, uv).g;
      col.b = texture2D(tScene, uv - ab).b;

      vec3 bloom = texture2D(tBloom1, uv).rgb * 0.72 + texture2D(tBloom2, uv).rgb * 0.52;
      col += bloom * bloomStrength;

      // Filmic exposure and ACES tonemap.
      col *= exposure;
      col = acesFilm(col);

      // Cold teal shadows / warm sodium highlights.
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      vec3 shadowTint = vec3(-0.012, 0.012, 0.028);
      vec3 highTint = vec3(0.022, 0.008, -0.014);
      col += shadowTint * (1.0 - smoothstep(0.0, 0.55, luma));
      col += highTint * smoothstep(0.45, 1.0, luma);
      col = mix(vec3(luma), col, 1.06);

      // Gentle S-curve.
      col = clamp((col - 0.5) * 1.075 + 0.5, 0.0, 1.0);

      float vig = smoothstep(1.08, 0.22, r2 * 1.7);
      col *= mix(0.42, 1.0, vig);

      // Damage wash and low-health desaturation.
      float dl = max(damage, lowHealth * 0.55);
      vec3 blood = vec3(0.26, 0.015, 0.008);
      col = mix(col, blood, dl * (0.24 + 0.55 * smoothstep(0.05, 0.7, r2)));
      col = mix(col, vec3(luma), lowHealth * 0.25);

      // Flash (lightning / muzzle illumination).
      col += vec3(0.72, 0.82, 1.0) * flash;

      // Grain.
      float grain = hash(uv * resolution + fract(time * 7.31)) - 0.5;
      float grainStrength = grainAmount * (1.0 - luma * 0.35);
      col += grain * grainStrength;

      // Subtle horizontal scan interference.
      col += sin(uv.y * resolution.y * 1.7 + time * 4.0) * 0.0015;

      col = pow(max(col, 0.0), vec3(1.0 / 2.2));
      col *= (1.0 - fade);
      gl_FragColor = vec4(col, 1.0);
    }
  `;

  class PostPipeline {
    constructor(renderer, scene, camera, quality) {
      this.renderer = renderer;
      this.scene = scene;
      this.camera = camera;
      this.quality = quality;
      this.enabled = true;
      this.renderScale = quality.level === "low" ? 0.82 : quality.level === "medium" ? 0.94 : 1.0;
      this.samples = quality.level === "high" ? 4 : quality.level === "medium" ? 2 : 0;
      this.time = 0;
      this.params = {
        exposure: 1.3,
        bloomStrength: quality.bloom ? 0.72 : 0.0,
        damage: 0,
        lowHealth: 0,
        flash: 0,
        fade: 0,
        grainAmount: 0.032,
        aberration: 0.0009,
      };
      this._makeTextures();
      this._makePasses();
      this.setSize(window.innerWidth, window.innerHeight);
    }

    _makeRenderTarget(w, h, depth) {
      const rt = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: !!depth,
        stencilBuffer: false,
        samples: depth ? this.samples : 0,
      });
      rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
      return rt;
    }

    _makeTextures() {
      this.rtScene = this._makeRenderTarget(2, 2, true);
      this.rtHalfA = this._makeRenderTarget(2, 2, false);
      this.rtHalfB = this._makeRenderTarget(2, 2, false);
      this.rtQuarterA = this._makeRenderTarget(2, 2, false);
      this.rtQuarterB = this._makeRenderTarget(2, 2, false);
    }

    _makePasses() {
      this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
      this.quad.frustumCulled = false;
      this.quadScene = new THREE.Scene();
      this.quadScene.add(this.quad);

      this.thresholdMat = new THREE.ShaderMaterial({
        uniforms: { tDiffuse: { value: null }, threshold: { value: 0.8 }, knee: { value: 0.4 } },
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: THRESHOLD_FRAG,
        depthTest: false,
        depthWrite: false,
      });
      this.blurMat = new THREE.ShaderMaterial({
        uniforms: {
          tDiffuse: { value: null },
          direction: { value: new THREE.Vector2(1, 0) },
          resolution: { value: new THREE.Vector2(1, 1) },
        },
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: BLUR_FRAG,
        depthTest: false,
        depthWrite: false,
      });
      this.compositeMat = new THREE.ShaderMaterial({
        uniforms: {
          tScene: { value: null },
          tBloom1: { value: null },
          tBloom2: { value: null },
          resolution: { value: new THREE.Vector2(1, 1) },
          time: { value: 0 },
          exposure: { value: 1.3 },
          bloomStrength: { value: 0.72 },
          damage: { value: 0 },
          lowHealth: { value: 0 },
          flash: { value: 0 },
          fade: { value: 0 },
          grainAmount: { value: 0.032 },
          aberration: { value: 0.0009 },
        },
        vertexShader: FULLSCREEN_VERT,
        fragmentShader: COMPOSITE_FRAG,
        depthTest: false,
        depthWrite: false,
      });
    }

    setSize(w, h) {
      const r = this.renderer;
      const scale = this.renderScale;
      const bufW = Math.max(2, Math.floor(w * r.getPixelRatio() * scale));
      const bufH = Math.max(2, Math.floor(h * r.getPixelRatio() * scale));
      this.rtScene.setSize(bufW, bufH);
      const hw = Math.max(2, Math.floor(bufW / 2)), hh = Math.max(2, Math.floor(bufH / 2));
      const qw = Math.max(2, Math.floor(bufW / 4)), qh = Math.max(2, Math.floor(bufH / 4));
      this.rtHalfA.setSize(hw, hh);
      this.rtHalfB.setSize(hw, hh);
      this.rtQuarterA.setSize(qw, qh);
      this.rtQuarterB.setSize(qw, qh);
      this.compositeMat.uniforms.resolution.value.set(bufW, bufH);
      this.width = bufW;
      this.height = bufH;
    }

    _draw(mat, target, clear = true) {
      const r = this.renderer;
      this.quad.material = mat;
      r.setRenderTarget(target);
      if (clear) {
        r.clear(true, false, false);
      }
      r.render(this.quadScene, this.quadCamera);
    }

    render(dt, overlayScene, overlayCamera) {
      const r = this.renderer;
      r.autoClear = false;
      r.setRenderTarget(this.rtScene);
      r.setClearColor(0x05080c, 1);
      r.clear(true, true, true);
      r.render(this.scene, this.camera);
      if (overlayScene && overlayCamera) {
        r.clearDepth();
        r.render(overlayScene, overlayCamera);
      }

      // Bloom chain (only when enabled by quality).
      if (this.quality.bloom) {
        this.thresholdMat.uniforms.tDiffuse.value = this.rtScene.texture;
        this._draw(this.thresholdMat, this.rtHalfA);

        this.blurMat.uniforms.tDiffuse.value = this.rtHalfA.texture;
        this.blurMat.uniforms.direction.value.set(1, 0);
        this.blurMat.uniforms.resolution.value.set(this.rtHalfA.width, this.rtHalfA.height);
        this._draw(this.blurMat, this.rtHalfB);

        this.blurMat.uniforms.tDiffuse.value = this.rtHalfB.texture;
        this.blurMat.uniforms.direction.value.set(0, 1);
        this._draw(this.blurMat, this.rtHalfA);

        // Quarter-res secondary glow.
        this.compositeMat.uniforms.tBloom1.value = this.rtHalfA.texture;
        this.thresholdMat.uniforms.tDiffuse.value = this.rtHalfA.texture;
        this._draw(this.thresholdMat, this.rtQuarterA);

        this.blurMat.uniforms.tDiffuse.value = this.rtQuarterA.texture;
        this.blurMat.uniforms.direction.value.set(1, 0);
        this.blurMat.uniforms.resolution.value.set(this.rtQuarterA.width, this.rtQuarterA.height);
        this._draw(this.blurMat, this.rtQuarterB);

        this.blurMat.uniforms.tDiffuse.value = this.rtQuarterB.texture;
        this.blurMat.uniforms.direction.value.set(0, 1);
        this._draw(this.blurMat, this.rtQuarterA);
        this.compositeMat.uniforms.tBloom2.value = this.rtQuarterA.texture;
      } else {
        this.compositeMat.uniforms.tBloom1.value = this.rtHalfA.texture;
        this.compositeMat.uniforms.tBloom2.value = this.rtQuarterA.texture;
      }

      const u = this.compositeMat.uniforms;
      u.tScene.value = this.rtScene.texture;
      u.time.value = this.time;
      u.exposure.value = this.params.exposure;
      u.bloomStrength.value = this.params.bloomStrength;
      u.damage.value = this.params.damage;
      u.lowHealth.value = this.params.lowHealth;
      u.flash.value = this.params.flash;
      u.fade.value = this.params.fade;
      u.grainAmount.value = this.params.grainAmount;
      u.aberration.value = this.params.aberration;

      this.quad.material = this.compositeMat;
      r.setRenderTarget(null);
      r.render(this.quadScene, this.quadCamera);
      r.autoClear = true;
    }

    update(dt) {
      this.time += dt;
    }

    dispose() {
      [this.rtScene, this.rtHalfA, this.rtHalfB, this.rtQuarterA, this.rtQuarterB].forEach((t) => t.dispose());
      this.quad.geometry.dispose();
      [this.thresholdMat, this.blurMat, this.compositeMat].forEach((m) => m.dispose());
    }
  }

  DL.PostPipeline = PostPipeline;
})();
