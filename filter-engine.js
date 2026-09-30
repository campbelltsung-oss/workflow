/*
 * Filter engine: learns a color & tone "look" from a reference image and
 * applies it to other images.
 *
 * How a look is captured (all in CIE Lab, D65):
 *  - Tone: 256 quantiles of the reference's lightness (L) distribution.
 *    Applying it is histogram matching, smoothed and kept monotonic so it
 *    behaves like a tone curve.
 *  - Color: mean and spread of the a/b (green–magenta, blue–yellow) channels
 *    in three tonal zones: shadows, midtones and highlights. Zones are defined
 *    by rank (percentile of lightness), so the darkest third of a new image is
 *    graded like the darkest third of the reference. This captures split
 *    toning such as teal shadows with warm highlights.
 *
 * Before a look is applied, an image can get base adjustments (exposure,
 * white balance, contrast, highlights/shadows, whites/blacks, vibrance,
 * saturation). The AI enhance feature picks these; they are ordinary
 * parameters, so every edit stays visible and editable.
 *
 * Works in the browser (window.FilterEngine) and in Node (require).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FilterEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const L_BINS = 1000;          // lightness histogram resolution (0.1 L)
  const QUANTILES = 256;        // stored tone quantiles per filter
  const ZONE_CENTERS = [1 / 6, 1 / 2, 5 / 6];
  const ZONE_SIGMA = 0.18;
  const ZONE_NAMES = ['Shadows', 'Midtones', 'Highlights'];
  const MAX_SAMPLES = 250000;
  const RATIO_MIN = 0.3, RATIO_MAX = 2.5; // limits on color spread scaling
  const TONE_SMOOTH = 15;       // box-filter radius in bins (1.5 L)

  // sRGB <-> linear lookup tables
  const toLin = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    toLin[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  const ENC_N = 4096;
  const toSrgb = new Uint8Array(ENC_N + 1);
  for (let i = 0; i <= ENC_N; i++) {
    const v = i / ENC_N;
    const s = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    toSrgb[i] = Math.max(0, Math.min(255, Math.round(s * 255)));
  }
  function enc(v) {
    if (v <= 0) return 0;
    if (v >= 1) return 255;
    return toSrgb[(v * ENC_N + 0.5) | 0];
  }

  const Xn = 0.95047, Zn = 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const finv = (t) => (t > 0.206893 ? t * t * t : (t - 16 / 116) / 7.787);

  function rgbToLab(r, g, b, out) {
    return linToLab(toLin[r], toLin[g], toLin[b], out);
  }

  function linToLab(R, G, B, out) {
    const fx = f((0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / Xn);
    const fy = f(0.2126729 * R + 0.7151522 * G + 0.072175 * B);
    const fz = f((0.0193339 * R + 0.119192 * G + 0.9503041 * B) / Zn);
    out[0] = 116 * fy - 16;
    out[1] = 500 * (fx - fy);
    out[2] = 200 * (fy - fz);
    return out;
  }

  function labToRgb(L, a, b, out) {
    const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
    const X = finv(fx) * Xn, Y = finv(fy), Z = finv(fz) * Zn;
    out[0] = enc(3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z);
    out[1] = enc(-0.969266 * X + 1.8760108 * Y + 0.041556 * Z);
    out[2] = enc(0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z);
    return out;
  }

  const binOf = (L) => Math.min(L_BINS - 1, Math.max(0, (L * L_BINS / 100) | 0));

  function zoneWeights(p, out) {
    let sum = 0;
    for (let z = 0; z < 3; z++) {
      const d = (p - ZONE_CENTERS[z]) / ZONE_SIGMA;
      out[z] = Math.exp(-0.5 * d * d);
      sum += out[z];
    }
    for (let z = 0; z < 3; z++) out[z] /= sum;
    return out;
  }

  /**
   * Measure an image's tone and color statistics.
   * @param {Uint8ClampedArray|Uint8Array} data RGBA pixels
   * @param {object} [adj] prepareAdjust() result, to measure the adjusted image
   * @returns {{lq:number[], zones:{a:number,b:number,sa:number,sb:number}[], cdf:Float32Array,
   *   clipLow:number, clipHigh:number, chroma:number}}
   *   lq and zones define a filter; cdf is needed when this image is the one
   *   being edited; the rest describe the image for the AI.
   */
  function analyze(data, adj) {
    const n = data.length >> 2;
    const step = Math.max(1, Math.floor(n / MAX_SAMPLES));
    const cap = Math.ceil(n / step);
    const Ls = new Float32Array(cap), As = new Float32Array(cap), Bs = new Float32Array(cap);
    const lab = [0, 0, 0];
    let m = 0;
    for (let i = 0; i < n; i += step) {
      const o = i << 2;
      if (data[o + 3] < 128) continue;
      pixelLab(data, o, adj, lab);
      Ls[m] = lab[0]; As[m] = lab[1]; Bs[m] = lab[2];
      m++;
    }
    if (m === 0) throw new Error('The image has no visible pixels.');

    const hist = new Float64Array(L_BINS);
    for (let i = 0; i < m; i++) hist[binOf(Ls[i])]++;
    const cdf = new Float32Array(L_BINS);
    let cum = 0;
    for (let i = 0; i < L_BINS; i++) {
      cdf[i] = (cum + hist[i] / 2) / m;
      cum += hist[i];
    }

    const sorted = Ls.slice(0, m).sort();
    const lq = new Array(QUANTILES);
    for (let k = 0; k < QUANTILES; k++) {
      lq[k] = round2(sorted[Math.round((k / (QUANTILES - 1)) * (m - 1))]);
    }

    let clipLow = 0, clipHigh = 0, chroma = 0;
    for (let i = 0; i < m; i++) {
      if (Ls[i] < 2) clipLow++;
      else if (Ls[i] > 98) clipHigh++;
      chroma += Math.hypot(As[i], Bs[i]);
    }

    const acc = [0, 1, 2].map(() => ({ w: 0, a: 0, b: 0, aa: 0, bb: 0 }));
    const w = [0, 0, 0];
    for (let i = 0; i < m; i++) {
      zoneWeights(cdf[binOf(Ls[i])], w);
      const a = As[i], b = Bs[i];
      for (let z = 0; z < 3; z++) {
        const s = acc[z], wz = w[z];
        s.w += wz; s.a += wz * a; s.b += wz * b; s.aa += wz * a * a; s.bb += wz * b * b;
      }
    }
    const zones = acc.map((s) => {
      const a = s.a / s.w, b = s.b / s.w;
      return {
        a: round2(a),
        b: round2(b),
        sa: round2(Math.sqrt(Math.max(0, s.aa / s.w - a * a))),
        sb: round2(Math.sqrt(Math.max(0, s.bb / s.w - b * b))),
      };
    });
    return { lq, zones, cdf, clipLow: clipLow / m, clipHigh: clipHigh / m, chroma: chroma / m };
  }

  function round2(v) { return Math.round(v * 100) / 100; }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function quantileAt(lq, p) {
    const x = clamp(p, 0, 1) * (lq.length - 1);
    const i = Math.min(lq.length - 2, Math.floor(x));
    const t = x - i;
    return lq[i] * (1 - t) + lq[i + 1] * t;
  }

  function boxSmooth(arr, r) {
    const out = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      let s = 0, c = 0;
      for (let j = Math.max(0, i - r); j <= Math.min(arr.length - 1, i + r); j++) { s += arr[j]; c++; }
      out[i] = s / c;
    }
    return out;
  }

  /**
   * Build the lookup tables that turn `source` into the filter's look.
   * @param source analyze() result for the image being edited
   * @param look   filter stats ({lq, zones})
   * @param {{tone?:number, color?:number}} amounts 0..1 strength of each part
   */
  function prepare(source, look, amounts) {
    const tone = amounts && amounts.tone != null ? amounts.tone : 1;
    const color = amounts && amounts.color != null ? amounts.color : 1;

    let mapped = new Float32Array(L_BINS);
    for (let i = 0; i < L_BINS; i++) mapped[i] = quantileAt(look.lq, source.cdf[i]);
    mapped = boxSmooth(boxSmooth(mapped, TONE_SMOOTH), TONE_SMOOTH);
    const toneLut = new Float32Array(L_BINS);
    let prev = -Infinity;
    for (let i = 0; i < L_BINS; i++) {
      const v = Math.max(prev, mapped[i]);
      prev = v;
      const L = ((i + 0.5) * 100) / L_BINS;
      toneLut[i] = v - L; // stored as an offset, scaled by tone strength
    }
    for (let i = 0; i < L_BINS; i++) toneLut[i] *= tone;

    const wLut = new Float32Array(L_BINS * 3);
    const w = [0, 0, 0];
    for (let i = 0; i < L_BINS; i++) {
      zoneWeights(source.cdf[i], w);
      wLut[i * 3] = w[0]; wLut[i * 3 + 1] = w[1]; wLut[i * 3 + 2] = w[2];
    }

    const zp = new Float32Array(12); // per zone: srcA, srcB, ratioA, ratioB... packed below
    const zt = new Float32Array(6);
    for (let z = 0; z < 3; z++) {
      const s = source.zones[z], t = look.zones[z];
      zp[z * 4] = s.a;
      zp[z * 4 + 1] = s.b;
      zp[z * 4 + 2] = clamp(t.sa / (s.sa + 1e-3), RATIO_MIN, RATIO_MAX);
      zp[z * 4 + 3] = clamp(t.sb / (s.sb + 1e-3), RATIO_MIN, RATIO_MAX);
      zt[z * 2] = t.a;
      zt[z * 2 + 1] = t.b;
    }
    return { toneLut, wLut, zp, zt, color, identity: tone === 0 && color === 0 };
  }

  /**
   * Apply base adjustments and/or a prepared look to RGBA pixels.
   * Either may be null. Writes into `out` (may equal `data`).
   */
  function render(data, adj, prep, out) {
    out = out || new Uint8ClampedArray(data.length);
    if (adj && adj.identity) adj = null;
    if (prep && prep.identity) prep = null;
    if (!adj && !prep) { if (out !== data) out.set(data); return out; }
    const lab = [0, 0, 0], rgb = [0, 0, 0];
    if (!prep) {
      for (let o = 0; o < data.length; o += 4) {
        pixelLab(data, o, adj, lab);
        labToRgb(lab[0], lab[1], lab[2], rgb);
        out[o] = rgb[0]; out[o + 1] = rgb[1]; out[o + 2] = rgb[2]; out[o + 3] = data[o + 3];
      }
      return out;
    }
    const { toneLut, wLut, zp, zt, color } = prep;
    for (let o = 0; o < data.length; o += 4) {
      pixelLab(data, o, adj, lab);
      const L = lab[0], a = lab[1], b = lab[2];
      const bin = binOf(L);
      const w0 = wLut[bin * 3], w1 = wLut[bin * 3 + 1], w2 = wLut[bin * 3 + 2];
      const a2 =
        w0 * (zt[0] + (a - zp[0]) * zp[2]) +
        w1 * (zt[2] + (a - zp[4]) * zp[6]) +
        w2 * (zt[4] + (a - zp[8]) * zp[10]);
      const b2 =
        w0 * (zt[1] + (b - zp[1]) * zp[3]) +
        w1 * (zt[3] + (b - zp[5]) * zp[7]) +
        w2 * (zt[5] + (b - zp[9]) * zp[11]);
      labToRgb(L + toneLut[bin], a + color * (a2 - a), b + color * (b2 - b), rgb);
      out[o] = rgb[0]; out[o + 1] = rgb[1]; out[o + 2] = rgb[2]; out[o + 3] = data[o + 3];
    }
    return out;
  }

  /** Apply a prepared look only (kept for callers that don't adjust). */
  function apply(data, prep, out) { return render(data, null, prep, out); }

  // ---------- Base adjustments ----------

  /** Neutral settings. Ranges: exposure -2..2 EV, everything else -100..100. */
  const ADJUST_DEFAULTS = Object.freeze({
    exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
    temperature: 0, tint: 0, vibrance: 0, saturation: 0,
  });
  const ADJUST_RANGES = Object.freeze({
    exposure: [-2, 2], contrast: [-100, 100], highlights: [-100, 100], shadows: [-100, 100],
    whites: [-100, 100], blacks: [-100, 100], temperature: [-100, 100], tint: [-100, 100],
    vibrance: [-100, 100], saturation: [-100, 100],
  });
  const CURVE_MAX = 170;   // L range covered by the tone curve (exposure can push past 100)
  const CURVE_N = 1700;

  /** Clamp and fill in a settings object; unknown keys are dropped. */
  function normalizeAdjust(p) {
    const out = {};
    for (const k of Object.keys(ADJUST_DEFAULTS)) {
      const v = Number(p && p[k]);
      const [lo, hi] = ADJUST_RANGES[k];
      out[k] = Number.isFinite(v) ? clamp(v, lo, hi) : 0;
    }
    return out;
  }

  function prepareAdjust(params) {
    const p = normalizeAdjust(params);
    const identity = Object.keys(p).every((k) => p[k] === 0);
    // White balance as linear-light channel gains, normalized to keep luminance
    let gr = Math.exp(0.0025 * p.temperature), gb = Math.exp(-0.0025 * p.temperature);
    let gg = Math.exp(-0.002 * p.tint);
    const norm = 0.2126 * gr + 0.7152 * gg + 0.0722 * gb;
    const ev = Math.pow(2, p.exposure);
    gr *= ev / norm; gg *= ev / norm; gb *= ev / norm;

    const c = p.contrast / 100, hi = p.highlights / 100, sh = p.shadows / 100;
    const wh = p.whites / 100, bl = p.blacks / 100;
    const curve = new Float32Array(CURVE_N + 1);
    let prev = 0;
    for (let i = 0; i <= CURVE_N; i++) {
      const x = (i / CURVE_N) * (CURVE_MAX / 100);
      const xc = Math.min(x, 1);
      let y = xc;
      y += c * 0.7 * (xc * xc * (3 - 2 * xc) - xc);
      y += sh * 0.22 * 6.75 * xc * (1 - xc) * (1 - xc);
      y += hi * 0.22 * 6.75 * xc * xc * (1 - xc);
      y += wh * 0.15 * xc * xc * xc;
      y += bl * 0.15 * (1 - xc) * (1 - xc) * (1 - xc);
      y += x - xc;                       // light pushed past white by exposure
      if (y > 0.92) y = 0.92 + 0.08 * Math.tanh((y - 0.92) / 0.08); // highlight roll-off
      y = Math.max(prev, Math.max(0, y));
      prev = y;
      curve[i] = y * 100;
    }
    return {
      identity, params: p, gains: [gr, gg, gb], curve,
      sat: 1 + p.saturation / 100, vib: p.vibrance / 100,
    };
  }

  // One pixel to Lab, with base adjustments when given
  function pixelLab(data, o, adj, out) {
    if (!adj || adj.identity) return rgbToLab(data[o], data[o + 1], data[o + 2], out);
    const g = adj.gains;
    linToLab(toLin[data[o]] * g[0], toLin[data[o + 1]] * g[1], toLin[data[o + 2]] * g[2], out);
    const x = clamp(out[0], 0, CURVE_MAX) * (CURVE_N / CURVE_MAX);
    const i = Math.min(CURVE_N - 1, x | 0), t = x - i;
    out[0] = adj.curve[i] * (1 - t) + adj.curve[i + 1] * t;
    const C = Math.hypot(out[1], out[2]);
    const k = adj.sat * (1 + adj.vib * 0.6 * (1 - Math.min(C / 45, 1)));
    out[1] *= k; out[2] *= k;
    return out;
  }

  /** Representative sRGB color for each zone of a look, for swatches. */
  function swatches(look) {
    return look.zones.map((z, i) => {
      const rgb = labToRgb(quantileAt(look.lq, ZONE_CENTERS[i]), z.a, z.b, [0, 0, 0]);
      return { name: ZONE_NAMES[i], rgb };
    });
  }

  /** Build a look from parameters instead of a photo (used for starter filters). */
  function synthesize({ curve, zones }) {
    const lq = [];
    for (let k = 0; k < QUANTILES; k++) lq.push(round2(clamp(curve(k / (QUANTILES - 1)), 0, 100)));
    return { lq, zones: zones.map(([a, b, sa, sb]) => ({ a, b, sa, sb: sb == null ? sa : sb })) };
  }

  return {
    analyze, prepare, apply, render, swatches, synthesize, rgbToLab, labToRgb, ZONE_NAMES,
    prepareAdjust, normalizeAdjust, ADJUST_DEFAULTS, ADJUST_RANGES,
  };
});
