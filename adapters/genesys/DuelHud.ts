import * as ENGINE from '@gnsx/genesys.js';

import { attack, ENEMY_CHAMPION, enemyUnit, endTurn, ownUnit, play } from '../core/actions';
import type { CardDef, MatchState, PlayerState } from '../core/types';
import type { MatchSession } from './session';

type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
const RARITIES: Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
type Pick = { kind: 'hand'; index: number; card: CardDef } | { kind: 'unit'; slot: number } | null;

// Developer-authored layout CSS; no game or network strings are ever placed in it.
const CSS = `
.tcg-duel{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:space-between;padding:12px;gap:8px;pointer-events:none;font-family:system-ui,sans-serif}
.tcg-row{display:flex;gap:8px;justify-content:center;align-items:flex-end;flex-wrap:wrap;min-height:40px;pointer-events:auto}
.tcg-row>*{cursor:pointer}
.tcg-selected{outline:3px solid #ffd54a;outline-offset:2px;border-radius:10px}
.tcg-status{color:#e8ecf8;text-align:center;font-size:14px;text-shadow:0 1px 2px #000;pointer-events:none}
`;

/**
 * Screen-space duel board built from Game UI Kit widgets: StatCard for each champion, ItemCard
 * for units, relics and hand cards, Button for turn controls, CenterMessage for the result.
 * Click a hand card to play it (damage and buff spells then ask for a target); click one of your
 * units, then an enemy unit or the enemy champion, to attack.
 */
export class DuelHud {
  private readonly root: HTMLDivElement;
  private readonly rows: Record<'enemy' | 'enemyRelics' | 'enemyBoard' | 'status' | 'myBoard' | 'myRelics' | 'me' | 'hand' | 'controls', HTMLDivElement>;
  private widgets: ENGINE.BaseUIComponent<any>[] = [];
  private banner: ENGINE.CenterMessage | null = null;
  private pick: Pick = null;
  private renderId = 0;

  constructor(private readonly world: ENGINE.World, private readonly session: MatchSession) {
    this.root = document.createElement('div');
    this.root.className = 'tcg-duel';
    const style = document.createElement('style');
    style.textContent = CSS;
    this.root.appendChild(style);
    const row = (cls = 'tcg-row'): HTMLDivElement => { const d = document.createElement('div'); d.className = cls; this.root.appendChild(d); return d; };
    this.rows = { enemy: row(), enemyRelics: row(), enemyBoard: row(), status: row('tcg-status'), myBoard: row(), myRelics: row(), me: row(), hand: row(), controls: row() };
    world.gameContainer?.appendChild(this.root);
    session.onChange(() => void this.render());
    void this.render();
  }

  public destroy(): void {
    this.clear();
    this.banner?.destroy();
    this.root.remove();
    this.session.close();
  }

  private clear(): void {
    for (const w of this.widgets) w.destroy();
    this.widgets = [];
  }

  private async mount<T extends ENGINE.BaseUIComponent<any>>(w: T, into: HTMLElement, onClick?: () => void, selected = false): Promise<T> {
    const id = this.renderId;
    await w.initialize();
    // A newer render cleared the board while this widget loaded.
    if (id !== this.renderId) { w.destroy(); return w; }
    const el = w.getElement();
    if (el) {
      el.appendTo(into);
      if (onClick) el.on('click', () => onClick());
      if (selected) el.addClass('tcg-selected');
    }
    this.widgets.push(w);
    return w;
  }

  private card(c: number): CardDef { return this.session.rules.game.cards[c]; }
  private rarity(def: CardDef): Rarity { return RARITIES.includes(def.rarity as Rarity) ? (def.rarity as Rarity) : 'common'; }

  private act(x: number): void {
    this.pick = null;
    this.session.act(x);
  }

