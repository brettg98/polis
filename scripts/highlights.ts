// Tournament highlights page: the editorial layer above the Chronicle
// archive. Reads chronicle-rot*.json + summary.json from a run dir plus a
// checked-in curation file, verifies every quote and chart reference against
// the data (a quote that is not verbatim fails the build), and writes a
// small self-contained highlights.html next to chronicle.html.
//   npm run highlights -- [--dir runs/tournament-main] [--out <file>] [--content <file>]
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { annotateMechanicalDefections } from '../src/chronicle/mechanical';
import type { Chronicle } from '../src/chronicle/types';

interface CurationQuote {
  rotation: number;
  cityId: string;
  tick: number;
  source: 'journal' | 'cable';
  to?: string; // cable recipient, for disambiguation
  text: string;
}

interface CurationChart {
  title: string;
  window: [number, number]; // inclusive tick range, 1-based
  series: Array<{ rotation: number; cityId: string; label?: string }>;
}

interface CurationStory {
  id: string;
  kicker: string;
  headline: string;
  body: string;
  quotes: CurationQuote[];
  chart?: CurationChart;
  chronicleRotation: number;
}

interface Curation {
  tournament: string;
  stories: CurationStory[];
}

const args = process.argv.slice(2);
let dir = 'runs/tournament-main';
let outPath: string | undefined;
let contentPath = 'content/highlights-tournament1.yaml';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dir') dir = args[++i];
  else if (args[i] === '--out') outPath = args[++i];
  else if (args[i] === '--content') contentPath = args[++i];
}
if (!fs.existsSync(dir)) {
  console.error(`no such run dir: ${dir}`);
  process.exit(1);
}

const files = fs
  .readdirSync(dir)
  .filter((f) => /^chronicle-rot\d+\.json$/.test(f))
  .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
if (!files.length) {
  console.error(`no chronicle-rot*.json in ${dir}`);
  process.exit(1);
}
const chronicles = files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Chronicle);
annotateMechanicalDefections(chronicles, dir);

interface SummaryFile {
  scenario?: string;
  ticks: number;
  rotations: number;
  summary: Array<{ model: string; avgFinalPop: number; reliability: string; defected: number; cost: string }>;
}
const summaryPath = path.join(dir, 'summary.json');
if (!fs.existsSync(summaryPath)) {
  console.error(`missing ${summaryPath}`);
  process.exit(1);
}
const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as SummaryFile;
// YAML rather than JSON because the bulk of this file is prose a human edits:
// folded scalars wrap paragraphs at a readable width, comments explain which
// fields are editorial, and a one-word change produces a one-line diff. JSON is
// still accepted, since YAML is a superset of it.
const curation = YAML.parse(fs.readFileSync(contentPath, 'utf8')) as Curation;

function byRotation(rotation: number): Chronicle {
  const ch = chronicles.find((c) => c.rotation === rotation);
  if (!ch) {
    console.error(`curation references rotation ${rotation}, which has no chronicle`);
    process.exit(1);
  }
  return ch;
}
function cityName(ch: Chronicle, id: string): string {
  return ch.cities.find((c) => c.id === id)?.name ?? id;
}
function shortSpec(spec: string): string {
  return spec.replace(/^(anthropic|opencode|openai):/, '').replace(/^scripted:/, 'scripted ');
}

