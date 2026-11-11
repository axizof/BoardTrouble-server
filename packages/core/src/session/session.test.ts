import { describe, expect, test } from 'bun:test';
import { prepareBoard } from '../board/board';
import { buildMontTrouble } from '../boards/montTrouble';
import type { GameEvent } from '../game/types';
import { naturalAppearance } from '../lobby/players';
import { FOUR_PLAYERS } from '../testing/fixtures';
import { animationTime } from './pacing';
import { GameSession, type Seat, type SeatControl, type SessionSave } from './session';

const board = prepareBoard(buildMontTrouble());
const DECISION_TIME = 20_000;

function start(
  controls: Record<string, SeatControl>,
  seed = 1,
  decisionTime: number | null = DECISION_TIME,
) {
  const seats = Object.fromEntries(
    Object.entries(controls).map(([id, control]): [string, Seat] => [
      id,
      { control, appearance: naturalAppearance('fox') },
    ]),
  );
  return GameSession.create(
    board,
    { players: FOUR_PLAYERS, tableSize: 4, seed },
    seats,
    { decisionTime },
    0,
  );
}

const BOTS: Record<string, SeatControl> = {
  ana: 'normal',
  bob: 'normal',
  cam: 'easy',
  dan: 'expert',
};

describe('a game session', () => {
  test('lets bots play a whole game on their own, never before the animations end', () => {
    const { session, events: opening } = start(BOTS);
    let previousReady = animationTime(opening);
    let ticks = 0;
    for (let wake = session.nextWakeAt(); wake !== null; wake = session.nextWakeAt()) {
      expect(wake).toBeGreaterThanOrEqual(previousReady);
      expect(session.tick(wake - 1)).toBeNull();
      const events = session.tick(wake);
      expect(events).not.toBeNull();
      previousReady = wake + animationTime(events ?? []);
      ticks++;
      // Un mini-jeu d'arène avance d'un pas par réveil (30 par seconde) : beaucoup de réveils.
      if (ticks > 200_000) throw new Error('Partie sans fin');
    }
    expect(session.isFinished).toBe(true);
  });

  test('lets a bot take its time: longer for a real choice than for a roll', () => {
    const { session, events: opening } = start(BOTS);
    let ready = animationTime(opening);
    const waits = { roll: [] as number[], choice: [] as number[] };
    for (let i = 0; i < 50_000 && waits.roll.length < 30; i++) {
      const wake = session.nextWakeAt();
      if (wake === null) break;
      const snapshot = session.snapshot({ type: 'spectator' }, wake);
      if (snapshot.type !== 'snapshot') throw new Error('Instantané attendu');
      const { phase } = snapshot.state;
      // Un mini-jeu joué en arène pendant le tour (1 contre tous, duel, défi de la porte
      // d'adresse) avance d'un pas par réveil : ce n'est pas un choix de bot.
      const arenaSteps = ['awaitOneVsAllResult', 'awaitDuelResult', 'awaitSkillGate'];
      if (phase.type === 'turn' && !arenaSteps.includes(phase.step.type)) {
        (phase.step.type === 'awaitRoll' ? waits.roll : waits.choice).push(wake - ready);
      }
      ready = wake + animationTime(session.tick(wake) ?? []);
    }
    expect(waits.roll.length).toBeGreaterThan(10);
    expect(waits.choice.length).toBeGreaterThan(0);
    // À l'arrondi près : les heures de réveil d'une arène s'additionnent en pas de 1/30 s.
    expect(Math.min(...waits.roll)).toBeGreaterThanOrEqual(1600 - 1e-6);
    expect(Math.min(...waits.choice)).toBeGreaterThan(Math.min(...waits.roll));
  });

  test('plays an arena minigame: intro, countdown, a real match, then its ranking', () => {
    // On cherche une partie dont le premier mini-jeu tiré est le Sumo.
    for (let seed = 1; seed < 400; seed++) {
      const { session } = start(BOTS, seed);
      let arenaSeen = false;
      let drawn: GameEvent | undefined;
      let ranked: GameEvent | undefined;
      for (let wake = session.nextWakeAt(); wake !== null && !ranked; wake = session.nextWakeAt()) {
        const events = session.tick(wake) ?? [];
        drawn ??= events.find((event) => event.type === 'minigameDrawn');
        const message = session.arenaMessage({ type: 'spectator' }, wake);
        if (message.type === 'arena' && message.run) arenaSeen = true;
        ranked = events.find((event) => event.type === 'minigameRanked');
      }
      if (drawn?.type !== 'minigameDrawn' || drawn.minigame !== 'pawnSumo') continue;
      expect(arenaSeen).toBe(true);
      expect(ranked?.type).toBe('minigameRanked');
      expect(session.isPlayingArena).toBe(false);
      return;
    }
    throw new Error('Aucune partie ne tire le Sumo en premier');
  });

  test('plays a 1-vs-all arena with the lone player on their own side, then rewards them', () => {
    for (let seed = 1; seed < 400; seed++) {
      const { session } = start(BOTS, seed);
      let solo: string | null = null;
      let ended: GameEvent | undefined;
      for (let wake = session.nextWakeAt(); wake !== null && !ended; wake = session.nextWakeAt()) {
        const events = session.tick(wake) ?? [];
        const message = session.arenaMessage({ type: 'spectator' }, wake);
        if (message.type === 'arena' && message.run?.minigame === 'bigDie') solo = message.run.solo;
        ended = events.find((event) => event.type === 'oneVsAllEnded');
      }
      if (solo === null || ended?.type !== 'oneVsAllEnded') continue;
      expect(ended.solo).toBe(solo);
      expect(session.isPlayingArena).toBe(false);
      return;
    }
    throw new Error('Aucune partie ne joue le Gros Dé en 1 contre tous');
  });

  // Joue des parties entières jusqu'à tomber sur un duel : avec les mini-jeux longs (Hors-piste
  // dure 3 minutes entre bots), il lui faut plus que les 5 s par défaut.
  test('plays a duel arena between the two duelists only, then settles the duel', () => {
    for (let seed = 1; seed < 400; seed++) {
      const { session } = start(BOTS, seed);
      let duelists: string[] | null = null;
      let ended: GameEvent | undefined;
      for (let wake = session.nextWakeAt(); wake !== null && !ended; wake = session.nextWakeAt()) {
        const events = session.tick(wake) ?? [];
        const run = session.arenaMessage({ type: 'spectator' }, wake);
        const isDuel = run.type === 'arena' && run.run?.minigame === 'clayShoot';
        if (isDuel && run.run) duelists = run.run.players;
        ended = events.find((event) => event.type === 'duelEnded');
      }
      if (duelists === null || ended?.type !== 'duelEnded') continue;
      expect(duelists).toHaveLength(2);
      expect(ended.winner === null || duelists.includes(ended.winner)).toBe(true);
      expect(session.isPlayingArena).toBe(false);
      return;
    }
    throw new Error('Aucune partie ne joue le Ball-trap en duel');
  }, 30_000);

  test('plays the skill gate challenge with the gate player alone, then opens or keeps the gate', () => {
    const challenges = ['perfectGauge', 'combination'];
    for (let seed = 1; seed < 600; seed++) {
      const { session } = start(BOTS, seed);
      let players: string[] | null = null;
      let gate: GameEvent | undefined;
      for (let wake = session.nextWakeAt(); wake !== null && !gate; wake = session.nextWakeAt()) {
        const events = session.tick(wake) ?? [];
        const message = session.arenaMessage({ type: 'spectator' }, wake);
        if (message.type === 'arena' && challenges.includes(message.run?.minigame ?? '')) {
          players = message.run?.players ?? null;
        }
        gate = events.find((event) => event.type === 'skillGateResult');
      }
      if (players === null || gate === undefined) continue;
      expect(players).toHaveLength(1);
      expect(session.isPlayingArena).toBe(false);
      return;
    }
    throw new Error("Aucune partie ne joue un défi de la porte d'adresse");
  });

  test('gives a human the decision time, then plays a default choice for them', () => {
    const { session } = start({ ...BOTS, ana: 'human' });
    // Les bots et les mini-jeux provisoires jouent jusqu'à ce que ce soit à Ana.
    let now = 0;
    for (let i = 0; i < 1000; i++) {
      const snapshot = session.snapshot({ type: 'player', playerId: 'ana' }, now);
      if (snapshot.type === 'snapshot' && snapshot.decisionEndsIn !== null) break;
      now = session.nextWakeAt() ?? now;
      session.tick(now);
    }
    const deadline = session.nextWakeAt();
    if (deadline === null) throw new Error('Décision attendue');
    expect(session.tick(deadline - 1)).toBeNull();
    const played = session.tick(deadline);
    expect(played?.length).toBeGreaterThan(0);
  });

  test('without a time limit, waits for the human as long as it takes; bots still play', () => {
    const { session } = start({ ...BOTS, ana: 'human' }, 1, null);
    let now = 0;
    for (let bot = 0; bot < 3; bot++) {
      now = session.nextWakeAt() ?? now;
      session.tick(now);
    }
    // Ana regarde l'intro : rien n'est prévu, ni chrono ni choix par défaut.
    expect(session.nextWakeAt()).toBeNull();
    expect(session.tick(now + 3_600_000)).toBeNull();
    const intro = session.snapshot({ type: 'player', playerId: 'ana' }, now);
    expect(intro.type === 'snapshot' && intro.decisionEndsIn).toBeNull();
    session.submit({ type: 'player', playerId: 'ana' }, { type: 'skipIntro' }, now);
    // Les bots reprennent seuls.
    expect(session.nextWakeAt()).not.toBeNull();
  });

  test('applies a human intent and waits for its animations before the next bot acts', () => {
    const { session } = start({ ...BOTS, ana: 'human' }, 3);
    let now = 0;
    for (let i = 0; i < 1000; i++) {
      const snapshot = session.snapshot({ type: 'player', playerId: 'ana' }, now);
      if (snapshot.type === 'snapshot' && snapshot.state.phase.type === 'turn') {
        const { phase } = snapshot.state;
        if (phase.playerId === 'ana' && phase.step.type === 'awaitRoll') break;
      }
      now = session.nextWakeAt() ?? now;
      session.tick(now);
    }
    expect(session.submit({ type: 'player', playerId: 'bob' }, { type: 'roll' }, now)).toEqual({
      ok: false,
      error: 'notYourTurn',
    });
    const result = session.submit({ type: 'player', playerId: 'ana' }, { type: 'roll' }, now);
    if (!result.ok) throw new Error(result.error);
    expect(session.nextWakeAt()).toBeGreaterThanOrEqual(now + animationTime(result.events));
  });

  test('opens with the intro and the order roll, bots first, the human with a longer timer', () => {
    const { session } = start({ ...BOTS, ana: 'human' });
    // Les bots passent l'intro sans attendre Ana.
    let now = 0;
    for (let bot = 0; bot < 3; bot++) {
      now = session.nextWakeAt() ?? now;
      session.tick(now);
    }
    const intro = session.snapshot({ type: 'player', playerId: 'ana' }, now);
    expect(intro).toMatchObject({ state: { phase: { type: 'intro', waiting: ['ana'] } } });
    // Ana a bien plus que le temps d'une décision pour regarder l'intro.
    expect(intro.type === 'snapshot' && (intro.decisionEndsIn ?? 0) > DECISION_TIME).toBe(true);

    const skipped = session.submit({ type: 'player', playerId: 'ana' }, { type: 'skipIntro' }, now);
    if (!skipped.ok) throw new Error(skipped.error);
    expect(skipped.events).toEqual([{ type: 'introEnded' }]);
    // Puis les bots lancent leur dé pour l'ordre, avant qu'on attende Ana.
    for (let bot = 0; bot < 3; bot++) {
      now = session.nextWakeAt() ?? now;
      expect(session.tick(now)?.map((event) => event.type)).toEqual(['orderRolled']);
    }
    const rolled = session.submit(
      { type: 'player', playerId: 'ana' },
      { type: 'rollForOrder' },
      now,
    );
    if (!rolled.ok) throw new Error(rolled.error);
    expect(rolled.events.map((event) => event.type)).toContain('orderDrawn');
  });

  test('sends each client only what it may see', () => {
    const { session, events } = start({ ...BOTS, ana: 'human' });
    const snapshot = session.snapshot({ type: 'player', playerId: 'ana' }, 0);
    expect(snapshot).toMatchObject({
      type: 'snapshot',
      you: 'ana',
      seats: {
        ana: { kind: 'human', appearance: naturalAppearance('fox') },
        bob: { kind: 'bot', appearance: naturalAppearance('fox') },
        cam: { kind: 'bot', appearance: naturalAppearance('fox') },
        dan: { kind: 'bot', appearance: naturalAppearance('fox') },
      },
      state: { rngState: 0 },
    });
    const secret: GameEvent = { type: 'mirrorArmed', playerId: 'ana' };
    expect(session.update({ type: 'spectator' }, [...events, secret], 0)).toMatchObject({
      events,
    });
  });
});

