// Mechanical-defection annotation (viewer-build-time only, ADR-002): a seat
// "passes" a tick when its last API attempt for that tick errored with no
// subsequent success entry, or its budget was exhausted. It then delivers
// nothing, so the engine records defections the model never chose. Scan the
// raw call logs (rotN-cM-*.jsonl) for failed ticks per (rotation, seat);
// logs absent → annotation silently unavailable. Shared by the chronicle
// and highlights generators; never written back to chronicle-rotN.json.
import fs from 'node:fs';
import path from 'node:path';
import type { Chronicle } from './types';

export interface SeatFailures {
  failed: Set<number>;
  exhaustedFrom?: number; // budget gone: every tick from here on is a pass
}

export function scanFailures(runDir: string): Map<number, Map<string, SeatFailures>> {
  const byRotation = new Map<number, Map<string, SeatFailures>>();
  for (const f of fs.readdirSync(runDir)) {
    const m = /^rot(\d+)-(c\d+)-.*\.jsonl$/.exec(f);
    if (!m) continue;
    const errored = new Set<number>();
    const succeeded = new Set<number>();
    let exhaustedFrom: number | undefined;
    for (const line of fs.readFileSync(path.join(runDir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let e: { tick?: number; error?: string; action?: unknown; event?: string };
      try {
        e = JSON.parse(line);
      } catch {
        continue; // partial line (a log may still be live)
      }
      if (typeof e.tick !== 'number') continue;
      if (e.event === 'budget_exhausted' && (exhaustedFrom === undefined || e.tick < exhaustedFrom)) exhaustedFrom = e.tick;
      if (e.error !== undefined) errored.add(e.tick);
      if (e.action !== undefined) succeeded.add(e.tick);
    }
    const failed = new Set([...errored].filter((t) => !succeeded.has(t)));
    if (!failed.size && exhaustedFrom === undefined) continue;
    const rotation = Number(m[1]);
    let seats = byRotation.get(rotation);
    if (!seats) byRotation.set(rotation, (seats = new Map()));
    seats.set(m[2], { failed, exhaustedFrom });
  }
  return byRotation;
}

export function annotateMechanicalDefections(chronicles: Chronicle[], runDir: string): void {
  const failures = scanFailures(runDir);
  for (const ch of chronicles) {
    const seats = failures.get(ch.rotation);
    if (!seats) continue;
    for (const ev of ch.events) {
      if (ev.kind !== 'defection' || !ev.actor) continue;
      const sf = seats.get(ev.actor);
      if (!sf) continue;
      // A pass at tick t surfaces as shortfalls at t..t+2, so look back 2.
      for (let t = ev.tick - 2; t <= ev.tick; t++) {
        if (sf.failed.has(t) || (sf.exhaustedFrom !== undefined && t >= sf.exhaustedFrom)) {
          ev.mechanical = true;
          break;
        }
      }
    }
  }
}
