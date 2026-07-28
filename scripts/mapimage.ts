// Renders a scenario's world to a standalone SVG: axonometric terrain with
// relief, the sea, and the city sites labelled. The Chronicle viewer draws the
// same world top-down on a canvas; this is the version for a README, where
// there is no JavaScript to run.
//
//   npm run mapimage -- [--scenario <file>] [--out <file>] [--step 2]
//
// Terrain comes from the engine (generateTerrain with the scenario's own seed
// and grid), so the picture cannot drift from the world the models played.
// SVG rather than PNG: no binary asset, no image dependency, text labels come
// free, and it stays diffable like everything else in the repo.
import fs from 'node:fs';
import path from 'node:path';
import { RNG } from '../src/engine/rng';
import { generateTerrain, type Terrain } from '../src/engine/terrain';
import { CITY_COLORS } from '../src/engine/cities';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const scenarioPath = arg('scenario', 'scenarios/kilnspire-ledger-424242-v2.json');
const outPath = arg('out', 'docs/world-kilnspire-ledger.svg');
// Every Nth cell. The grid is 96x96; at step 1 that is 9216 quads and a file
// too heavy for a README. Step 2 keeps the landforms and lands near 250KB.
const step = Math.max(1, Number(arg('step', '2')));

if (!fs.existsSync(scenarioPath)) {
  console.error(`no such scenario: ${scenarioPath}`);
  process.exit(1);
}

interface ScenarioCity {
  name: string;
  site: { x: number; y: number };
  produces: string[];
}
interface ScenarioFile {
  name: string;
  seed: number;
  gridSize: number;
  cities: ScenarioCity[];
}
const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8')) as ScenarioFile;
const terrain = generateTerrain(new RNG(scenario.seed), scenario.gridSize);

// ---- projection ----
const TILE_W = 26;
const TILE_H = 13; // 2:1 axonometric
const RELIEF = 190; // vertical exaggeration, in px at height 1.0

// Labels and markers are sized in tile units, not pixels. A 96x96 grid makes a
// ~2700px-wide viewBox that a README column scales to roughly a third, so a
// 17px label would arrive at 6px and be unreadable. Deriving from TILE_W keeps
// them legible at display scale for any grid size.
const NAME_PX = TILE_W * 1.7;
const PROD_PX = TILE_W * 1.15;
const TITLE_PX = TILE_W * 1.3;
const STALK = TILE_W * 3;
const DOT_R = TILE_W * 0.62;
const PAD = TILE_W * 2.5;
// Labels stack above the tallest marker, so the top edge needs more room.
const PAD_TOP = STALK + NAME_PX * 2.4;

const at = (t: Terrain, x: number, y: number): number =>
  t.heights[Math.min(t.size - 1, y) * t.size + Math.min(t.size - 1, x)];

// Water reads as a flat sheet rather than a lumpy seabed, matching the sim.
const surface = (x: number, y: number): number => Math.max(at(terrain, x, y), terrain.seaLevel);

const N = scenario.gridSize;
function project(x: number, y: number, h: number): [number, number] {
  return [((x - y) * TILE_W) / 2, ((x + y) * TILE_H) / 2 - h * RELIEF];
}

// Bounds, so the viewBox fits whatever the terrain does.
let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
for (let y = 0; y <= N; y += step) {
  for (let x = 0; x <= N; x += step) {
    const [px, py] = project(x, y, surface(x, y));
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
}

// ---- shading ----
// Same colour bands as the browser renderer (src/render/scene.ts) so the two
// views of one world agree.
function band(h: number): string {
  const sea = terrain.seaLevel;
  if (h < sea - 0.02) return '#173a52';
  if (h < sea + 0.015) return '#c7b280';
  if (h < 0.5) return '#5f9450';
  if (h < 0.62) return '#497a41';
  if (h < 0.74) return '#8a8175';
  return '#e6e7ea';
}

const LIGHT: [number, number, number] = (() => {
  const v: [number, number, number] = [-0.55, -0.65, 0.52];
  const m = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / m, v[1] / m, v[2] / m];
})();

function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(c * k)));
  const r = f((n >> 16) & 255);
  const g = f((n >> 8) & 255);
  const b = f(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

// SVG text is markup. Scenario files are LLM-authored and shared, so city
// names are untrusted input here exactly as they are in the browser HUD.
const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: unknown): string => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

const r1 = (n: number): string => (Math.round(n * 10) / 10).toString();

