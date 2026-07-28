import { createNoise2D } from 'simplex-noise';
import type { RNG } from './rng';

export interface Terrain {
  size: number;
  heights: Float32Array; // size*size, normalized 0..1
  seaLevel: number;
}

export function generateTerrain(rng: RNG, size: number): Terrain {
  const noise = createNoise2D(() => rng.next());
  const heights = new Float32Array(size * size);
  let lo = Infinity;
  let hi = -Infinity;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = x / size - 0.5;
      const ny = y / size - 0.5;
      let v = 0;
      let amp = 1;
      let freq = 2.6;
      let norm = 0;
      for (let o = 0; o < 4; o++) {
        v += amp * noise(nx * freq, ny * freq);
        norm += amp;
        amp *= 0.5;
        freq *= 2.1;
      }
      v = (v / norm + 1) / 2;
      // island falloff so the map edges tend toward sea
      const d = Math.sqrt(nx * nx + ny * ny) * 2;
      v -= Math.pow(d, 2.6) * 0.55;
      heights[y * size + x] = v;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  for (let i = 0; i < heights.length; i++) heights[i] = (heights[i] - lo) / (hi - lo);
  return { size, heights, seaLevel: 0.34 };
}

export const heightAt = (t: Terrain, x: number, y: number): number => t.heights[y * t.size + x];

export interface SiteFeatures {
  water: number;
  mountain: number;
  flat: number;
}

// Terrain features near a site decide which two resources a city produces:
// water access → food, nearby peaks → materials, open flat land → energy.
export function featuresAt(t: Terrain, cx: number, cy: number): SiteFeatures {
  const R = 5;
  let total = 0;
  let waterCells = 0;
  let peak = 0;
  let sum = 0;
  let sumSq = 0;
  let landCount = 0;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= t.size || y >= t.size) continue;
      const h = heightAt(t, x, y);
      total++;
      if (h > peak) peak = h;
      if (h < t.seaLevel) waterCells++;
      else {
        sum += h;
        sumSq += h * h;
        landCount++;
      }
    }
  }
  const water = Math.min(1, (waterCells / Math.max(1, total)) * 2.2);
  const mountain = Math.max(0, Math.min(1, (peak - 0.68) / 0.32));
  let flat = 0;
  if (landCount > 3) {
    const mean = sum / landCount;
    const variance = Math.max(0, sumSq / landCount - mean * mean);
    flat = Math.max(0, Math.min(1, 1 - Math.sqrt(variance) * 10));
  }
  return { water, mountain, flat };
}
