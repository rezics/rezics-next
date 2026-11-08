import type { OwnDraftIdentity, OwnDraftReader } from './model';
import { listOwnDraftPage, resumeOwnDraftPost } from './actions';

/** Private server functions use the authenticated generated client; no browser query cache is involved. */
export const ownDraftNativeReader: OwnDraftReader = Object.freeze({
  list: (data, signal) => listOwnDraftPage({ data, signal }),
  resume: (data, signal) => resumeOwnDraftPost({ data, signal }),
});

function validEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Bind native reads to the first admitted viewer and epoch for this one mounted visit. */
export function ownDraftReaderForVisit(
  reader: OwnDraftReader,
  identity: OwnDraftIdentity,
  current: () => boolean,
): OwnDraftReader {
  let admittedEpoch = identity.authnEpoch;
  return {
    async list(request, signal) {
      if (signal.aborted || !current()) return 'unavailable';
      if (request.accountId !== identity.accountId) return 'denied';
      if (request.authnEpoch !== undefined && admittedEpoch !== null && request.authnEpoch !== admittedEpoch)
        return 'denied';
      const result = await reader.list(request, signal);
      if (signal.aborted || !current()) return 'unavailable';
      if (typeof result === 'string') return result;
      if (
        result.viewer.accountId !== identity.accountId ||
        !validEpoch(result.viewer.authnEpoch) ||
        (request.authnEpoch !== undefined && result.viewer.authnEpoch !== request.authnEpoch) ||
        (admittedEpoch !== null && result.viewer.authnEpoch !== admittedEpoch)
      )
        return 'denied';
      admittedEpoch ??= result.viewer.authnEpoch;
      return result;
    },
    async resume(request, signal) {
      if (signal.aborted || !current()) return 'unavailable';
      if (
        request.accountId !== identity.accountId ||
        !validEpoch(request.authnEpoch) ||
        admittedEpoch === null ||
        request.authnEpoch !== admittedEpoch
      )
        return 'denied';
      const result = await reader.resume(request, signal);
      if (signal.aborted || !current()) return 'unavailable';
      return result;
    },
  };
}
