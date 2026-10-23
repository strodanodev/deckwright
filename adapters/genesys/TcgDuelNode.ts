import * as ENGINE from '@gnsx/genesys.js';

import { compileGame } from '../core/game';
import { createRules } from '../core/rules';
import type { GameConfig } from '../core/types';
import { DuelHud } from './DuelHud';
import { type Champion, sessionFromUrl } from './session';

/**
 * Drop-in duel for any Genesys scene: spawn it from a GameMode with the game config, and it picks
 * a session from the page URL (placed LitNode match, dev relay, or practice vs bot) and mounts the HUD.
 *
 *   world.add(TcgDuelNode.create({ name: 'Duel' }).configure(forgeDuel));
 */
@ENGINE.GameClass()
export class TcgDuelNode extends ENGINE.SceneNode {
  private config: GameConfig | null = null;
  private champion: Champion | undefined;
  private hud: DuelHud | null = null;

  /** The game to play, and optionally the ERC-6699 champion the local player brings. */
  public configure(config: GameConfig, champion?: Champion): this {
    this.config = config;
    this.champion = champion;
    return this;
  }

  public override beginPlay(): boolean {
    if (!super.beginPlay()) return false;
    const world = this.getWorld();
    if (world && this.config) void this.start(world, this.config);
    return true;
  }

  private async start(world: ENGINE.World, config: GameConfig): Promise<void> {
    const rules = createRules(compileGame(config));
    try {
      const session = await sessionFromUrl(rules, this.champion);
      if (!this.isPlaying()) { session.close(); return; }
      this.hud = new DuelHud(world, session);
    } catch (e) {
      console.error('[tcg] could not start the duel', e);
    }
  }

  public override endPlay(): boolean {
    if (!super.endPlay()) return false;
    this.hud?.destroy();
    this.hud = null;
    return true;
  }
}
