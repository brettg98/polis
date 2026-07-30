// Scenario files: a world authored once (by Fable, per ADR-001) and committed
// to scenarios/*.json. Terrain still comes from the seed deterministically;
// the scenario fixes city sites, production assignments, names, lore, and the
// economy's slack. Loading a scenario is pure — no model calls at run time.
import { defaultConfig, type SimConfig } from './config';
import { Terrain, heightAt } from './terrain';
import { City, RESOURCES, Resource } from './types';
import { CITY_COLORS } from './cities';

export interface ScenarioCity {
  name: string;
  site: { x: number; y: number };
  produces: [Resource, Resource];
  lore: string;
}

// A scheduled production modifier (ADR-003). target is a city NAME or 'all'
// in the scenario file; the loader resolves names to city ids.
export interface ScenarioShock {
  name: string;
  description: string;
  target: string; // city name or 'all'
  resource: Resource | 'all';
  startTick: number;
  duration: number;
  multiplier: number;
  visibility: 'forecast' | 'surprise';
  forecastLead?: number; // forecast only: public announcement this many ticks before onset
  privateWarning?: number; // city-targeted only: target learns this many ticks before onset
}

export interface Scenario {
  name: string;
  premise: string;
  seed: number;
  gridSize: number;
  productionPerCapita: number;
  cities: ScenarioCity[];
  shocks?: ScenarioShock[];
  designNotes?: string;
  generator?: { model: string; date: string };
}

// Engine-resolved shock: target as city id, announce/end ticks precomputed.
export interface EngineShock {
  name: string;
  description: string;
  targetId: string | 'all';
  resource: Resource | 'all';
  startTick: number;
  endTick: number; // exclusive
  duration: number;
  multiplier: number;
  visibility: 'forecast' | 'surprise';
  announceTick: number; // when the public learns
  privateWarning?: number;
}

export function engineShocks(s: Scenario, cities: City[]): EngineShock[] {
  return (s.shocks ?? []).map((sh) => {
    const targetId =
      sh.target === 'all' ? 'all' : (cities.find((c) => c.name.trim().toLowerCase() === sh.target.trim().toLowerCase())?.id ?? 'all');
    return {
      name: sh.name,
      description: sh.description,
      targetId,
      resource: sh.resource,
      startTick: sh.startTick,
      endTick: sh.startTick + sh.duration,
      duration: sh.duration,
      multiplier: sh.multiplier,
      visibility: sh.visibility,
      announceTick: sh.visibility === 'forecast' ? sh.startTick - (sh.forecastLead ?? 3) : sh.startTick,
      privateWarning: sh.privateWarning,
    };
  });
}

const MARGIN = 6;

export function isBuildable(terrain: Terrain, x: number, y: number): boolean {
  if (x < MARGIN || y < MARGIN || x >= terrain.size - MARGIN || y >= terrain.size - MARGIN) return false;
  const h = heightAt(terrain, x, y);
  return h >= terrain.seaLevel + 0.02 && h <= 0.72;
}

// Nearest buildable cell (ring search) — used by the generator to repair
// near-miss coordinates before validation.
export function snapToBuildableLand(
  terrain: Terrain,
  x0: number,
  y0: number,
  maxRadius = 10,
): { x: number; y: number } | null {
  if (isBuildable(terrain, x0, y0)) return { x: x0, y: y0 };
  for (let r = 1; r <= maxRadius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (isBuildable(terrain, x0 + dx, y0 + dy)) return { x: x0 + dx, y: y0 + dy };
      }
    }
  }
  return null;
}

export function scenarioProblems(s: Scenario, terrain: Terrain): string[] {
  const p: string[] = [];
  if (s.cities.length < 3 || s.cities.length > 6) p.push(`need 3-6 cities, got ${s.cities.length}`);
  const names = new Set(s.cities.map((c) => c.name.trim().toLowerCase()));
  if (names.size !== s.cities.length) p.push('city names must be unique');
  if (!(s.productionPerCapita >= 0.15 && s.productionPerCapita <= 0.35)) {
    p.push(`productionPerCapita ${s.productionPerCapita} outside [0.15, 0.35]`);
  }
  for (const r of RESOURCES) {
    if (!s.cities.some((c) => c.produces.includes(r))) p.push(`no city produces ${r}`);
  }
  s.cities.forEach((c, i) => {
    if (c.produces[0] === c.produces[1]) p.push(`${c.name}: produces must be two different resources`);
    if (!isBuildable(terrain, c.site.x, c.site.y)) {
      p.push(`${c.name}: site (${c.site.x},${c.site.y}) is not buildable land (margin ${MARGIN}, grid ${terrain.size})`);
    }
    for (let j = i + 1; j < s.cities.length; j++) {
      const o = s.cities[j];
      const d = Math.hypot(c.site.x - o.site.x, c.site.y - o.site.y);
      if (d < terrain.size * 0.12) {
        p.push(`${c.name} and ${o.name} too close (${Math.round(d)} cells, min ${Math.round(terrain.size * 0.12)})`);
      }
    }
  });
  p.push(...shockProblems(s));
  return p;
}

