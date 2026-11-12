import type { HostedReadingResume, HostedReadingSelection } from '../library/contract/hosted-reading.ts';
import {
  HOSTED_READING_POSITION_BLOCK_MAX,
  HOSTED_READING_POSITION_OFFSET_MAX,
} from '../library/contract/hosted-reading.ts';

function digest(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

export function hostedReadingUnavailable(
  occurrenceId: string,
  kind: HostedReadingResume['kind'] = 'unknown',
): HostedReadingResume {
  return { availability: 'unavailable', occurrenceId, kind };
}

export function hostedReadingPositionIsBounded(position: HostedReadingSelection['documentPosition']): boolean {
  if (position === null) return true;
  return (
    typeof position.blockId === 'string' &&
    position.blockId.length >= 1 &&
    position.blockId.length <= HOSTED_READING_POSITION_BLOCK_MAX &&
    position.blockId.isWellFormed() &&
    !/[\u0000-\u001f\u007f]/.test(position.blockId) &&
    Number.isInteger(position.offset) &&
    position.offset >= 0 &&
    position.offset <= HOSTED_READING_POSITION_OFFSET_MAX
  );
}

export function hostedReadingSelectionShape(selection: HostedReadingSelection): boolean {
  return (
    typeof selection.catalogueId === 'string' &&
    typeof selection.publicationRevisionId === 'string' &&
    typeof selection.occurrenceId === 'string' &&
    typeof selection.targetRevisionId === 'string' &&
    digest(selection.targetSha256) &&
    hostedReadingPositionIsBounded(selection.documentPosition)
  );
}