// ---- terrain quads, painter's order (back to front) ----
const quads: string[] = [];
for (let y = 0; y < N; y += step) {
  for (let x = 0; x < N; x += step) {
    const s = step;
    const h00 = surface(x, y);
    const h10 = surface(x + s, y);
    const h11 = surface(x + s, y + s);
    const h01 = surface(x, y + s);
    const avg = (at(terrain, x, y) + at(terrain, x + s, y) + at(terrain, x + s, y + s) + at(terrain, x, y + s)) / 4;

    // Face normal from two edges, in the same units the projection uses.
    const ex: [number, number, number] = [s, 0, (h10 - h00) * RELIEF];
    const ey: [number, number, number] = [0, s, (h01 - h00) * RELIEF];
    const nx = ex[1] * ey[2] - ex[2] * ey[1];
    const ny = ex[2] * ey[0] - ex[0] * ey[2];
    const nz = ex[0] * ey[1] - ex[1] * ey[0];
    const nm = Math.hypot(nx, ny, nz) || 1;
    const lambert = (nx / nm) * LIGHT[0] + (ny / nm) * LIGHT[1] + (nz / nm) * LIGHT[2];
    const k = Math.max(0.45, Math.min(1.35, 0.72 + lambert * 0.62));

    const p = [
      project(x, y, h00),
      project(x + s, y, h10),
      project(x + s, y + s, h11),
      project(x, y + s, h01),
    ];
    const pts = p.map(([px, py]) => `${r1(px)},${r1(py)}`).join(' ');
    const isSea = avg < terrain.seaLevel;
    const fill = shade(band(avg), isSea ? Math.max(0.85, k) : k);
    quads.push(`<polygon points="${pts}" fill="${fill}"/>`);
  }
}

// ---- city markers ----
const markers: string[] = [];
scenario.cities.forEach((c, i) => {
  const colour = CITY_COLORS[i % CITY_COLORS.length];
  const h = surface(c.site.x, c.site.y);
  const [gx, gy] = project(c.site.x, c.site.y, h);
  markers.push(
    `<g>` +
      `<ellipse cx="${r1(gx)}" cy="${r1(gy)}" rx="${r1(DOT_R * 1.5)}" ry="${r1(DOT_R * 0.72)}" fill="#000" opacity="0.4"/>` +
      `<line x1="${r1(gx)}" y1="${r1(gy)}" x2="${r1(gx)}" y2="${r1(gy - STALK)}" stroke="${colour}" stroke-width="${r1(DOT_R * 0.42)}"/>` +
      `<circle cx="${r1(gx)}" cy="${r1(gy - STALK)}" r="${r1(DOT_R)}" fill="${colour}" stroke="#0b0e14" stroke-width="${r1(DOT_R * 0.34)}"/>` +
      `<text x="${r1(gx)}" y="${r1(gy - STALK - PROD_PX * 1.35)}" text-anchor="middle" class="cname">${esc(c.name)}</text>` +
      `<text x="${r1(gx)}" y="${r1(gy - STALK - PROD_PX * 0.15)}" text-anchor="middle" class="cprod">${esc(c.produces.join(' + '))}</text>` +
    `</g>`,
  );
});

const vx = minX - PAD;
const vy = minY - PAD_TOP;
const vbW = maxX - minX + PAD * 2;
const vbH = maxY - minY + PAD_TOP + PAD;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${r1(vx)} ${r1(vy)} ${r1(vbW)} ${r1(vbH)}" width="${Math.round(vbW)}" height="${Math.round(vbH)}" role="img" aria-label="${esc(scenario.name)}: axonometric terrain with ${scenario.cities.length} city sites">
<style>
  .cname { font: 600 ${r1(NAME_PX)}px ui-sans-serif, -apple-system, 'Segoe UI', Roboto, sans-serif; fill: #f2f4f8; paint-order: stroke; stroke: #0b0e14; stroke-width: ${r1(NAME_PX * 0.26)}px; stroke-linejoin: round; }
  .cprod { font: 500 ${r1(PROD_PX)}px ui-sans-serif, -apple-system, 'Segoe UI', Roboto, sans-serif; fill: #b9c2d0; paint-order: stroke; stroke: #0b0e14; stroke-width: ${r1(PROD_PX * 0.32)}px; stroke-linejoin: round; }
  .title { font: 600 ${r1(TITLE_PX)}px ui-monospace, 'SF Mono', Menlo, monospace; fill: #8b93a3; }
</style>
<rect x="${r1(vx)}" y="${r1(vy)}" width="${r1(vbW)}" height="${r1(vbH)}" fill="#0b0e14"/>
${quads.join('\n')}
${markers.join('\n')}
<text x="${r1(vx + PAD * 0.6)}" y="${r1(vy + vbH - PAD * 0.55)}" class="title">${esc(scenario.name)} · seed ${scenario.seed} · ${N}x${N}</text>
</svg>
`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, svg);
console.log(
  `wrote ${outPath} (${Math.round(svg.length / 1024)} KB, ${quads.length} faces at step ${step}, ${scenario.cities.length} cities)`,
);
