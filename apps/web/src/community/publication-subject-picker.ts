import { pickText } from '@rezics/composition';
import type { EntityPickerSearch } from '@rezics/ui/entity-picker';
import { coverOf, coverSubject } from '../media/summary';
import {
  loadGlobalHeaderSuggestions,
  readHeaderSuggestions,
  type HeaderSuggestionLoader,
} from '../search/header-search/suggestions';
import type { PublicationChange, PublicationOutcome } from './publication-controls';
import type { PublishedSubject } from './space';

/** Presentation of Search's disclosed response; Search remains the only suggestions producer. */
export function publicationSubjectSearch(
  locale: string,
  load: HeaderSuggestionLoader = loadGlobalHeaderSuggestions,
): EntityPickerSearch {
  return async (query, signal) => {
    const result = await readHeaderSuggestions(load, query, locale, signal);
    return result.subjects.map((subject) => {
      const title = pickText(subject.labels, locale).text;
      return {
        id: subject.id,
        title,
        types: coverSubject(subject.id, title, subject.summary, subject.type).types,
        typeLabel: pickText(result.types[subject.type] ?? {}, locale).text,
        cover: coverOf(subject.summary),
      };
    });
  };
}

export type PublicationTarget = PublishedSubject & { title: string };
export type PublicationSend = (input: PublicationChange) => Promise<PublicationOutcome>;
type Saved = (input: PublicationChange, target: PublicationTarget, head: string) => void;
type Draft = {
  target: PublicationTarget | null;
  outcome: PublicationOutcome | null;
  busy: boolean;
  action?: PublicationChange['action'];
};

/** A visit's draft and exact pending command, never a permission or publication authority. */
export function createPublicationDraft(
  realmId: string,
  send: PublicationSend,
  saved: Saved,
  currentSubjects: () => readonly PublishedSubject[],
  enabled = true,
) {
  let state: Draft = { target: null, outcome: null, busy: false };
  let request: { input: PublicationChange; target: PublicationTarget } | null = null;
  let active = enabled;
  const heads = new Map<string, string>();
  const listeners = new Set<() => void>();
  const locked = () => !active || state.busy || state.outcome?.kind === 'unavailable';
  function update(next: Draft) {
    state = next;
    for (const listener of listeners) listener();
  }
  async function perform(input: PublicationChange, subject: PublicationTarget) {
    if (!active || state.busy) return;
    // Copy the intent once; later shelf refreshes and choices cannot retarget an uncertain retry.
    const intent = { input: Object.freeze({ ...input }), target: structuredClone(subject) };
    request = intent;
    update({ target: intent.target, outcome: null, busy: true, action: input.action });
    let result: PublicationOutcome;
    try {
      result = await send(intent.input);
    } catch {
      result = { kind: 'unavailable' };
    }
    if (!active) return;
    if (result.kind === 'saved') {
      heads.set(intent.target.id, result.head);
      saved(intent.input, intent.target, result.head);
    }
    update({
      target:
        result.kind === 'denied' || (result.kind === 'conflict' && !result.currentHead)
          ? null
          : { ...intent.target, ...(result.kind === 'saved' ? { publicationId: result.head } : {}) },
      outcome: result,
      busy: false,
      action: input.action,
    });
    if (result.kind === 'denied') request = null;
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    choose(next: PublicationTarget | null) {
      if (locked()) return;
      request = null;
      update({ target: next ? structuredClone(next) : null, outcome: null, busy: false });
    },
    change(action: PublicationChange['action'], subject = state.target) {
      if (!subject || locked()) return;
      const head =
        currentSubjects().find((item) => item.id === subject.id)?.publicationId ??
        heads.get(subject.id) ??
        subject.publicationId;
      if (action !== 'publish' && !head) return;
      return perform(
        {
          realmId,
          subjectId: subject.id,
          action,
          idempotencyKey: crypto.randomUUID(),
          ...(head ? { expectedHead: head } : {}),
        },
        subject,
      );
    },
    retry() {
      if (active && state.outcome?.kind === 'unavailable' && request) return perform(request.input, request.target);
    },
    review() {
      if (!active || state.outcome?.kind !== 'conflict' || !state.outcome.currentHead || !request) return;
      return perform(
        {
          ...request.input,
          expectedHead: state.outcome.currentHead,
          idempotencyKey: crypto.randomUUID(),
        },
        request.target,
      );
    },
    // Retire on Realm, reader, locale or lifecycle changes, including while a reply is in flight.
    retire() {
      active = false;
      request = null;
      heads.clear();
      state = { target: null, outcome: null, busy: false };
    },
    activate() {
      active = true;
    },
  };
}
