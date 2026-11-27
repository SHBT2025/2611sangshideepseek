/* ============================================================
   DEADLIGHT // OUTPOST 13 — procedural WebAudio engine
   ------------------------------------------------------------
   Pure WebAudio. No THREE, no DOM, no assets, no network.
   Everything (weapons, creatures, impacts, footsteps, ambience,
   reverb impulse response, tension score) is synthesised from
   oscillators and noise at init time and reused as AudioBuffers.

   Public API (see CONTRACT.md):

     const audio = new DL.AudioEngine();
     await audio.init();                  // after a user gesture
     audio.setMasterVolume(0.9);
     audio.setMuted(false);
     audio.setListener(pos, forward, up); // once per frame
     audio.update(dt, {zombies, wave, health, phase});
     audio.play('rifle', {pos:{x,y,z}, volume, rate, loop,
                          refDistance, maxDistance});
     audio.startAmbient(); / audio.stopAmbient();
     audio.thunder(distance);             // 1 = close strike, 0 = far
     audio.setTension(0..1);
     audio.dispose();

   Design notes:
   - One-shot buffers are rendered offline in plain JS, then played
     through per-voice envelopes (>= 4 ms attack, soft release) into a
     dry bus and a convolver (procedural IR) wet bus.
   - Voice cap 28; the oldest non-loop voice is stolen with a 30 ms
     fade. BufferSources are disconnected on 'ended'.
   - A glue compressor feeds a fast master limiter, so loud events
     cannot clip.
   - Distance/azimuth use HRTF PannerNodes (inverse distance model).
   - Tension music is a pre-rendered sparse string pulse + a low
     oscillator drone + a heartbeat when health is low. update() only
     schedules a pulse when a timer expires; it never builds a graph
     per frame.
   ============================================================ */

