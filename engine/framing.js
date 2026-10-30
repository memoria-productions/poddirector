/*
 * PodCutter — "who's in the shot" for operated cameras.
 *
 * An operated dolly / follow camera isn't always on the person talking: the operator may hold on a listener,
 * or be late moving to a new speaker. This module splits the camera's footage into steady stretches (between
 * moves), describes each stretch by the colours in the middle of the frame (mostly the person: skin, hair,
 * clothes), and groups stretches that look alike — one group per person. Each group is then given a name by
 * matching it against who was talking while the camera sat on it; the editor confirms or corrects that once.
 *
 * Pure JavaScript, no dependencies. Input thumbnails come from motion.js (32x18 RGB, one per second).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.PodFraming = api;
  else if (root) root.PodFraming = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var BINS = 4; // per RGB channel -> 64-bin colour histogram

  /** Describe one thumbnail: colour histogram of the centre of frame + a coarse colour layout. */
  function describe(data, offset, w, h) {
    var hist = new Float32Array(BINS * BINS * BINS), grid = new Float32Array(4 * 3 * 3), gridN = new Float32Array(12);
    var x0 = Math.floor(w * 0.22), x1 = Math.ceil(w * 0.78), y0 = Math.floor(h * 0.12), n = 0;
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var k = offset + (y * w + x) * 3, r = data[k], g = data[k + 1], b = data[k + 2];
      if (x >= x0 && x < x1 && y >= y0) {
        hist[((r * BINS) >> 8) * BINS * BINS + ((g * BINS) >> 8) * BINS + ((b * BINS) >> 8)] += 1; n++;
      }
      var cell = Math.min(3, Math.floor(x / w * 4)) + 4 * Math.min(2, Math.floor(y / h * 3));
      grid[cell * 3] += r; grid[cell * 3 + 1] += g; grid[cell * 3 + 2] += b; gridN[cell]++;
    }
    var f = new Float32Array(hist.length + grid.length);
    for (var i = 0; i < hist.length; i++) f[i] = hist[i] / Math.max(1, n);
    // Layout counts for less than the colours of the person (operators reframe a little all the time).
    for (i = 0; i < 12; i++) for (var c = 0; c < 3; c++) f[hist.length + i * 3 + c] = 0.35 * grid[i * 3 + c] / Math.max(1, gridN[i]) / 255 / 12;
    return f;
  }

  function dist(a, b) { var d = 0; for (var i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]); return d; }

  function mean(list) {
    var m = new Float32Array(list[0].length);
    list.forEach(function (v) { for (var i = 0; i < m.length; i++) m[i] += v[i]; });
    for (var i = 0; i < m.length; i++) m[i] /= list.length;
    return m;
  }

  /** Steady stretches (seconds) from the motion curve: between moves, at least minSec long. */
  function steadyStretches(motion, steadyMaxPct, minSec) {
    var v = motion.values, hop = motion.hopSec, out = [], start = -1;
    for (var i = 0; i <= v.length; i++) {
      // Median of 5 so a single noisy reading doesn't split a stretch.
      var ok = false;
      if (i < v.length) {
        var w = [];
        for (var k = Math.max(0, i - 2); k <= Math.min(v.length - 1, i + 2); k++) if (!isNaN(v[k])) w.push(v[k]);
        w.sort(function (a, b) { return a - b; });
        ok = !w.length || w[w.length >> 1] <= steadyMaxPct;
      }
      if (ok && start < 0) start = i;
      if (!ok && start >= 0) { if ((i - start) * hop >= minSec) out.push([start * hop, i * hop]); start = -1; }
    }
    return out;
  }

  function overlap(runs, a, b) {
    var s = 0;
    runs.forEach(function (r) { s += Math.max(0, Math.min(r[1], b) - Math.max(r[0], a)); });
    return s;
  }

  /** Deterministic k-means (k-means++ seeding with a fixed RNG) over stretch descriptors, weighted by length. */
  function kmeans(items, k, seed) {
    var a = seed || 3;
    function rand() { a = (a * 16807) % 2147483647; return a / 2147483647; }
    var cents = [items[0].f];
    while (cents.length < k) {
      var d2 = items.map(function (it) { var m = Infinity; cents.forEach(function (c) { m = Math.min(m, dist(it.f, c)); }); return m * m * it.w; });
      var sum = d2.reduce(function (x, y) { return x + y; }, 0);
      if (!(sum > 0)) break;
      var r = rand() * sum, j = 0;
      while (r > d2[j] && j < d2.length - 1) { r -= d2[j]; j++; }
      cents.push(items[j].f);
    }
    var assign = new Array(items.length).fill(0);
    for (var iter = 0; iter < 30; iter++) {
      var changed = false;
      items.forEach(function (it, i) {
        var best = 0, bd = Infinity;
        cents.forEach(function (c, ci) { var d = dist(it.f, c); if (d < bd) { bd = d; best = ci; } });
        if (assign[i] !== best) { assign[i] = best; changed = true; }
      });
      cents = cents.map(function (c, ci) {
        var mem = items.filter(function (_, i) { return assign[i] === ci; });
        if (!mem.length) return c;
        var m = new Float32Array(c.length), tw = 0;
        mem.forEach(function (it) { for (var q = 0; q < m.length; q++) m[q] += it.f[q] * it.w; tw += it.w; });
        for (var q = 0; q < m.length; q++) m[q] /= tw;
        return m;
      });
      if (!changed && iter > 0) break;
    }
    return { assign: assign, centroids: cents };
  }

  /**
   * analyze(opts) -> { stretches: [{startSec,endSec,group}], groups: [{id, guess, seconds, share, sampleSec, talk}] }
   *   opts.thumbs   { w, h, hopSec: 1, data: Uint8Array, valid: Uint8Array }   (from motion.analyzeTrack)
   *   opts.motion   { hopSec, values }                                           (same camera)
   *   opts.speech   [{ speakerId, runs: [[startSec, endSec], ...] }]              (from the cutting engine)
   *   opts.speakers [{ id }]   opts.steadyMaxPct (default 1.5)   opts.minSec (default 2)   opts.range {a,b}
   */
  function analyze(opts) {
    var th = opts.thumbs, w = th.w, h = th.h, size = w * h * 3;
    var stretches = steadyStretches(opts.motion, opts.steadyMaxPct || 1.5, opts.minSec || 2).filter(function (s) {
      return !opts.range || (s[1] > opts.range.a && s[0] < opts.range.b);
    });
    var items = [];
    stretches.forEach(function (s) {
      var feats = [];
      for (var sec = Math.ceil(s[0] + 0.5); sec < s[1] - 0.5; sec++) {
        if (sec >= 0 && th.valid[sec]) feats.push(describe(th.data, sec * size, w, h));
      }
      if (feats.length) items.push({ startSec: s[0], endSec: s[1], f: mean(feats), w: s[1] - s[0], sample: Math.round((s[0] + s[1]) / 2) });
    });
    if (!items.length) return { stretches: [], groups: [] };

    var k = Math.min(opts.speakers.length, items.length);
    var km = kmeans(items, k, 7);
    var groups = km.centroids.map(function (c, gi) {
      var mem = items.filter(function (_, i) { return km.assign[i] === gi; });
      var secs = mem.reduce(function (x, it) { return x + it.w; }, 0);
      var talk = {};
      (opts.speech || []).forEach(function (sp) {
        talk[sp.speakerId] = mem.reduce(function (x, it) { return x + overlap(sp.runs, it.startSec, it.endSec); }, 0);
      });
      // Representative frame: the stretch closest to the group's centre.
      var rep = mem.slice().sort(function (x, y) { return dist(x.f, c) - dist(y.f, c); })[0];
      return { id: gi, seconds: Math.round(secs), talk: talk, sampleSec: rep ? rep.sample : null };
    }).filter(function (g) { return g.seconds > 0; });

    // Name each group after the person most often talking while the camera sat on it (one person per group).
    var pairs = [];
    groups.forEach(function (g) {
      var total = 0; for (var s in g.talk) total += g.talk[s];
      for (s in g.talk) pairs.push({ g: g, s: s, share: total ? g.talk[s] / total : 0, abs: g.talk[s] });
    });
    pairs.sort(function (x, y) { return y.share - x.share || y.abs - x.abs; });
    var usedS = {};
    pairs.forEach(function (p) {
      if (p.g.guess !== undefined || usedS[p.s] || p.share < 0.2) return;
      p.g.guess = p.s; p.g.share = Math.round(p.share * 100) / 100; usedS[p.s] = true;
    });
    groups.forEach(function (g) { if (g.guess === undefined) { g.guess = null; g.share = 0; } });

    return {
      stretches: items.map(function (it, i) { return { startSec: it.startSec, endSec: it.endSec, group: km.assign[i] }; }),
      groups: groups
    };
  }

  /** Stretches + a {groupId: speakerId|null} map -> framing timeline for the cutting engine. */
  function timeline(result, names) {
    return result.stretches.map(function (s) {
      var who = Object.prototype.hasOwnProperty.call(names || {}, s.group) ? names[s.group] : null;
      return { startSec: s.startSec, endSec: s.endSec, speakerId: who };
    });
  }

  return { analyze: analyze, timeline: timeline, _internal: { describe: describe, steadyStretches: steadyStretches, kmeans: kmeans } };
});
