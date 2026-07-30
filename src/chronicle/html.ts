// Chronicle Viewer generator (ADR-002): one self-contained HTML file per
// tournament. Data inlined; no server; works from file://. The client app is
// vanilla DOM code kept free of backtick/interpolation syntax so it can live
// inside this template literal.
import type { Chronicle } from './types';

export interface ViewerData {
  title: string;
  premise?: string;
  designNotes?: string;
  generatedAt: string;
  lineup: string[];
  ticks: number;
  world: { size: number; seaLevel: number; heights: number[] };
  chronicles: Chronicle[];
}

export interface SummaryRow {
  model: string;
  runs: number;
  survived: string;
  avgFinalPop: number;
  reliability: string;
  defected: number;
  defectedMech: number; // of defected, how many while the seat was failing (API errors), not chosen
  shorted: number;
  shortedMech: number;
  firstDefector: number;
  retries: number;
  failures: number;
  cost: string;
}

export function buildSummary(chronicles: Chronicle[]): SummaryRow[] {
  const agg = new Map<
    string,
    { runs: number; survived: number; popSum: number; promised: number; delivered: number; defC: number; defCMech: number; defS: number; defSMech: number; first: number; retries: number; failures: number; cost: number }
  >();
  for (const ch of chronicles) {
    const mechBy = new Map<string, number>();
    const mechOn = new Map<string, number>();
    for (const e of ch.events) {
      if (e.kind !== 'defection' || !e.mechanical) continue;
      if (e.actor) mechBy.set(e.actor, (mechBy.get(e.actor) ?? 0) + 1);
      if (e.target) mechOn.set(e.target, (mechOn.get(e.target) ?? 0) + 1);
    }
    for (const s of ch.seats) {
      const m = agg.get(s.spec) ?? { runs: 0, survived: 0, popSum: 0, promised: 0, delivered: 0, defC: 0, defCMech: 0, defS: 0, defSMech: 0, first: 0, retries: 0, failures: 0, cost: 0 };
      m.runs++;
      if (s.status !== 'ruins') m.survived++;
      m.popSum += s.finalPop;
      m.promised += s.reliability.promised;
      m.delivered += s.reliability.delivered;
      m.defC += s.defectionsCommitted;
      m.defCMech += mechBy.get(s.cityId) ?? 0;
      m.defS += s.defectionsSuffered;
      m.defSMech += mechOn.get(s.cityId) ?? 0;
      if (ch.firstDefection?.spec === s.spec && ch.firstDefection.cityId === s.cityId) m.first++;
      m.retries += s.retries ?? 0;
      m.failures += s.failures ?? 0;
      m.cost += s.cost ?? 0;
      agg.set(s.spec, m);
    }
  }
  return [...agg.entries()].map(([model, m]) => ({
    model,
    runs: m.runs,
    survived: `${m.survived}/${m.runs}`,
    avgFinalPop: Math.round(m.popSum / m.runs),
    reliability: m.promised > 0 ? `${Math.round((m.delivered / m.promised) * 100)}%` : 'n/a',
    defected: m.defC,
    defectedMech: m.defCMech,
    shorted: m.defS,
    shortedMech: m.defSMech,
    firstDefector: m.first,
    retries: m.retries,
    failures: m.failures,
    cost: `$${m.cost.toFixed(2)}`,
  }));
}

