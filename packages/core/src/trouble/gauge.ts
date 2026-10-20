import type { Context } from '../game/context';
import type { ChaosLevel } from '../game/types';

// Réglages de la jauge (01-vision-et-plateau.md, section 14), à affiner au simulateur.
export const GAUGE_MAX = 100;
export const ROUND_GAIN = 15;
export const DOUBLE_GAIN = 5;
export const GAP_GAIN = 10;
/** Écart (en cases) entre le premier et le dernier à partir duquel la jauge monte plus vite. */
export const GAP_THRESHOLD = 25;

const CHAOS_SPEED: Record<ChaosLevel, number> = { calm: 0.6, normal: 1, trouble: 1.5 };

export function addGauge(ctx: Context, base: number, reason: 'round' | 'double' | 'gap'): void {
  const { trouble } = ctx.state;
  const added = Math.round(base * CHAOS_SPEED[trouble.chaos]);
  trouble.gauge = Math.min(GAUGE_MAX, trouble.gauge + added);
  ctx.events.push({ type: 'troubleGauge', value: trouble.gauge, added, reason });
}
