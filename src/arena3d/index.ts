/**
 * The 3D arena: Rapture Chess's stage and realms behind the Deckwright game client. Bundled on its own
 * (scripts/build-arena3d.mjs → web/arena3d.js) and loaded only after the title screen is up, so it never delays the
 * first screen; web/ui/arena.js falls back to the CSS arena whenever this can't run or can't keep its frame rate.
 */
import { Realm, type RealmId } from './realm';
import { type Mood, Stage, type StageStats } from './stage';

export type { Mood, RealmId, StageStats };

export interface Arena3D {
  setRealm(id: RealmId): Promise<boolean>;
  setMood(mood: Mood): void;
  quake(): void;
  stats(): StageStats;
  dispose(): void;
}

/**
 * Start the stage in `canvas` and load the first realm. Resolves once that arena is on screen, or rejects (WebGL
 * unavailable, model missing) so the caller keeps the CSS arena. `onTooSlow` fires if the device can't keep up.
 */
export async function mountArena3D(canvas: HTMLCanvasElement, opts: { base: string; realm: RealmId; mood: Mood; still: boolean; onTooSlow: () => void }): Promise<Arena3D> {
  performance.mark('arena:start');
  const stage = new Stage(canvas, opts.still);
  performance.mark('arena:stage');
  stage.onTooSlow = opts.onTooSlow;
  const realm = new Realm(stage, opts.base);
  stage.setMood(opts.mood);
  stage.start();
  if (!(await realm.load(opts.realm))) { stage.dispose(); throw new Error(`arena model ${opts.realm} unavailable`); }
  return {
    setRealm: (id) => realm.load(id),
    setMood: (m) => stage.setMood(m),
    quake: () => stage.quake(),
    stats: () => stage.getStats(),
    dispose: () => stage.dispose(),
  };
}