  private async render(): Promise<void> {
    const id = ++this.renderId;
    const s = this.session.state;
    this.clear();
    this.rows.status.textContent = this.session.status;
    if (!s) return;
    const meIdx = s.p[0].id === this.session.you ? 0 : 1;
    const me = s.p[meIdx], foe = s.p[meIdx === 0 ? 1 : 0];
    const myTurn = !s.over && s.turn === meIdx;
    this.rows.status.textContent = `${this.session.status} · turn ${s.turnNo} · ${s.over ? 'over' : myTurn ? 'your turn' : 'opponent’s turn'}${this.pick?.kind === 'hand' ? ` · choose a target for ${this.pick.card.name}` : ''}`;
    const ui = this.world.uiManager;
    const jobs: Array<Promise<unknown>> = [];
    const champ = (p: PlayerState, label: string, into: HTMLElement, onClick?: () => void): void => {
      jobs.push(this.mount(new ENGINE.StatCard(ui, { position: 'none', visible: true, label, value: p.life, subtitle: `energy ${p.energy}/${p.energyCap} · deck ${p.deck.length} · hand ${p.hand.length}` }), into, onClick));
    };
    const unitRow = (p: PlayerState, into: HTMLElement, onClick: (slot: number) => void, selectedSlot: number): void => {
      p.board.forEach((u, slot) => {
        const def = this.card(u.c);
        const tags = `${u.guard ? ' [guard]' : ''}${u.ready ? '' : ' [tired]'}`;
        jobs.push(this.mount(new ENGINE.ItemCard(ui, { position: 'none', visible: true, itemName: `${def.name}${tags}`, rarity: this.rarity(def), price: `${u.atk}/${u.hp}` }), into, () => onClick(slot), slot === selectedSlot));
      });
    };
    const relicRow = (p: PlayerState, into: HTMLElement): void => {
      for (const r of p.relics) { const def = this.card(r); jobs.push(this.mount(new ENGINE.ItemCard(ui, { position: 'none', visible: true, itemName: def.name, rarity: this.rarity(def) }), into)); }
    };

    champ(foe, 'Opponent', this.rows.enemy, () => this.target(ENEMY_CHAMPION));
    relicRow(foe, this.rows.enemyRelics);
    unitRow(foe, this.rows.enemyBoard, (slot) => this.target(enemyUnit(slot)), -1);
    unitRow(me, this.rows.myBoard, (slot) => this.ownUnit(s, slot), this.pick?.kind === 'unit' ? this.pick.slot : -1);
    relicRow(me, this.rows.myRelics);
    champ(me, 'You', this.rows.me);
    me.hand.forEach((c, index) => {
      const def = this.card(c);
      const detail = def.type === 'unit' ? ` ${def.attack}/${def.health}` : def.effect ? ` ${def.effect.op}` : '';
      jobs.push(this.mount(new ENGINE.ItemCard(ui, { position: 'none', visible: true, itemName: `${def.name}${detail}`, rarity: this.rarity(def), price: `${def.cost} energy` }), this.rows.hand, () => this.handCard(s, index), this.pick?.kind === 'hand' && this.pick.index === index));
    });
    jobs.push(this.mount(new ENGINE.Button(ui, { position: 'none', visible: true, label: 'End turn', variant: 'primary', disabled: !myTurn, onClick: () => this.act(endTurn()) }), this.rows.controls));
    jobs.push(this.mount(new ENGINE.Button(ui, { position: 'none', visible: true, label: 'Concede', variant: 'danger', size: 'small', disabled: s.over, onClick: () => this.session.concede() }), this.rows.controls));
    await Promise.all(jobs);
    if (id !== this.renderId) return; // a newer render replaced this one
    if (s.over) await this.showResult(s, meIdx);
  }

  private handCard(s: MatchState, index: number): void {
    const def = this.card(s.p[s.turn].hand[index] ?? -1);
    if (!def || s.p[s.turn].id !== this.session.you) return;
    const op = def.type === 'spell' ? def.effect?.op : null;
    if (op === 'damage' || op === 'buff') { this.pick = { kind: 'hand', index, card: def }; void this.render(); return; }
    this.act(play(index));
  }

  private ownUnit(s: MatchState, slot: number): void {
    if (this.pick?.kind === 'hand' && this.pick.card.effect?.op === 'buff') { this.act(play(this.pick.index, ownUnit(slot))); return; }
    this.pick = s.p[s.turn].id === this.session.you ? { kind: 'unit', slot } : null;
    void this.render();
  }

  private target(t: number): void {
    const p = this.pick;
    if (p?.kind === 'unit') this.act(attack(p.slot, t));
    else if (p?.kind === 'hand' && p.card.effect?.op === 'damage') this.act(play(p.index, t));
  }

  private async showResult(s: MatchState, meIdx: number): Promise<void> {
    if (!this.banner) {
      this.banner = new ENGINE.CenterMessage(this.world.uiManager, {});
      await this.banner.initialize();
    }
    const title = s.winner === 2 ? 'Draw' : s.winner === meIdx ? 'Victory' : 'Defeat';
    this.banner.updateData({ title, subtitle: this.session.status });
    this.banner.show();
  }
}