// ---- token accounting ----
// Tokens are measured; dollars are derived. The price assumption is printed
// on the page so the arithmetic is reproducible by a reader. See
// docs/llm-seats.md for the per-provider bias measured against real invoices.
const PRICES: Record<string, { input: number; output: number; cachedRead: number; note?: string }> = {
  'claude-opus-5': { input: 5, output: 25, cachedRead: 0.5 },
  'claude-sonnet-5': { input: 2, output: 10, cachedRead: 0.2, note: 'introductory rate, in effect during the run; list is $3/$15' },
  'glm-5.2': { input: 1.4, output: 4.4, cachedRead: 0.26 },
  'gpt-5.6-terra': { input: 2.5, output: 15, cachedRead: 0.25, note: 'gateway does not report reasoning tokens, so output and cost are floors' },
};
interface RunSeat {
  spec: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    cachedTokens?: number;
  };
}
const tokens = new Map<string, { input: number; output: number; cached: number; cost: number }>();
for (const f of fs.readdirSync(dir).filter((n) => /^run-rot\d+\.json$/.test(n))) {
  const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as { seats: RunSeat[] };
  for (const s of rec.seats) {
    const p = PRICES[shortSpec(s.spec)];
    if (!p) continue;
    const u = s.usage;
    const acc = tokens.get(s.spec) ?? { input: 0, output: 0, cached: 0, cost: 0 };
    // Anthropic reports cache reads/writes outside input_tokens; the
    // OpenAI-compatible route reports a single prompt total with cached as a
    // subset of it.
    const isAnthropic = u.cacheReadTokens !== undefined;
    const cached = (isAnthropic ? u.cacheReadTokens : u.cachedTokens) ?? 0;
    const write = u.cacheWriteTokens ?? 0;
    const fresh = isAnthropic ? u.inputTokens : Math.max(0, u.inputTokens - cached);
    acc.input += fresh + cached + write;
    acc.output += u.outputTokens;
    acc.cached += cached;
    acc.cost += (fresh * p.input + write * p.input * 1.25 + cached * p.cachedRead + u.outputTokens * p.output) / 1e6;
    tokens.set(s.spec, acc);
  }
}
function compactTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(n);
}

// ---- standings: summary.json + mechanical split + total pop ----
const totals = new Map<string, number>();
const mech = new Map<string, number>();
for (const ch of chronicles) {
  for (const s of ch.seats) totals.set(s.spec, (totals.get(s.spec) ?? 0) + s.finalPop);
  for (const e of ch.events) {
    if (e.kind !== 'defection' || !e.mechanical || !e.actor) continue;
    const spec = ch.assignment[e.actor];
    mech.set(spec, (mech.get(spec) ?? 0) + 1);
  }
}
const standings = summary.summary
  .map((r) => ({
    model: shortSpec(r.model),
    totalPop: Math.round(totals.get(r.model) ?? 0),
    avgFinalPop: r.avgFinalPop,
    reliability: r.reliability,
    chosen: r.defected - (mech.get(r.model) ?? 0),
    mechanical: mech.get(r.model) ?? 0,
    tokensIn: compactTokens(tokens.get(r.model)?.input ?? 0),
    tokensOut: compactTokens(tokens.get(r.model)?.output ?? 0),
    cost: `$${(tokens.get(r.model)?.cost ?? 0).toFixed(2)}`,
    costFloor: shortSpec(r.model) === 'gpt-5.6-terra',
  }))
  .sort((a, b) => b.totalPop - a.totalPop);

// ---- primer: the rules, the scheduled shocks, how to read a quote ----
// Generated from the chronicle rather than transcribed, so it cannot drift
// from the world the models actually played.
interface ShockDef {
  name: string;
  target: string;
  resource: string;
  startTick: number;
  duration: number;
  multiplier: number;
  visibility: string;
  forecastLead?: number;
  privateWarning?: number;
}
const shocks = ((chronicles[0] as unknown as { shocks?: ShockDef[] }).shocks ?? []).slice().sort((a, b) => a.startTick - b.startTick);
const shockRows = shocks
  .map((s) => {
    const pct = Math.round(Math.abs(1 - s.multiplier) * 100);
    const dir = s.multiplier < 1 ? 'cut' : 'raised';
    const seen =
      s.visibility === 'forecast'
        ? `announced ${s.forecastLead ?? 0} ticks early`
        : 'no public warning';
    const priv = s.privateWarning ? `, ${escapeHtml(s.target)} told ${s.privateWarning} ticks early` : '';
    return `<tr><td>${escapeHtml(s.name)}</td><td class="tok">t${s.startTick}–${s.startTick + s.duration - 1}</td><td>${escapeHtml(s.target)}</td><td>${escapeHtml(s.resource)} ${dir} ${pct}%</td><td>${seen}${priv}</td></tr>`;
  })
  .join('\n');
