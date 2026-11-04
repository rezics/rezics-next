import {
  admittedPublicationCommand,
  unavailablePublicationPreparation,
  type PublicationPrepare,
  type PublicationPreparationResult,
  type RealmPublicationPreparation,
} from './realm-publication-preparation';
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
  preparation?: RealmPublicationPreparation | null;
  preparationState?: 'loading' | 'ready' | 'denied' | 'unavailable' | undefined;
  reviewAction?: PublicationChange['action'];
};
type DraftBinding = {
  current: () => boolean;
  watch?: (listener: () => void) => () => void;
  startDisconnected?: boolean;
};
let nextDraftId = 0;

/** One explicit selection, one replacing preparation and one sealed original command. */
export function createPublicationDraft(
  realmId: string,
  send: PublicationSend,
  saved: Saved,
  _currentSubjects: () => readonly PublishedSubject[],
  enabled = true,
  binding?: DraftBinding,
  prepare: PublicationPrepare = unavailablePublicationPreparation,
) {
  const id = ++nextDraftId;
  let state: Draft = { target: null, outcome: null, busy: false };
  let request: { input: PublicationChange; target: PublicationTarget } | null = null;
  let selected: PublicationTarget | null = null;
  // Picker disclosure is only a selection hint; native review owns its own presentation.
  const identity = (target: PublicationTarget): PublicationTarget => ({
    id: target.id,
    title: '',
    label: '',
    labels: {},
    types: [],
    cover: null,
  });
  let active = enabled;
  let retired = false;
  let connected = !binding?.startDisconnected;
  let serial = 0;
  let reading = 0;
  let stopWatching: (() => void) | undefined;
  const listeners = new Set<() => void>();
  function update(next: Draft) {
    state = next;
    for (const listener of listeners) listener();
  }
  function retire() {
    if (retired) return;
    retired = true;
    active = false;
    connected = false;
    serial++;
    reading++;
    stopWatching?.();
    stopWatching = undefined;
    request = null;
    selected = null;
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
  async function inspect(ticket = serial) {
    // Reads can explain an unknown write, but never recover or replace its identity.
    if (!current(ticket) || state.busy || state.preparationState === 'loading') return;
    const target = selected ?? request?.target;
    if (!target) return;
    const read = ++reading;
    update({ ...state, target: identity(target), preparation: null, preparationState: 'loading' });
    if (!current(ticket)) return;
    let result: PublicationPreparationResult;
    try {
      result = await prepare({ realmId, subjectId: target.id });
    } catch {
      result = { kind: 'unavailable' };
    }
    if (!current(ticket) || read !== reading) return;
    if (
      result.kind === 'ready' &&
      (result.preparation.realm.realmId !== realmId || result.preparation.subject.originalId !== target.id)
    ) {
      result = { kind: 'denied' };
    }
    if (result.kind !== 'ready') {
      update({ ...state, target: null, preparation: null, preparationState: result.kind });
      return;
    }
    update({
      ...state,
      target: {
        ...identity(target),
        ...(result.preparation.subject.presentation.label.state === 'available'
          ? {
              title: result.preparation.subject.presentation.label.value,
              label: result.preparation.subject.presentation.label.value,
              labels: {
                [result.preparation.subject.presentation.label.language]:
                  result.preparation.subject.presentation.label.value,
              },
            }
          : {}),
        cover:
          result.preparation.subject.presentation.cover.state === 'available'
            ? structuredClone(result.preparation.subject.presentation.cover.value)
            : null,
      },
      preparation: structuredClone(result.preparation),
      preparationState: 'ready',
    });
  }
  function choose(next: PublicationTarget | null, ticket = serial, action?: PublicationChange['action']) {
    if (locked(ticket)) return;
    request = null;
    selected = next ? identity(next) : null;
    reading++;
    update({
      target: next ? identity(next) : null,
      outcome: null,
      busy: false,
      ...(action ? { reviewAction: action } : {}),
    });
    if (next) return inspect(ticket);
  }
  async function performIntent(intent: { input: PublicationChange; target: PublicationTarget }, ticket: number) {
    if (!current(ticket) || state.busy) return;
    request = intent;
    reading++;
    update({
      ...state,
      target: identity(intent.target),
      preparation: null,
      preparationState: undefined,
      outcome: null,
      busy: true,
      action: intent.input.action,
    });
    if (!current(ticket)) return;
    let result: PublicationOutcome;
    try {
      if (!current(ticket)) return;
      result = await send(intent.input);
    } catch {
      result = { kind: 'unavailable' };
    }
    if (!current(ticket)) return;
    if (result.kind === 'saved') {
      saved(intent.input, structuredClone(intent.target), result.head);
      if (!current(ticket)) return;
    }
    const unknown = result.kind === 'unavailable';
    // Any definitive outcome consumes the preparation and the old command.
    if (!unknown) request = null;
    update({
      target:
        result.kind === 'denied'
          ? null
          : { ...identity(intent.target), ...(result.kind === 'saved' ? { publicationId: result.head } : {}) },
      outcome: Object.freeze({ ...result }),
      busy: false,
      action: intent.input.action,
      preparation: null,
    });
  }
  function change(action: PublicationChange['action'], subject = state.target, ticket = serial) {
    if (!subject || locked(ticket)) return;
    if (subject.id !== state.target?.id) return choose(subject, ticket, action);
    const preparation = state.preparation;
    if (!preparation || state.preparationState !== 'ready') return;
    const command = admittedPublicationCommand(preparation, action);
    if (!command) return;
    const input: PublicationChange = Object.freeze({
      realmId,
      subjectId: preparation.subject.originalId,
      action,
      idempotencyKey: crypto.randomUUID(),
      ...(command.expectedHead === null ? {} : { expectedHead: command.expectedHead }),
      href: command.href,
      ifMatch: command.ifMatch,
    });
    return performIntent({ input, target: structuredClone(subject) }, ticket);
  }
  function retry(ticket = serial) {
    if (!current(ticket) || state.outcome?.kind !== 'unavailable' || !request) return;
    return performIntent(request, ticket);
  }
  function review(ticket = serial) {
    if (!current(ticket) || state.outcome?.kind !== 'conflict') return;
    return inspect(ticket);
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
      reading++;
      stopWatching?.();
      stopWatching = undefined;
      request = null;
      selected = null;
      update({ target: null, outcome: null, busy: false });
      queueMicrotask(() => {
        if (!connected) retire();
      });
    };
  }
  function bind() {
    const ticket = serial;
    return {
      choose: (next: PublicationTarget | null, action?: PublicationChange['action']) => choose(next, ticket, action),
      change: (action: PublicationChange['action'], subject = state.target) => change(action, subject, ticket),
      retry: () => retry(ticket),
      review: () => review(ticket),
      inspect: () => inspect(ticket),
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
    inspect,
    bind,
    current: () => current(),
    connect,
    retire,
    activate() {
      if (!retired) active = true;
    },
  };
}
