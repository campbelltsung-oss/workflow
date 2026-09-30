const test = require('node:test');
const assert = require('node:assert');
const E = require('../filter-engine.js');

// Synthetic RGBA image: horizontal lightness ramp, vertical hue variation.
function makeImage(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fn(x / (w - 1), y / (h - 1));
      const o = (y * w + x) * 4;
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
    }
  }
  return data;
}
const neutral = makeImage(200, 100, (u, v) => [u * 255, u * 230 + v * 25, u * 210 + v * 45]);
const warmFaded = makeImage(200, 100, (u) => [60 + u * 180, 50 + u * 150, 30 + u * 100]);

test('Lab round trip is accurate', () => {
  for (const c of [[0, 0, 0], [255, 255, 255], [200, 30, 90], [12, 180, 240], [128, 128, 128]]) {
    const lab = E.rgbToLab(...c, [0, 0, 0]);
    const back = E.labToRgb(...lab, [0, 0, 0]);
    back.forEach((v, i) => assert.ok(Math.abs(v - c[i]) <= 1, `${c} -> ${back}`));
  }
});

test('zero strength leaves the image unchanged', () => {
  const src = E.analyze(neutral);
  const look = E.analyze(warmFaded);
  const out = E.apply(neutral, E.prepare(src, look, { tone: 0, color: 0 }));
  assert.deepStrictEqual(out, neutral);
});

test('applying an image\'s own look barely changes it', () => {
  const src = E.analyze(neutral);
  const out = E.apply(neutral, E.prepare(src, src));
  let maxDiff = 0;
  for (let i = 0; i < out.length; i++) maxDiff = Math.max(maxDiff, Math.abs(out[i] - neutral[i]));
  assert.ok(maxDiff <= 8, `max channel diff ${maxDiff}`);
});

test('full strength moves the image toward the reference', () => {
  const src = E.analyze(neutral);
  const look = E.analyze(warmFaded);
  const after = E.analyze(E.apply(neutral, E.prepare(src, look)));
  for (let z = 0; z < 3; z++) {
    const dBefore = Math.hypot(src.zones[z].a - look.zones[z].a, src.zones[z].b - look.zones[z].b);
    const dAfter = Math.hypot(after.zones[z].a - look.zones[z].a, after.zones[z].b - look.zones[z].b);
    assert.ok(dAfter < dBefore * 0.35, `zone ${z}: ${dBefore.toFixed(2)} -> ${dAfter.toFixed(2)}`);
  }
  // Faded look: blacks lifted, whites lowered
  assert.ok(after.lq[5] > src.lq[5] + 10, 'shadows lifted');
  assert.ok(after.lq[250] < src.lq[250] - 5, 'highlights lowered');
});

test('synthesized looks have the expected shape', () => {
  const look = E.synthesize({ curve: (p) => 10 + 80 * p, zones: [[0, 5, 8], [1, 6, 9], [2, 7, 10]] });
  assert.strictEqual(look.lq.length, 256);
  assert.strictEqual(look.lq[0], 10);
  assert.strictEqual(look.lq[255], 90);
  assert.strictEqual(E.swatches(look).length, 3);
});

test('neutral adjustments leave the image unchanged', () => {
  const adj = E.prepareAdjust(E.ADJUST_DEFAULTS);
  assert.ok(adj.identity);
  assert.deepStrictEqual(E.render(neutral, adj, null), neutral);
});

test('adjustments move the image in the expected direction', () => {
  const base = E.analyze(neutral);
  const brighter = E.analyze(E.render(neutral, E.prepareAdjust({ exposure: 1 }), null));
  assert.ok(brighter.lq[128] > base.lq[128] + 8, 'exposure brightens midtones');
  assert.ok(brighter.lq[255] <= 100, 'highlights stay in range');

  const warmer = E.analyze(E.render(neutral, E.prepareAdjust({ temperature: 60 }), null));
  assert.ok(warmer.zones[1].b > base.zones[1].b + 3, 'temperature adds yellow');
  assert.ok(Math.abs(warmer.lq[128] - base.lq[128]) < 3, 'white balance keeps brightness');

  const lifted = E.analyze(E.render(neutral, E.prepareAdjust({ shadows: 80 }), null));
  assert.ok(lifted.lq[64] > base.lq[64] + 3, 'shadows lift the dark quarter');
  assert.ok(Math.abs(lifted.lq[0] - base.lq[0]) < 1, 'pure black stays black');

  const gray = E.analyze(E.render(neutral, E.prepareAdjust({ saturation: -100 }), null));
  assert.ok(gray.chroma < 1, 'saturation -100 removes color');
});

test('settings are clamped to their ranges', () => {
  const p = E.normalizeAdjust({ exposure: 9, contrast: -500, tint: 'x', bogus: 3 });
  assert.strictEqual(p.exposure, 2);
  assert.strictEqual(p.contrast, -100);
  assert.strictEqual(p.tint, 0);
  assert.ok(!('bogus' in p));
});
