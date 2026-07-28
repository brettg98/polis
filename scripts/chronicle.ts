// Regenerate a tournament's Chronicle Viewer from its chronicle-rot*.json
// files — template iteration without re-running anything (ADR-002).
//   npm run chronicle -- runs/tournament-<id> [--out <file>]
import fs from 'node:fs';
import path from 'node:path';
import { RNG } from '../src/engine/rng';
import { generateTerrain } from '../src/engine/terrain';
import { buildViewerHtml } from '../src/chronicle/html';
import { annotateMechanicalDefections } from '../src/chronicle/mechanical';
import type { Chronicle } from '../src/chronicle/types';

const args = process.argv.slice(2);
let dir: string | undefined;
let outPath: string | undefined;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') outPath = args[++i];
  else dir = args[i];
}
if (!dir || !fs.existsSync(dir)) {
  console.error('usage: npm run chronicle -- <tournament-dir> [--out <file>]');
  process.exit(1);
}

const files = fs
  .readdirSync(dir)
  .filter((f) => /^chronicle-rot\d+\.json$/.test(f))
  .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
if (!files.length) {
  console.error(`no chronicle-rot*.json in ${dir} (chronicles exist only for runs made after ADR-002 landed)`);
  process.exit(1);
}
const chronicles = files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Chronicle);
annotateMechanicalDefections(chronicles, dir);

const first = chronicles[0];
const L = first.cities.length;
// Undo the rotation to recover the original lineup order.
const lineup = first.cities.map((_c, j) => {
  const cityIdx = (((j - first.rotation) % L) + L) % L;
  return first.assignment[first.cities[cityIdx].id];
});
const terrain = generateTerrain(new RNG(first.world.seed), first.world.gridSize);

const html = buildViewerHtml({
  title: first.world.scenarioName ?? `seed ${first.world.seed}`,
  premise: first.world.premise,
  designNotes: first.world.designNotes,
  generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
  lineup,
  ticks: Math.max(...chronicles.map((c) => c.ticksRun)),
  world: {
    size: first.world.gridSize,
    seaLevel: terrain.seaLevel,
    heights: Array.from(terrain.heights, (h) => Math.round(h * 1000) / 1000),
  },
  chronicles,
});
const out = outPath ?? path.join(dir, 'chronicle.html');
fs.writeFileSync(out, html);
console.log(`wrote ${out} (${chronicles.length} rotation(s), ${(html.length / 1024).toFixed(0)} KB)`);
