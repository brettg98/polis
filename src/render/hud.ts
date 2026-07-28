import type { Simulation } from '../engine/sim';
import { RESOURCES } from '../engine/types';

export interface HudHandlers {
  onPlayToggle(): void;
  onStep(): void;
  onSpeed(v: number): void;
}

const RES_COLORS: Record<string, string> = { food: '#7fc97f', energy: '#f2c14e', materials: '#9fb3c8' };

// City names and event text originate in scenario files, which are LLM-authored
// (`npm run genmap`) and meant to be shared between people running the sim. A
// scenario is untrusted input, so nothing derived from one reaches innerHTML raw.
const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

// A CSS value can't be made safe by HTML-escaping: a hostile one breaks out of
// the declaration rather than the attribute. Colors are palette-assigned today,
// but the type is a bare string, so allow only what a color can legitimately be.
function cssColor(s: unknown): string {
  const v = String(s);
  return /^#[0-9a-fA-F]{3,8}$|^[a-zA-Z]{3,20}$/.test(v) ? v : '#8899aa';
}

export class Hud {
  private cardsEl: HTMLElement;
  private tickEl: HTMLElement;
  private logEl: HTMLElement;
  private playBtn: HTMLButtonElement;

  constructor(sim: Simulation, handlers: HudHandlers) {
    const hud = document.getElementById('hud')!;
    hud.innerHTML = `
      <div class="panel-head">
        <div class="title">POLIS</div>
        <div class="tick" id="tick"></div>
      </div>
      <div class="controls">
        <button id="play" title="play/pause">⏸</button>
        <button id="stepbtn" title="advance one tick">step</button>
        <select id="speed" title="ticks per second">
          <option value="1">1×</option>
          <option value="2" selected>2×</option>
          <option value="4">4×</option>
          <option value="8">8×</option>
        </select>
      </div>
      <div class="controls world-controls">
        <input id="seed" type="text" size="9" value="${esc(sim.config.seed)}" title="world seed" />
        <label title="disable to watch autarky collapse"><input id="trade" type="checkbox" ${sim.config.tradeEnabled ? 'checked' : ''}/>trade</label>
        <label title="one city defects on deals"><input id="opp" type="checkbox" ${sim.config.opportunistCount > 0 ? 'checked' : ''}/>opportunist</label>
        <button id="regen">rebuild</button>
        <button id="rand" title="random seed">🎲</button>
      </div>
      <div id="cards"></div>`;
    this.cardsEl = hud.querySelector('#cards')!;
    this.tickEl = hud.querySelector('#tick')!;
    this.playBtn = hud.querySelector<HTMLButtonElement>('#play')!;
    this.logEl = document.getElementById('log')!;

    this.playBtn.addEventListener('click', handlers.onPlayToggle);
    hud.querySelector('#stepbtn')!.addEventListener('click', handlers.onStep);
    hud.querySelector<HTMLSelectElement>('#speed')!.addEventListener('change', (e) => {
      handlers.onSpeed(Number((e.target as HTMLSelectElement).value));
    });
    const regen = (newSeed: boolean): void => {
      const seedInput = hud.querySelector<HTMLInputElement>('#seed')!.value.trim();
      const seed = newSeed ? String(Math.floor(Math.random() * 1e9)) : seedInput || String(sim.config.seed);
      const trade = hud.querySelector<HTMLInputElement>('#trade')!.checked ? '1' : '0';
      const opp = hud.querySelector<HTMLInputElement>('#opp')!.checked ? '1' : '0';
      location.href = `${location.pathname}?seed=${encodeURIComponent(seed)}&trade=${trade}&opp=${opp}`;
    };
    hud.querySelector('#regen')!.addEventListener('click', () => regen(false));
    hud.querySelector('#rand')!.addEventListener('click', () => regen(true));
    this.update(sim);
  }

  setPlaying(playing: boolean): void {
    this.playBtn.textContent = playing ? '⏸' : '▶';
  }

  update(sim: Simulation): void {
    this.tickEl.textContent = `tick ${sim.tick} · ${sim.aliveCities().length}/${sim.cities.length} alive`;
    this.cardsEl.innerHTML = sim.cities
      .map((c) => {
        const cap = sim.stockpileCap(c);
        const rel = sim.reliabilityOf(c.id);
        const relPct = rel.promised > 0 ? Math.round((rel.delivered / rel.promised) * 100) : null;
        const dead = c.status === 'ruins';
        return `
        <div class="card ${dead ? 'dead' : ''}" style="--c:${cssColor(c.color)}">
          <div class="card-head">
            <span class="dot ${esc(c.status)}"></span>
            <b>${esc(c.name)}</b>
            <span class="badges">${c.produces.map((r) => `<i style="background:${RES_COLORS[r]}" title="produces ${r}">${r[0].toUpperCase()}</i>`).join('')}</span>
            ${c.personality === 'opportunist' ? '<span class="tag">opportunist</span>' : ''}
            ${relPct !== null ? `<span class="rel" title="delivered / promised">${relPct}%</span>` : ''}
          </div>
          <div class="pop">pop ${Math.round(c.population)}${dead ? ` · collapsed t${c.collapsedTick}` : ''}</div>
          ${RESOURCES.map(
            (r) => `
            <div class="res">
              <span class="rname">${r}</span>
              <span class="bar"><i style="width:${Math.min(100, (c.stockpiles[r] / cap) * 100)}%;background:${RES_COLORS[r]}"></i></span>
              <span class="rval">${Math.round(c.stockpiles[r])}</span>
            </div>`,
          ).join('')}
        </div>`;
      })
      .join('');

    const recent = sim.events.slice(-30);
    this.logEl.innerHTML =
      `<div class="log-head">event log</div>` +
      recent.map((e) => `<div class="ev ev-${esc(e.kind)}"><span class="t">t${e.tick}</span>${esc(e.text)}</div>`).join('');
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }
}
