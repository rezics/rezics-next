import type { browserObservation, BrowserReader } from '../../../session/observation';
import type { HomeWorkLibraryLease, HomeWorkLibraryProjection } from './contract';

/** A receipt may replace facts, but cannot replace the lifetime of their original source. */
export function createHomeWorkLibraryAdmission(
  projection: HomeWorkLibraryProjection,
  observation?: Pick<ReturnType<typeof browserObservation>, 'getSnapshot'>,
) {
  const source = projection.lease;
  const subject = projection.scope.reader;
  let retired = false;
  let reader: BrowserReader | undefined;
  const retire = () => {
    retired = true;
  };
  const isCurrent = () => {
    if (!source.isCurrent()) retire();
    if (retired) return false;
    if (!observation) return true;
    const reading = observation.getSnapshot();
    if (reading.state !== 'signed-in') {
      if (reader) retire();
      return false;
    }
    if (reading.observation.subject !== subject || (reader && reader.id !== reading.observation.id)) {
      retire();
      return false;
    }
    reader ??= reading.observation;
    return true;
  };
  const lease: HomeWorkLibraryLease = {
    isCurrent,
    snapshot: () => source.snapshot(),
    subscribe: (listener) =>
      source.subscribe(() => {
        // Observe withdrawal even when React batches it with a later source update.
        isCurrent();
        listener();
      }),
  };
  return { lease, retire };
}
