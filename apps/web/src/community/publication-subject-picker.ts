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

type DraftBinding = {
  current: () => boolean;
  watch?: (listener: () => void) => () => void;
  startDisconnected?: boolean;
};

let nextDraftId = 0;

/** A visit's draft and exact pending command, never a permission or publication authority. */
export function createPublicationDraft(
  realmId: string,
  send: PublicationSend,
  saved: Saved,
  currentSubjects: () => readonly PublishedSubject[],
  enabled = true,
  binding?: DraftBinding,
) {
  const id = ++nextDraftId;
  let state: Draft = { target: null, outcome: null, busy: false };
  let request: { input: PublicationChange; target: PublicationTarget } | null = null;
  let active = enabled;
  let retired = false;
  let connected = !binding?.startDisconnected;
  let serial = 0;
  let stopWatching: (() => void) | undefined;
  const heads = new Map<string, string>();
  const listeners = new Set<() => void>();
  const publish = () => {
    for (const listener of listeners) listener();
  };
  function update(next: Draft) {
    state = next;
    publish();
  }
  function retire() {
    if (retired) return;
    retired = true;
    active = false;
    connected = false;
    serial++;
    stopWatching?.();
    stopWatching = undefined;
    request = null;
    heads.clear();
    update({ target: null, outcome: null, busy: false });
  }
  function current(ticket = serial) {
    if (retired || !active || !connected || ticket !== serial) return false;
    if (binding && !binding.current()) {
      retire();
      return false;
    }
    return true;
  }
  function locked(ticket = serial) {
    return !current(ticket) || state.busy || state.outcome?.kind === 'unavailable';
  }
  function choose(next: PublicationTarget | null, ticket = serial) {
    if (locked(ticket)) return;
    request = null;
    update({ target: next ? structuredClone(next) : null, outcome: null, busy: false });
  }
  function perform(input: PublicationChange, subject: PublicationTarget, ticket = serial) {
    if (!current(ticket) || state.busy) return;
    // Copy the intent once; later shelf refreshes and choices cannot retarget an uncertain retry.
    const intent = { input: Object.freeze({ ...input }), target: structuredClone(subject) };
    request = intent;
    update({ target: structuredClone(intent.target), outcome: null, busy: true, action: input.action });
    // Subscribers can synchronously retire this caller while the busy snapshot is published.
    if (!current(ticket)) return;
    return performIntent(intent, ticket);
  }
  async function performIntent(intent: { input: PublicationChange; target: PublicationTarget }, ticket: number) {
    if (!current(ticket)) return;
    let result: PublicationOutcome;
    try {
      // This is the final caller and connection fence immediately before transport invocation.
      if (!current(ticket)) return;
      result = await send(intent.input);
    } catch {
      result = { kind: 'unavailable' };
    }
    if (!current(ticket)) return;
    if (result.kind === 'saved') {
      heads.set(intent.target.id, result.head);
      saved(intent.input, structuredClone(intent.target), result.head);
      if (!current(ticket)) return;
    }
    const outcome = Object.freeze({ ...result }) as PublicationOutcome;
    update({
      target:
        outcome.kind === 'denied' || (outcome.kind === 'conflict' && !outcome.currentHead)
          ? null
          : {
              ...structuredClone(intent.target),
              ...(outcome.kind === 'saved' ? { publicationId: outcome.head } : {}),
            },
      outcome,
      busy: false,
      action: intent.input.action,
    });
    if (outcome.kind === 'denied') request = null;
  }
  function change(action: PublicationChange['action'], subject = state.target, ticket = serial) {
    if (!subject || locked(ticket)) return;
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
      ticket,
    );
  }
  function retry(ticket = serial) {
    if (!current(ticket) || state.outcome?.kind !== 'unavailable' || !request) return;
    return perform(request.input, request.target, ticket);
  }
  function review(ticket = serial) {
    if (!current(ticket) || state.outcome?.kind !== 'conflict' || !state.outcome.currentHead || !request) return;
    return perform(
      {
        ...request.input,
        expectedHead: state.outcome.currentHead,
        idempotencyKey: crypto.randomUUID(),
      },
      request.target,
      ticket,
    );
  }
  function connect() {
    if (retired) return () => {};
    connected = true;
    serial++;
    stopWatching = binding?.watch?.(() => {
      if (!binding.current()) retire();
    });
    if (binding && !binding.current()) retire();
    else update({ ...state });
    let disconnected = false;
    return () => {
      if (disconnected) return;
      disconnected = true;
      connected = false;
      serial++;
      stopWatching?.();
      stopWatching = undefined;
      request = null;
      heads.clear();
      update({ target: null, outcome: null, busy: false });
      // Strict Mode reconnects synchronously; genuine unmount remains disconnected and retires.
      queueMicrotask(() => {
        if (!connected) retire();
      });
    };
  }
  function bind() {
    const ticket = serial;
    return {
      choose: (next: PublicationTarget | null) => choose(next, ticket),
      change: (action: PublicationChange['action'], subject = state.target) => change(action, subject, ticket),
      retry: () => retry(ticket),
      review: () => review(ticket),
    };
  }
  return {
    id,
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    choose,
    change,
    retry,
    review,
    bind,
    current: () => current(),
    connect,
    // Retire on Realm, reader, locale or lifecycle changes, including while a reply is in flight.
    retire,
    activate() {
      if (!retired) active = true;
    },
  };
}
