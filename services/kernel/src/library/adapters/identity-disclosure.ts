/** Identity/disclosure adapter. Semantic and Access implementations arrive through composition. */

import type { NativeReleasedDefinitions } from '../../semantic/adapters/index.ts';
import type { readIdentityMappings } from '../../semantic/identity-adapters/read.ts';
import type { durableInitiatorCommitment } from '../../access/durable-initiator-capture.ts';
import type { Pool } from 'pg';
import type { IdentityDisclosureCapability, LibraryRelease } from '../contract/index.ts';
import type { LibraryActor } from '../contract/index.ts';

type IdentityMapping = Awaited<ReturnType<typeof readIdentityMappings>>[number];

export type IdentityDisclosureAdapterPorts = Readonly<{
  readRelease: NativeReleasedDefinitions['read'];
  readActiveRelease: NativeReleasedDefinitions['active'];
  readIdentityMappings: typeof readIdentityMappings;
  durableInitiatorCommitment: typeof durableInitiatorCommitment;
  within<T>(deadline: number, work: () => Promise<T>): Promise<T>;
}>;

export function createIdentityDisclosureAdapter(input: {
  pool?: Pool | undefined;
  ports: IdentityDisclosureAdapterPorts;
}): IdentityDisclosureCapability {
  const { pool, ports } = input;
  return {
    readRelease(source, digest, options) {
      const nativeSource = source ?? pool;
      if (!nativeSource) return Promise.resolve(null);
      return ports.readRelease(nativeSource as Parameters<typeof ports.readRelease>[0], digest, options);
    },
    async readActiveRelease(source) {
      const nativeSource = source ?? pool;
      if (!nativeSource) return null;
      const active = await ports.readActiveRelease(nativeSource as Parameters<typeof ports.readActiveRelease>[0]);
      if (!active) return null;
      return { digest: active.digest, release: active.release } satisfies LibraryRelease;
    },
    async readOriginalTerminal(input) {
      if (input.actor.kind !== 'account' || !pool) return { original: null, terminal: null };
      const mappings = await ports.within(input.deadline, () => ports.readIdentityMappings(pool, [input.subjectId]));
      const mapped: IdentityMapping | undefined = mappings[0];
      if (mapped?.state === 'mapped') return { original: mapped.original, terminal: mapped.terminal };
      return { original: input.subjectId, terminal: input.subjectId };
    },
    initiatorCommitment(original) {
      return ports.durableInitiatorCommitment(original as Parameters<typeof ports.durableInitiatorCommitment>[0]);
    },
  };
}

export type { LibraryActor };
