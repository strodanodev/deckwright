/**
 * Player actions as one integer per log entry.
 *
 * LitNode records `{ k, inputs: [side0, side1] }` per entry and coerces every frame with `| 0`,
 * so an action must be a 32-bit integer. The acting player's frame carries the action; the
 * other side sends 0. Any integer is safe to replay: an illegal action is a no-op.
 *
 *   bits 0-2  op      0 none, 1 play, 2 attack, 3 end turn, 4 concede (honoured on either side's frame),
 *                     5 declare (deck phase, either side)
 *   bits 3-6  a       hand index (play) or attacker board slot (attack)
 *   bits 7-10 target  0 enemy champion, 1-9 enemy unit (slot+1), 10 own champion, 11-15 own unit (slot+11)
 *   bits 3-17 card    declare: index into the game's card list
 */

export const Op = { None: 0, Play: 1, Attack: 2, End: 3, Concede: 4, Declare: 5 } as const;
export type OpCode = typeof Op[keyof typeof Op];

export const ENEMY_CHAMPION = 0;
export const OWN_CHAMPION = 10;
export const enemyUnit = (slot: number): number => 1 + slot;
export const ownUnit = (slot: number): number => 11 + slot;

export interface Action {
  op: number;
  a: number;
  target: number;
}

export const encode = (op: number, a = 0, target = 0): number => (op & 7) | ((a & 15) << 3) | ((target & 15) << 7);

export const decode = (x: number): Action => ({ op: x & 7, a: (x >>> 3) & 15, target: (x >>> 7) & 15 });

export const play = (handIndex: number, target = ENEMY_CHAMPION): number => encode(Op.Play, handIndex, target);
export const attack = (slot: number, target = ENEMY_CHAMPION): number => encode(Op.Attack, slot, target);
export const endTurn = (): number => encode(Op.End);
export const concede = (): number => encode(Op.Concede);
/** Put one card (index into the game's card list) into your declared deck. */
export const declare = (card: number): number => Op.Declare | ((card & 0x7fff) << 3);
export const declaredCard = (x: number): number => (x >>> 3) & 0x7fff;

export type TargetRef =
  | { side: 'enemy'; kind: 'champion' }
  | { side: 'enemy'; kind: 'unit'; slot: number }
  | { side: 'own'; kind: 'champion' }
  | { side: 'own'; kind: 'unit'; slot: number };

export function targetOf(t: number): TargetRef {
  if (t === ENEMY_CHAMPION) return { side: 'enemy', kind: 'champion' };
  if (t < OWN_CHAMPION) return { side: 'enemy', kind: 'unit', slot: t - 1 };
  if (t === OWN_CHAMPION) return { side: 'own', kind: 'champion' };
  return { side: 'own', kind: 'unit', slot: t - 11 };
}