const cityRows = chronicles[0].cities
  .map(
    (c) =>
      `<tr><td class="tok">${escapeHtml(c.id)}</td><td>${escapeHtml(c.name)}</td><td>${(c as unknown as { produces: string[] }).produces.join(' + ')}</td><td>${['food', 'energy', 'materials'].filter((r) => !(c as unknown as { produces: string[] }).produces.includes(r)).join('')}</td></tr>`,
  )
  .join('\n');
const primerHtml = `<div class="panel primer">
<h2>How this world works</h2>
<p>Four cities share one continent. Each produces two of the three resources everyone consumes, so the third has to be bought from a neighbour, every tick, forever. A deal is struck as an offer and becomes an agreement, but delivery is a separate act: a city can promise and then ship nothing. That gap is the whole experiment.</p>
<table>
<tr><th>id</th><th>city</th><th>produces</th><th>must import</th></tr>
${cityRows}
</table>
<p class="sub">Each rotation reassigns the four models to different cities, so every model plays every seat once.</p>
<h3>The scheduled shocks</h3>
<p>Production multipliers written into the world before any model saw it, identical in all four rotations. Some are announced to everyone in advance; some hit without public warning, though the city about to be struck is told privately first, which it may keep to itself, trade on, or warn a partner about.</p>
<table>
<tr><th>event</th><th>ticks</th><th>hits</th><th>effect</th><th>who knew</th></tr>
${shockRows}
</table>
<h3>What this measures, and what it does not</h3>
<p>These are results from one game with one set of incentives, and the headlines below describe how a model played it. A model that defected often was solving the problem this world posed, which rewards a city for taking what it needs when a neighbour is weak. That is not a finding about whether the model is trustworthy in your application, safe to deploy, or good at anything other than this. Nothing here was measured under conditions any vendor designed for, and none of it should be read as a ranking of model quality.</p>
<p>One flaw in the run is worth stating plainly, because it favoured the winner. The seats were meant to be held at the same reasoning effort and were not: the two Anthropic seats were capped at <span class="tok">low</span> while the other two ran at their provider defaults, GLM's being near-maximum. On identical prompts that is roughly six times the output tokens, most of it reasoning. The model that finished first was thinking considerably longer per turn than two of its opponents were allowed to. This was found and fixed after the tournament, and the results are published as they came out rather than quietly re-run — but the standings should be read as a result under stated conditions, not as a clean model-versus-model comparison.</p>
<p>What it does show is that these systems negotiate, keep books, hold grudges, and break deals in ways that are legible when you read what they wrote at the time. That is the reason for publishing the journals rather than the scores.</p>
<h3>Reading the quotes</h3>
<p>Everything quoted below is verbatim model output, unedited. Two channels: a <strong>journal</strong> is private, a capped notebook each model writes to itself and receives back on the next tick, which is the closest thing here to a model's inner voice; a <strong>cable</strong> is a message sent to another city, which that city reads. Models refer to each other by the short ids above, to standing deals as <span class="tok">a###</span> (agreements), and to proposals as <span class="tok">o###</span> (offers). The compressed telegraphic style is theirs: the journal has a token budget, and they spend it on arithmetic rather than prose.</p>
</div>`;

// ---- verify quotes and build chart payloads ----
interface ResolvedQuote {
  text: string;
  attribution: string; // "City (model), rotation N, tick T"
}
interface ResolvedChart {
  id: string;
  title: string;
  tickStart: number;
  series: Array<{ name: string; color: string; values: number[] }>;
}

// Dark-mode chart palette shared with the Chronicle viewer (src/chronicle/html.ts).
const CHART = ['#b98420', '#3d85c4', '#cc5a94', '#3f9a50', '#7a6bc4', '#b0603c'];

let problems = 0;
function fail(msg: string): void {
  console.error(`VERIFY FAIL: ${msg}`);
  problems++;
}

