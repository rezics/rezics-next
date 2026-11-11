import { readNativeHostedBook, type HostedBookViewer } from './native-read';
import { nativeBookRequestWithinBounds } from './native-mapper';
import {
  bookPageMatches, samePublication,
  type BookPublication, type BookSourceObservation, type HostedBookSource,
} from './source';

export type NativeHostedBookAdmission =
  | Readonly<{
      state: 'current';
      publication: BookPublication;
      currentReleaseRevisionId: string;
      currentStructureRevisionId: string;
      /** Label from the admitted host; the hosted Content schema carries no catalogue title. */
      publicationTitle: string;
      viewer: HostedBookViewer;
    }>
  | Readonly<{ state: 'unavailable' | 'not-installed' }>;

/**
 * The native host supplies a stable snapshot for one admission incarnation and replaces it on every
 * publication, structure, target or prepared-viewer replacement, notifying synchronously, including A/B/A.
 * This observation is a lifetime fence; native Content still authorizes every request.
 */
export type NativeHostedBookAdmissionSource = Readonly<{
  getSnapshot: () => NativeHostedBookAdmission;
  subscribe: (retired: () => void) => () => void;
}>;

/** Bind the existing reader port to private server functions, without a browser Content transport or cache. */
export function createNativeHostedBookSource(admission: NativeHostedBookAdmissionSource): HostedBookSource {
  return {
    getSnapshot: (): BookSourceObservation => admission.getSnapshot(),
    subscribe: (retired) => admission.subscribe(retired),
    async read(request, signal) {
      const observed = admission.getSnapshot();
      const current = () => !signal.aborted && admission.getSnapshot() === observed;
      if (!current() || observed.state !== 'current') return { state: 'unavailable' };
      if (!samePublication(request.address.publication, observed.publication) || !nativeBookRequestWithinBounds(request))
        return { state: 'unavailable' };
      try {
        const result = await readNativeHostedBook({ data: {
          request, viewer: observed.viewer, publicationTitle: observed.publicationTitle,
          currentReleaseRevisionId: observed.currentReleaseRevisionId,
          currentStructureRevisionId: observed.currentStructureRevisionId,
        }, signal });
        if (!current()) return { state: 'unavailable' };
        if (result.state === 'ready' && (!bookPageMatches(request, result.page) ||
          result.page.currentReleaseRevisionId !== observed.currentReleaseRevisionId ||
          result.page.currentStructureRevisionId !== observed.currentStructureRevisionId)) return { state: 'changed' };
        return result;
      } catch { return { state: 'unavailable' }; }
    },
  };
}
