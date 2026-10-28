/* Timeline preview: mic waveforms, thresholds, detected speech, and the camera plan. */
(function () {
  function Viz(canvas, scroll) {
    this.c = canvas; this.scroll = scroll; this.ctx = canvas.getContext("2d");
    this.data = null; this.view = { start: 0, span: 60 }; this.playhead = null;
    this.sel = null; this.drag = null; this.onSeek = null; this.onSelect = null;
    var self = this;
    canvas.addEventListener("mousedown", function (e) { self.drag = { x0: self.xOf(e), x1: self.xOf(e) }; self.render(); });
    window.addEventListener("mousemove", function (e) { if (self.drag) { self.drag.x1 = self.xOf(e); self.render(); } });
    window.addEventListener("mouseup", function () {
      if (!self.drag) return;
      var d = self.drag; self.drag = null;
      var a = self.tOf(Math.min(d.x0, d.x1)), b = self.tOf(Math.max(d.x0, d.x1));
      if (Math.abs(d.x1 - d.x0) < 4) { self.sel = null; if (self.onSeek) self.onSeek(a); }
      else { self.sel = [a, b]; if (self.onSelect) self.onSelect(a, b); }
      self.render();
    });
    canvas.addEventListener("wheel", function (e) {
      if (!self.data) return;
      e.preventDefault();
      var t = self.tOf(self.xOf(e));
      var f = e.deltaY > 0 ? 1.25 : 0.8;
      self.zoomAround(t, f);
    }, { passive: false });
    scroll.addEventListener("input", function () {
      if (!self.data) return;
      var maxStart = Math.max(0, self.data.durationSec - self.view.span);
      self.view.start = maxStart * (scroll.value / 1000);
      self.render();
    });
    window.addEventListener("resize", function () { self.render(); });
  }
  Viz.prototype.xOf = function (e) { var r = this.c.getBoundingClientRect(); return e.clientX - r.left; };
  Viz.prototype.width = function () { return this.c.clientWidth; };
  Viz.prototype.tOf = function (x) { return this.view.start + (x / this.width()) * this.view.span; };
  Viz.prototype.xAt = function (t) { return (t - this.view.start) / this.view.span * this.width(); };
  Viz.prototype.setData = function (d) {
    if (!d) { this.data = null; this.render(); return; }
    var first = !this.data || this.data.durationSec !== d.durationSec;
    this.data = d;
    if (first) this.fit();
    this.render();
  };
  Viz.prototype.fit = function () { if (!this.data) return; this.view = { start: 0, span: Math.max(5, this.data.durationSec) }; this.syncScroll(); this.render(); };
  Viz.prototype.zoomAround = function (t, f) {
    var dur = this.data ? this.data.durationSec : 60;
    var span = Math.min(dur, Math.max(4, this.view.span * f));
    var rel = (t - this.view.start) / this.view.span;
    this.view.span = span;
    this.view.start = Math.max(0, Math.min(dur - span, t - rel * span));
    this.syncScroll(); this.render();
  };
  Viz.prototype.zoom = function (f) { this.zoomAround(this.view.start + this.view.span / 2, f); };
  Viz.prototype.syncScroll = function () {
    if (!this.data) return;
    var maxStart = Math.max(0.0001, this.data.durationSec - this.view.span);
    this.scroll.value = Math.round(1000 * this.view.start / maxStart);
  };
  Viz.prototype.setPlayhead = function (t) {
    this.playhead = t;
    // Follow the playhead when it leaves the view.
    if (this.data && t !== null && (t < this.view.start || t > this.view.start + this.view.span) && this.view.span < this.data.durationSec) {
      this.view.start = Math.max(0, Math.min(this.data.durationSec - this.view.span, t - this.view.span * 0.1));
      this.syncScroll();
    }
    this.render();
  };

  Viz.prototype.render = function () {
    var c = this.c, ctx = this.ctx, dpr = window.devicePixelRatio || 1;
    var W = c.clientWidth, H = c.clientHeight;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.font = "10px -apple-system, Segoe UI, sans-serif";
    var d = this.data;
    if (!d) {
      ctx.fillStyle = "#666"; ctx.fillText("Scan a sequence, then Analyze waveforms.", 10, H / 2);
      return;
    }
    var RULER = 14, STRIP = 30, GAP = 4;
    var lanes = d.speakers.length;
    var motionLanes = d.motion || [], ML = 9;
    var laneH = Math.max(14, (H - RULER - STRIP - GAP * 2 - motionLanes.length * ML) / Math.max(1, lanes));
    var self = this;
    var t0 = this.view.start, t1 = t0 + this.view.span;

    // ruler
    ctx.fillStyle = "#777";
    var stepOpts = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];
    var step = stepOpts.filter(function (s) { return (s / self.view.span) * W >= 60; })[0] || 3600;
    for (var t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
      var x = this.xAt(t);
      ctx.fillRect(x, 0, 1, 5);
      ctx.fillText(fmt(t), x + 3, 10);
    }

    // speaker lanes
    var hop = d.hopSec;
    d.speakers.forEach(function (sp, i) {
      var y0 = RULER + i * laneH, h = laneH - 2;
      ctx.fillStyle = "#1c1c1c"; ctx.fillRect(0, y0, W, h);
      // detected speech
      var runs = (d.speech && d.speech[i]) ? d.speech[i].runs : [];
      ctx.fillStyle = hexA(sp.color, 0.16);
      runs.forEach(function (r) {
        if (r[1] < t0 || r[0] > t1) return;
        var xa = self.xAt(r[0]), xb = self.xAt(r[1]);
        ctx.fillRect(xa, y0, Math.max(1, xb - xa), h);
      });
      // envelope
      var curve = d.curves[sp.id];
      if (curve) {
        // Scale each lane to that mic's own noise floor..speech level so bleed reads as "low".
        var cal = d.calibration && d.calibration[i];
        var lo = cal ? cal.floorDb - 2 : -70, hi = cal ? Math.max(cal.floorDb + 12, cal.speechDb + 1) : -6;
        ctx.fillStyle = hexA(sp.color, 0.9);
        for (var px = 0; px < W; px++) {
          var ta = self.tOf(px), tb = self.tOf(px + 1);
          var fa = Math.max(0, Math.floor(ta / hop)), fb = Math.min(curve.length, Math.max(fa + 1, Math.ceil(tb / hop)));
          var mx = -120;
          for (var f = fa; f < fb; f++) if (curve[f] > mx) mx = curve[f];
          var v = (Math.max(lo, Math.min(hi, mx)) - lo) / (hi - lo);
          var bh = v * (h - 2);
          ctx.fillRect(px, y0 + h - 1 - bh, 1, bh);
        }
        // threshold
        if (d.calibration && d.calibration[i]) {
          var th = d.calibration[i].thresholdDb;
          var ty = y0 + h - 1 - ((Math.max(lo, Math.min(hi, th)) - lo) / (hi - lo)) * (h - 2);
          ctx.strokeStyle = "rgba(255,255,255,.45)"; ctx.setLineDash([3, 3]);
          ctx.beginPath(); ctx.moveTo(0, ty + 0.5); ctx.lineTo(W, ty + 0.5); ctx.stroke(); ctx.setLineDash([]);
        }
      }
      ctx.fillStyle = "#ddd"; ctx.fillText(sp.name, 4, y0 + 11);
    });

    // camera movement lanes: green = steady, amber = slow move, red = big move
    var MCOL = ["rgba(73,199,138,.55)", "rgba(230,180,80,.9)", "rgba(239,93,93,.95)"];
    motionLanes.forEach(function (m, k) {
      var y = H - STRIP - GAP - (motionLanes.length - k) * ML;
      ctx.fillStyle = "#1c1c1c"; ctx.fillRect(0, y, W, ML - 2);
      var n = m.states.length;
      for (var px = 0; px < W; px++) {
        var off = m.offsetSec || 0;
        var ia = Math.max(0, Math.floor((self.tOf(px) - off) / m.hopSec)), ib = Math.min(n, Math.max(ia + 1, Math.ceil((self.tOf(px + 1) - off) / m.hopSec)));
        if (self.tOf(px + 1) < off) continue;
        var worst = -1;
        for (var q = ia; q < ib; q++) if (m.states[q] > worst) worst = m.states[q];
        if (worst < 0) continue;
        ctx.fillStyle = MCOL[worst]; ctx.fillRect(px, y, 1, ML - 2);
      }
      // Who the camera is pointed at (operated cams): a thin coloured line under the movement lane.
      (m.framing || []).forEach(function (f) {
        if (f.endSec < t0 || f.startSec > t1) return;
        var xa = self.xAt(f.startSec), xb = self.xAt(f.endSec);
        ctx.fillStyle = f.color; ctx.fillRect(xa, y + ML - 4, Math.max(1, xb - xa), 2);
      });
      ctx.save(); ctx.font = "8px -apple-system, Segoe UI, sans-serif"; ctx.fillStyle = "rgba(255,255,255,.85)";
      ctx.fillText(m.name + " movement", 4, y + ML - 3); ctx.restore();
    });

    // camera strip
    var sy = H - STRIP;
    var camById = {};
    d.cameras.forEach(function (cm) { camById[cm.id] = cm; });
    (d.shots || []).forEach(function (s) {
      if (s.endSec < t0 || s.startSec > t1) return;
      var xa = self.xAt(s.startSec), xb = self.xAt(s.endSec);
      var cm = camById[s.cameraId];
      ctx.fillStyle = cm ? cm.color : "#444";
      ctx.fillRect(xa, sy, Math.max(1, xb - xa - 1), STRIP - 10);
      if (s.locked) { ctx.fillStyle = "rgba(255,255,255,.8)"; ctx.fillRect(xa, sy, Math.max(1, xb - xa - 1), 2); }
      if (xb - xa > 34 && cm) {
        ctx.fillStyle = "rgba(0,0,0,.75)";
        var tag = REASON[s.reason] ? " · " + REASON[s.reason] : "";
        ctx.save(); ctx.beginPath(); ctx.rect(xa, sy, xb - xa - 2, STRIP - 10); ctx.clip();
        ctx.fillText(cm.name + tag, xa + 3, sy + 13); ctx.restore();
      }
    });
    // cleanup ranges (transcript suggestions)
    (d.cleanup || []).forEach(function (r) {
      if (r.endSec < t0 || r.startSec > t1) return;
      var xa = self.xAt(r.startSec), xb = self.xAt(r.endSec);
      ctx.fillStyle = "rgba(239,93,93,.18)"; ctx.fillRect(xa, RULER, xb - xa, H - RULER - 8);
      ctx.fillStyle = "rgba(239,93,93,.9)"; ctx.fillRect(xa, H - 8, Math.max(1, xb - xa), 6);
    });
    // outside the In/Out range: untouched by PodDirector
    if (d.range) {
      ctx.fillStyle = "rgba(10,10,10,.62)";
      var ra = this.xAt(d.range.a), rb = this.xAt(d.range.b);
      if (ra > 0) ctx.fillRect(0, RULER, Math.min(W, ra), H - RULER);
      if (rb < W) ctx.fillRect(Math.max(0, rb), RULER, W - Math.max(0, rb), H - RULER);
      ctx.fillStyle = "#e6b450";
      [ra, rb].forEach(function (x) { if (x >= 0 && x <= W) ctx.fillRect(Math.round(x), 0, 2, H); });
    }
    // selection
    var selPx = null;
    if (this.drag) selPx = [Math.min(this.drag.x0, this.drag.x1), Math.max(this.drag.x0, this.drag.x1)];
    else if (this.sel) selPx = [this.xAt(this.sel[0]), this.xAt(this.sel[1])];
    if (selPx) {
      ctx.fillStyle = "rgba(79,140,255,.18)"; ctx.fillRect(selPx[0], 0, selPx[1] - selPx[0], H);
      ctx.strokeStyle = "rgba(79,140,255,.9)"; ctx.strokeRect(selPx[0] + 0.5, 0.5, selPx[1] - selPx[0], H - 1);
    }
    // playhead
    if (this.playhead !== null && this.playhead >= t0 && this.playhead <= t1) {
      var px2 = Math.round(this.xAt(this.playhead)) + 0.5;
      ctx.strokeStyle = "#ff5a5a"; ctx.beginPath(); ctx.moveTo(px2, 0); ctx.lineTo(px2, H); ctx.stroke();
    }
  };

  var REASON = { "wide-turn": "wide turn", intro: "welcome", "intro-wide": "intros", reaction: "react", cutaway: "cutaway", crosstalk: "overlap", pause: "pause", opening: "open", locked: "locked", "interjection-wide": "react", "camera-move": "cam moving", "jump-cover": "cut cover", removed: "removed" };
  function fmt(t) { var m = Math.floor(t / 60), s = Math.floor(t % 60); return (m >= 60 ? Math.floor(m / 60) + ":" + pad(m % 60) : m) + ":" + pad(s); }
  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function hexA(hex, a) {
    var n = parseInt(hex.slice(1), 16);
    return "rgba(" + (n >> 16 & 255) + "," + (n >> 8 & 255) + "," + (n & 255) + "," + a + ")";
  }
  window.PDViz = Viz;
})();
