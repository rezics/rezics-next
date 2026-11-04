import type { FollowWriteInput, FollowWriteResult } from '../../library/follow-records';
import type { ExpectedReader } from '../../session/expected-reader';
import type { DiscoveryCommandRegistry } from '../discovery-personal-state';

/** A Search page's Space commands share the existing no-queue registry and settle into one aggregate read. */
export function createSpaceEntryCommands(input: {
  reader: ExpectedReader;
  current: () => boolean;
  registry: DiscoveryCommandRegistry;
  write: (command: FollowWriteInput & ExpectedReader) => Promise<FollowWriteResult>;
  suppress: () => void;
  refresh: () => Promise<void>;
}) {
  let active = true,
    pending = 0,
    refreshNeeded = false,
    refreshing = false;
  const owns = () => active && input.current();
  return {
    current: owns,
    async execute(command: FollowWriteInput): Promise<FollowWriteResult | null> {
      if (!owns() || refreshing || refreshNeeded) return null;
      const release = input.registry.acquire(
        JSON.stringify(['space-follow', input.reader.expectedReader, command.targetId]),
      );
      if (!release) return null;
      pending++;
      let result: FollowWriteResult;
      try {
        result = await input.write({ ...command, ...input.reader });
      } catch {
        result = { ok: false, reason: 'unavailable' };
      } finally {
        pending--;
        release();
      }
      if (!owns()) return null;
      if (result.ok && result.following !== command.following) result = { ok: false, reason: 'unavailable' };
      if (result.ok || result.reason === 'unavailable') {
        refreshNeeded = true;
        input.suppress();
      }
      if (refreshNeeded && pending === 0 && !refreshing && owns()) {
        refreshing = true;
        await input.refresh();
      }
      return owns() ? result : null;
    },
    dispose() {
      active = false;
    },
  };
}
export type SpaceEntryCommands = ReturnType<typeof createSpaceEntryCommands>;