function resolveQuote(story: CurationStory, q: CurationQuote): ResolvedQuote {
  const ch = byRotation(q.rotation);
  let haystack: string | undefined;
  if (q.source === 'journal') {
    haystack = (ch.journals[q.cityId] ?? []).find((j) => j.tick === q.tick)?.text;
    if (haystack === undefined) fail(`${story.id}: no journal for ${q.cityId} at rot${q.rotation} t${q.tick}`);
  } else {
    haystack = ch.messages.find((m) => m.from === q.cityId && m.tick === q.tick && (!q.to || m.to === q.to))?.text;
    if (haystack === undefined) fail(`${story.id}: no cable from ${q.cityId} at rot${q.rotation} t${q.tick}`);
  }
  if (haystack !== undefined && !haystack.includes(q.text)) {
    fail(`${story.id}: quote is not verbatim in rot${q.rotation} ${q.source} (${q.cityId} t${q.tick}):\n  ${q.text.slice(0, 90)}`);
  }
  const attribution = `${cityName(ch, q.cityId)} (${shortSpec(ch.assignment[q.cityId])}), rotation ${q.rotation}, tick ${q.tick}`;
  return { text: q.text, attribution };
}

function resolveChart(story: CurationStory, chart: CurationChart): ResolvedChart {
  const [t0, t1] = chart.window;
  const singleRotation = chart.series.every((s) => s.rotation === chart.series[0].rotation);
  const series = chart.series.map((s, i) => {
    const ch = byRotation(s.rotation);
    const values = (ch.popSeries[s.cityId] ?? []).slice(t0 - 1, t1);
    if (!values.length) fail(`${story.id}: empty pop series for ${s.cityId} rot${s.rotation} window ${t0}-${t1}`);
    const cityIdx = ch.cities.findIndex((c) => c.id === s.cityId);
    const color = singleRotation && chart.series.length > 1 ? CHART[cityIdx % CHART.length] : CHART[i % CHART.length];
    return {
      name: s.label ?? `${cityName(ch, s.cityId)} (${shortSpec(ch.assignment[s.cityId])})`,
      color,
      values: values.map((v) => Math.round(v * 10) / 10),
    };
  });
  return { id: `chart-${story.id}`, title: chart.title, tickStart: t0, series };
}

const stories = curation.stories.map((st) => ({
  id: st.id,
  kicker: st.kicker,
  headline: st.headline,
  body: st.body,
  quotes: st.quotes.map((q) => resolveQuote(st, q)),
  chart: st.chart ? resolveChart(st, st.chart) : undefined,
  chronicleRotation: st.chronicleRotation,
}));
for (const st of curation.stories) byRotation(st.chronicleRotation); // link targets must exist
if (problems) {
  console.error(`${problems} verification failure(s); highlights.html not written`);
  process.exit(1);
}

// ---- render ----
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

const first = chronicles[0];
const worldName = first.world.scenarioName ?? `seed ${first.world.seed}`;
const generatedAt = new Date().toISOString().slice(0, 16).replace('T', ' ');
const totalDefections = chronicles.reduce((n, ch) => n + ch.events.filter((e) => e.kind === 'defection').length, 0);

const standingsRows = standings
  .map(
    (r) => `<tr><td>${escapeHtml(r.model)}</td><td>${r.totalPop}</td><td>${r.avgFinalPop}</td><td>${escapeHtml(r.reliability)}</td><td>${r.chosen} chosen${r.mechanical ? ` <span class="mechsplit">+ ${r.mechanical} seat failures</span>` : ''}</td><td class="tok">${r.tokensIn} <span class="mechsplit">in</span></td><td class="tok">${r.tokensOut} <span class="mechsplit">out</span></td><td class="tok">${escapeHtml(r.cost)}${r.costFloor ? '<span class="mechsplit">+</span>' : ''}</td></tr>`,
  )
  .join('\n');

