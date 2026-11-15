import { readNativeHostedBook, type HostedBookViewer } from './native-read';
import { readNativeHostedBookLanguages } from './native-languages';
import type { BookLanguageSource } from './languages';
import { getLocale } from '../../paraglide/runtime.js';
import { nativeBookRequestWithinBounds } from './native-mapper';
import {
  bookPageMatches,
  samePublication,
  type BookPublication,
  type BookSourceObservation,
  type HostedBookSource,
} from './source';

export type NativeHostedBookAdmission =
  | Readonly<{
      state: 'current';
      publication: BookPublication;
      currentReleaseRevisionId: string;
      currentStructureRevisionId: string;
      /** Current public opening label from this admission, or its localized fallback. */
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
export function createNativeHostedBookSource(
  admission: NativeHostedBookAdmissionSource,
  locale: string = getLocale(),
): HostedBookSource {
  async function languageRead(
    address: import('./source').BookChapterAddress,
    locale: string,
    operation: import('./native-languages').HostedBookLanguageInput['operation'],
    signal: AbortSignal,
  ) {
    const observed = admission.getSnapshot();
    const current = () => !signal.aborted && admission.getSnapshot() === observed;
    if (!current() || observed.state !== 'current' || !samePublication(address.publication, observed.publication))
      return { state: 'unavailable' as const };
    try {
      const result = await readNativeHostedBookLanguages({
        data: {
          address,
          locale,
          operation,
          viewer: observed.viewer,
          currentReleaseRevisionId: observed.currentReleaseRevisionId,
          currentStructureRevisionId: observed.currentStructureRevisionId,
        },
        signal,
      });
      return current() ? result : { state: 'unavailable' as const };
    } catch {
      return { state: 'unavailable' as const };
    }
  }
  const languages: BookLanguageSource = {
    async list(address, cursor, signal) {
      const result = await languageRead(address, locale, { kind: 'list', cursor }, signal);
      return result.state !== 'ready'
        ? result
        : 'choices' in result.value
          ? { state: 'ready', value: result.value }
          : { state: 'unavailable' };
    },
    async select(address, preference, signal) {
      const result = await languageRead(
        address,
        'en',
        {
          kind: 'select',
          preference: { language: preference.language, preferredLanguages: [...preference.preferredLanguages] },
        },
        signal,
      );
      return result.state !== 'ready'
        ? result
        : 'address' in result.value
          ? { state: 'ready', value: result.value }
          : { state: 'unavailable' };
    },
  };
  return {
    languages,
    getSnapshot: (): BookSourceObservation => admission.getSnapshot(),
    subscribe: (retired) => admission.subscribe(retired),
    async read(request, signal) {
      const observed = admission.getSnapshot();
      const current = () => !signal.aborted && admission.getSnapshot() === observed;
      if (!current() || observed.state !== 'current') return { state: 'unavailable' };
      if (
        !samePublication(request.address.publication, observed.publication) ||
        !nativeBookRequestWithinBounds(request)
      )
        return { state: 'unavailable' };
      try {
        const result = await readNativeHostedBook({
          data: {
            request,
            viewer: observed.viewer,
            publicationTitle: observed.publicationTitle,
            currentReleaseRevisionId: observed.currentReleaseRevisionId,
            currentStructureRevisionId: observed.currentStructureRevisionId,
          },
          signal,
        });
        if (!current()) return { state: 'unavailable' };
        if (
          result.state === 'ready' &&
          (!bookPageMatches(request, result.page) ||
            result.page.currentReleaseRevisionId !== observed.currentReleaseRevisionId ||
            result.page.currentStructureRevisionId !== observed.currentStructureRevisionId)
        )
          return { state: 'changed' };
        return result;
      } catch {
        return { state: 'unavailable' };
      }
    },
  };
}