describe('saving a game session', () => {
  /** Fait jouer les bots jusqu'à ce que `until` soit vrai ; renvoie l'heure atteinte. */
  function playUntil(session: GameSession, until: () => boolean): number {
    let now = 0;
    for (let wake = session.nextWakeAt(); wake !== null && !until(); wake = session.nextWakeAt()) {
      now = wake;
      session.tick(now);
    }
    return now;
  }

  test('resumes a saved game where it stopped, and plays it to the end', () => {
    const { session } = start(BOTS, 3);
    const stoppedAt = playUntil(session, () => {
      const message = session.update({ type: 'spectator' }, [], 0);
      return message.type === 'events' && message.state.round >= 6 && !session.isPlayingArena;
    });
    // Comme dans le navigateur : la sauvegarde passe par une copie, sans rien de vivant.
    const save = JSON.parse(JSON.stringify(session.toSave()));
    const resumed = GameSession.restore(board, save, stoppedAt);
    expect(resumed.update({ type: 'spectator' }, [], stoppedAt)).toEqual(
      session.update({ type: 'spectator' }, [], stoppedAt),
    );
    playUntil(resumed, () => resumed.isFinished);
    expect(resumed.isFinished).toBe(true);
    const recap = resumed.recapMessage();
    expect(recap?.type === 'recap' && recap.recap.players.ana?.progress.length).toBeGreaterThan(6);
  });

  test('refuses a save from another format version', () => {
    const { session } = start(BOTS);
    const save = { ...session.toSave(), version: 99 } as unknown as SessionSave;
    expect(() => GameSession.restore(board, save, 0)).toThrow();
  });

  test('sends no recap before the end, then the winner first', () => {
    const { session } = start(BOTS, 2);
    expect(session.recapMessage()).toBeNull();
    playUntil(session, () => session.isFinished);
    const message = session.recapMessage();
    const final = session.update({ type: 'spectator' }, [], 0);
    if (message?.type !== 'recap' || final.type !== 'events') throw new Error('Récap attendu');
    expect(final.state.phase.type === 'finished' && final.state.phase.winner).toBe(
      message.recap.ranking[0] ?? '',
    );
  });
});

describe('pacing', () => {
  test('counts moves space by space, and never times secret actions', () => {
    const moved: GameEvent = {
      type: 'moved',
      playerId: 'ana',
      path: ['a', 'b', 'c'],
      cause: 'dice',
    };
    expect(animationTime([moved])).toBe(3 * animationTime([{ ...moved, path: ['a'] }]));
    const armed: GameEvent = { type: 'mirrorArmed', playerId: 'ana' };
    expect(animationTime([moved, armed])).toBe(animationTime([moved]));
  });
});