(function () {
  "use strict";

  const DL = (window.DL = window.DL || {});

  const TAU = Math.PI * 2;
  const MAX_VOICES = 28;
  const EMPTY_OPTS = {};

  /* ---------------------------------------------------------- */
  /* small helpers                                              */
  /* ---------------------------------------------------------- */

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  function nowMs() {
    try {
      if (typeof performance !== "undefined" && performance.now) return performance.now();
    } catch (e) { /* ignore */ }
    return Date.now();
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------------------------------------------------------- */
  /* DSP primitives used by the offline renderer                */
  /* ---------------------------------------------------------- */

  // RBJ biquad. Coefficients are refreshed per block by callers so
  // frequency sweeps stay cheap (no per-sample trig).
  class Biq {
    constructor() {
      this.b0 = 1; this.b1 = 0; this.b2 = 0;
      this.a1 = 0; this.a2 = 0;
      this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
    }
    set(type, f, q, sr) {
      if (!(f > 8)) f = 8;
      if (f > sr * 0.46) f = sr * 0.46;
      if (!(q > 0.05)) q = 0.05;
      const w = TAU * f / sr;
      const cosw = Math.cos(w);
      const sinw = Math.sin(w);
      const alpha = sinw / (2 * q);
      let b0, b1, b2, a0, a1, a2;
      if (type === "lp") {
        b0 = (1 - cosw) * 0.5; b1 = 1 - cosw; b2 = (1 - cosw) * 0.5;
        a0 = 1 + alpha; a1 = -2 * cosw; a2 = 1 - alpha;
      } else if (type === "hp") {
        b0 = (1 + cosw) * 0.5; b1 = -(1 + cosw); b2 = (1 + cosw) * 0.5;
        a0 = 1 + alpha; a1 = -2 * cosw; a2 = 1 - alpha;
      } else {
        b0 = alpha; b1 = 0; b2 = -alpha;
        a0 = 1 + alpha; a1 = -2 * cosw; a2 = 1 - alpha;
      }
      const inv = 1 / a0;
      this.b0 = b0 * inv; this.b1 = b1 * inv; this.b2 = b2 * inv;
      this.a1 = a1 * inv; this.a2 = a2 * inv;
    }
    process(x) {
      const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2
        - this.a1 * this.y1 - this.a2 * this.y2;
      this.x2 = this.x1; this.x1 = x;
      this.y2 = this.y1; this.y1 = y;
      return y;
    }
  }

  // A small offline track builder. Generates one mono/stereo buffer by
  // summing layered noise/tone voices, then normalises to a target peak.
  // Performance: filter coefficients, LFOs, pitch glide, vibrato and AM
  // are refreshed once per 64-sample block (per-sample values are static
  // within a block), so only the source waves and filters run per sample.
  class Synth {
    constructor(ctx, dur, ch, seed, sr) {
      this.sr = sr || ctx.sampleRate || 48000;
      this.ch = ch;
      this.n = Math.max(1, Math.ceil(dur * this.sr));
      this.ctx = ctx;
      this.chans = [];
      for (let c = 0; c < ch; c++) this.chans.push(new Float32Array(this.n));
      this.rng = mulberry32((seed >>> 0) || 1);
    }

    // Continuous filtered-noise bed with slow amplitude/cutoff LFOs.
    // Used for rain and wind loops (loop seam handled by doneLoop).
    bed(o) {
      const sr = this.sr;
      const n = this.n;
      const gain = o.gain == null ? 0.3 : o.gain;
      const type = o.type || "lp";
      const q = o.q == null ? 0.8 : o.q;
      const f0 = Math.max(20, o.f == null ? 1000 : o.f);
      const f1 = Math.max(20, o.f1 == null ? f0 : o.f1);
      const lfos = o.lfos || null;
      const cl = o.cutoffLfo || null;
      const rng = o.rng || this.rng;
      const ratio = f1 / f0;
      const biq = new Biq();
      biq.set(type, f0, q, sr);
      const L = this.chans[0];
      const R = this.ch > 1 ? this.chans[1] : null;
      const pan = o.pan == null ? 0.5 : (o.pan < 0 ? 0 : (o.pan > 1 ? 1 : o.pan));
      const ang = pan * Math.PI * 0.5;
      const gl = Math.cos(ang);
      const gr = R ? Math.sin(ang) : 0;
      let a = gain;
      for (let i = 0; i < n; i++) {
        if ((i & 63) === 0) {
          const t = i / sr;
          const u = i / n;
          let f = ratio === 1 ? f0 : f0 * Math.pow(ratio, u);
          if (cl) f *= 1 + cl.depth * Math.sin(TAU * cl.f * t + (cl.phase || 0));
          biq.set(type, f, q, sr);
          a = gain;
          if (lfos) {
            let m = 1;
            for (let k = 0; k < lfos.length; k++) {
              m *= 1 + lfos[k].depth * Math.sin(TAU * lfos[k].f * t + (lfos[k].phase || 0));
            }
            if (m < 0) m = 0;
            a = gain * m;
          }
        }
        const v = biq.process(rng() * 2 - 1) * a;
        if (R) { L[i] += v * gl; R[i] += v * gr; } else L[i] += v;
      }
      return this;
    }

    // Filtered noise burst with exponential decay.
    noise(o) {
      const sr = this.sr;
      const start = Math.max(0, Math.round((o.t || 0) * sr));
      const want = o.dur == null ? 0.1 : o.dur;
      const n = Math.min(this.n - start, Math.round(want * sr));
      if (n <= 0) return this;
      const gain = o.gain == null ? 0.5 : o.gain;
      const atk = Math.max(0, o.attack == null ? 0.002 : o.attack);
      const atkN = Math.floor(atk * sr);
      const decay = o.decay == null ? want * 0.4 : o.decay;
      const dk = decay > 0 ? Math.exp(-6.907755 / (decay * sr)) : 1;
      const type = o.type || "bp";
      const f0 = Math.max(20, o.f == null ? 1200 : o.f);
      const f1 = Math.max(20, o.f1 == null ? f0 : o.f1);
      const q = o.q == null ? 1 : o.q;
      const rng = o.rng || this.rng;
      const am = o.am || 0;
      const amRate = o.amRate || 8;
      const ratio = f1 / f0;
      const biq = new Biq();
      biq.set(type, f0, q, sr);
      const L = this.chans[0];
      const R = this.ch > 1 ? this.chans[1] : null;
      const pan = o.pan == null ? 0.5 : (o.pan < 0 ? 0 : (o.pan > 1 ? 1 : o.pan));
      const ang = pan * Math.PI * 0.5;
      const gl = Math.cos(ang);
      const gr = R ? Math.sin(ang) : 0;
      const fadeN = Math.min(n, Math.floor(0.002 * sr));
      const tailAt = n - fadeN;
      let env = 1;
      let amF = 1;
      for (let i = 0; i < n; i++) {
        if ((i & 63) === 0) {
          const u = i / n;
          biq.set(type, ratio === 1 ? f0 : f0 * Math.pow(ratio, u), q, sr);
          if (am) {
            const t = i / sr;
            amF = 1 - am * 0.5 + am * 0.5 * Math.sin(TAU * amRate * t);
          }
        }
        let e = env;
        if (atkN > 0 && i < atkN) e *= i / atkN;
        if (i >= tailAt && fadeN > 0) e *= (n - i) / fadeN;
        let x = rng() * 2 - 1;
        if (am) x *= amF;
        const v = biq.process(x) * e * gain;
        const idx = start + i;
        if (R) { L[idx] += v * gl; R[idx] += v * gr; } else L[idx] += v;
        env *= dk;
      }
      return this;
    }

    // Pitch-swept oscillator with optional vibrato, jitter, formant bank,
    // saturation and amplitude modulation. The backbone of creature voices.
    osc(o) {
      const sr = this.sr;
      const start = Math.max(0, Math.round((o.t || 0) * sr));
      const want = o.dur == null ? 0.2 : o.dur;
      const n = Math.min(this.n - start, Math.round(want * sr));
      if (n <= 0) return this;
      const gain = o.gain == null ? 0.5 : o.gain;
      const atk = Math.max(0, o.attack == null ? 0.003 : o.attack);
      const atkN = Math.floor(atk * sr);
      const decay = o.decay == null ? want * 0.5 : o.decay;
      const sustain = o.sustain == null ? 0 : o.sustain;
      const dk = decay > 0 ? Math.exp(-6.907755 / (decay * sr)) : 1;
      const f0 = Math.max(4, o.f0 == null ? 220 : o.f0);
      const f1 = Math.max(4, o.f1 == null ? f0 : o.f1);
      const glide = Math.max(1e-3, o.glide == null ? want : o.glide);
      const type = o.type || "sine";
      const vib = o.vib || 0;
      const vibDepth = o.vibDepth == null ? 0.02 : o.vibDepth;
      const jitter = o.jitter || 0;
      const drive = o.drive || 0;
      const driveNorm = drive ? 1 / Math.tanh(drive) : 1;
      const formants = o.formants || null;
      const partials = o.partials || null;
      const am = o.am || 0;
      const amRate = o.amRate || 8;
      const tailFade = o.tailFade !== false;
      const rng = o.rng || this.rng;
      const L = this.chans[0];
      const R = this.ch > 1 ? this.chans[1] : null;
      const pan = o.pan == null ? 0.5 : (o.pan < 0 ? 0 : (o.pan > 1 ? 1 : o.pan));
      const ang = pan * Math.PI * 0.5;
      const gl = Math.cos(ang);
      const gr = R ? Math.sin(ang) : 0;
      const glideN = Math.min(n, Math.max(1, Math.round(glide * sr)));
      const fk = f1 === f0 ? 1 : Math.pow(f1 / f0, 1 / glideN);
      const fadeN = tailFade ? Math.min(n, Math.floor(0.004 * sr)) : 0;
      const tailAt = n - fadeN;
      let fs = null;
      if (formants) {
        fs = [];
        for (let k = 0; k < formants.length; k++) {
          const f = formants[k];
          const b = new Biq();
          b.set("bp", f.f, f.q == null ? 5 : f.q, sr);
          fs.push({ b: b, g: f.g == null ? 1 : f.g });
        }
      }
      let phase = o.phase || 0;
      let env = 1;
      let jv = 0;
      let f = f0;
      let fInc = f / sr;
      let amF = 1;
      for (let i = 0; i < n; i++) {
        if ((i & 63) === 0) {
          const t = i / sr;
          if (i > 0) {
            if (i < glideN) f *= fk;
            else f = f1;
          }
          let ff = f;
          if (vib) ff *= 1 + vibDepth * Math.sin(TAU * vib * t);
          if (jitter) {
            jv += ((rng() * 2 - 1) - jv) * 0.3;
            ff *= 1 + jitter * jv;
          }
          fInc = ff / sr;
          if (am) amF = 1 - am * 0.5 + am * 0.5 * Math.sin(TAU * amRate * t);
        }
        phase += fInc;
        const ph = phase - Math.floor(phase);
        let x;
        if (partials) {
          x = 0;
          for (let p2 = 0; p2 < partials.length; p2++) {
            const pt = partials[p2];
            x += Math.sin(TAU * (phase * pt.mul + (pt.ph || 0))) * pt.amp;
          }
        } else if (type === "saw") x = ph * 2 - 1;
        else if (type === "tri") x = 1 - 4 * Math.abs(ph - 0.5);
        else if (type === "square") x = ph < 0.5 ? 1 : -1;
        else x = Math.sin(TAU * phase);
        if (fs) {
          let sum = 0;
          for (let k = 0; k < fs.length; k++) sum += fs[k].b.process(x) * fs[k].g;
          x = sum;
        }
        if (drive) x = Math.tanh(x * drive) * driveNorm;
        let e = sustain + (1 - sustain) * env;
        if (atkN > 0 && i < atkN) {
          const au = i / atkN;
          e *= au * au * (3 - 2 * au);
        }
        if (am) e *= amF;
        if (fadeN > 0 && i >= tailAt) e *= (n - i) / fadeN;
        const v = x * e * gain;
        const idx = start + i;
        if (R) { L[idx] += v * gl; R[idx] += v * gr; } else L[idx] += v;
        env *= dk;
      }
      return this;
    }

    // Finalise: DC block, 8 ms tail fade, peak-normalise, to AudioBuffer.
    // Deliberately no fade-in on the buffer itself: that would soften the
    // attack of impacts. One-shot playback applies a >= 3 ms anti-click
    // envelope at the voice gain instead.
    done(peak, skipEdges) {
      const sr = this.sr;
      const ch = this.ch;
      const n = this.n;
      const fout = skipEdges ? 0 : Math.min(Math.floor(0.008 * sr), n >> 2);
      let max = 0;
      for (let c = 0; c < ch; c++) {
        const d = this.chans[c];
        if (!skipEdges) {
          let x1 = 0, y1 = 0;
          for (let i = 0; i < n; i++) {
            const x = d[i];
            const y = x - x1 + 0.9995 * y1;
            x1 = x; y1 = y;
            d[i] = y;
          }
          for (let i = 0; i < fout; i++) d[n - 1 - i] *= i / fout;
        }
        for (let i = 0; i < n; i++) {
          const a = d[i] < 0 ? -d[i] : d[i];
          if (a > max) max = a;
        }
      }
      const target = peak == null ? 0.9 : peak;
      const g = max > 1e-7 ? target / max : 0;
      for (let c = 0; c < ch; c++) {
        const d = this.chans[c];
        for (let i = 0; i < n; i++) d[i] *= g;
      }
      const buf = this.ctx.createBuffer(ch, n, sr);
      for (let c = 0; c < ch; c++) {
        if (buf.copyToChannel) buf.copyToChannel(this.chans[c], c);
        else buf.getChannelData(c).set(this.chans[c]);
      }
      return buf;
    }

    // Seamless loop: crossfade the tail over the head, then trim.
    doneLoop(peak, fadeSec) {
      const ch = this.ch;
      const n = this.n;
      const F = Math.max(1, Math.min(n >> 2, Math.floor((fadeSec || 0.4) * this.sr)));
      const outLen = n - F;
      for (let c = 0; c < ch; c++) {
        const d = this.chans[c];
        for (let i = 0; i < F; i++) {
          const u = i / F;
          const a = Math.sin(u * Math.PI * 0.5);
          const b = Math.cos(u * Math.PI * 0.5);
          d[i] = d[i] * a + d[outLen + i] * b;
        }
        this.chans[c] = d.slice(0, outLen);
      }
      this.n = outLen;
      return this.done(peak);
    }
  }

  /* ---------------------------------------------------------- */
  /* buffer factory helpers                                     */
  /* ---------------------------------------------------------- */

  // Render sample rates: most one-shots carry no useful energy above
  // ~10 kHz, so they are rendered at 24 kHz (half the cost/memory) and
  // resampled by WebAudio on playback. Gunshots and bright impacts keep
  // a higher rate so the crack/crackle detail survives.
  const SR_LO = 24000;
  const SR_HI = 32000;

  function makeOne(ctx, dur, ch, seed, peak, fn, sr) {
    const s = new Synth(ctx, dur, ch, seed, sr || SR_LO);
    fn(s, 0);
    return s.done(peak);
  }

  function makeVariants(ctx, count, dur, ch, seed, peak, fn, sr) {
    const out = [];
    for (let i = 0; i < count; i++) {
      const s = new Synth(ctx, dur, ch, seed + i * 7717, sr || SR_LO);
      fn(s, i);
      out.push(s.done(peak));
    }
    return out;
  }

  function metalClick(s, t, f, gain, q, pan) {
    s.noise({
      t: t, dur: 0.05, gain: gain, attack: 0.0006, decay: 0.006,
      type: "bp", f: f, q: q == null ? 2.5 : q, pan: pan == null ? 0.5 : pan
    });
    s.osc({
      t: t, dur: 0.08, f0: f * 1.6, f1: f * 1.3, type: "sine",
      gain: gain * 0.16, attack: 0.001, decay: 0.025,
      pan: pan == null ? 0.5 : pan
    });
  }

  /* ---------------------------------------------------------- */
  /* weapon recipes                                             */
  /* ---------------------------------------------------------- */

  function buildRifle(s, v) {
    const det = v === 0 ? 1 : 0.945;
    // supersonic crack
    s.noise({ t: 0, dur: 0.05, gain: 0.9, attack: 0.0008, decay: 0.010, type: "hp", f: 2200, q: 0.7 });
    s.noise({ t: 0.0006, dur: 0.04, gain: 0.55, attack: 0.0005, decay: 0.006, type: "bp", f: 4300, f1: 2400, q: 1.1, pan: 0.46 });
    // body / muzzle blast
    s.noise({ t: 0.001, dur: 0.18, gain: 0.85, attack: 0.001, decay: 0.055, type: "bp", f: 1050 * det, f1: 400, q: 0.9 });
    // deep punch
    s.osc({ t: 0, dur: 0.26, f0: 178 * det, f1: 48, glide: 0.08, type: "sine", gain: 1.0, attack: 0.0015, decay: 0.10, drive: 1.8 });
    s.osc({ t: 0.003, dur: 0.5, f0: 88, f1: 36, type: "sine", gain: 0.32, attack: 0.003, decay: 0.16 });
    // outdoor tail
    s.noise({ t: 0.012, dur: 0.75, gain: 0.14, attack: 0.006, decay: 0.21, type: "lp", f: 2600, f1: 420, q: 0.6, pan: 0.4 });
    s.noise({ t: 0.02, dur: 0.5, gain: 0.08, attack: 0.012, decay: 0.15, type: "bp", f: 5200, q: 0.7, pan: 0.62 });
    // bolt cycling
    s.noise({ t: 0.035, dur: 0.05, gain: 0.1, attack: 0.001, decay: 0.015, type: "bp", f: 2700, q: 2.5, pan: 0.7 });
  }

  function buildPistol(s, v) {
    const det = v ? 0.93 : 1;
    s.noise({ t: 0, dur: 0.045, gain: 0.9, attack: 0.0006, decay: 0.008, type: "hp", f: 2800, q: 0.7 });
    s.noise({ t: 0.0005, dur: 0.03, gain: 0.6, attack: 0.0004, decay: 0.005, type: "bp", f: 5000, f1: 3000, q: 1.0 });
    s.noise({ t: 0.001, dur: 0.12, gain: 0.75, attack: 0.001, decay: 0.04, type: "bp", f: 1500 * det, f1: 520, q: 0.9 });
    s.osc({ t: 0, dur: 0.2, f0: 232 * det, f1: 78, glide: 0.055, type: "sine", gain: 0.95, attack: 0.001, decay: 0.075, drive: 1.5 });
    s.osc({ t: 0.004, dur: 0.35, f0: 105, f1: 48, type: "sine", gain: 0.22, attack: 0.003, decay: 0.11 });
    s.noise({ t: 0.008, dur: 0.32, gain: 0.09, attack: 0.004, decay: 0.1, type: "lp", f: 3800, f1: 700, q: 0.6 });
    s.noise({ t: 0.03, dur: 0.04, gain: 0.08, attack: 0.001, decay: 0.012, type: "bp", f: 3200, q: 3, pan: 0.65 });
  }

  function buildDryfire(s) {
    s.noise({ t: 0, dur: 0.03, gain: 0.75, attack: 0.0005, decay: 0.004, type: "bp", f: 2600, q: 2.5 });
    s.osc({ t: 0, dur: 0.06, f0: 180, f1: 110, type: "sine", gain: 0.4, attack: 0.001, decay: 0.018 });
    s.noise({ t: 0.008, dur: 0.05, gain: 0.14, attack: 0.001, decay: 0.01, type: "bp", f: 4200, q: 4 });
  }

  function buildReloadOut(s) {
    metalClick(s, 0, 3000, 0.55, 3, 0.5);
    // magazine sliding out of the well
    s.noise({ t: 0.02, dur: 0.3, gain: 0.3, attack: 0.01, decay: 0.16, type: "bp", f: 2300, f1: 900, q: 1.4, am: 0.35, amRate: 17, pan: 0.42 });
    s.osc({ t: 0.16, dur: 0.15, f0: 1900, f1: 1600, type: "sine", gain: 0.06, attack: 0.002, decay: 0.05 });
    s.osc({ t: 0.23, dur: 0.3, f0: 3100, f1: 2700, type: "sine", gain: 0.05, attack: 0.002, decay: 0.09 });
    s.noise({ t: 0.24, dur: 0.12, gain: 0.18, attack: 0.002, decay: 0.05, type: "lp", f: 1200, q: 0.6 });
  }

  function buildReloadIn(s) {
    // magazine seats with a thunk
    s.osc({ t: 0.02, dur: 0.16, f0: 110, f1: 58, glide: 0.05, type: "sine", gain: 0.8, attack: 0.001, decay: 0.07, drive: 1.5 });
    s.noise({ t: 0.02, dur: 0.09, gain: 0.4, attack: 0.001, decay: 0.03, type: "lp", f: 900, q: 0.6 });
    metalClick(s, 0.09, 3400, 0.5, 3, 0.5);
    // bolt release / slap
    s.noise({ t: 0.24, dur: 0.16, gain: 0.35, attack: 0.002, decay: 0.05, type: "bp", f: 1800, q: 1.2 });
    s.osc({ t: 0.24, dur: 0.1, f0: 2100, f1: 1700, type: "sine", gain: 0.1, attack: 0.002, decay: 0.03 });
    s.osc({ t: 0.25, dur: 0.12, f0: 3200, f1: 2600, type: "sine", gain: 0.08, attack: 0.002, decay: 0.035 });
    metalClick(s, 0.42, 2600, 0.3, 2.5, 0.5);
  }

  function buildBolt(s) {
    metalClick(s, 0, 2400, 0.55, 2.5, 0.5);
    s.osc({ t: 0, dur: 0.1, f0: 2400, f1: 1900, type: "sine", gain: 0.12, attack: 0.001, decay: 0.03 });
    // spring / slide travel
    s.noise({ t: 0.12, dur: 0.22, gain: 0.3, attack: 0.012, decay: 0.08, type: "bp", f: 1600, f1: 2400, q: 1.5, am: 0.3, amRate: 30 });
    metalClick(s, 0.3, 3000, 0.5, 2.5, 0.5);
    s.osc({ t: 0.3, dur: 0.14, f0: 2800, f1: 2100, type: "sine", gain: 0.1, attack: 0.001, decay: 0.05 });
  }

  function buildEquip(s) {
    s.noise({ t: 0.02, dur: 0.32, gain: 0.28, attack: 0.03, decay: 0.15, type: "lp", f: 3000, f1: 900, q: 0.7, am: 0.4, amRate: 9 });
    s.noise({ t: 0.16, dur: 0.28, gain: 0.16, attack: 0.02, decay: 0.12, type: "bp", f: 1200, q: 0.9, pan: 0.6 });
    metalClick(s, 0.3, 2600, 0.35, 2, 0.5);
    s.osc({ t: 0.3, dur: 0.1, f0: 1900, f1: 1500, type: "sine", gain: 0.08, attack: 0.001, decay: 0.03 });
  }

  function buildExplosion(s) {
    // blast transient
    s.noise({ t: 0, dur: 0.18, gain: 0.9, attack: 0.0008, decay: 0.05, type: "lp", f: 6000, f1: 1200, q: 0.7 });
    s.noise({ t: 0, dur: 0.06, gain: 0.6, attack: 0.0005, decay: 0.012, type: "hp", f: 3000 });
    // deep sub
    s.osc({ t: 0, dur: 1.7, f0: 95, f1: 26, glide: 0.7, type: "sine", gain: 1.0, attack: 0.002, decay: 0.55, drive: 2.2 });
    // body
    s.noise({ t: 0.01, dur: 1.1, gain: 0.55, attack: 0.004, decay: 0.35, type: "lp", f: 3200, f1: 260, q: 0.6 });
    // rolling rumble
    s.noise({ t: 0.12, dur: 2.2, gain: 0.25, attack: 0.1, decay: 0.9, type: "lp", f: 600, f1: 120, q: 0.5, am: 0.35, amRate: 3.5, pan: 0.5 });
    // debris crackle
    for (let k = 0; k < 26; k++) {
      const tt = 0.15 + s.rng() * 1.4;
      s.noise({
        t: tt, dur: 0.04, gain: 0.04 + s.rng() * 0.09, attack: 0.001, decay: 0.01,
        type: "bp", f: 1500 + s.rng() * 3500, q: 2, pan: s.rng()
      });
    }
    // air rush
    s.noise({ t: 0.05, dur: 1.4, gain: 0.12, attack: 0.02, decay: 0.5, type: "hp", f: 1500, q: 0.7, pan: 0.5 });
  }

  /* ---------------------------------------------------------- */
  /* movement / player recipes                                  */
  /* ---------------------------------------------------------- */

  function buildFootstepConcrete(s, v) {
    const g = 0.9 + v * 0.07;
    const t2 = 0.055 + v * 0.007;
    // heel
    s.noise({ t: 0, dur: 0.09, gain: 0.55 * g, attack: 0.001, decay: 0.022, type: "lp", f: 1500, f1: 600, q: 0.6 });
    s.osc({ t: 0, dur: 0.1, f0: 105 + v * 8, f1: 62, type: "sine", gain: 0.5, attack: 0.001, decay: 0.035 });
    // toe
    s.noise({ t: t2, dur: 0.08, gain: 0.35 * g, attack: 0.001, decay: 0.018, type: "lp", f: 1200, f1: 500, q: 0.6, pan: 0.55 });
    s.osc({ t: t2, dur: 0.08, f0: 95, f1: 60, type: "sine", gain: 0.3, attack: 0.001, decay: 0.028 });
    // grit
    s.noise({ t: 0.012, dur: 0.1, gain: 0.1, attack: 0.002, decay: 0.04, type: "hp", f: 2400, q: 0.8, pan: 0.6 });
  }

  function buildFootstepMud(s, v) {
    const g = 0.9 + v * 0.08;
    s.noise({ t: 0, dur: 0.22, gain: 0.5 * g, attack: 0.004, decay: 0.07, type: "lp", f: 1100, f1: 380, q: 0.8 });
    s.noise({ t: 0.01, dur: 0.18, gain: 0.3 * g, attack: 0.003, decay: 0.05, type: "bp", f: 700, f1: 250, q: 2, am: 0.5, amRate: 23, pan: 0.45 });
    s.osc({ t: 0, dur: 0.2, f0: 160 + v * 10, f1: 70, type: "sine", gain: 0.35, attack: 0.004, decay: 0.06, drive: 1.2 });
    s.osc({ t: 0.07, dur: 0.18, f0: 95, f1: 52, type: "sine", gain: 0.2, attack: 0.003, decay: 0.05 });
    s.noise({ t: 0.08, dur: 0.1, gain: 0.08, attack: 0.002, decay: 0.03, type: "hp", f: 1800, q: 0.6, pan: 0.6 });
  }

  function buildFootstepGrass(s, v) {
    s.noise({ t: 0, dur: 0.16, gain: 0.35, attack: 0.004, decay: 0.05, type: "hp", f: 2200, q: 0.7, am: 0.7, amRate: 38 });
    s.noise({ t: 0.05, dur: 0.14, gain: 0.2, attack: 0.003, decay: 0.04, type: "hp", f: 3600, q: 0.8, am: 0.8, amRate: 29, pan: 0.6 });
    s.osc({ t: 0, dur: 0.08, f0: 120 + v * 8, f1: 70, type: "sine", gain: 0.15, attack: 0.002, decay: 0.025 });
  }

  function buildLand(s) {
    s.osc({ t: 0, dur: 0.3, f0: 120, f1: 42, glide: 0.12, type: "sine", gain: 0.9, attack: 0.001, decay: 0.1, drive: 1.4 });
    s.noise({ t: 0, dur: 0.14, gain: 0.5, attack: 0.001, decay: 0.035, type: "lp", f: 1100, f1: 400 });
    s.noise({ t: 0.03, dur: 0.12, gain: 0.2, attack: 0.002, decay: 0.04, type: "bp", f: 2600, q: 1 });
    // gear rattle
    for (let k = 0; k < 3; k++) {
      s.noise({
        t: 0.06 + k * 0.035, dur: 0.05, gain: 0.09, attack: 0.001, decay: 0.012,
        type: "bp", f: 2200 + s.rng() * 1200, q: 5, pan: 0.4 + k * 0.1
      });
    }
  }

  function buildHurt(s) {
    // body impact
    s.noise({ t: 0, dur: 0.1, gain: 0.6, attack: 0.001, decay: 0.03, type: "lp", f: 1400, f1: 500 });
    s.osc({ t: 0, dur: 0.15, f0: 140, f1: 70, type: "sine", gain: 0.55, attack: 0.001, decay: 0.05, drive: 1.4 });
    // pained grunt (formant voice)
    s.osc({
      t: 0.01, dur: 0.42, f0: 135, f1: 88, glide: 0.22, type: "saw", gain: 0.5,
      attack: 0.02, decay: 0.16, jitter: 0.06, vib: 5, vibDepth: 0.02, drive: 2,
      formants: [{ f: 560, q: 5, g: 1 }, { f: 1050, q: 6, g: 0.6 }, { f: 2400, q: 5, g: 0.25 }]
    });
    s.noise({ t: 0.02, dur: 0.3, gain: 0.12, attack: 0.03, decay: 0.12, type: "bp", f: 1300, q: 1, am: 0.3, amRate: 13 });
  }

  function buildHeal(s) {
    s.osc({ t: 0, dur: 1.0, f0: 523.25, type: "sine", gain: 0.5, attack: 0.12, decay: 0.5, sustain: 0.15 });
    s.osc({ t: 0.18, dur: 0.9, f0: 659.25, type: "sine", gain: 0.4, attack: 0.12, decay: 0.45, sustain: 0.12 });
    s.osc({ t: 0.02, dur: 1.0, f0: 261.63, type: "tri", gain: 0.25, attack: 0.15, decay: 0.5, sustain: 0.1 });
    s.noise({ t: 0.05, dur: 0.9, gain: 0.08, attack: 0.2, decay: 0.5, type: "hp", f: 4000, q: 0.7, am: 0.4, amRate: 6 });
  }

  function buildHitFlesh(s) {
    s.noise({ t: 0, dur: 0.08, gain: 0.7, attack: 0.0008, decay: 0.022, type: "lp", f: 1800, f1: 400 });
    s.noise({ t: 0.002, dur: 0.1, gain: 0.35, attack: 0.001, decay: 0.03, type: "bp", f: 650, f1: 250, q: 1.4 });
    s.osc({ t: 0, dur: 0.12, f0: 190, f1: 80, type: "sine", gain: 0.45, attack: 0.001, decay: 0.04, drive: 1.5 });
    s.osc({
      t: 0.01, dur: 0.16, f0: 230, f1: 110, type: "saw", gain: 0.18, attack: 0.003, decay: 0.05,
      jitter: 0.1, drive: 2, formants: [{ f: 600, q: 3, g: 1 }, { f: 1400, q: 4, g: 0.4 }]
    });
  }

  function buildHeadshot(s) {
    s.noise({ t: 0, dur: 0.06, gain: 0.8, attack: 0.0006, decay: 0.012, type: "hp", f: 3000, q: 0.8 });
    s.noise({ t: 0, dur: 0.05, gain: 0.6, attack: 0.0008, decay: 0.01, type: "bp", f: 1200, q: 1.2 });
    s.osc({ t: 0, dur: 0.16, f0: 150, f1: 55, type: "sine", gain: 0.6, attack: 0.001, decay: 0.06, drive: 1.6 });
    s.osc({
      t: 0.005, dur: 0.2, f0: 340, f1: 120, type: "saw", gain: 0.2, attack: 0.002, decay: 0.07,
      jitter: 0.08, drive: 2.2,
      formants: [{ f: 800, q: 4, g: 1 }, { f: 1900, q: 5, g: 0.5 }]
    });
    s.noise({ t: 0.02, dur: 0.16, gain: 0.14, attack: 0.003, decay: 0.05, type: "bp", f: 2400, q: 0.8, am: 0.5, amRate: 40 });
  }

  /* ---------------------------------------------------------- */
  /* zombie recipes                                             */
  /* ---------------------------------------------------------- */

  function buildZombieGrowl(s, v) {
    const shift = v ? 1.08 : 1;
    // two detuned formant voices for width
    s.osc({
      t: 0.02, dur: 1.55, f0: 82 * shift, f1: 96 * shift, glide: 0.5, type: "saw", gain: 0.55,
      attack: 0.14, decay: 0.55, sustain: 0.4, jitter: 0.14, vib: 5.5, vibDepth: 0.03,
      drive: 2.4, pan: 0.32, am: 0.35, amRate: 9,
      formants: [
        { f: 300, q: 6, g: 1 }, { f: 720, q: 7, g: 0.75 },
        { f: 1300, q: 5, g: 0.35 }, { f: 2600, q: 4, g: 0.14 }
      ]
    });
    s.osc({
      t: 0.08, dur: 1.4, f0: 88 * shift, f1: 78 * shift, glide: 0.7, type: "saw", gain: 0.4,
      attack: 0.2, decay: 0.5, sustain: 0.3, jitter: 0.16, vib: 4.1, vibDepth: 0.03,
      drive: 2.2, pan: 0.66, am: 0.3, amRate: 7.3,
      formants: [{ f: 340, q: 6, g: 1 }, { f: 800, q: 7, g: 0.6 }, { f: 1500, q: 5, g: 0.3 }]
    });
    // breath
    s.noise({ t: 0.05, dur: 1.3, gain: 0.16, attack: 0.16, decay: 0.5, type: "bp", f: 1000, q: 0.9, am: 0.4, amRate: 11, pan: 0.5 });
    s.noise({ t: 0.1, dur: 0.9, gain: 0.08, attack: 0.1, decay: 0.4, type: "hp", f: 3000, q: 0.7, pan: 0.45 });
    // sub pressure
    s.osc({ t: 0.05, dur: 1.2, f0: 46, f1: 36, type: "sine", gain: 0.18, attack: 0.2, decay: 0.5, sustain: 0.2 });
  }

  function buildZombieAttack(s) {
    s.osc({
      t: 0, dur: 0.3, f0: 150, f1: 250, glide: 0.14, type: "saw", gain: 0.45,
      attack: 0.02, decay: 0.12, jitter: 0.12, drive: 2.5, vib: 8, vibDepth: 0.04,
      formants: [{ f: 450, q: 5, g: 1 }, { f: 1100, q: 6, g: 0.7 }, { f: 2200, q: 5, g: 0.3 }]
    });
    // bite/snap
    s.noise({ t: 0.14, dur: 0.08, gain: 0.6, attack: 0.001, decay: 0.02, type: "bp", f: 1600, q: 1.2 });
    s.osc({
      t: 0.14, dur: 0.16, f0: 300, f1: 110, type: "saw", gain: 0.3,
      attack: 0.002, decay: 0.05, drive: 2.2,
      formants: [{ f: 700, q: 4, g: 1 }, { f: 1800, q: 5, g: 0.5 }]
    });
    s.noise({ t: 0.15, dur: 0.3, gain: 0.12, attack: 0.01, decay: 0.1, type: "lp", f: 900, q: 0.7 });
  }

  function buildZombieDeath(s) {
    s.osc({
      t: 0, dur: 1.2, f0: 120, f1: 48, glide: 0.9, type: "saw", gain: 0.5,
      attack: 0.06, decay: 0.5, sustain: 0.25, jitter: 0.15, vib: 3.5, vibDepth: 0.04,
      drive: 2.6, am: 0.4, amRate: 6.5,
      formants: [{ f: 380, q: 5, g: 1 }, { f: 900, q: 6, g: 0.6 }, { f: 1600, q: 5, g: 0.25 }]
    });
    s.noise({ t: 0.1, dur: 0.9, gain: 0.15, attack: 0.08, decay: 0.36, type: "bp", f: 900, q: 0.8, am: 0.5, amRate: 8 });
    // gurgle
    s.osc({
      t: 0.35, dur: 0.7, f0: 70, f1: 40, type: "square", gain: 0.12, attack: 0.05, decay: 0.3,
      drive: 1.5, formants: [{ f: 500, q: 4, g: 1 }, { f: 1200, q: 4, g: 0.4 }]
    });
    // body hits the ground
    s.osc({ t: 1.0, dur: 0.45, f0: 100, f1: 38, type: "sine", gain: 0.6, attack: 0.002, decay: 0.12, drive: 1.4 });
    s.noise({ t: 1.0, dur: 0.25, gain: 0.3, attack: 0.002, decay: 0.06, type: "lp", f: 800, f1: 300 });
  }

  function buildZombieScream(s) {
    s.osc({
      t: 0, dur: 0.5, f0: 420, f1: 620, glide: 0.4, type: "saw", gain: 0.5,
      attack: 0.03, decay: 0.25, sustain: 0.5, vib: 7.5, vibDepth: 0.05, jitter: 0.05,
      drive: 2.8, formants: [{ f: 950, q: 6, g: 1 }, { f: 1900, q: 7, g: 0.7 }, { f: 3200, q: 5, g: 0.35 }]
    });
    s.osc({
      t: 0.3, dur: 0.9, f0: 560, f1: 300, glide: 0.7, type: "saw", gain: 0.35,
      attack: 0.03, decay: 0.4, sustain: 0.3, vib: 6, vibDepth: 0.06, jitter: 0.05,
      drive: 2.5,
      formants: [{ f: 1000, q: 5, g: 1 }, { f: 2100, q: 6, g: 0.6 }, { f: 3600, q: 4, g: 0.3 }]
    });
    s.noise({ t: 0.05, dur: 0.9, gain: 0.14, attack: 0.06, decay: 0.4, type: "hp", f: 2500, q: 0.7 });
  }

  function buildBruteRoar(s) {
    // rising bellow
    s.osc({
      t: 0.05, dur: 1.2, f0: 70, f1: 110, glide: 0.4, type: "saw", gain: 0.5,
      attack: 0.12, decay: 0.35, sustain: 0.5, jitter: 0.14, drive: 3, vib: 4, vibDepth: 0.04, pan: 0.3,
      formants: [{ f: 240, q: 5, g: 1 }, { f: 520, q: 6, g: 0.8 }, { f: 980, q: 5, g: 0.4 }]
    });
    // main roar, falling
    s.osc({
      t: 0.35, dur: 1.9, f0: 105, f1: 52, glide: 1.6, type: "saw", gain: 0.6,
      attack: 0.1, decay: 0.8, sustain: 0.35, jitter: 0.18, drive: 3.2, vib: 3.2, vibDepth: 0.05,
      pan: 0.68, am: 0.3, amRate: 5.5,
      formants: [
        { f: 260, q: 5, g: 1 }, { f: 560, q: 6, g: 0.8 },
        { f: 1100, q: 5, g: 0.4 }, { f: 2200, q: 4, g: 0.15 }
      ]
    });
    // sub
    s.osc({ t: 0.1, dur: 2.4, f0: 58, f1: 30, glide: 1.4, type: "sine", gain: 0.7, attack: 0.15, decay: 1.0, sustain: 0.25, drive: 1.8 });
    // roaring noise
    s.noise({ t: 0.3, dur: 1.9, gain: 0.28, attack: 0.2, decay: 0.9, type: "bp", f: 520, q: 0.7, am: 0.5, amRate: 6, pan: 0.5 });
    s.noise({ t: 0.2, dur: 1.6, gain: 0.12, attack: 0.2, decay: 0.8, type: "hp", f: 2600, q: 0.8, pan: 0.5 });
  }

  /* ---------------------------------------------------------- */
  /* environment / impacts                                      */
  /* ---------------------------------------------------------- */

  function buildBarricadeHit(s) {
    s.noise({ t: 0, dur: 0.16, gain: 0.6, attack: 0.001, decay: 0.035, type: "lp", f: 1600, f1: 500 });
    s.osc({ t: 0, dur: 0.2, f0: 210, f1: 120, type: "sine", gain: 0.5, attack: 0.001, decay: 0.06, drive: 1.4 });
    s.osc({ t: 0.001, dur: 0.2, f0: 430, f1: 360, type: "sine", gain: 0.2, attack: 0.002, decay: 0.08 });
    s.noise({ t: 0.004, dur: 0.12, gain: 0.15, attack: 0.002, decay: 0.05, type: "bp", f: 900, q: 3 });
  }

  function buildBarricadeBreak(s) {
    s.noise({ t: 0, dur: 0.3, gain: 0.6, attack: 0.001, decay: 0.06, type: "hp", f: 1800, f1: 700, q: 0.7 });
    s.osc({ t: 0, dur: 0.4, f0: 180, f1: 60, type: "sine", gain: 0.6, attack: 0.002, decay: 0.12, drive: 1.6 });
    // splintering
    for (let k = 0; k < 7; k++) {
      const tt = 0.04 + s.rng() * 0.55;
      s.noise({
        t: tt, dur: 0.09, gain: 0.18 + s.rng() * 0.2, attack: 0.001, decay: 0.02,
        type: "bp", f: 1200 + s.rng() * 2600, q: 2, pan: 0.3 + s.rng() * 0.4
      });
    }
    // plank resonances
    s.osc({ t: 0.02, dur: 0.6, f0: 320, f1: 300, type: "sine", gain: 0.22, attack: 0.004, decay: 0.25 });
    s.osc({ t: 0.03, dur: 0.5, f0: 560, f1: 520, type: "sine", gain: 0.14, attack: 0.004, decay: 0.2 });
    // settling debris
    for (let k = 0; k < 6; k++) {
      const tt = 0.4 + s.rng() * 0.8;
      s.noise({
        t: tt, dur: 0.06, gain: 0.05 + s.rng() * 0.05, attack: 0.001, decay: 0.012,
        type: "bp", f: 2000 + s.rng() * 2000, q: 3, pan: s.rng()
      });
    }
    s.noise({ t: 0.5, dur: 0.9, gain: 0.07, attack: 0.05, decay: 0.35, type: "lp", f: 600, q: 0.6 });
  }

  function buildBarricadeRepair(s) {
    s.noise({ t: 0.02, dur: 0.5, gain: 0.12, attack: 0.02, decay: 0.2, type: "bp", f: 1500, f1: 800, q: 1 });
    // three hammer strokes
    for (let k = 0; k < 3; k++) {
      const t = k * 0.15;
      s.noise({ t: t, dur: 0.12, gain: 0.45, attack: 0.001, decay: 0.025, type: "lp", f: 1700, f1: 600, q: 0.7 });
      s.osc({ t: t, dur: 0.16, f0: 220, f1: 130, type: "sine", gain: 0.35, attack: 0.001, decay: 0.05, drive: 1.3 });
      s.osc({ t: t, dur: 0.2, f0: 460, f1: 400, type: "sine", gain: 0.12, attack: 0.002, decay: 0.07 });
      metalClick(s, t + 0.09, 2800, 0.12, 3, 0.6);
    }
  }

  function buildGeneratorHit(s) {
    // inharmonic metal clang
    const parts = [417, 812, 1290, 2030];
    for (let k = 0; k < parts.length; k++) {
      const f = parts[k];
      s.osc({
        t: 0, dur: 0.6, f0: f, f1: f * 0.985, type: "sine",
        gain: 0.3 * (1 - k * 0.18), attack: 0.001, decay: 0.16 / (1 + k * 0.5)
      });
    }
    s.noise({ t: 0, dur: 0.09, gain: 0.55, attack: 0.0008, decay: 0.02, type: "hp", f: 1600 });
    s.osc({ t: 0, dur: 0.2, f0: 120, f1: 60, type: "sine", gain: 0.4, attack: 0.001, decay: 0.06, drive: 1.4 });
    // electrical spark
    s.noise({ t: 0.01, dur: 0.15, gain: 0.1, attack: 0.001, decay: 0.03, type: "hp", f: 5000, am: 0.8, amRate: 60 });
  }

  function buildBulletConcrete(s) {
    s.noise({ t: 0, dur: 0.05, gain: 0.7, attack: 0.0005, decay: 0.007, type: "hp", f: 2500, q: 0.8 });
    s.noise({ t: 0.002, dur: 0.14, gain: 0.28, attack: 0.001, decay: 0.045, type: "bp", f: 1500, f1: 600, q: 0.8 });
    s.osc({ t: 0, dur: 0.08, f0: 180, f1: 90, type: "sine", gain: 0.25, attack: 0.001, decay: 0.025 });
    s.noise({ t: 0.02, dur: 0.2, gain: 0.06, attack: 0.004, decay: 0.08, type: "lp", f: 700, q: 0.5, pan: 0.4 });
  }

  function buildBulletWood(s) {
    s.noise({ t: 0, dur: 0.05, gain: 0.6, attack: 0.0006, decay: 0.008, type: "hp", f: 2000 });
    s.noise({ t: 0.001, dur: 0.1, gain: 0.35, attack: 0.001, decay: 0.03, type: "bp", f: 950, f1: 400, q: 1.2 });
    s.osc({ t: 0, dur: 0.12, f0: 160, f1: 80, type: "sine", gain: 0.3, attack: 0.001, decay: 0.04 });
    s.noise({ t: 0.01, dur: 0.16, gain: 0.07, attack: 0.002, decay: 0.05, type: "bp", f: 2600, q: 2 });
  }

  function buildBulletMetal(s) {
    s.noise({ t: 0, dur: 0.06, gain: 0.65, attack: 0.0005, decay: 0.008, type: "hp", f: 2600 });
    s.osc({ t: 0, dur: 0.4, f0: 1450, f1: 1380, type: "sine", gain: 0.3, attack: 0.001, decay: 0.14 });
    s.osc({ t: 0.001, dur: 0.3, f0: 2400, f1: 2300, type: "sine", gain: 0.22, attack: 0.001, decay: 0.1 });
    s.osc({ t: 0.002, dur: 0.22, f0: 3700, f1: 3550, type: "sine", gain: 0.14, attack: 0.001, decay: 0.07 });
    s.osc({ t: 0, dur: 0.1, f0: 160, f1: 90, type: "sine", gain: 0.2, attack: 0.001, decay: 0.03 });
  }

  function buildRicochet(s) {
    const f0 = 3600, f1 = 800;
    s.osc({ t: 0, dur: 0.55, f0: f0, f1: f1, glide: 0.42, type: "sine", gain: 0.5, attack: 0.003, decay: 0.22, vib: 18, vibDepth: 0.02 });
    s.osc({ t: 0.006, dur: 0.5, f0: f0 * 1.5, f1: f1 * 1.4, glide: 0.4, type: "sine", gain: 0.18, attack: 0.003, decay: 0.16 });
    s.osc({ t: 0.16, dur: 0.4, f0: f0 * 0.6, f1: f1 * 0.7, glide: 0.32, type: "sine", gain: 0.12, attack: 0.01, decay: 0.12, pan: 0.35 });
    s.osc({ t: 0.34, dur: 0.4, f0: f0 * 0.4, f1: f1 * 0.5, glide: 0.3, type: "sine", gain: 0.07, attack: 0.02, decay: 0.1, pan: 0.65 });
    s.noise({ t: 0, dur: 0.05, gain: 0.35, attack: 0.0005, decay: 0.007, type: "hp", f: 4000 });
  }

  function buildThunder(s) {
    // initial distant crack
    s.noise({ t: 0, dur: 0.3, gain: 0.3, attack: 0.002, decay: 0.09, type: "lp", f: 2600, f1: 600, q: 0.6 });
    // rolling swells
    const swells = [
      { t: 0.05, g: 0.75, d: 1.2, f: 300, f1: 120, pan: 0.4 },
      { t: 0.7, g: 0.6, d: 1.4, f: 220, f1: 90, pan: 0.62 },
      { t: 1.5, g: 0.5, d: 1.5, f: 180, f1: 70, pan: 0.42 },
      { t: 2.4, g: 0.35, d: 1.6, f: 140, f1: 60, pan: 0.58 }
    ];
    for (let k = 0; k < swells.length; k++) {
      const w = swells[k];
      s.noise({
        t: w.t, dur: w.d + 0.5, gain: w.g, attack: 0.2, decay: w.d * 0.55,
        type: "lp", f: w.f, f1: w.f1, q: 0.5, am: 0.3, amRate: 0.8 + k * 0.3, pan: w.pan
      });
    }
    // sub roll
    s.osc({ t: 0.3, dur: 3.5, f0: 52, f1: 24, glide: 2.2, type: "sine", gain: 0.5, attack: 0.6, decay: 1.6, sustain: 0.05 });
    // tail hiss
    s.noise({ t: 1.2, dur: 2.8, gain: 0.06, attack: 0.5, decay: 1.2, type: "lp", f: 500, q: 0.5 });
  }

  /* ---------------------------------------------------------- */
  /* pickups / UI / stingers                                    */
  /* ---------------------------------------------------------- */

  function buildPickupAmmo(s) {
    metalClick(s, 0, 2200, 0.4, 2, 0.5);
    s.osc({ t: 0.01, dur: 0.2, f0: 880, f1: 1150, type: "sine", gain: 0.3, attack: 0.003, decay: 0.07 });
    s.osc({ t: 0.07, dur: 0.22, f0: 1320, f1: 1700, type: "sine", gain: 0.22, attack: 0.003, decay: 0.08 });
    s.noise({ t: 0.05, dur: 0.12, gain: 0.08, attack: 0.001, decay: 0.03, type: "bp", f: 3000, q: 3 });
  }

  function buildPickupMed(s) {
    s.osc({ t: 0, dur: 0.6, f0: 660, type: "sine", gain: 0.4, attack: 0.02, decay: 0.24, sustain: 0.15 });
    s.osc({ t: 0.1, dur: 0.55, f0: 990, type: "sine", gain: 0.3, attack: 0.02, decay: 0.22, sustain: 0.12 });
    s.osc({ t: 0.01, dur: 0.5, f0: 330, type: "tri", gain: 0.14, attack: 0.03, decay: 0.2 });
    s.noise({ t: 0.06, dur: 0.4, gain: 0.05, attack: 0.05, decay: 0.18, type: "hp", f: 5000, q: 0.7 });
  }

  function buildPickupSupply(s) {
    metalClick(s, 0, 1800, 0.3, 2, 0.5);
    s.osc({ t: 0.01, dur: 0.5, f0: 440, type: "sine", gain: 0.3, attack: 0.015, decay: 0.2, sustain: 0.12 });
    s.osc({ t: 0.1, dur: 0.5, f0: 659.25, type: "sine", gain: 0.24, attack: 0.015, decay: 0.2, sustain: 0.1 });
    s.noise({ t: 0.03, dur: 0.25, gain: 0.06, attack: 0.01, decay: 0.1, type: "bp", f: 2600, q: 1 });
  }

  function buildUiClick(s) {
    s.noise({ t: 0, dur: 0.03, gain: 0.5, attack: 0.0006, decay: 0.005, type: "bp", f: 1800, q: 2 });
    s.osc({ t: 0, dur: 0.05, f0: 220, f1: 160, type: "sine", gain: 0.2, attack: 0.001, decay: 0.02 });
    s.osc({ t: 0.002, dur: 0.03, f0: 2400, f1: 2000, type: "sine", gain: 0.06, attack: 0.001, decay: 0.01 });
  }

  function buildUiHover(s) {
    s.noise({ t: 0, dur: 0.02, gain: 0.35, attack: 0.0006, decay: 0.004, type: "bp", f: 3200, q: 2 });
    s.osc({ t: 0, dur: 0.025, f0: 900, f1: 760, type: "sine", gain: 0.08, attack: 0.001, decay: 0.008 });
  }

  function buildWaveStart(s) {
    const formantsA = [{ f: 330, q: 1.2, g: 1 }, { f: 700, q: 1.1, g: 0.5 }, { f: 1500, q: 0.9, g: 0.2 }];
    const formantsB = [{ f: 440, q: 1.2, g: 1 }, { f: 880, q: 1.1, g: 0.5 }, { f: 1800, q: 0.9, g: 0.2 }];
    // D + A war horn
    s.osc({
      t: 0, dur: 2.0, f0: 73.42, type: "saw", gain: 0.28, attack: 0.22, decay: 0.9, sustain: 0.35,
      vib: 4.5, vibDepth: 0.006, pan: 0.38, formants: formantsA
    });
    s.osc({
      t: 0.02, dur: 1.9, f0: 110.0, type: "saw", gain: 0.24, attack: 0.24, decay: 0.9, sustain: 0.3,
      vib: 4.2, vibDepth: 0.006, pan: 0.62, formants: formantsB
    });
    // sub impact
    s.osc({ t: 0, dur: 0.9, f0: 70, f1: 40, type: "sine", gain: 0.5, attack: 0.005, decay: 0.25, drive: 1.5 });
    // distant war drum
    s.osc({ t: 0.9, dur: 0.7, f0: 65, f1: 38, type: "sine", gain: 0.35, attack: 0.005, decay: 0.22 });
    s.noise({ t: 0.9, dur: 0.3, gain: 0.08, attack: 0.002, decay: 0.1, type: "lp", f: 400, q: 0.6 });
    // cold air tail
    s.noise({ t: 0.2, dur: 1.8, gain: 0.05, attack: 0.4, decay: 0.7, type: "bp", f: 1200, q: 0.8 });
  }

  function buildWaveEnd(s) {
    const formantsA = [{ f: 300, q: 1.2, g: 1 }, { f: 650, q: 1, g: 0.5 }];
    const formantsB = [{ f: 420, q: 1.2, g: 1 }, { f: 900, q: 1, g: 0.5 }];
    s.osc({
      t: 0, dur: 1.5, f0: 110.0, type: "saw", gain: 0.22, attack: 0.18, decay: 0.7, sustain: 0.2,
      vib: 4, vibDepth: 0.006, pan: 0.4, formants: formantsA
    });
    s.osc({
      t: 0.1, dur: 1.3, f0: 146.83, type: "saw", gain: 0.18, attack: 0.2, decay: 0.6, sustain: 0.18,
      vib: 3.8, vibDepth: 0.006, pan: 0.6, formants: formantsB
    });
    s.osc({ t: 0, dur: 0.8, f0: 60, f1: 36, type: "sine", gain: 0.35, attack: 0.01, decay: 0.3 });
    s.noise({ t: 0.1, dur: 1.2, gain: 0.04, attack: 0.3, decay: 0.5, type: "lp", f: 900, q: 0.6 });
  }

  function buildVictory(s) {
    // D major resolve, slow swell
    const notes = [146.83, 185.0, 220.0, 293.66];
    for (let k = 0; k < notes.length; k++) {
      const n = notes[k];
      s.osc({
        t: k * 0.12, dur: 3.2 - k * 0.2, f0: n, type: "sine", gain: 0.22,
        attack: 0.9, decay: 1.2, sustain: 0.25, vib: 4.5, vibDepth: 0.004,
        pan: 0.3 + k * 0.13
      });
      s.osc({
        t: k * 0.12, dur: 3.0, f0: n * 2, type: "saw", gain: 0.05,
        attack: 1.0, decay: 1.0, sustain: 0.15, pan: 0.5,
        formants: [{ f: 1200, q: 1, g: 1 }, { f: 2400, q: 1, g: 0.4 }]
      });
    }
    s.noise({ t: 0.6, dur: 2.6, gain: 0.05, attack: 0.8, decay: 1.0, type: "hp", f: 4000, q: 0.7, am: 0.3, amRate: 5 });
  }

  function buildDefeat(s) {
    const fA = [{ f: 250, q: 1, g: 1 }, { f: 520, q: 1, g: 0.5 }];
    const fB = [{ f: 265, q: 1, g: 1 }, { f: 560, q: 1, g: 0.5 }];
    s.osc({
      t: 0, dur: 3.6, f0: 110, f1: 55, glide: 3.0, type: "saw", gain: 0.3,
      attack: 0.7, decay: 1.4, sustain: 0.25, vib: 2.8, vibDepth: 0.01, jitter: 0.02,
      pan: 0.45, formants: fA
    });
    s.osc({
      t: 0.2, dur: 3.4, f0: 116.5, f1: 58, glide: 3.0, type: "saw", gain: 0.22,
      attack: 0.8, decay: 1.4, sustain: 0.2, pan: 0.55, formants: fB
    });
    s.osc({ t: 0, dur: 3.2, f0: 48, f1: 28, glide: 2.4, type: "sine", gain: 0.5, attack: 0.4, decay: 1.4, sustain: 0.1, drive: 1.6 });
    s.noise({ t: 0.3, dur: 3.0, gain: 0.05, attack: 1.0, decay: 1.2, type: "lp", f: 600, q: 0.6 });
  }

  /* ---------------------------------------------------------- */
  /* music material (pre-rendered; played sparsely)             */
  /* ---------------------------------------------------------- */

  function buildStringNote(s, freq) {
    s.osc({
      t: 0, dur: 2.5, f0: freq, type: "saw", gain: 0.4, attack: 0.28, decay: 1.0, sustain: 0.28,
      vib: 4.8, vibDepth: 0.006, pan: 0.35,
      formants: [{ f: freq * 3.2, q: 2.2, g: 1 }, { f: freq * 6.5, q: 1.7, g: 0.45 }, { f: 1300, q: 1.2, g: 0.18 }]
    });
    s.osc({
      t: 0.012, dur: 2.4, f0: freq * 1.004, type: "saw", gain: 0.3, attack: 0.3, decay: 0.95,
      sustain: 0.24, vib: 4.4, vibDepth: 0.007, pan: 0.65,
      formants: [{ f: freq * 3.4, q: 2.0, g: 1 }, { f: freq * 6.8, q: 1.6, g: 0.4 }]
    });
    s.osc({ t: 0, dur: 2.5, f0: freq * 0.5, type: "sine", gain: 0.14, attack: 0.36, decay: 1.1, sustain: 0.2 });
  }

  function buildHeartbeat(s) {
    s.osc({ t: 0, dur: 0.25, f0: 72, f1: 40, type: "sine", gain: 0.9, attack: 0.004, decay: 0.09, drive: 1.6 });
    s.noise({ t: 0, dur: 0.08, gain: 0.15, attack: 0.002, decay: 0.02, type: "lp", f: 400, q: 0.6 });
    s.osc({ t: 0.16, dur: 0.28, f0: 64, f1: 36, type: "sine", gain: 0.6, attack: 0.005, decay: 0.1, drive: 1.5 });
  }

  function buildCreak(s) {
    s.noise({ t: 0.1, dur: 1.6, gain: 0.35, attack: 0.2, decay: 0.7, type: "bp", f: 900, f1: 1400, q: 18, am: 0.4, amRate: 2.2, pan: 0.45 });
    s.noise({ t: 0.5, dur: 1.4, gain: 0.2, attack: 0.2, decay: 0.6, type: "bp", f: 1800, f1: 1100, q: 25, pan: 0.6 });
    s.osc({ t: 0.2, dur: 1.8, f0: 420, f1: 365, glide: 1.2, type: "sine", gain: 0.12, attack: 0.3, decay: 0.6, vib: 2.5, vibDepth: 0.01, pan: 0.4 });
    s.osc({ t: 0.6, dur: 1.6, f0: 1170, f1: 980, glide: 1.0, type: "sine", gain: 0.06, attack: 0.3, decay: 0.6, pan: 0.6 });
    s.noise({ t: 0.2, dur: 2.2, gain: 0.1, attack: 0.5, decay: 0.9, type: "bp", f: 420, f1: 520, q: 8 });
  }

  /* ---------------------------------------------------------- */
  /* ambient loop material                                      */
  /* ---------------------------------------------------------- */

  function buildRainLoop(ctx) {
    const loopDur = 6.5;
    const fade = 0.6;
    const s = new Synth(ctx, loopDur + fade, 2, 0x2A11, 24000);
    const total = loopDur + fade;
    // decorrelated stereo hiss
    s.bed({ type: "hp", f: 2400, q: 0.7, gain: 0.30, pan: 0, lfos: [{ f: 0.11, depth: 0.35 }, { f: 0.037, depth: 0.25, phase: 1.3 }] });
    s.bed({ type: "hp", f: 2100, q: 0.7, gain: 0.30, pan: 1, lfos: [{ f: 0.09, depth: 0.35, phase: 0.7 }, { f: 0.043, depth: 0.25, phase: 2.1 }] });
    // mid body
    s.bed({ type: "bp", f: 850, q: 0.6, gain: 0.15, pan: 0.5, lfos: [{ f: 0.06, depth: 0.25 }] });
    // low roar
    s.bed({ type: "lp", f: 260, q: 0.5, gain: 0.12, pan: 0.5, lfos: [{ f: 0.03, depth: 0.2 }] });
    // droplet transients
    const drops = Math.floor(total * 45);
    for (let k = 0; k < drops; k++) {
      const t = s.rng() * total;
      const f = 900 + Math.pow(s.rng(), 1.6) * 4200;
      const d = 0.004 + s.rng() * 0.02;
      s.osc({
        t: t, dur: d * 2.5, f0: f, f1: f * 0.72, type: "sine",
        gain: 0.012 + s.rng() * 0.05, attack: 0.001, decay: d, pan: s.rng()
      });
    }
    return s.doneLoop(0.82, fade);
  }

  function buildWindLoop(ctx) {
    const loopDur = 8.5;
    const fade = 0.8;
    const s = new Synth(ctx, loopDur + fade, 2, 0x51B2, 24000);
    s.bed({
      type: "lp", f: 520, q: 0.9, gain: 0.38, pan: 0,
      cutoffLfo: { f: 0.08, depth: 0.5 },
      lfos: [{ f: 0.06, depth: 0.5 }, { f: 0.021, depth: 0.35, phase: 1.1 }, { f: 0.13, depth: 0.15, phase: 2.2 }]
    });
    s.bed({
      type: "lp", f: 470, q: 0.9, gain: 0.38, pan: 1,
      cutoffLfo: { f: 0.065, depth: 0.55, phase: 1.7 },
      lfos: [{ f: 0.05, depth: 0.5, phase: 0.9 }, { f: 0.017, depth: 0.4, phase: 2.4 }, { f: 0.11, depth: 0.15, phase: 0.3 }]
    });
    // howling resonances
    s.bed({ type: "bp", f: 700, q: 20, gain: 0.05, pan: 0.35, cutoffLfo: { f: 0.05, depth: 0.45, phase: 0.4 }, lfos: [{ f: 0.07, depth: 0.7 }] });
    s.bed({ type: "bp", f: 1150, q: 26, gain: 0.03, pan: 0.66, cutoffLfo: { f: 0.043, depth: 0.5, phase: 2.0 }, lfos: [{ f: 0.055, depth: 0.8, phase: 1.4 }] });
    return s.doneLoop(0.75, fade);
  }

  function buildHumLoop(ctx) {
    // Exact integer cycles over 2 s -> seamless without crossfade.
    const s = new Synth(ctx, 2.0, 1, 0x6C3D, 24000);
    s.osc({ t: 0, dur: 2.0, f0: 50, type: "sine", gain: 0.55, attack: 0, decay: 0, am: 0.12, amRate: 0.5, tailFade: false });
    s.osc({ t: 0, dur: 2.0, f0: 100, type: "sine", gain: 0.22, attack: 0, decay: 0, am: 0.08, amRate: 1, tailFade: false });
    s.osc({ t: 0, dur: 2.0, f0: 150, type: "sine", gain: 0.10, attack: 0, decay: 0, tailFade: false });
    s.osc({ t: 0, dur: 2.0, f0: 200, type: "sine", gain: 0.05, attack: 0, decay: 0, tailFade: false });
    s.osc({ t: 0, dur: 2.0, f0: 300, type: "sine", gain: 0.028, attack: 0, decay: 0, vib: 0.5, vibDepth: 0.002, tailFade: false });
    s.osc({ t: 0, dur: 2.0, f0: 450, type: "tri", gain: 0.016, attack: 0, decay: 0, vib: 1, vibDepth: 0.0015, tailFade: false });
    return s.done(0.6, true);
  }

  /* ---------------------------------------------------------- */
  /* per-sound mix defaults                                     */
  /* ---------------------------------------------------------- */

  const DEFAULT_DEF = { gain: 1, rateVar: 0.03, send: 0.1, refDistance: 2.5, maxDistance: 120, rolloff: 1 };

  const SOUND_DEF = {
    rifle: { gain: 1.0, rateVar: 0.03, send: 0.20, refDistance: 6, maxDistance: 140, rolloff: 0.9 },
    pistol: { gain: 0.92, rateVar: 0.035, send: 0.18, refDistance: 5, maxDistance: 110, rolloff: 0.95 },
    dryfire: { gain: 0.8, rateVar: 0.05, send: 0.05 },
    reload_out: { gain: 0.85, rateVar: 0.06, send: 0.06 },
    reload_in: { gain: 0.9, rateVar: 0.06, send: 0.06 },
    bolt: { gain: 0.85, rateVar: 0.05, send: 0.06 },
    equip: { gain: 0.8, rateVar: 0.05, send: 0.05 },
    explosion: { gain: 1.0, rateVar: 0.05, send: 0.35, refDistance: 10, maxDistance: 220, rolloff: 0.6 },
    footstep_concrete: { gain: 0.75, rateVar: 0.12, send: 0.06, refDistance: 2.0, maxDistance: 45, rolloff: 1.1 },
    footstep_mud: { gain: 0.8, rateVar: 0.12, send: 0.05, refDistance: 2.0, maxDistance: 45, rolloff: 1.1 },
    footstep_grass: { gain: 0.85, rateVar: 0.14, send: 0.04, refDistance: 2.0, maxDistance: 45, rolloff: 1.1 },
    land: { gain: 0.9, rateVar: 0.06, send: 0.10 },
    hurt: { gain: 1.0, rateVar: 0.06, send: 0.10 },
    heal: { gain: 0.9, rateVar: 0.03, send: 0.18 },
    hit_flesh: { gain: 1.0, rateVar: 0.07, send: 0.08, refDistance: 3, maxDistance: 70 },
    headshot: { gain: 1.0, rateVar: 0.06, send: 0.10, refDistance: 3, maxDistance: 70 },
    zombie_growl: { gain: 0.95, rateVar: 0.1, send: 0.18, refDistance: 4, maxDistance: 100, rolloff: 1.05 },
    zombie_attack: { gain: 1.0, rateVar: 0.07, send: 0.16, refDistance: 3.5, maxDistance: 80 },
    zombie_death: { gain: 1.0, rateVar: 0.08, send: 0.16, refDistance: 4, maxDistance: 100 },
    zombie_scream: { gain: 1.0, rateVar: 0.06, send: 0.2, refDistance: 5, maxDistance: 130, rolloff: 0.95 },
    brute_roar: { gain: 1.0, rateVar: 0.04, send: 0.3, refDistance: 8, maxDistance: 180, rolloff: 0.8 },
    barricade_hit: { gain: 0.9, rateVar: 0.08, send: 0.12, refDistance: 3, maxDistance: 80 },
    barricade_break: { gain: 1.0, rateVar: 0.05, send: 0.2, refDistance: 5, maxDistance: 120 },
    barricade_repair: { gain: 0.85, rateVar: 0.07, send: 0.1, refDistance: 3, maxDistance: 60 },
    generator_hit: { gain: 0.95, rateVar: 0.06, send: 0.15, refDistance: 3, maxDistance: 80 },
    bullet_concrete: { gain: 0.9, rateVar: 0.1, send: 0.14, refDistance: 3, maxDistance: 70 },
    bullet_wood: { gain: 0.9, rateVar: 0.1, send: 0.1, refDistance: 3, maxDistance: 60 },
    bullet_metal: { gain: 0.9, rateVar: 0.08, send: 0.14, refDistance: 3, maxDistance: 70 },
    ricochet: { gain: 0.9, rateVar: 0.1, send: 0.25, refDistance: 4, maxDistance: 90 },
    thunder: { gain: 1.0, rateVar: 0.05, send: 0.4 },
    pickup_ammo: { gain: 1.0, rateVar: 0.02, send: 0.12 },
    pickup_med: { gain: 1.0, rateVar: 0.02, send: 0.15 },
    pickup_supply: { gain: 1.0, rateVar: 0.02, send: 0.14 },
    ui_click: { gain: 1.0, rateVar: 0.02, send: 0.04 },
    ui_hover: { gain: 1.0, rateVar: 0.03, send: 0.03 },
    wave_start: { gain: 1.0, rateVar: 0.01, send: 0.3 },
    wave_end: { gain: 1.0, rateVar: 0.01, send: 0.3 },
    victory: { gain: 1.0, rateVar: 0.01, send: 0.35 },
    defeat: { gain: 1.0, rateVar: 0.01, send: 0.35 }
  };

  const SOUND_BUILDERS = {
    rifle: function (ctx) { return makeVariants(ctx, 2, 1.05, 2, 0x51A1, 0.92, buildRifle, SR_HI); },
    pistol: function (ctx) { return makeVariants(ctx, 2, 0.62, 2, 0x51A2, 0.78, buildPistol, SR_HI); },
    dryfire: function (ctx) { return makeOne(ctx, 0.16, 1, 0x51A3, 0.32, buildDryfire); },
    reload_out: function (ctx) { return makeOne(ctx, 0.5, 1, 0x51A4, 0.42, buildReloadOut); },
    reload_in: function (ctx) { return makeOne(ctx, 0.6, 1, 0x51A5, 0.5, buildReloadIn); },
    bolt: function (ctx) { return makeOne(ctx, 0.48, 1, 0x51A6, 0.45, buildBolt); },
    equip: function (ctx) { return makeOne(ctx, 0.5, 1, 0x51A7, 0.4, buildEquip); },
    explosion: function (ctx) { return makeOne(ctx, 2.6, 2, 0x51A8, 0.98, buildExplosion, SR_HI); },
    footstep_concrete: function (ctx) { return makeVariants(ctx, 3, 0.26, 1, 0x51B1, 0.17, buildFootstepConcrete); },
    footstep_mud: function (ctx) { return makeVariants(ctx, 3, 0.3, 1, 0x51B2, 0.19, buildFootstepMud); },
    footstep_grass: function (ctx) { return makeVariants(ctx, 3, 0.24, 1, 0x51B3, 0.15, buildFootstepGrass); },
    land: function (ctx) { return makeOne(ctx, 0.45, 1, 0x51B4, 0.46, buildLand); },
    hurt: function (ctx) { return makeOne(ctx, 0.55, 1, 0x51B5, 0.58, buildHurt); },
    heal: function (ctx) { return makeOne(ctx, 1.1, 1, 0x51B6, 0.42, buildHeal); },
    hit_flesh: function (ctx) { return makeOne(ctx, 0.28, 1, 0x51B7, 0.5, buildHitFlesh); },
    headshot: function (ctx) { return makeOne(ctx, 0.32, 2, 0x51B8, 0.66, buildHeadshot); },
    zombie_growl: function (ctx) { return makeVariants(ctx, 2, 1.7, 2, 0x51C1, 0.6, buildZombieGrowl); },
    zombie_attack: function (ctx) { return makeOne(ctx, 0.7, 1, 0x51C2, 0.68, buildZombieAttack); },
    zombie_death: function (ctx) { return makeOne(ctx, 1.7, 2, 0x51C3, 0.62, buildZombieDeath); },
    zombie_scream: function (ctx) { return makeOne(ctx, 1.3, 2, 0x51C4, 0.66, buildZombieScream); },
    brute_roar: function (ctx) { return makeOne(ctx, 2.9, 2, 0x51C5, 0.98, buildBruteRoar); },
    barricade_hit: function (ctx) { return makeOne(ctx, 0.42, 1, 0x51D1, 0.5, buildBarricadeHit); },
    barricade_break: function (ctx) { return makeOne(ctx, 1.7, 2, 0x51D2, 0.75, buildBarricadeBreak); },
    barricade_repair: function (ctx) { return makeOne(ctx, 1.0, 1, 0x51D3, 0.45, buildBarricadeRepair); },
    generator_hit: function (ctx) { return makeOne(ctx, 0.6, 1, 0x51D4, 0.55, buildGeneratorHit); },
    bullet_concrete: function (ctx) { return makeOne(ctx, 0.4, 1, 0x51D5, 0.44, buildBulletConcrete); },
    bullet_wood: function (ctx) { return makeOne(ctx, 0.38, 1, 0x51D6, 0.4, buildBulletWood); },
    bullet_metal: function (ctx) { return makeOne(ctx, 0.55, 1, 0x51D7, 0.46, buildBulletMetal); },
    ricochet: function (ctx) { return makeOne(ctx, 1.2, 2, 0x51D8, 0.46, buildRicochet, SR_HI); },
    thunder: function (ctx) { return makeOne(ctx, 4.8, 2, 0x51E1, 0.95, buildThunder); },
    pickup_ammo: function (ctx) { return makeOne(ctx, 0.4, 1, 0x51E2, 0.34, buildPickupAmmo); },
    pickup_med: function (ctx) { return makeOne(ctx, 0.8, 1, 0x51E3, 0.32, buildPickupMed); },
    pickup_supply: function (ctx) { return makeOne(ctx, 0.7, 1, 0x51E4, 0.34, buildPickupSupply); },
    ui_click: function (ctx) { return makeOne(ctx, 0.12, 1, 0x51E5, 0.22, buildUiClick); },
    ui_hover: function (ctx) { return makeOne(ctx, 0.1, 1, 0x51E6, 0.14, buildUiHover); },
    wave_start: function (ctx) { return makeOne(ctx, 2.2, 2, 0x51F1, 0.6, buildWaveStart); },
    wave_end: function (ctx) { return makeOne(ctx, 1.8, 2, 0x51F2, 0.55, buildWaveEnd); },
    victory: function (ctx) { return makeOne(ctx, 3.6, 2, 0x51F3, 0.62, buildVictory); },
    defeat: function (ctx) { return makeOne(ctx, 3.8, 2, 0x51F4, 0.62, buildDefeat); }
  };

  /* ---------------------------------------------------------- */
  /* AudioEngine                                                */
  /* ---------------------------------------------------------- */

  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.buffers = {};
      this.initMs = 0;
      this.renderMs = 0;
      this.renderErrors = [];

      this._ready = false;
      this._disposed = false;
      this._initPromise = null;
      this._resuming = false;
      this._ambientWanted = false;

      this._volume = 0.9;
      this._muted = false;
      this._voices = [];
      this._timeouts = [];

      this._dryBus = null;
      this._reverbSend = null;
      this._reverbReturn = null;
      this._convolver = null;
      this._volumeGain = null;
      this._muteGain = null;
      this._glue = null;
      this._limiter = null;

      this._rainBuf = null;
      this._windBuf = null;
      this._humBuf = null;
      this._creakBuf = null;
      this._pulseBufs = null;
      this._heartBuf = null;

      this._ambient = null;
      this._ambientOn = false;
      this._droneGain = null;
      this._droneFilter = null;
      this._droneSend = null;
      this._droneOscs = null;

      this._userTension = 0.2;
      this._tension = 0.1;
      this._mixTimer = 0;
      this._pulseTimer = 2.0;
      this._heartTimer = 0.5;
    }

    get ready() { return this._ready; }

    /* ------------------------------------------------------ */
    /* init                                                   */
    /* ------------------------------------------------------ */

    init() {
      if (this._ready) return Promise.resolve(this);
      if (this._initPromise) return this._initPromise;
      this._initPromise = this._doInit();
      return this._initPromise;
    }

    async _doInit() {
      const t0 = nowMs();
      const Ctor = (typeof window !== "undefined") &&
        (window.AudioContext || window.webkitAudioContext);
      if (!Ctor) {
        this._initPromise = null;
        return false;
      }
      let ctx = null;
      try {
        this._disposed = false;
        ctx = new Ctor({ latencyHint: "interactive" });
        this.ctx = ctx;
        this._buildGraph(ctx);
        this._renderBuffers(ctx);
        this._buildMusic(ctx);
        this._setListenerDefaults(ctx);
        if (ctx.state === "suspended") {
          // Resume within the gesture if possible, but never block init:
          // if the autoplay policy keeps the context suspended, init still
          // completes and play() silently no-ops until a gesture arrives.
          try {
            const resumed = ctx.resume();
            if (resumed && resumed.then) {
              await Promise.race([
                resumed,
                new Promise(function (resolve) { setTimeout(resolve, 220); })
              ]);
            }
          } catch (e) { /* gesture may be required */ }
        }
        this._ready = true;
        this.initMs = Math.round(nowMs() - t0);
        this._applyMix("menu", 100);
        if (this._ambientWanted) this.startAmbient();
        return this;
      } catch (err) {
        this._initError = err;
        this._ready = false;
        this._initPromise = null;
        this.ctx = null;
        try { if (ctx) ctx.close(); } catch (e) { /* ignore */ }
        return false;
      }
    }

    _buildGraph(ctx) {
      // master chain: volume -> mute -> glue compressor -> limiter -> out
      const volume = ctx.createGain();
      volume.gain.value = this._volume;
      this._volumeGain = volume;

      const mute = ctx.createGain();
      mute.gain.value = this._muted ? 0 : 1;
      this._muteGain = mute;

      const glue = ctx.createDynamicsCompressor();
      glue.threshold.value = -16;
      glue.knee.value = 12;
      glue.ratio.value = 3;
      glue.attack.value = 0.012;
      glue.release.value = 0.25;
      this._glue = glue;

      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -4;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.12;
      this._limiter = limiter;

      volume.connect(mute);
      mute.connect(glue);
      glue.connect(limiter);
      limiter.connect(ctx.destination);

      // dry bus
      const dry = ctx.createGain();
      dry.gain.value = 1;
      dry.connect(volume);
      this._dryBus = dry;

      // procedural reverb
      const conv = ctx.createConvolver();
      conv.normalize = true;
      conv.buffer = this._makeImpulseResponse(ctx);
      this._convolver = conv;

      const send = ctx.createGain();
      send.gain.value = 1;
      send.connect(conv);
      this._reverbSend = send;

      const ret = ctx.createGain();
      ret.gain.value = 0.85;
      conv.connect(ret);
      ret.connect(volume);
      this._reverbReturn = ret;
    }

    _makeImpulseResponse(ctx) {
      const sr = ctx.sampleRate || 48000;
      const dur = 2.8;
      const n = Math.floor(dur * sr);
      const buf = ctx.createBuffer(2, n, sr);
      const rng = mulberry32(0xA17E55);
      const preDelay = Math.floor(0.018 * sr);
      // sparse early reflections (bunker slap)
      const refl = [0.011, 0.019, 0.029, 0.041, 0.058, 0.077, 0.101];
      for (let c = 0; c < 2; c++) {
        const d = buf.getChannelData(c);
        let lp = 0;
        let decay = 1;
        let coef = 0.2;
        for (let i = 0; i < n; i++) {
          if ((i & 63) === 0) {
            const t = Math.max(0, (i - preDelay) / sr);
            decay = Math.exp(-t * 6.907755 / 2.6);
            const fc = 7000 * Math.pow(1500 / 7000, t / 2.6);
            coef = 1 - Math.exp(-TAU * fc / sr);
          }
          let v = 0;
          if (i >= preDelay) {
            const nz = rng() * 2 - 1;
            lp += (nz - lp) * coef;
            v = lp * decay * 0.5;
          }
          d[i] = v;
        }
        for (let k = 0; k < refl.length; k++) {
          const idx = Math.floor((refl[k] + (c ? 0.0021 : 0)) * sr);
          if (idx < n) d[idx] += (k % 2 ? -1 : 1) * (0.5 / (1 + k * 0.75));
        }
        // gentle tail fade
        const fadeN = Math.floor(0.02 * sr);
        for (let i = 0; i < fadeN; i++) d[n - 1 - i] *= i / fadeN;
      }
      return buf;
    }

    _renderBuffers(ctx) {
      const t0 = nowMs();
      const buffers = {};
      const errors = [];
      const timing = {};
      for (const name in SOUND_BUILDERS) {
        if (!Object.prototype.hasOwnProperty.call(SOUND_BUILDERS, name)) continue;
        const tb = nowMs();
        try {
          buffers[name] = SOUND_BUILDERS[name](ctx);
        } catch (e) {
          buffers[name] = null;
          errors.push(name + ": " + (e && e.message ? e.message : String(e)));
        }
        timing[name] = nowMs() - tb;
      }
      this.buffers = buffers;
      const tk = (label, fn) => {
        const tb = nowMs();
        try { return fn(); } catch (e) { errors.push(label + ": " + e); return null; }
        finally { timing[label] = nowMs() - tb; }
      };
      this._rainBuf = tk("_rain", () => buildRainLoop(ctx));
      this._windBuf = tk("_wind", () => buildWindLoop(ctx));
      this._humBuf = tk("_hum", () => buildHumLoop(ctx));
      this._creakBuf = tk("_creak", () => makeOne(ctx, 2.6, 2, 0x3311, 0.5, buildCreak, 24000));
      this._pulseBufs = [];
      const notes = [146.83, 174.61, 220.0, 261.63];
      for (let i = 0; i < notes.length; i++) {
        this._pulseBufs.push(tk("_pulse" + i, (function (f) {
          return function () {
            return makeOne(ctx, 2.6, 2, 0x7C11 + i * 97, 0.5, function (s) { buildStringNote(s, f); }, 24000);
          };
        })(notes[i])));
      }
      this._heartBuf = tk("_heart", () => makeOne(ctx, 0.7, 1, 0x1199, 0.7, buildHeartbeat));
      this.renderMs = Math.round(nowMs() - t0);
      this.renderErrors = errors;
      this.renderTiming = timing;
    }

    _setListenerDefaults(ctx) {
      try {
        const L = ctx.listener;
        if (!L) return;
        if (L.positionX) {
          L.positionX.value = 0; L.positionY.value = 0; L.positionZ.value = 0;
          L.forwardX.value = 0; L.forwardY.value = 0; L.forwardZ.value = -1;
          L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
        } else {
          if (L.setPosition) L.setPosition(0, 0, 0);
          if (L.setOrientation) L.setOrientation(0, 0, -1, 0, 1, 0);
        }
      } catch (e) { /* ignore */ }
    }

    _buildMusic(ctx) {
      // Low tension drone: A1 / E2 / A2 / E3 through a slowly opening LP.
      const droneGain = ctx.createGain();
      droneGain.gain.value = 0.0001;
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 180;
      filter.Q.value = 0.8;
      const send = ctx.createGain();
      send.gain.value = 0.08;
      const oscs = [];
      const addOsc = (type, freq, gain) => {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = freq;
        const g = ctx.createGain();
        g.gain.value = gain;
        o.connect(g);
        g.connect(filter);
        o.start();
        oscs.push({ osc: o, gain: g, base: gain });
      };
      addOsc("sine", 55, 0.55);
      addOsc("triangle", 82.41, 0.2);
      addOsc("sine", 110, 0.14);
      addOsc("sine", 164.81, 0.05);

      // slow detune drift
      const lfo = ctx.createOscillator();
      lfo.type = "sine";
      lfo.frequency.value = 0.07;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 7;
      lfo.connect(lfoGain);
      for (let i = 0; i < oscs.length; i++) lfoGain.connect(oscs[i].osc.detune);
      lfo.start();

      filter.connect(droneGain);
      droneGain.connect(this._dryBus);
      droneGain.connect(send);
      send.connect(this._reverbSend);

      this._droneGain = droneGain;
      this._droneFilter = filter;
      this._droneSend = send;
      this._droneOscs = oscs.map(function (o) { return o.osc; });
      this._droneOscs.push(lfo);
    }

    /* ------------------------------------------------------ */
    /* public controls                                        */
    /* ------------------------------------------------------ */

    setMasterVolume(v) {
      this._volume = clamp(typeof v === "number" ? v : 0.9, 0, 1);
      if (this._volumeGain && this.ctx) {
        try {
          this._volumeGain.gain.setTargetAtTime(this._volume, this.ctx.currentTime, 0.02);
        } catch (e) { /* ignore */ }
      }
    }

    setMuted(flag) {
      this._muted = !!flag;
      if (this._muteGain && this.ctx) {
        try {
          this._muteGain.gain.setTargetAtTime(this._muted ? 0 : 1, this.ctx.currentTime, 0.02);
        } catch (e) { /* ignore */ }
      }
    }

    setListener(position, forward, up) {
      if (!this._ready || !this.ctx) return;
      const L = this.ctx.listener;
      if (!L || !position) return;
      const f = forward || { x: 0, y: 0, z: -1 };
      const u = up || { x: 0, y: 1, z: 0 };
      try {
        if (L.positionX) {
          L.positionX.value = position.x;
          L.positionY.value = position.y;
          L.positionZ.value = position.z;
          L.forwardX.value = f.x;
          L.forwardY.value = f.y;
          L.forwardZ.value = f.z;
          L.upX.value = u.x;
          L.upY.value = u.y;
          L.upZ.value = u.z;
        } else {
          if (L.setPosition) L.setPosition(position.x, position.y, position.z);
          if (L.setOrientation) L.setOrientation(f.x, f.y, f.z, u.x, u.y, u.z);
        }
      } catch (e) { /* ignore */ }
    }

    setTension(level) {
      const v = typeof level === "number" ? level : 0;
      this._userTension = clamp(v, 0, 1);
    }

    /* ------------------------------------------------------ */
    /* one-shot playback                                      */
    /* ------------------------------------------------------ */

    play(name, opts) {
      if (!this._ready || !this.ctx || this._disposed) return null;
      const bank = this.buffers[name];
      if (!bank) return null;
      const ctx = this.ctx;
      if (ctx.state !== "running") { this._tryResume(); return null; }
      const o = opts || EMPTY_OPTS;
      const buf = Array.isArray(bank) ? bank[(Math.random() * bank.length) | 0] : bank;
      if (!buf) return null;
      const def = SOUND_DEF[name] || DEFAULT_DEF;
      const vary = o.rate == null ? (def.rateVar || 0) : 0;
      const rate = clamp((o.rate == null ? 1 : o.rate) * (1 + (Math.random() * 2 - 1) * vary), 0.2, 4);
      const vol = clamp((o.volume == null ? 1 : o.volume) * (def.gain == null ? 1 : def.gain), 0, 4);
      if (!(vol > 0.0001)) return null;
      return this._start(buf, {
        vol: vol,
        rate: rate,
        loop: !!o.loop,
        pos: o.pos || null,
        refDistance: o.refDistance == null ? def.refDistance : o.refDistance,
        maxDistance: o.maxDistance == null ? def.maxDistance : o.maxDistance,
        rolloff: def.rolloff,
        send: def.send == null ? 0.12 : def.send,
        name: name
      });
    }

    _start(buf, o) {
      const ctx = this.ctx;
      if (!ctx || !buf || this._disposed) return null;
      if (ctx.state !== "running") { this._tryResume(); return null; }
      if (this._voices.length >= MAX_VOICES) this._stealVoice();
      const t = ctx.currentTime + 0.005;
      const rate = o.rate || 1;
      let src = null, gain = null, panner = null, sendGain = null;
      try {
        src = ctx.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = rate;
        src.loop = !!o.loop;
        gain = ctx.createGain();
      } catch (e) {
        return null;
      }
      const vol = o.vol == null ? 1 : o.vol;
      const atk = Math.max(0.003, o.attack == null ? 0.004 : o.attack);
      const dur = Math.max(0.02, buf.duration / rate);
      try {
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.linearRampToValueAtTime(vol, t + atk);
        if (!o.loop) {
          const rel = Math.min(0.012, dur * 0.25);
          gain.gain.setValueAtTime(vol, Math.max(t + atk, t + dur - rel));
          gain.gain.linearRampToValueAtTime(0.0001, t + dur);
        }
        if (o.pos) {
          panner = ctx.createPanner();
          panner.panningModel = "HRTF";
          panner.distanceModel = "inverse";
          panner.refDistance = o.refDistance > 0 ? o.refDistance : 2.5;
          panner.maxDistance = o.maxDistance > 0 ? o.maxDistance : 120;
          panner.rolloffFactor = o.rolloff == null ? 1 : o.rolloff;
          if (panner.positionX) {
            panner.positionX.value = o.pos.x;
            panner.positionY.value = o.pos.y;
            panner.positionZ.value = o.pos.z;
          } else if (panner.setPosition) {
            panner.setPosition(o.pos.x, o.pos.y, o.pos.z);
          }
        }
        const send = o.send == null ? 0.12 : o.send;
        if (send > 0.001 && this._reverbSend) {
          sendGain = ctx.createGain();
          sendGain.gain.value = send;
        }
        if (panner) {
          src.connect(panner);
          panner.connect(gain);
        } else {
          src.connect(gain);
        }
        gain.connect(this._dryBus);
        if (sendGain) {
          gain.connect(sendGain);
          sendGain.connect(this._reverbSend);
        }
        src.start(t);
        if (!o.loop) src.stop(t + dur + 0.02);
      } catch (e) {
        try { if (src) src.disconnect(); } catch (e2) { /* ignore */ }
        try { if (gain) gain.disconnect(); } catch (e2) { /* ignore */ }
        return null;
      }
      const voice = {
        src: src, gain: gain, panner: panner, send: sendGain,
        ended: false, loop: !!o.loop, name: o.name || ""
      };
      src.onended = () => this._endVoice(voice);
      this._voices.push(voice);
      return {
        name: voice.name,
        voice: voice,
        stop: (fade) => this._stopVoice(voice, fade),
        get playing() { return !voice.ended; }
      };
    }

    _stopVoice(v, fade) {
      if (!v || v.ended || !this.ctx) return;
      const f = Math.max(0.02, fade == null ? 0.08 : fade);
      const now = this.ctx.currentTime;
      try {
        v.gain.gain.cancelScheduledValues(now);
        v.gain.gain.setValueAtTime(Math.max(0.0001, v.gain.gain.value), now);
        v.gain.gain.linearRampToValueAtTime(0.0001, now + f);
        v.src.stop(now + f + 0.02);
      } catch (e) {
        this._endVoice(v);
      }
    }

    _stealVoice() {
      if (!this._voices.length) return;
      let victim = null;
      for (let i = 0; i < this._voices.length; i++) {
        if (!this._voices[i].loop) {
          victim = this._voices[i];
          this._voices.splice(i, 1);
          break;
        }
      }
      if (!victim) victim = this._voices.shift();
      if (!victim || !this.ctx) return;
      const now = this.ctx.currentTime;
      try {
        victim.gain.gain.cancelScheduledValues(now);
        victim.gain.gain.setValueAtTime(Math.max(0.0001, victim.gain.gain.value), now);
        victim.gain.gain.linearRampToValueAtTime(0.0001, now + 0.03);
        victim.src.stop(now + 0.05);
      } catch (e) {
        this._endVoice(victim);
      }
    }

    _endVoice(v) {
      if (!v || v.ended) return;
      v.ended = true;
      const idx = this._voices.indexOf(v);
      if (idx >= 0) this._voices.splice(idx, 1);
      try { v.src.onended = null; } catch (e) { /* ignore */ }
      try { v.src.disconnect(); } catch (e) { /* ignore */ }
      try { if (v.gain) v.gain.disconnect(); } catch (e) { /* ignore */ }
      try { if (v.panner) v.panner.disconnect(); } catch (e) { /* ignore */ }
      try { if (v.send) v.send.disconnect(); } catch (e) { /* ignore */ }
      v.src = null;
      v.gain = null;
      v.panner = null;
      v.send = null;
    }

    _tryResume() {
      const ctx = this.ctx;
      if (!ctx || this._resuming || ctx.state === "running") return;
      this._resuming = true;
      try {
        const p = ctx.resume();
        if (p && p.then) {
          p.then(() => { this._resuming = false; }, () => { this._resuming = false; });
        } else {
          this._resuming = false;
        }
      } catch (e) {
        this._resuming = false;
      }
    }

    _later(ms, fn) {
      const id = setTimeout(() => {
        const i = this._timeouts.indexOf(id);
        if (i >= 0) this._timeouts.splice(i, 1);
        if (this._disposed) return;
        try { fn(); } catch (e) { /* ignore */ }
      }, ms);
      this._timeouts.push(id);
      return id;
    }

    /* ------------------------------------------------------ */
    /* dynamic tension / music                                */
    /* ------------------------------------------------------ */

    update(dt, state) {
      if (!this._ready || !this.ctx || this._disposed) return;
      if (this.ctx.state !== "running") return;
      let step = typeof dt === "number" ? dt : 0.016;
      if (!(step > 0)) step = 0.016;
      if (step > 0.1) step = 0.1;
      const st = state || EMPTY_OPTS;
      const health = st.health == null ? 100 : st.health;
      const zombies = st.zombies == null ? 0 : st.zombies;
      const wave = st.wave == null ? 1 : st.wave;
      const phase = st.phase || "combat";
      const inMenu = phase === "menu";

      // derived tension from the battlefield state
      let derived = 0;
      derived += clamp(zombies / 10, 0, 1) * 0.4;
      derived += clamp(1 - health / 100, 0, 1) * 0.55;
      derived += clamp((wave - 1) / 7, 0, 1) * 0.2;
      if (inMenu) derived *= 0.25;
      const target = clamp(Math.max(this._userTension * 0.85, derived * 0.9), 0, 1);
      this._tension += (target - this._tension) * (1 - Math.exp(-1.8 * step));

      // throttle AudioParam automation (no per-frame graph churn)
      this._mixTimer += step;
      if (this._mixTimer >= 0.1) {
        this._mixTimer = 0;
        this._applyMix(phase);
      }

      // sparse string pulses
      if (!inMenu && !this._muted && this._tension > 0.2 && this._pulseBufs && this._pulseBufs.length) {
        this._pulseTimer -= step;
        if (this._pulseTimer <= 0) {
          this._pulseTimer = lerp(2.8, 0.95, clamp(this._tension, 0, 1)) * (0.8 + Math.random() * 0.45);
          const buf = this._pulseBufs[(Math.random() * this._pulseBufs.length) | 0];
          this._start(buf, {
            vol: 0.10 + this._tension * 0.22,
            rate: 0.78 + Math.random() * 0.44,
            send: 0.3,
            name: "_pulse"
          });
        }
      }

      // heartbeat at low health
      const low = clamp((55 - health) / 55, 0, 1);
      if (!inMenu && !this._muted && low > 0.01 && this._heartBuf) {
        this._heartTimer -= step;
        if (this._heartTimer <= 0) {
          this._heartTimer = lerp(1.15, 0.5, low);
          this._start(this._heartBuf, {
            vol: 0.15 + low * 0.32,
            rate: 0.94 + Math.random() * 0.12,
            send: 0.06,
            name: "_heart"
          });
        }
      } else {
        this._heartTimer = 0.2;
      }
    }

    _applyMix(phase) {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      const tension = clamp(this._tension, 0, 1);
      const menu = phase === "menu";
      try {
        if (this._droneGain) {
          const level = menu ? (0.012 + tension * 0.05) : (0.02 + tension * 0.15);
          this._droneGain.gain.setTargetAtTime(Math.max(0.0001, level), t, 0.5);
        }
        if (this._droneFilter) {
          this._droneFilter.frequency.setTargetAtTime(180 + tension * 520, t, 0.6);
        }
        if (this._droneSend) {
          this._droneSend.gain.setTargetAtTime(0.06 + tension * 0.22, t, 0.6);
        }
      } catch (e) { /* ignore */ }
    }

    /* ------------------------------------------------------ */
    /* ambient bed                                            */
    /* ------------------------------------------------------ */

    startAmbient() {
      if (this._disposed) return false;
      this._ambientWanted = true;
      if (!this._ready) return false;
      if (this._ambientOn) return true;
      const ctx = this.ctx;
      if (!ctx || ctx.state !== "running" || !this._rainBuf || !this._windBuf || !this._humBuf) return false;
      const t = ctx.currentTime;
      let ambGain = null;
      try {
        ambGain = ctx.createGain();
        ambGain.gain.setValueAtTime(0.0001, t);
        ambGain.gain.linearRampToValueAtTime(1, t + 1.5);
        ambGain.connect(this._dryBus);
      } catch (e) {
        return false;
      }
      const layers = [
        { buf: this._rainBuf, gain: 0.17, send: 0.06 },
        { buf: this._windBuf, gain: 0.12, send: 0.04 },
        { buf: this._humBuf, gain: 0.07, send: 0.02 }
      ];
      const sources = [];
      for (let i = 0; i < layers.length; i++) {
        const L = layers[i];
        try {
          const src = ctx.createBufferSource();
          src.buffer = L.buf;
          src.loop = true;
          const g = ctx.createGain();
          g.gain.value = L.gain;
          const sd = ctx.createGain();
          sd.gain.value = L.send;
          src.connect(g);
          g.connect(ambGain);
          g.connect(sd);
          sd.connect(this._reverbSend);
          src.start(t);
          sources.push({ src: src, gain: g, send: sd });
        } catch (e) { /* skip layer */ }
      }
      this._ambientOn = true;
      const ambient = {
        ambGain: ambGain,
        sources: sources,
        timer: 0,
        nextCreak: 8 + Math.random() * 10,
        nextThunder: 22 + Math.random() * 20
      };
      ambient.timer = setInterval(() => this._ambientTick(), 1000);
      this._ambient = ambient;
      return true;
    }

    stopAmbient() {
      this._ambientWanted = false;
      if (!this._ambient) { this._ambientOn = false; return; }
      const a = this._ambient;
      this._ambient = null;
      this._ambientOn = false;
      if (a.timer) { clearInterval(a.timer); a.timer = 0; }
      const ctx = this.ctx;
      if (!ctx) {
        for (let i = 0; i < a.sources.length; i++) {
          try { a.sources[i].src.disconnect(); } catch (e) { /* ignore */ }
        }
        return;
      }
      const t = ctx.currentTime;
      try {
        a.ambGain.gain.cancelScheduledValues(t);
        a.ambGain.gain.setValueAtTime(Math.max(0.0001, a.ambGain.gain.value), t);
        a.ambGain.gain.linearRampToValueAtTime(0.0001, t + 1.2);
      } catch (e) { /* ignore */ }
      for (let i = 0; i < a.sources.length; i++) {
        const s = a.sources[i];
        try { s.src.stop(t + 1.3); } catch (e) { /* ignore */ }
        s.src.onended = function () {
          try { s.src.disconnect(); } catch (e) { /* ignore */ }
          try { s.gain.disconnect(); } catch (e) { /* ignore */ }
          try { s.send.disconnect(); } catch (e) { /* ignore */ }
        };
      }
      this._later(1400, function () {
        try { a.ambGain.disconnect(); } catch (e) { /* ignore */ }
      });
    }

    _ambientTick() {
      if (!this._ambientOn || !this._ambient || !this._ready || this._disposed) return;
      if (!this.ctx || this.ctx.state !== "running") return;
      const a = this._ambient;
      a.nextCreak -= 1;
      a.nextThunder -= 1;
      if (a.nextCreak <= 0) {
        a.nextCreak = 9 + Math.random() * 18;
        if (this._creakBuf) {
          this._start(this._creakBuf, {
            vol: 0.16 + Math.random() * 0.14,
            rate: 0.7 + Math.random() * 0.5,
            send: 0.25,
            name: "_creak"
          });
        }
      }
      if (a.nextThunder <= 0) {
        a.nextThunder = 25 + Math.random() * 35;
        this.thunder(0.12 + Math.random() * 0.3);
      }
    }

    // Thunder after a lightning strike. `distance` is proximity (1 = close
    // overhead strike, 0 = far horizon) matching world.js onLightning():
    // close strikes crack sooner and louder, distant ones arrive late, deep
    // and quiet.
    thunder(distance) {
      if (!this._ready || this._disposed) return false;
      const near = clamp(distance == null ? 1 : distance, 0, 1);
      const delay = 90 + Math.random() * 90 + (1 - near) * 900;
      const vol = clamp(0.35 + near * 0.65, 0.25, 1);
      this._later(delay, () => {
        if (!this._ready || this._disposed) return;
        this.play("thunder", {
          volume: vol,
          rate: 0.9 + (1 - near) * 0.12 + Math.random() * 0.1
        });
      });
      return true;
    }

    /* ------------------------------------------------------ */
    /* teardown                                               */
    /* ------------------------------------------------------ */

    dispose() {
      this._disposed = true;
      this._ambientWanted = false;
      try { this.stopAmbient(); } catch (e) { /* ignore */ }
      for (let i = 0; i < this._timeouts.length; i++) {
        try { clearTimeout(this._timeouts[i]); } catch (e) { /* ignore */ }
      }
      this._timeouts.length = 0;
      if (this._voices) {
        const list = this._voices.slice();
        for (let i = 0; i < list.length; i++) {
          try { this._stopVoice(list[i], 0.03); } catch (e) { /* ignore */ }
        }
      }
      if (this._droneOscs) {
        for (let i = 0; i < this._droneOscs.length; i++) {
          try { this._droneOscs[i].stop(); } catch (e) { /* ignore */ }
        }
        for (let i = 0; i < this._droneOscs.length; i++) {
          try { this._droneOscs[i].disconnect(); } catch (e) { /* ignore */ }
        }
      }
      const ctx = this.ctx;
      this.ctx = null;
      this._ready = false;
      this._initPromise = null;
      this.buffers = {};
      this._rainBuf = null;
      this._windBuf = null;
      this._humBuf = null;
      this._creakBuf = null;
      this._pulseBufs = null;
      this._heartBuf = null;
      this._voices = [];
      if (ctx) {
        try {
          const p = ctx.close();
          if (p && p.catch) p.catch(function () { /* ignore */ });
        } catch (e) { /* ignore */ }
      }
      this._ambient = null;
      this._ambientOn = false;
      this._droneGain = null;
      this._droneFilter = null;
      this._droneSend = null;
      this._droneOscs = null;
      this._volumeGain = null;
      this._muteGain = null;
      this._dryBus = null;
      this._reverbSend = null;
      this._reverbReturn = null;
      this._convolver = null;
      this._glue = null;
      this._limiter = null;
    }
  }

  DL.AudioEngine = AudioEngine;
})();