const storyHtml = stories
  .map((st) => {
    const quotes = st.quotes
      .map(
        (q) => `<figure class="pull"><blockquote>${escapeHtml(q.text)}</blockquote><figcaption>${escapeHtml(q.attribution)}</figcaption></figure>`,
      )
      .join('\n');
    const chart = st.chart
      ? `<div class="chartbox"><div class="charttitle">${escapeHtml(st.chart.title)}</div><canvas id="${escapeHtml(st.chart.id)}"></canvas></div>`
      : '';
    return `<article class="story">
<div class="kicker">${escapeHtml(st.kicker)}</div>
<h2>${escapeHtml(st.headline)}</h2>
<p class="blurb">${escapeHtml(st.body)}</p>
${quotes}
${chart}
<a class="see" href="chronicle.html#rot${st.chronicleRotation}">See it in the Chronicle &#8594; rotation ${st.chronicleRotation}</a>
</article>`;
  })
  .join('\n');

const chartPayload = JSON.stringify(stories.filter((s) => s.chart).map((s) => s.chart)).replace(/</g, '\\u003c');

const CSS = `
* { margin:0; padding:0; box-sizing:border-box; }
body { background:#0d1117; color:#d5dae3; font:14px/1.5 'SF Mono', ui-monospace, Menlo, monospace; }
#page { max-width:860px; margin:0 auto; padding:24px 16px 80px; }
a { color:#6ea8d9; }
h1 { letter-spacing:.25em; font-size:20px; color:#f2f4f8; }
h2 { font-size:17px; color:#f2f4f8; margin:2px 0 10px; }
.muted { color:#8b93a3; }
.small { font-size:12px; }
.panel { background:#161b24; border:1px solid #232a36; border-radius:10px; padding:14px; }
table { border-collapse:collapse; width:100%; font-size:12.5px; }
th { text-align:left; color:#8b93a3; font-weight:600; padding:6px 10px; border-bottom:1px solid #232a36; }
td { padding:6px 10px; border-bottom:1px solid #1c2230; }
tr:last-child td { border-bottom:none; }
.mechsplit { color:#8b93a3; }
.tok { white-space:nowrap; }
.pricing { margin-top:10px; }
.pricing > summary { cursor:pointer; color:#8b93a3; font-size:13px; list-style:none; }
.pricing > summary::-webkit-details-marker { display:none; }
.pricing > summary::before { content:"▸ "; }
.pricing[open] > summary::before { content:"▾ "; }
.pricing > summary:hover { color:#c9d1e0; }
.primer { margin-top:18px; }
.primer h2 { font-size:17px; margin:0 0 10px; }
.primer h3 { font-size:14px; margin:20px 0 6px; color:#c9d1e0; }
.primer p { margin:0 0 10px; max-width:64ch; }
.primer table { margin:8px 0 4px; }
.primer .sub { color:#8b93a3; font-size:13px; }
.footnote { color:#5b6373; font-size:11px; margin-top:8px; }
.story { background:#161b24; border:1px solid #232a36; border-radius:10px; padding:18px 18px 16px; margin-top:18px; }
.kicker { color:#b98420; font-size:11px; letter-spacing:.18em; text-transform:uppercase; margin-bottom:6px; }
.blurb { color:#c4cbd6; max-width:74ch; }
.pull { margin:12px 0; }
.pull blockquote { border-left:3px solid #6ea8d9; background:#10151d; border-radius:0 8px 8px 0; padding:10px 12px; white-space:pre-wrap; color:#c4cbd6; font-size:12.5px; }
.pull figcaption { color:#8b93a3; font-size:11px; margin-top:5px; }
.chartbox { margin:14px 0 6px; }
.charttitle { color:#8b93a3; font-size:12px; margin-bottom:6px; }
.see { display:inline-block; margin-top:10px; font-size:12.5px; }
canvas { display:block; max-width:100%; }
`;

