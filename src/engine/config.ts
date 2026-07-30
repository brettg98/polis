export interface SimConfig {
  seed: number;
  gridSize: number;
  numCities: number;
  opportunistCount: number;
  tradeEnabled: boolean;
  city: {
    startPopulation: number;
    consumptionPerCapita: number; // per resource per tick
    productionPerCapita: number; // per produced resource per tick
    startStockpileTicks: number; // starting storage, in ticks of consumption
    stockpileCapTicks: number;
    starvationDecline: number; // max population loss fraction per tick when fully starved
    growthRate: number;
    maxGrowthFactor: number;
    collapseFraction: number; // dead below this fraction of starting population
    unrestRise: number;
    unrestFall: number;
  };
  trade: {
    offerTTL: number;
    maxOffersPerTick: number;
    transportLossPerCell: number; // efficiency = max(floor, 1 - loss * distance)
    transportEfficiencyFloor: number;
  };
  // Materials-funded growth (ADR-004). Spending resolves AFTER deliveries move,
  // so obligations are paid before a city funds its own ceiling.
  build: {
    firstStepCost: number; // materials for the first ceiling step
    stepCostIncrement: number; // each step costs this much more than the last
    ceilingPerStep: number; // ceiling added per completed step
  };
}

// Collapse buffer target: ~15 ticks from full stockpile to ruins for a city
// missing one resource with no trade. 8 ticks of storage + ~7 ticks of
// starvation decline (0.87^n < 0.35 → n ≈ 7.5).
export function defaultConfig(seed = 20260725): SimConfig {
  return {
    seed,
    gridSize: 96,
    numCities: 4,
    opportunistCount: 1,
    tradeEnabled: true,
    city: {
      startPopulation: 100,
      consumptionPerCapita: 0.1,
      productionPerCapita: 0.22,
      startStockpileTicks: 8,
      stockpileCapTicks: 20,
      starvationDecline: 0.13,
      growthRate: 0.01,
      maxGrowthFactor: 1.5,
      collapseFraction: 0.35,
      unrestRise: 0.12,
      unrestFall: 0.04,
    },
    trade: { offerTTL: 4, maxOffersPerTick: 4, transportLossPerCell: 0.0025, transportEfficiencyFloor: 0.6 },
    build: { firstStepCost: 50, stepCostIncrement: 25, ceilingPerStep: 25 },
  };
}
