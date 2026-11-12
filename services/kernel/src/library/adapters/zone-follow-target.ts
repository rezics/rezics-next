import type { LibraryActor } from '../contract/index.ts';
import type { NativeFollowProjection, NativeFollowTargetAdapter } from '../contract/index.ts';

/** The producer supplies only the current public Zone shell, after native read authorization. */
export type FollowableZone = Readonly<{
  id: string;
  revision: string;
  visibility: 'public' | 'unlisted' | 'private';
  label: string;
}>;
export type ReadFollowableZone = (actor: LibraryActor, id: string, deadline: number) => Promise<FollowableZone | null>;

/** One current owner read per observation, plus a final read before FULL disclosure. */
export function createZoneFollowTargetAdapter(read: ReadFollowableZone): NativeFollowTargetAdapter {
  return Object.freeze({
    targetType: 'zone' as const,
    async observe(actor: LibraryActor, id: string, deadline: number) {
      const before = await read(actor, id, deadline);
      const admitted = before !== null && before.visibility !== 'private';
      const value: NativeFollowProjection | null = admitted
        ? {
            target: { id: before.id, type: 'zone', label: before.label },
            destination: { kind: 'zone', zoneId: before.id },
          }
        : null;
      return {
        value,
        async current() {
          const after = await read(actor, id, deadline);
          return (
            after?.id === before?.id &&
            after?.revision === before?.revision &&
            after?.visibility === before?.visibility &&
            after?.label === before?.label
          );
        },
      };
    },
  });
}