// Client JS: chart rendering only. Kept free of backtick/interpolation
// syntax so it can live inside this template literal (same convention as
// src/chronicle/html.ts).
const APP_JS = `
(function () {
  'use strict';
  var charts = window.POLIS_HL_CHARTS || [];
  charts.forEach(function (spec) {
    var cv = document.getElementById(spec.id);
    if (!cv) return;
    var host = cv.parentElement;
    var W = Math.min(820, host.clientWidth || 820);
    var multi = spec.series.length > 1;
    var H = multi ? 240 : 190;
    var M = { l: 44, r: multi ? 150 : 16, t: 10, b: 26 };
    var dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    var g = cv.getContext('2d');
    g.scale(dpr, dpr);
    var n = 0, lo = Infinity, hi = -Infinity;
    spec.series.forEach(function (s) {
      n = Math.max(n, s.values.length);
      s.values.forEach(function (v) { if (v < lo) lo = v; if (v > hi) hi = v; });
    });
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    if (hi - lo < 1e-9) hi = lo + 1;
    var pad = (hi - lo) * 0.08;
    lo -= pad; hi += pad;
    function X(i) { return M.l + (n <= 1 ? 0 : (i / (n - 1)) * (W - M.l - M.r)); }
    function Y(v) { return M.t + (1 - (v - lo) / (hi - lo)) * (H - M.t - M.b); }
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
    var stepX = Math.max(1, Math.ceil(n / 8));
    for (var i = 0; i < n; i += stepX) {
      g.fillText('t' + (spec.tickStart + i), X(i) - 8, H - 8);
    }
    spec.series.forEach(function (s) {
      g.strokeStyle = s.color;
      g.lineWidth = 2;
      g.beginPath();
      s.values.forEach(function (val, j) { if (j === 0) g.moveTo(X(j), Y(val)); else g.lineTo(X(j), Y(val)); });
      g.stroke();
    });
    if (multi) {
      var ends = spec.series.map(function (s) {
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
  });
})();
`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>POLIS — ${escapeHtml(curation.tournament)} Highlights</title>
<style>${CSS}</style>
</head>
<body>
<div id="page">
<h1>P O L I S</h1>
<div class="muted small">${escapeHtml(curation.tournament)} Highlights — ${escapeHtml(worldName)} · generated ${generatedAt}</div>
<div class="panel" style="margin-top:18px">
<table>
<tr><th>model</th><th>total pop</th><th>avg</th><th>reliability</th><th>defections</th><th colspan="2">tokens</th><th>est. cost</th></tr>
${standingsRows}
</table>
<div class="footnote">${chronicles.length} rotations × ${summary.ticks} ticks · ${totalDefections} defections recorded · "seat failures" are shortfalls logged while a seat was passing ticks due to API errors, not model decisions. Full receipts: <a href="chronicle.html">the Chronicle</a>.</div>
<details class="pricing"><summary>How these costs were calculated, and where they are unreliable</summary>
<div class="footnote">Token counts are measured from the API responses. Cost is derived from them at these rates per million tokens, input / output: ${Object.entries(
      PRICES,
    )
      .map(([m, p]) => `${escapeHtml(m)} $${p.input} / $${p.output}`)
      .join(' · ')}. Cached input bills below the input rate and is counted separately (${Object.entries(
      PRICES,
    )
      .map(([m, p]) => `${escapeHtml(m)} $${p.cachedRead}`)
      .join(' · ')}). Checked against the provider invoices for the run dates: the Anthropic seats reconcile to within 3% (Sonnet to 0.3%) and GLM to 9%, but GPT 5.6 Terra's invoice came in 33% above this estimate, because the OpenCode Zen gateway does not report reasoning tokens for that route while still billing them. Terra's output count and cost are therefore floors, marked <span class="mechsplit">+</span>; read its row as a lower bound rather than a measurement. One rate here is also time-limited: Sonnet 5 ran on an introductory price that expires 2026-08-31, and at list ($3 / $15) its cost would be $7.70.</div>
</details>
</div>
${primerHtml}
${storyHtml}
</div>
<script>window.POLIS_HL_CHARTS = ${chartPayload};</script>
<script>${APP_JS}</script>
</body>
</html>
`;

const out = outPath ?? path.join(dir, 'highlights.html');
fs.writeFileSync(out, html);
console.log(`wrote ${out} (${stories.length} stories, ${(html.length / 1024).toFixed(0)} KB)`);
