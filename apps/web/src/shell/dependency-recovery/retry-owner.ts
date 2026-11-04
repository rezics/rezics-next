import type { BrowserObservationSnapshot } from '../../session/observation';

export type RecoveryOwner = { visit: string | undefined; reader: BrowserObservationSnapshot };

/** A retry can settle only for the visit and reader incarnation that own its pending request. */
export function recoveryOwnerIsCurrent(
  expected: RecoveryOwner,
  current: RecoveryOwner,
  mounted: boolean,
): boolean {
  if (!mounted || expected.visit !== current.visit || expected.reader.state !== current.reader.state) return false;
  if (expected.reader.state !== 'signed-in' || current.reader.state !== 'signed-in') return true;
  return (
    expected.reader.observation.id === current.reader.observation.id &&
    expected.reader.observation.subject === current.reader.observation.subject
  );
}
