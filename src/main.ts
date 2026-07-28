import './style.css';
import { defaultConfig } from './engine/config';
import { Simulation } from './engine/sim';
import { ScriptedSeat } from './engine/seats/scripted';
import { RNG } from './engine/rng';
import { configForScenario, type Scenario } from './engine/scenario';
import type { Seat } from './engine/types';
import { SceneView } from './render/scene';
import { Hud } from './render/hud';

// Committed scenario files are bundled; select with ?scenario=<name substring>.
const SCENARIOS = import.meta.glob('../scenarios/*.json', { eager: true, import: 'default' }) as Record<string, Scenario>;

const params = new URLSearchParams(location.search);
const scenarioParam = params.get('scenario');
const scenario = scenarioParam
  ? Object.entries(SCENARIOS).find(([p]) => p.includes(scenarioParam))?.[1]
  : undefined;
if (scenarioParam && !scenario) console.warn(`scenario "${scenarioParam}" not found; using procedural world`);

const seed = scenario ? scenario.seed : Number(params.get('seed')) || 20260725;
const cfg = scenario ? configForScenario(scenario) : defaultConfig(seed);
cfg.tradeEnabled = params.get('trade') !== '0';
if (!scenario) {
  cfg.opportunistCount = params.get('opp') === '0' ? 0 : 1;
  const nc = Number(params.get('cities'));
  if (nc >= 3 && nc <= 6) cfg.numCities = nc;
}

const sim = new Simulation(cfg, scenario);
if (scenario) console.log(`Scenario: ${scenario.name} — ${scenario.premise}`);
const seatRng = new RNG(cfg.seed ^ 0x9e3779b9);
const seats = new Map<string, Seat>(sim.cities.map((c) => [c.id, new ScriptedSeat(c.id, c.personality, seatRng)]));

const scene = new SceneView(document.getElementById('scene')!, sim);

let playing = true;
let speed = 2;
let timer: number | undefined;
let busy = false;

const hud = new Hud(sim, {
  onPlayToggle() {
    playing = !playing;
    hud.setPlaying(playing);
    schedule();
  },
  onStep() {
    if (!playing) void tickOnce();
  },
  onSpeed(v) {
    speed = v;
    schedule();
  },
});

async function tickOnce(): Promise<void> {
  if (busy) return;
  busy = true;
  await sim.step(seats);
  scene.update(sim);
  hud.update(sim);
  if (sim.aliveCities().length === 0 && playing) {
    playing = false;
    hud.setPlaying(false);
    schedule();
  }
  busy = false;
}

function schedule(): void {
  if (timer !== undefined) clearInterval(timer);
  timer = playing ? window.setInterval(() => void tickOnce(), 1000 / speed) : undefined;
}
schedule();
