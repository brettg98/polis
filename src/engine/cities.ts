import type { RNG } from './rng';
import { Terrain, featuresAt, heightAt } from './terrain';
import { City, RESOURCES, Resource } from './types';
import type { SimConfig } from './config';

const NAMES = ['Ashford', 'Brinemoor', 'Caldera', 'Dunmark', 'Eastvale', 'Fenwick', 'Greywater', 'Holt'];
export const CITY_COLORS = ['#e8b04b', '#5aa9e6', '#e77fb3', '#7fc97f', '#c2b3ff', '#ff9070'];
const COLORS = CITY_COLORS;

export function placeCities(rng: RNG, terrain: Terrain, cfg: SimConfig): City[] {
  const { size, seaLevel } = terrain;
  const margin = 6;
  const candidates: { x: number; y: number }[] = [];
  for (let y = margin; y < size - margin; y++) {
    for (let x = margin; x < size - margin; x++) {
      const h = heightAt(terrain, x, y);
      if (h >= seaLevel + 0.02 && h <= 0.7) candidates.push({ x, y });
    }
  }
  const shuffled = rng.shuffle(candidates);
  const sites: { x: number; y: number }[] = [];
  let minDist = size * 0.26;
  while (sites.length < cfg.numCities && minDist > 2) {
    for (const c of shuffled) {
      if (sites.length >= cfg.numCities) break;
      if (sites.every((s) => Math.hypot(s.x - c.x, s.y - c.y) >= minDist)) sites.push(c);
    }
    minDist *= 0.8;
  }

  const names = rng.shuffle(NAMES);
  const cc = cfg.city;
  const startStock = cc.startStockpileTicks * cc.consumptionPerCapita * cc.startPopulation;
  const cities: City[] = sites.map((site, i) => {
    const f = featuresAt(terrain, site.x, site.y);
    const scores: Record<Resource, number> = {
      food: 0.25 + f.water * 1.1 + rng.range(0, 0.15),
      materials: 0.12 + f.mountain * 1.2 + rng.range(0, 0.15),
      energy: 0.2 + f.flat * 0.9 + rng.range(0, 0.15),
    };
    const produces = (Object.keys(scores) as Resource[])
      .sort((a, b) => scores[b] - scores[a])
      .slice(0, 2) as [Resource, Resource];
    return {
      id: `c${i + 1}`,
      name: names[i % names.length],
      color: COLORS[i % COLORS.length],
      site,
      produces,
      personality: 'honest',
      population: cc.startPopulation,
      startPopulation: cc.startPopulation,
      stockpiles: { food: startStock, energy: startStock, materials: startStock },
      unrest: 0,
      status: 'alive',
      buildProgress: 0,
      ceilingBonus: 0,
    };
  });

  // Coverage repair: every resource needs at least one producer, and no
  // resource should be nearly monopolized while another starves for makers.
  // Terrain proposes, economic viability disposes.
  let guard = 0;
  while (guard++ < 10) {
    const counts = RESOURCES.map((r) => ({ r, n: cities.filter((c) => c.produces.includes(r)).length }));
    counts.sort((a, b) => a.n - b.n);
    const min = counts[0];
    const max = counts[counts.length - 1];
    if (min.n >= 1 && !(min.n <= 1 && max.n >= 3)) break;
    const donor = cities.find((c) => c.produces.includes(max.r) && !c.produces.includes(min.r));
    if (!donor) break;
    const keep = donor.produces[0] === max.r ? donor.produces[1] : donor.produces[0];
    donor.produces = [keep, min.r];
  }

  for (let k = 0; k < Math.min(cfg.opportunistCount, cities.length - 1); k++) {
    const honest = cities.filter((c) => c.personality === 'honest');
    rng.pick(honest).personality = 'opportunist';
  }
  return cities;
}
