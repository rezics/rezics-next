import { canonicalLanguageKey } from '@rezics/definitions/language';
import {
  BOOK_LANGUAGE_PAGE_LIMIT,
  bookLanguagePreferenceWithinBounds,
  type BookLanguageChoice,
  type BookLanguagePreference,
  type BookLanguageSource,
} from './languages';
import { bookAddressWithinBounds, samePublication, type BookChapterAddress } from './source';

export type BookLanguageState = Readonly<{
  state: 'idle' | 'loading' | 'ready' | 'selecting' | 'unavailable' | 'retired';
  choices: readonly BookLanguageChoice[];
  cursor: string | null;
  nextCursor: string | null;
}>;

/** One replacing metadata page and one native selection; no body bytes or private positions enter this owner. */
export function createBookLanguageVisit(
  source: BookLanguageSource,
  address: BookChapterAddress,
  current: () => boolean,
  selected: (address: BookChapterAddress, keyboard: boolean) => void,
) {
  let state: BookLanguageState = { state: 'idle', choices: [], cursor: null, nextCursor: null };
  let active = true;
  let generation = 0;
  let controller: AbortController | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: BookLanguageState) => {
    state = next;
    for (const listener of [...listeners]) listener();
  };
  const live = (ticket: number) => active && ticket === generation && current();
  const retire = () => {
    if (!active) return;
    active = false;
    generation++;
    controller?.abort();
    publish({ state: 'retired', choices: [], cursor: null, nextCursor: null });
  };
  const begin = () => {
    controller?.abort();
    controller = new AbortController();
    return { ticket: ++generation, signal: controller.signal };
  };
  const matches = (next: BookChapterAddress) =>
    samePublication(address.publication, next.publication) &&
    next.selection.occurrenceId === address.selection.occurrenceId &&
    bookAddressWithinBounds(next);
  const load = async (cursor: string | null) => {
    if (!active || !current() || (cursor !== null && (!cursor || cursor.length > 4096))) return;
    const { ticket, signal } = begin();
    publish({ state: 'loading', choices: [], cursor, nextCursor: null });
    try {
      const result = await source.list(address, cursor, signal);
      if (!live(ticket)) return;
      if (
        result.state !== 'ready' ||
        result.value.choices.length > BOOK_LANGUAGE_PAGE_LIMIT ||
        (result.value.nextCursor !== null &&
          (!result.value.nextCursor || result.value.nextCursor.length > 4096 || result.value.nextCursor === cursor)) ||
        result.value.choices.some(
          (choice) =>
            canonicalLanguageKey(choice.language) !== choice.language ||
            choice.selection.bodyLanguage !== choice.language ||
            !choice.title ||
            choice.title.length > 256 ||
            !matches({ ...address, selection: choice.selection }),
        ) ||
        new Set(result.value.choices.map((choice) => choice.language)).size !== result.value.choices.length
      ) {
        publish({ state: 'unavailable', choices: [], cursor, nextCursor: null });
        return;
      }
      publish({ state: 'ready', choices: result.value.choices, cursor, nextCursor: result.value.nextCursor });
    } catch {
      if (live(ticket)) publish({ state: 'unavailable', choices: [], cursor, nextCursor: null });
    }
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    connect() {
      active = true;
      if (state.state === 'retired') publish({ state: 'idle', choices: [], cursor: null, nextCursor: null });
      return retire;
    },
    retire,
    load,
    async choose(preference: BookLanguagePreference, keyboard: boolean) {
      if (!active || !current() || state.state === 'selecting' || !bookLanguagePreferenceWithinBounds(preference))
        return;
      const { ticket, signal } = begin();
      publish({ state: 'selecting', choices: [], cursor: state.cursor, nextCursor: null });
      try {
        const result = await source.select(address, preference, signal);
        if (!live(ticket)) return;
        if (
          result.state !== 'ready' ||
          !matches(result.value.address) ||
          (result.value.language !== null && canonicalLanguageKey(result.value.language) !== result.value.language) ||
          result.value.address.selection.bodyLanguage !== (result.value.language ?? undefined)
        ) {
          publish({ state: 'unavailable', choices: [], cursor: state.cursor, nextCursor: null });
          return;
        }
        const destination = { ...result.value.address, languagePreference: preference };
        retire();
        selected(destination, keyboard);
      } catch {
        if (live(ticket)) publish({ state: 'unavailable', choices: [], cursor: state.cursor, nextCursor: null });
      }
    },
  };
}
