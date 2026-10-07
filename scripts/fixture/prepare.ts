import { buildFixture } from './build.ts';
import { DEFAULT_SEED, type FixtureProfile } from './corpus.ts';
import { type FixtureManifest } from './manifest.ts';
import { compatibleFixture, RESTORE_DEADLINE_MS } from './restore.ts';

export interface FixturePreparation {
  fixture: string;
  profile: FixtureProfile;
  built: boolean;
  elapsedMs: number;
  deadlineMs: number;
}

/** Build missing background once, retain the stopped owner cut, then let each
 * drill restore its own writable copy. Never fall back to incompatible data. */
export async function prepareFixture(
  profile: FixtureProfile,
  seed = DEFAULT_SEED,
  dependencies = {
    retained: compatibleFixture,
    build: buildFixture,
    now: Date.now,
  },
): Promise<FixturePreparation> {
  const started = dependencies.now();
  let admissionWaitMs = 0;
  const retained = dependencies.retained(profile, seed);
  const remaining = RESTORE_DEADLINE_MS - (dependencies.now() - started);
  if (remaining <= 0) throw new Error('Fixture preparation exceeded 600 seconds');
  const manifest: FixtureManifest =
    retained ?? (await dependencies.build(profile, seed, remaining,
      ms => { admissionWaitMs += ms; }));
  const elapsedMs = dependencies.now() - started;
  if (elapsedMs - admissionWaitMs > RESTORE_DEADLINE_MS) throw new Error('Fixture preparation exceeded 600 seconds');
  return {
    fixture: manifest.id,
    profile,
    built: !retained,
    elapsedMs,
    deadlineMs: RESTORE_DEADLINE_MS,
  };
}
