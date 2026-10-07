import { saveWorkDetails, detailsValues } from '../studio/details-api.ts';
import type { DetailsValues } from '../studio/details-form.tsx';
import { publishText, readLatest, saveText, selectMainText } from '../studio/text-api.ts';
import type { MainClient } from '../studio/types.ts';

// The recipe's title, description and notes live beside the Composition, each on its own head, so
// they are saved by their own writers. The same rules hold as for the Composition: one write in
// flight, a refused head reads Main again and writes the newest intent once more over it.

/** One write at a time; a value submitted while one is in flight replaces the one waiting behind it. */
export function latestLane<I, R>(run: (input: I) => Promise<R>, failed: R, onChange: () => void) {
  let running = false;
  let waiting: { input: I; resolvers: ((result: R) => void)[] } | null = null;
  async function go(first: { input: I; resolvers: ((result: R) => void)[] }) {
    running = true;
    onChange();
    let current: typeof first | null = first;
    while (current) {
      const result: R = await run(current.input).catch(() => failed);
      const next: typeof waiting = waiting;
      waiting = null;
      if (next) { next.resolvers.unshift(...current.resolvers); current = next; continue; }
      for (const resolve of current.resolvers) resolve(result);
      current = null;
    }
    running = false;
    onChange();
  }
  return {
    busy: () => running,
    submit: (input: I) => new Promise<R>(resolve => {
      if (running) waiting = { input, resolvers: [...(waiting?.resolvers ?? []), resolve] };
      else void go({ input, resolvers: [resolve] });
    }),
  };
}

export type SaveRefusal = 'sign-in' | 'denied' | 'invalid' | 'unavailable' | 'pending' | 'moved' | 'empty';
export type SaveOutcome = { kind: 'saved' } | { kind: 'unchanged' } | { kind: 'refused'; refusal: SaveRefusal };

// -- title and description --------------------------------------------------------------------

export interface DetailsSnapshot { head: string | null; values: DetailsValues; busy: boolean;
  failure: SaveRefusal | null }

const ownIndex = (values: DetailsValues, language: string) =>
  values.entries.findIndex(entry => entry.language.toLowerCase() === language.toLowerCase());

/** The title and description of the recipe's own language, as the header details hold them. */
export function entryOf(values: DetailsValues, language: string): { title: string; description: string } {
  const entry = values.entries[ownIndex(values, language)];
  return { title: entry?.title ?? '', description: entry?.description ?? '' };
}

function withEntry(values: DetailsValues, language: string, change: { title: string; description: string }): DetailsValues {
  const index = ownIndex(values, language);
  const own = index >= 0 ? values.entries[index]! : { language, title: '', description: '', tagline: '', label: null };
  const entries = index >= 0 ? values.entries.map((entry, at) => at === index ? { ...own, ...change } : entry)
    : [{ ...own, ...change }, ...values.entries];
  return { ...values, entries };
}

export function createDetailsSaver({ main, actingSubject, work, language, initial }: {
  main: () => MainClient; actingSubject: string; work: string; language: string; initial: { head: string | null; values: DetailsValues };
}) {
  let head = initial.head;
  let values = initial.values;
  let failure: SaveRefusal | null = null;
  let snapshot: DetailsSnapshot = { head, values, busy: false, failure };
  const listeners = new Set<() => void>();
  const notify = (busy = lane.busy()) => {
    snapshot = { head, values, busy, failure };
    for (const listener of listeners) listener();
  };

  async function run(change: { title: string; description: string }): Promise<SaveOutcome> {
    failure = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = entryOf(values, language);
      if (current.title === change.title && current.description === change.description) return { kind: 'unchanged' };
      const next = withEntry(values, language, change);
      const result = await saveWorkDetails({ actingSubject, work, head, values: next }, main());
      if (result.status === 'saved') { head = result.head; values = next; notify(); return { kind: 'saved' }; }
      if (result.status === 'stale') {
        // Someone saved first: read what Main holds and put this edit of the title and description over it.
        const read = await main().v1.works({ id: work.slice(-36) }).metadata.get({ query: { actingSubject } });
        if (!read.data) return refuse('unavailable');
        head = read.data.revision;
        values = detailsValues(read.data, language);
        continue;
      }
      if (result.status === 'denied') return refuse('denied');
      if (result.status === 'error') return refuse(result.reason === 'invalid' ? 'invalid' : result.reason === 'pending' ? 'pending' : 'unavailable');
    }
    return refuse('moved');
  }
  const refuse = (refusal: SaveRefusal): SaveOutcome => { failure = refusal; notify(); return { kind: 'refused', refusal }; };
  const lane = latestLane(run, { kind: 'refused', refusal: 'unavailable' } as SaveOutcome, () => notify());
  return {
    snapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    submit: (change: { title: string; description: string }) => lane.submit(change),
  };
}
export type DetailsSaver = ReturnType<typeof createDetailsSaver>;