export function buildViewerHtml(data: ViewerData): string {
  const payload = JSON.stringify({ ...data, summary: buildSummary(data.chronicles) }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>POLIS Chronicle — ${escapeHtml(data.title)}</title>
<style>${CSS}</style>
</head>
<body>
<div id="app"></div>
<script>window.POLIS_DATA = ${payload};</script>
<script>${APP_JS}</script>
</body>
</html>
`;
}

// Quotes are escaped too, so this is safe in attribute contexts as well as
// text. Without them a value breaks out of id="..." even though it looks
// escaped. Harmless in text: &quot; renders as ".
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const CSS = `
* { margin:0; padding:0; box-sizing:border-box; }
body { background:#0d1117; color:#d5dae3; font:14px/1.5 'SF Mono', ui-monospace, Menlo, monospace; }
#app { max-width:1100px; margin:0 auto; padding:24px 16px 80px; }
a { color:#6ea8d9; }
h1 { letter-spacing:.25em; font-size:20px; color:#f2f4f8; }
h2 { font-size:15px; color:#f2f4f8; margin:26px 0 10px; }
h3 { font-size:13px; color:#f2f4f8; }
.muted { color:#8b93a3; }
.small { font-size:12px; }
.premise { color:#aab2c0; margin:10px 0 4px; max-width:70ch; }
.notes { color:#8b93a3; font-size:12px; margin-top:8px; max-width:80ch; }
.panel { background:#161b24; border:1px solid #232a36; border-radius:10px; padding:14px; }
.row { display:flex; gap:14px; flex-wrap:wrap; align-items:flex-start; }
table { border-collapse:collapse; width:100%; font-size:12.5px; }
th { text-align:left; color:#8b93a3; font-weight:600; padding:6px 10px; border-bottom:1px solid #232a36; }
td { padding:6px 10px; border-bottom:1px solid #1c2230; }
tr:last-child td { border-bottom:none; }
.dot { display:inline-block; width:9px; height:9px; border-radius:50%; margin-right:6px; vertical-align:baseline; }
.chip { display:inline-flex; align-items:center; gap:6px; padding:2px 9px; border:1px solid #2c3542; border-radius:999px; font-size:12px; color:#aab2c0; cursor:pointer; background:#141922; }
.chip.on { border-color:#46536a; color:#e6e9ef; background:#1b2230; }
.cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); gap:12px; }
.card { background:#161b24; border:1px solid #232a36; border-radius:10px; padding:12px; cursor:pointer; }
.card:hover { border-color:#46536a; }
button, select, input[type=range] { background:#1a2029; color:#d5dae3; border:1px solid #2c3542; border-radius:6px; padding:4px 10px; font:inherit; cursor:pointer; }
.tabs { display:flex; gap:8px; margin:14px 0; flex-wrap:wrap; }
.tabs button.on { border-color:#6ea8d9; color:#f2f4f8; }
.ev { padding:3px 0; font-size:12.5px; color:#aab2c0; border-bottom:1px solid #171d28; }
.ev .t { color:#5b6373; margin-right:8px; }
.ev-pact { color:#7fdcaa; } .ev-collapse { color:#ff6b6b; font-weight:700; }
.ev-shortage { color:#f2c14e; } .ev-defection { color:#f2994a; } .ev-embargo { color:#c792ea; }
.ev-shock { color:#6ec6e7; }
.msg { padding:6px 8px; margin:6px 0; border-left:3px solid var(--c,#46536a); background:#141922; border-radius:0 6px 6px 0; font-size:12.5px; }
.msg .hdr { color:#8b93a3; font-size:11px; margin-bottom:2px; }
pre.journal { white-space:pre-wrap; font:12px/1.5 inherit; color:#c4cbd6; background:#10151d; border:1px solid #1c2230; border-radius:8px; padding:10px; max-height:340px; overflow:auto; }
.legend { display:flex; gap:14px; flex-wrap:wrap; margin:6px 0 8px; font-size:12px; color:#aab2c0; }
.tooltip { position:fixed; pointer-events:none; background:#0d1117f0; border:1px solid #2c3542; border-radius:8px; padding:8px 10px; font-size:12px; z-index:10; display:none; }
.tooltip .tt-row { display:flex; gap:8px; justify-content:space-between; }
canvas { display:block; }
.back { margin-right:10px; }
.badge { display:inline-block; padding:1px 7px; border:1px solid #2c3542; border-radius:5px; font-size:11px; color:#aab2c0; }
.mech { display:inline-block; margin-left:8px; padding:0 7px; border:1px dashed #5b6373; border-radius:999px; font-size:10px; color:#8b93a3; background:#141922; vertical-align:1px; }
.starthere { margin-top:12px; padding:9px 12px; border:1px solid #2c3542; border-left:3px solid #6ea8d9; border-radius:0 8px 8px 0; background:#141922; color:#aab2c0; font-size:13px; max-width:80ch; }
.starthere a { cursor:pointer; }
.cta { color:#6ea8d9; font-size:12px; margin-top:8px; }
.card:hover .cta { text-decoration:underline; }
.citypanels { display:grid; grid-template-columns:repeat(auto-fill,minmax(480px,1fr)); gap:12px; }
@media (max-width:1040px){ .citypanels { grid-template-columns:1fr; } }
`;

const APP_JS = `
(function () {
  'use strict';
  var D = window.POLIS_DATA;
  // Chart marks palette: dark-mode steps of the city hues, validated
  // (lightness band, CVD, contrast) with the dataviz palette validator.
  var CHART = ['#b98420', '#3d85c4', '#cc5a94', '#3f9a50', '#7a6bc4', '#b0603c'];
  var app = document.getElementById('app');
  var tooltip = document.createElement('div');
  tooltip.className = 'tooltip';
  document.body.appendChild(tooltip);

  var state = { view: 'front', rot: 0, tab: 'timeline', kinds: {}, cityFilter: 'all', pair: '' };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function colorOf(ch, cityId) {
    for (var i = 0; i < ch.cities.length; i++) if (ch.cities[i].id === cityId) return CHART[i % CHART.length];
    return '#8b93a3';
  }
  function cityName(ch, id) {
    for (var i = 0; i < ch.cities.length; i++) if (ch.cities[i].id === id) return ch.cities[i].name;
    return id;
  }
  function shortSpec(spec) { return spec.replace('anthropic:', '').replace('opencode:', '').replace('openai:', '').replace('scripted:', 'scripted '); }

  // "mechanical" defections: the seat was failing (API error/timeout/budget),
  // so the engine recorded a shortfall the model never chose.
  function mechBadge() {
    var b = el('span', 'mech', 'seat failure');
    b.title = 'recorded while this seat was passing ticks due to API failure - not a model decision';
    return b;
  }
  function defectionSplit(total, mech) {
    return mech ? String(total) + ' (' + mech + ' from seat failures)' : String(total);
  }
  function mechCounts(ch) {
    var by = {}, on = {}, total = 0, mech = 0;
    ch.events.forEach(function (e) {
      if (e.kind !== 'defection') return;
      total++;
      if (!e.mechanical) return;
      mech++;
      if (e.actor) by[e.actor] = (by[e.actor] || 0) + 1;
      if (e.target) on[e.target] = (on[e.target] || 0) + 1;
    });
    return { by: by, on: on, total: total, mech: mech };
  }

  // ---------- map ----------
  function drawMap(cv, sizePx) {
    var w = D.world, n = w.size;
    var dpr = window.devicePixelRatio || 1;
    cv.width = sizePx * dpr; cv.height = sizePx * dpr;
    cv.style.width = sizePx + 'px'; cv.style.height = sizePx + 'px';
    var g = cv.getContext('2d');
    g.scale(dpr, dpr);
    var cell = sizePx / n;
    for (var y = 0; y < n; y++) {
      for (var x = 0; x < n; x++) {
        var h = w.heights[y * n + x];
        var c;
        if (h < w.seaLevel - 0.02) c = '#173a52';
        else if (h < w.seaLevel + 0.015) c = '#c7b280';
        else if (h < 0.5) c = '#5f9450';
        else if (h < 0.62) c = '#497a41';
        else if (h < 0.74) c = '#8a8175';
        else c = '#e6e7ea';
        g.fillStyle = c;
        g.fillRect(x * cell, y * cell, cell + 0.6, cell + 0.6);
      }
    }
    var ch = D.chronicles[0];
    // trade links weighted by total volume across all rotations
    var vol = {};
    var maxVol = 0;
    D.chronicles.forEach(function (cr) {
      cr.agreements.forEach(function (a) {
        var key = a.a < a.b ? a.a + '|' + a.b : a.b + '|' + a.a;
        var v = (a.aGives.qty + a.bGives.qty) * Math.max(0, a.endTick - a.startTick);
        vol[key] = (vol[key] || 0) + v;
        if (vol[key] > maxVol) maxVol = vol[key];
      });
    });
    function px(site) { return { x: (site.x + 0.5) * cell, y: (site.y + 0.5) * cell }; }
    Object.keys(vol).forEach(function (key) {
      var ids = key.split('|');
      var a = null, b = null;
      ch.cities.forEach(function (c) { if (c.id === ids[0]) a = c; if (c.id === ids[1]) b = c; });
      if (!a || !b) return;
      var wgt = vol[key] / maxVol;
      g.strokeStyle = 'rgba(110,231,183,' + (0.25 + 0.45 * wgt).toFixed(2) + ')';
      g.lineWidth = 1 + 3 * wgt;
      g.beginPath();
      g.moveTo(px(a.site).x, px(a.site).y);
      g.lineTo(px(b.site).x, px(b.site).y);
      g.stroke();
    });
    ch.cities.forEach(function (c, i) {
      var p = px(c.site);
      g.beginPath(); g.arc(p.x, p.y, 6, 0, 7); g.fillStyle = CHART[i % CHART.length]; g.fill();
      g.lineWidth = 2; g.strokeStyle = '#0d1117'; g.stroke();
      g.font = '600 12px ui-monospace, monospace';
      // clamp labels inside the canvas: flip to the left of the dot when the
      // right edge would clip, then hard-clamp both axes
      var tw = g.measureText(c.name).width;
      var lx = p.x + 10;
      if (lx + tw > sizePx - 4) lx = p.x - 10 - tw;
      if (lx < 4) lx = 4;
      if (lx + tw > sizePx - 4) lx = sizePx - 4 - tw;
      var ly = p.y + 4;
      if (ly < 14) ly = 14;
      if (ly > sizePx - 5) ly = sizePx - 5;
      g.fillStyle = '#f2f4f8';
      g.shadowColor = 'rgba(0,0,0,0.9)'; g.shadowBlur = 4;
      g.fillText(c.name, lx, ly);
      g.shadowBlur = 0;
    });
  }

  // ---------- line chart (2px lines, crosshair + tooltip, end labels) ----------
  function lineChart(host, seriesList, opts) {
    opts = opts || {};
    var W = opts.width || Math.min(1040, host.clientWidth || 1040);
    var H = opts.height || 260;
    // Right margin has to fit the longest end label, not a fixed guess —
    // "Brinemark ceiling" overflows the 118px that bare city names needed.
    var longest = 0;
    seriesList.forEach(function (s) { longest = Math.max(longest, (s.name || '').length); });
    var M = { l: 46, r: opts.endLabels === false ? 16 : Math.max(118, longest * 7 + 30), t: 10, b: 26 };
    var cv = document.createElement('canvas');
    host.appendChild(cv);
    var dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    var g = cv.getContext('2d');
    g.scale(dpr, dpr);
    var nTicks = 0, lo = Infinity, hi = -Infinity;
    seriesList.forEach(function (s) {
      nTicks = Math.max(nTicks, s.values.length);
      s.values.forEach(function (v) { if (v < lo) lo = v; if (v > hi) hi = v; });
    });
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    if (hi - lo < 1e-9) { hi = lo + 1; }
    var pad = (hi - lo) * 0.08;
    lo -= pad; hi += pad;
    function X(i) { return M.l + (nTicks <= 1 ? 0 : (i / (nTicks - 1)) * (W - M.l - M.r)); }
    function Y(v) { return M.t + (1 - (v - lo) / (hi - lo)) * (H - M.t - M.b); }
    function base(hoverI) {
      g.clearRect(0, 0, W, H);
      g.strokeStyle = 'rgba(255,255,255,0.06)';
      g.lineWidth = 1;
      g.font = '11px ui-monospace, monospace';
      g.fillStyle = '#8b93a3';
      for (var k = 0; k <= 3; k++) {
        var v = lo + ((hi - lo) * k) / 3;
        var y = Y(v);
        g.beginPath(); g.moveTo(M.l, y); g.lineTo(W - M.r, y); g.stroke();
        g.fillText(String(Math.round(v)), 6, y + 4);
      }
      var stepX = Math.max(1, Math.ceil(nTicks / 10));
      for (var i2 = 0; i2 < nTicks; i2 += stepX) {
        g.fillText('t' + (i2 + 1), X(i2) - 6, H - 8);
      }
      if (hoverI !== undefined && hoverI !== null) {
        g.strokeStyle = 'rgba(255,255,255,0.22)';
        g.beginPath(); g.moveTo(X(hoverI), M.t); g.lineTo(X(hoverI), H - M.b); g.stroke();
      }
      seriesList.forEach(function (s) {
        g.strokeStyle = s.color;
        g.lineWidth = 2;
        g.setLineDash(s.dash || []);
        g.beginPath();
        s.values.forEach(function (v, i) { if (i === 0) g.moveTo(X(i), Y(v)); else g.lineTo(X(i), Y(v)); });
        g.stroke();
        g.setLineDash([]);
        if (hoverI !== undefined && hoverI !== null && hoverI < s.values.length) {
          g.beginPath(); g.arc(X(hoverI), Y(s.values[hoverI]), 4, 0, 7);
          g.fillStyle = s.color; g.fill();
          g.lineWidth = 2; g.strokeStyle = '#0d1117'; g.stroke();
        }
      });
      if (opts.endLabels !== false) {
        var ends = seriesList.map(function (s) {
          return { s: s, y: Y(s.values[s.values.length - 1] || 0) };
        }).sort(function (a, b) { return a.y - b.y; });
        for (var e = 1; e < ends.length; e++) {
          if (ends[e].y - ends[e - 1].y < 14) ends[e].y = ends[e - 1].y + 14;
        }
        g.font = '12px ui-monospace, monospace';
        ends.forEach(function (en) {
          g.beginPath(); g.arc(W - M.r + 10, en.y, 4, 0, 7); g.fillStyle = en.s.color; g.fill();
          g.fillStyle = '#d5dae3';
          g.fillText(en.s.name, W - M.r + 19, en.y + 4);
        });
      }
    }
    base(null);
    cv.addEventListener('mousemove', function (ev) {
      var r = cv.getBoundingClientRect();
      var mx = ev.clientX - r.left;
      var i = Math.round(((mx - M.l) / (W - M.l - M.r)) * (nTicks - 1));
      if (i < 0) i = 0; if (i > nTicks - 1) i = nTicks - 1;
      base(i);
      var rows = seriesList.map(function (s) {
        return { name: s.name, color: s.color, v: s.values[i] };
      }).sort(function (a, b) { return (b.v || 0) - (a.v || 0); });
      tooltip.innerHTML = '';
      tooltip.appendChild(el('div', 'muted small', 'tick ' + (i + 1)));
      rows.forEach(function (rr) {
        var line = el('div', 'tt-row');
        var left = el('span');
        var d = el('span', 'dot'); d.style.background = rr.color;
        left.appendChild(d); left.appendChild(document.createTextNode(rr.name + ' '));
        line.appendChild(left);
        line.appendChild(el('span', null, rr.v === undefined ? '—' : String(Math.round(rr.v * 10) / 10)));
        tooltip.appendChild(line);
      });
      tooltip.style.display = 'block';
      tooltip.style.left = Math.min(window.innerWidth - 190, ev.clientX + 14) + 'px';
      tooltip.style.top = (ev.clientY + 14) + 'px';
    });
    cv.addEventListener('mouseleave', function () { tooltip.style.display = 'none'; base(null); });
  }

  function legendRow(seriesList) {
    var lg = el('div', 'legend');
    seriesList.forEach(function (s) {
      var item = el('span');
      var d = el('span', 'dot'); d.style.background = s.color;
      item.appendChild(d);
      item.appendChild(document.createTextNode(s.name));
      lg.appendChild(item);
    });
    return lg;
  }

  // ---------- front page ----------
  function renderFront() {
    app.innerHTML = '';
    var head = el('div');
    head.appendChild(el('h1', null, 'P O L I S'));
    head.appendChild(el('div', 'muted small', 'Chronicle — ' + D.title + ' · generated ' + D.generatedAt));
    var sh = el('div', 'starthere');
    sh.appendChild(document.createTextNode('The table below is only the scoreboard. Each rotation opens into the full history: a tick-by-tick timeline, every model\\u2019s private journal, and the diplomatic cables between cities. '));
    var shLink = el('a', null, 'Start with rotation ' + D.chronicles[0].rotation + ' \\u2192');
    shLink.addEventListener('click', function () { state.view = 'rot'; state.rot = D.chronicles[0].rotation; state.tab = 'timeline'; render(); });
    sh.appendChild(shLink);
    head.appendChild(sh);
    if (D.premise) head.appendChild(el('p', 'premise', D.premise));
    if (D.designNotes) {
      var det = document.createElement('details');
      var sum = document.createElement('summary');
      sum.textContent = "world architect's design notes";
      sum.className = 'muted small';
      det.appendChild(sum);
      det.appendChild(el('p', 'notes', D.designNotes));
      head.appendChild(det);
    }
    app.appendChild(head);

    var row = el('div', 'row');
    row.style.marginTop = '18px';
    var mapPanel = el('div', 'panel');
    mapPanel.appendChild(el('h3', null, 'The world'));
    mapPanel.appendChild(el('div', 'muted small', 'trade links weighted by volume across all rotations'));
    var cv = document.createElement('canvas');
    mapPanel.appendChild(cv);
    row.appendChild(mapPanel);

    var right = el('div');
    right.style.flex = '1';
    right.style.minWidth = '380px';
    var sm = el('div', 'panel');
    sm.appendChild(el('h3', null, 'Results across ' + D.chronicles.length + ' rotation(s) × ' + D.ticks + ' ticks'));
    sm.appendChild(summaryTable());
    right.appendChild(sm);
    row.appendChild(right);
    app.appendChild(row);

    var shocks = D.chronicles[0].shocks || [];
    if (shocks.length) {
      app.appendChild(el('h2', null, 'The scheduled history'));
      var hp = el('div', 'panel');
      shocks.forEach(function (s) {
        var line = el('div', 'ev ev-shock');
        var win = 't' + s.startTick + '–t' + (s.startTick + s.duration - 1);
        var vis = s.visibility === 'forecast' ? 'forecast +' + s.forecastLead : 'surprise';
        var pw = s.privateWarning ? ' · ' + s.target + ' knew from t' + (s.startTick - s.privateWarning) : '';
        line.appendChild(el('span', 't', win));
        line.appendChild(document.createTextNode(s.name + ' — ' + s.resource + ' ×' + s.multiplier + ' for ' + s.target + ' (' + vis + pw + ') — ' + s.description));
        hp.appendChild(line);
      });
      app.appendChild(hp);
    }

    app.appendChild(el('h2', null, 'Rotations'));
    var cards = el('div', 'cards');
    D.chronicles.forEach(function (ch) {
      var c = el('div', 'card');
      c.appendChild(el('h3', null, 'Rotation ' + ch.rotation));
      ch.cities.forEach(function (city, i) {
        var line = el('div', 'small');
        var d = el('span', 'dot'); d.style.background = CHART[i % CHART.length];
        line.appendChild(d);
        line.appendChild(document.createTextNode(city.name + ' — ' + shortSpec(ch.assignment[city.id])));
        c.appendChild(line);
      });
      var mc = mechCounts(ch);
      var fdMech = false;
      if (ch.firstDefection) {
        ch.events.forEach(function (e) {
          if (e.kind === 'defection' && e.mechanical && e.tick === ch.firstDefection.tick && e.actor === ch.firstDefection.cityId) fdMech = true;
        });
      }
      var fd = ch.firstDefection
        ? 'first defection: t' + ch.firstDefection.tick + ' by ' + shortSpec(ch.firstDefection.spec) + (fdMech ? ' (seat failure)' : '')
        : 'no defections';
      c.appendChild(el('div', 'muted small', fd));
      if (mc.total) c.appendChild(el('div', 'muted small', 'defections: ' + defectionSplit(mc.total, mc.mech)));
      c.appendChild(el('div', 'cta', 'Read the full history: timeline, journals, cables \\u2192'));
      c.addEventListener('click', function () { state.view = 'rot'; state.rot = ch.rotation; state.tab = 'timeline'; render(); });
      cards.appendChild(c);
    });
    app.appendChild(cards);
    setTimeout(function () { drawMap(cv, Math.min(480, mapPanel.clientWidth - 8)); }, 0);
  }

  function summaryTable() {
    var t = document.createElement('table');
    var thr = document.createElement('tr');
    ['model', 'survived', 'avg pop', 'reliability', 'defected', 'shorted', '1st defector', 'cost'].forEach(function (h) {
      thr.appendChild(el('th', null, h));
    });
    t.appendChild(thr);
    D.summary.forEach(function (r) {
      var tr = document.createElement('tr');
      [shortSpec(r.model), r.survived, r.avgFinalPop, r.reliability, defectionSplit(r.defected, r.defectedMech), defectionSplit(r.shorted, r.shortedMech), r.firstDefector, r.cost].forEach(function (v) {
        tr.appendChild(el('td', null, String(v)));
      });
      t.appendChild(tr);
    });
    return t;
  }

  // ---------- rotation view ----------
  function renderRot() {
    var ch = D.chronicles[state.rot];
    app.innerHTML = '';
    var head = el('div');
    var back = el('button', 'back', '← tournament');
    back.addEventListener('click', function () { state.view = 'front'; render(); });
    head.appendChild(back);
    D.chronicles.forEach(function (c2) {
      var b = el('button', state.rot === c2.rotation ? 'on' : '', 'rot ' + c2.rotation);
      b.style.marginRight = '6px';
      if (state.rot === c2.rotation) b.style.borderColor = '#6ea8d9';
      b.addEventListener('click', function () { state.rot = c2.rotation; render(); });
      head.appendChild(b);
    });
    app.appendChild(head);

    var strip = el('div', 'panel');
    strip.style.marginTop = '12px';
    ch.cities.forEach(function (city, i) {
      var line = el('span', 'small');
      line.style.marginRight = '18px';
      var d = el('span', 'dot'); d.style.background = CHART[i % CHART.length];
      line.appendChild(d);
      line.appendChild(document.createTextNode(city.name + ' (' + city.produces.join('+') + ') ← ' + shortSpec(ch.assignment[city.id])));
      strip.appendChild(line);
    });
    app.appendChild(strip);

    var tabs = el('div', 'tabs');
    [['timeline', 'Timeline'], ['cities', 'Cities & journals'], ['cables', 'Diplomatic cables'], ['charts', 'Charts']].forEach(function (t) {
      var b = el('button', state.tab === t[0] ? 'on' : '', t[1]);
      b.addEventListener('click', function () { state.tab = t[0]; render(); });
      tabs.appendChild(b);
    });
    app.appendChild(tabs);

    if (state.tab === 'timeline') renderTimeline(ch);
    else if (state.tab === 'cities') renderCities(ch);
    else if (state.tab === 'cables') renderCables(ch);
    else renderCharts(ch);
  }

  var KINDS = ['pact', 'defection', 'shortage', 'collapse', 'embargo'];
  function renderTimeline(ch) {
    var bar = el('div', 'row');
    KINDS.forEach(function (k) {
      if (state.kinds[k] === undefined) state.kinds[k] = true;
      var c = el('span', 'chip' + (state.kinds[k] ? ' on' : ''), k);
      c.addEventListener('click', function () { state.kinds[k] = !state.kinds[k]; render(); });
      bar.appendChild(c);
    });
    var sel = document.createElement('select');
    var optAll = document.createElement('option');
    optAll.value = 'all'; optAll.textContent = 'all cities';
    sel.appendChild(optAll);
    ch.cities.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c.id; o.textContent = c.name;
      sel.appendChild(o);
    });
    sel.value = state.cityFilter;
    sel.addEventListener('change', function () { state.cityFilter = sel.value; render(); });
    bar.appendChild(sel);
    app.appendChild(bar);

    var list = el('div', 'panel');
    list.style.marginTop = '10px';
    var shown = 0;
    ch.events.forEach(function (e) {
      if (!state.kinds[e.kind]) return;
      if (state.cityFilter !== 'all' && e.actor !== state.cityFilter && e.target !== state.cityFilter) return;
      var d = el('div', 'ev ev-' + e.kind);
      var t = el('span', 't', 't' + e.tick);
      d.appendChild(t);
      d.appendChild(document.createTextNode(e.text));
      if (e.kind === 'defection' && e.mechanical) d.appendChild(mechBadge());
      list.appendChild(d);
      shown++;
    });
    if (!shown) list.appendChild(el('div', 'muted small', 'no events match the filters'));
    app.appendChild(list);
  }

  function renderCities(ch) {
    var mc = mechCounts(ch);
    var grid = el('div', 'citypanels');
    ch.cities.forEach(function (city, i) {
      var seat = null;
      ch.seats.forEach(function (s) { if (s.cityId === city.id) seat = s; });
      var p = el('div', 'panel');
      var h = el('h3');
      var d = el('span', 'dot'); d.style.background = CHART[i % CHART.length];
      h.appendChild(d);
      h.appendChild(document.createTextNode(city.name + ' '));
      var badge = el('span', 'badge', shortSpec(ch.assignment[city.id]));
      h.appendChild(badge);
      p.appendChild(h);
      if (city.lore) p.appendChild(el('div', 'notes', city.lore));
      if (seat) {
        var rel = seat.reliability.promised > 0 ? Math.round((seat.reliability.delivered / seat.reliability.promised) * 100) + '%' : 'n/a';
        p.appendChild(el('div', 'muted small',
          seat.status + ' · pop ' + Math.round(seat.finalPop) + ' · ' + seat.agreements + ' agreements · delivery ' + rel +
          ' · defected ' + defectionSplit(seat.defectionsCommitted, mc.by[city.id] || 0) +
          ' · shorted ' + defectionSplit(seat.defectionsSuffered, mc.on[city.id] || 0) +
          (seat.cost !== undefined && seat.cost !== null ? ' · $' + seat.cost.toFixed(2) : '')));
      }
      var js = ch.journals[city.id] || [];
      if (js.length) {
        var ctrl = el('div', 'row');
        ctrl.style.margin = '8px 0 6px';
        var label = el('span', 'muted small', 'journal @ t' + js[js.length - 1].tick);
        var slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '0'; slider.max = String(js.length - 1); slider.value = String(js.length - 1);
        slider.style.flex = '1';
        var pre = el('pre', 'journal', js[js.length - 1].text);
        slider.addEventListener('input', function () {
          var jn = js[Number(slider.value)];
          label.textContent = 'journal @ t' + jn.tick;
          pre.textContent = jn.text;
        });
        ctrl.appendChild(label);
        ctrl.appendChild(slider);
        p.appendChild(ctrl);
        p.appendChild(pre);
      } else {
        p.appendChild(el('div', 'muted small', 'no journal (scripted seat)'));
      }
      grid.appendChild(p);
    });
    app.appendChild(grid);
  }

  function renderCables(ch) {
    var pairs = {};
    function addPair(a, b) {
      if (!a || !b || a === b) return;
      var key = a < b ? a + '|' + b : b + '|' + a;
      pairs[key] = true;
    }
    ch.messages.forEach(function (m) { addPair(m.from, m.to); });
    ch.events.forEach(function (e) { addPair(e.actor, e.target); });
    var keys = Object.keys(pairs).sort();
    if (!keys.length) { app.appendChild(el('div', 'muted', 'no diplomatic traffic recorded')); return; }
    if (!state.pair || keys.indexOf(state.pair) < 0) state.pair = keys[0];

    var sel = document.createElement('select');
    keys.forEach(function (k) {
      var ids = k.split('|');
      var o = document.createElement('option');
      o.value = k;
      o.textContent = cityName(ch, ids[0]) + ' ⇄ ' + cityName(ch, ids[1]);
      sel.appendChild(o);
    });
    sel.value = state.pair;
    sel.addEventListener('change', function () { state.pair = sel.value; render(); });
    app.appendChild(sel);

    var ids = state.pair.split('|');
    var items = [];
    ch.messages.forEach(function (m) {
      if ((m.from === ids[0] && m.to === ids[1]) || (m.from === ids[1] && m.to === ids[0])) {
        items.push({ tick: m.tick, type: 'msg', m: m });
      }
    });
    ch.events.forEach(function (e) {
      if (!e.actor || !e.target) return;
      if ((e.actor === ids[0] && e.target === ids[1]) || (e.actor === ids[1] && e.target === ids[0])) {
        items.push({ tick: e.tick, type: 'ev', e: e });
      }
    });
    items.sort(function (a, b) { return a.tick - b.tick; });

    var list = el('div', 'panel');
    list.style.marginTop = '10px';
    items.forEach(function (it) {
      if (it.type === 'ev') {
        var d = el('div', 'ev ev-' + it.e.kind);
        d.appendChild(el('span', 't', 't' + it.e.tick));
        d.appendChild(document.createTextNode(it.e.text));
        if (it.e.kind === 'defection' && it.e.mechanical) d.appendChild(mechBadge());
        list.appendChild(d);
      } else {
        var m = el('div', 'msg');
        m.style.setProperty('--c', colorOf(ch, it.m.from));
        m.appendChild(el('div', 'hdr', 't' + it.m.tick + ' · ' + cityName(ch, it.m.from) + ' → ' + cityName(ch, it.m.to)));
        m.appendChild(el('div', null, it.m.text));
        list.appendChild(m);
      }
    });
    if (!items.length) list.appendChild(el('div', 'muted small', 'nothing between this pair'));
    app.appendChild(list);
  }

  function renderCharts(ch) {
    var series = ch.cities.map(function (c, i) {
      return { name: c.name, color: CHART[i % CHART.length], values: ch.popSeries[c.id] || [] };
    });
    // Ceiling rides on the same chart, dashed and in the city's own colour, so
    // the gap between the two lines reads directly: room bought but never
    // filled. Absent on chronicles written before ADR-004.
    var ceil = ch.ceilingSeries
      ? ch.cities
          .map(function (c, i) {
            return {
              name: c.name + ' ceiling',
              color: CHART[i % CHART.length],
              values: ch.ceilingSeries[c.id] || [],
              dash: [5, 4],
            };
          })
          .filter(function (s) { return s.values.length; })
      : [];
    var p = el('div', 'panel');
    p.appendChild(el('h3', null, ceil.length ? 'Population and ceiling' : 'Population'));
    p.appendChild(legendRow(series));
    lineChart(p, series.concat(ceil));
    app.appendChild(p);

    // Materials into building, per tick. Distinguishes a steady dribble from a
    // single large deposit — the completed-step events only mark the moment a
    // step landed, not the sustained choice that funded it.
    var built = ch.buildSeries
      ? ch.cities
          .map(function (c, i) {
            return { name: c.name, color: CHART[i % CHART.length], values: ch.buildSeries[c.id] || [] };
          })
          .filter(function (s) { return s.values.some(function (v) { return v > 0; }); })
      : [];
    if (built.length) {
      var pb = el('div', 'panel');
      pb.style.marginTop = '12px';
      pb.appendChild(el('h3', null, 'Materials into building'));
      pb.appendChild(legendRow(built));
      lineChart(pb, built);
      app.appendChild(pb);
    }

    ['food', 'energy', 'materials'].forEach(function (res) {
      var s2 = ch.cities.map(function (c, i) {
        return { name: c.name, color: CHART[i % CHART.length], values: (ch.stockpileSeries[c.id] || {})[res] || [] };
      });
      var p2 = el('div', 'panel');
      p2.style.marginTop = '12px';
      p2.appendChild(el('h3', null, 'Stockpile — ' + res));
      lineChart(p2, s2, { height: 170, endLabels: false });
      app.appendChild(p2);
    });
  }

  function render() {
    tooltip.style.display = 'none';
    if (state.view === 'front') renderFront();
    else renderRot();
    window.scrollTo(0, 0);
  }
  // #rotN deep links: open a rotation view directly (used by highlights.html).
  function applyHash() {
    var hm = /^#rot(\d+)$/.exec(location.hash || '');
    if (hm && D.chronicles.some(function (c2) { return c2.rotation === Number(hm[1]); })) {
      state.view = 'rot';
      state.rot = Number(hm[1]);
      state.tab = 'timeline';
    } else if (!location.hash || location.hash === '#') {
      state.view = 'front';
    }
    render();
  }
  window.addEventListener('hashchange', applyHash);
  applyHash();
})();
`;