// ADR-003 rails. The survivability principle is enforced separately by the
// genmap sanity sim; these are the static checks.
function shockProblems(s: Scenario): string[] {
  const shocks = s.shocks ?? [];
  const p: string[] = [];
  if (!shocks.length) return p;
  if (shocks.length > 6) p.push(`at most 6 shocks (got ${shocks.length})`);
  if (new Set(shocks.map((x) => x.name.trim().toLowerCase())).size !== shocks.length) p.push('shock names must be unique');
  const cityNames = new Set(s.cities.map((c) => c.name.trim().toLowerCase()));
  const intersects = (a: string, b: string) => a === 'all' || b === 'all' || a === b;
  shocks.forEach((sh) => {
    const id = `shock "${sh.name}"`;
    if (sh.target !== 'all' && !cityNames.has(sh.target.trim().toLowerCase())) p.push(`${id}: unknown target "${sh.target}"`);
    if (sh.resource !== 'all' && !RESOURCES.includes(sh.resource)) p.push(`${id}: bad resource`);
    if (!(sh.multiplier >= 0.25 && sh.multiplier <= 1.75)) p.push(`${id}: multiplier ${sh.multiplier} outside [0.25, 1.75]`);
    if (!Number.isInteger(sh.duration) || sh.duration < 3 || sh.duration > 15) p.push(`${id}: duration must be an integer in [3, 15]`);
    if (!Number.isInteger(sh.startTick) || sh.startTick < 15) p.push(`${id}: startTick must be an integer >= 15`);
    if (sh.visibility === 'forecast') {
      if (!Number.isInteger(sh.forecastLead) || sh.forecastLead! < 3 || sh.forecastLead! > 8) {
        p.push(`${id}: forecast shocks need forecastLead in [3, 8]`);
      }
    } else if (sh.forecastLead) {
      p.push(`${id}: surprise shocks take no forecastLead`);
    }
    if (sh.privateWarning !== undefined) {
      if (sh.target === 'all') p.push(`${id}: privateWarning requires a city target`);
      const min = sh.visibility === 'forecast' ? (sh.forecastLead ?? 3) + 2 : 3;
      if (!Number.isInteger(sh.privateWarning) || sh.privateWarning < min || sh.privateWarning > 12) {
        p.push(`${id}: privateWarning must be an integer in [${min}, 12]`);
      }
    }
  });
  for (let i = 0; i < shocks.length; i++) {
    for (let j = i + 1; j < shocks.length; j++) {
      const a = shocks[i], b = shocks[j];
      const overlap = a.startTick < b.startTick + b.duration && b.startTick < a.startTick + a.duration;
      if (overlap && intersects(a.target, b.target) && intersects(a.resource, b.resource)) {
        p.push(`shocks "${a.name}" and "${b.name}" overlap on the same city+resource`);
      }
    }
  }
  for (const sh of shocks) {
    const active = shocks.filter((x) => x.startTick < sh.startTick + sh.duration && sh.startTick < x.startTick + x.duration);
    if (active.length > 2) {
      p.push(`more than 2 shocks active around t${sh.startTick}`);
      break;
    }
  }
  return p;
}

export function configForScenario(s: Scenario, base?: SimConfig): SimConfig {
  const cfg = base ?? defaultConfig(s.seed);
  return {
    ...cfg,
    seed: s.seed,
    gridSize: s.gridSize,
    numCities: s.cities.length,
    city: { ...cfg.city, productionPerCapita: s.productionPerCapita },
  };
}

export function citiesFromScenario(s: Scenario, cfg: SimConfig, terrain: Terrain): City[] {
  const problems = scenarioProblems(s, terrain);
  if (problems.length) throw new Error(`invalid scenario "${s.name}": ${problems.join('; ')}`);
  const cc = cfg.city;
  const startStock = cc.startStockpileTicks * cc.consumptionPerCapita * cc.startPopulation;
  return s.cities.map((c, i) => ({
    id: `c${i + 1}`,
    name: c.name,
    color: CITY_COLORS[i % CITY_COLORS.length],
    site: { ...c.site },
    produces: [...c.produces] as [Resource, Resource],
    personality: 'honest',
    population: cc.startPopulation,
    startPopulation: cc.startPopulation,
    stockpiles: { food: startStock, energy: startStock, materials: startStock },
    unrest: 0,
    status: 'alive',
    buildProgress: 0,
    ceilingBonus: 0,
  }));
}