// -- notes and publication --------------------------------------------------------------------

export interface NotesState { text: string | null; head: string | null; body: string; publicationHead: string | null }
export interface NotesSnapshot { notes: NotesState; busy: boolean; publishing: boolean; failure: SaveRefusal | null;
  /** True once this editor has published, or the notes were already published when it opened. */
  published: boolean }
export type PublishOutcome = { kind: 'published' } | { kind: 'refused'; refusal: SaveRefusal } | { kind: 'busy' };

const idOf = (iri: string) => iri.slice(-36);

export function createNotesWriter({ main, actingSubject, work, mainVersion, language, initial }: {
  main: () => MainClient; actingSubject: string; work: string; mainVersion: string; language: string; initial: NotesState;
}) {
  let notes = initial;
  let failure: SaveRefusal | null = null;
  let publishing = false;
  let snapshot: NotesSnapshot = { notes, busy: false, publishing, failure, published: Boolean(initial.publicationHead) };
  const listeners = new Set<() => void>();
  const notify = () => {
    snapshot = { notes, busy: lane.busy() || publishing, publishing, failure, published: Boolean(notes.publicationHead) };
    for (const listener of listeners) listener();
  };
  const target = { actingSubject, work, language };

  /** Writes `body` as the draft; a moved draft head is read and the body written once more over it. */
  async function write(body: string): Promise<SaveOutcome> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (notes.text && notes.body === body) return { kind: 'unchanged' };
      if (!body.trim()) return notes.text ? { kind: 'refused', refusal: 'empty' } : { kind: 'unchanged' };
      const saved = await saveText(target, notes.text, body, notes.head, crypto.randomUUID(),
        created => { notes = { ...notes, text: created }; }, main());
      if (saved.kind === 'saved') { notes = { ...notes, head: saved.head, body }; return { kind: 'saved' }; }
      if (saved.kind === 'conflict' && notes.text) {
        const latest = await readLatest(actingSubject, notes.text, main());
        if (!latest) return { kind: 'refused', refusal: 'unavailable' };
        notes = { ...notes, head: latest.head, body: latest.body };
        continue;
      }
      return { kind: 'refused', refusal: saved.kind === 'denied' ? 'denied' : saved.kind === 'conflict' ? 'moved' : 'unavailable' };
    }
    return { kind: 'refused', refusal: 'moved' };
  }
  async function save(body: string): Promise<SaveOutcome> {
    failure = null;
    const outcome = await write(body);
    if (outcome.kind === 'refused') failure = outcome.refusal;
    notify();
    return outcome;
  }
  const lane = latestLane(save, { kind: 'refused', refusal: 'unavailable' } as SaveOutcome, notify);

  async function publish(body: string): Promise<PublishOutcome> {
    if (publishing) return { kind: 'busy' };
    publishing = true;
    failure = null;
    notify();
    const fail = (refusal: SaveRefusal): PublishOutcome => { failure = refusal; return { kind: 'refused', refusal }; };
    try {
      // A save started by leaving the field finishes first, and what is in the field now is what gets published.
      const first = await lane.submit(body);
      if (first.kind === 'refused') return fail(first.refusal);
      for (let attempt = 0; attempt < 2; attempt++) {
        const saved = await write(body);
        if (saved.kind === 'refused') return fail(saved.refusal);
        if (!notes.text || !notes.head) return fail('invalid');
        const published = await publishText({ actingSubject, text: notes.text, head: notes.head,
          expectedPublicationHead: notes.publicationHead, key: crypto.randomUUID() }, main());
        if (published.outcome === 'stale') {
          const current = await main().v1.contributions({ contribution: idOf(notes.text) }).get({ query: { actingSubject } });
          if (!current.data) return fail('unavailable');
          notes = { ...notes, head: current.data.draftHead, publicationHead: current.data.publicationHead };
          continue;
        }
        if (published.outcome === 'denied') return fail('denied');
        if (published.outcome === 'pending') return fail('pending');
        if (published.outcome !== 'done' || !published.publication) return fail('unavailable');
        const selected = await selectMainText({ actingSubject, work, mainVersion, text: notes.text,
          publication: published.publication, key: crypto.randomUUID() }, main());
        if (selected === 'denied') return fail('denied');
        if (selected === 'pending') return fail('pending');
        if (selected !== 'done') return fail('unavailable');
        notes = { ...notes, publicationHead: published.publication.publicationDecision };
        return { kind: 'published' };
      }
      return fail('moved');
    } finally { publishing = false; notify(); }
  }
  return {
    snapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    save: (body: string) => lane.submit(body),
    publish,
  };
}
export type NotesWriter = ReturnType<typeof createNotesWriter>;
