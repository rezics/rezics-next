import { profileRegistry } from '../../../../packages/model/src/generated/profiles.ts';
import type { CommandValidation, FusekiClient } from './fuseki.ts';

export type ProfileId = keyof typeof profileRegistry;

export async function assertCommandProfiles(fuseki: FusekiClient): Promise<void> {
  const health = await fuseki.commandHealth();
  if (health.moduleVersion !== '0.5.4') throw new Error('unsupported Fuseki command module');
  for (const [id, profile] of Object.entries(profileRegistry)) {
    if (health.profiles[id] !== profile.sha256) {
      throw new Error(`Fuseki profile ${id} differs from reviewed artifact`);
    }
  }
}

/** Build validation entries only from reviewed, generated shape identities. */
export async function profileValidations(fuseki: FusekiClient, profile: ProfileId,
  entries: readonly { shape: string; focus: readonly string[]; graphs: readonly string[] }[],
  binding?: Readonly<Record<string, string>>,
): Promise<CommandValidation[]> {
  const pinned = profileRegistry[profile];
  const health = await fuseki.commandHealth();
  if (health.profiles[profile] !== pinned.sha256) {
    throw new Error(`Fuseki profile ${profile} differs from reviewed artifact`);
  }
  return entries.map(entry => {
    if (!(pinned.shapes as readonly string[]).includes(entry.shape)) {
      throw new Error(`unreviewed shape ${entry.shape} for ${profile}`);
    }
    if (entry.focus.length === 0 || entry.graphs.length === 0) {
      throw new Error('required validation focus or graph is empty');
    }
    return { profile, sha256: pinned.sha256, shape: entry.shape,
      focus: [...entry.focus], graphs: [...entry.graphs],
      ...(binding ? { binding: { ...binding } } : {}) };
  });
}
