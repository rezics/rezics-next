import { bodyText } from '../document-editor/body.ts';
import { saveWorkDetails, detailsValues } from '../studio/details-api.ts';
import type { DetailsValues } from '../studio/details-form.tsx';
import { publishText, readLatest, readTextRevision, saveText, selectMainText } from '../studio/text-api.ts';
import type { MainClient } from '../studio/types.ts';

// The recipe's title, description and notes live beside the Composition, each on its own head, so
// they are saved by their own writers. The same rules hold as for the Composition: one write in
// flight, a refused head reads Main again and writes the newest intent once more over it.

/**
 * One record's writes: at most one in flight and one newest slot behind it, which every newer
 * submission overwrites (`merge` says how, for inputs that must not simply replace each other). A
 * refused write that reads Main again asks `newest()` for what to write over it: the slot's input
 * if there is one, never the stale original, and the callers waiting on either share the outcome.
 */
export function latestLane<I, R>(run: (input: I, newest: () => I) => Promise<R>, failed: R, onChange: () => void,
  merge: (waiting: I, next: I) => I = (_waiting, next) => next) {
  type Task = { input: I; resolvers: ((result: R) => void)[] };
  let running = false;
  let current: Task | null = null;
  let waiting: Task | null = null;
  const newest = () => {
    if (waiting && current) {
      current = { input: merge(current.input, waiting.input), resolvers: [...current.resolvers, ...waiting.resolvers] };
      waiting = null;
    }
    return current!.input;
  };
  async function go(first: Task) {
    running = true;
    current = first;
    onChange();
    while (current) {
      const task: Task = current;
      const result: R = await run(task.input, newest).catch(() => failed);
      const done: Task = current;
      for (const resolve of done.resolvers) resolve(result);
      current = waiting;
      waiting = null;
    }
    running = false;
    onChange();
  }
  return {
    busy: () => running,
    submit: (input: I) => new Promise<R>(resolve => {
      if (!running) { void go({ input, resolvers: [resolve] }); return; }
      waiting = { input: waiting ? merge(waiting.input, input) : input, resolvers: [...(waiting?.resolvers ?? []), resolve] };
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

  async function run(first: { title: string; description: string },
    newest: () => { title: string; description: string }): Promise<SaveOutcome> {
    failure = null;
    let change = first;
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
        // Only the newest title and description are written over what Main holds now.
        change = newest();
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
export type PublishOutcome = { kind: 'published' } | { kind: 'refused'; refusal: SaveRefusal };
type NotesOutcome = SaveOutcome | { kind: 'published' };

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
    snapshot = { notes, busy: lane.busy(), publishing, failure, published: Boolean(notes.publicationHead) };
    for (const listener of listeners) listener();
  };
  const target = { actingSubject, work, language };
  type Task = { body: string; publish: boolean };

  /** Writes `body` as the draft; a moved draft head is read, and the newest body is written over it. */
  async function write(first: string, adopt: () => string): Promise<SaveOutcome> {
    let body = first;
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
        body = adopt();
        continue;
      }
      return { kind: 'refused', refusal: saved.kind === 'denied' ? 'denied' : saved.kind === 'conflict' ? 'moved' : 'unavailable' };
    }
    return { kind: 'refused', refusal: 'moved' };
  }

  /**
   * One task of the notes record: save the body, and for a publication publish it and select it as the
   * text readers open. Publication runs in this lane, so a field save made meanwhile waits in the newest
   * slot and never overlaps it, and a publication waits for the saves ahead of it.
   */
  async function runTask(first: Task, newest: () => Task): Promise<NotesOutcome> {
    let task = first;
    const adopt = () => { task = newest(); return task.body; };
    failure = null;
    publishing = task.publish;
    notify();
    const finish = (outcome: NotesOutcome): NotesOutcome => {
      failure = outcome.kind === 'refused' ? outcome.refusal : null;
      return outcome;
    };
    const fail = (refusal: SaveRefusal) => finish({ kind: 'refused', refusal });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const saved = await write(task.body, adopt);
        if (saved.kind === 'refused') return finish(saved);
        if (!task.publish) return finish(saved);
        publishing = true;
        if (!notes.text || !notes.head) return fail('invalid');
        const published = await publishText({ actingSubject, text: notes.text, head: notes.head,
          expectedPublicationHead: notes.publicationHead, key: crypto.randomUUID() }, main());
        if (published.outcome === 'stale') {
          const current = await main().v1.contributions({ contribution: idOf(notes.text) }).get({ query: { actingSubject } });
          if (!current.data) return fail('unavailable');
          // The head moved. Read that revision's body before treating this publication as already saved:
          // the text held here can still match what this tab wants while the new draft says something else.
          const read = await readTextRevision(actingSubject, notes.text, current.data.draftHead, main());
          if (read === null) return fail('unavailable');
          notes = { ...notes, head: current.data.draftHead, body: bodyText(read), publicationHead: current.data.publicationHead };
          adopt();
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
        return finish({ kind: 'published' });
      }
      return fail('moved');
    } finally { publishing = false; notify(); }
  }
  const lane = latestLane(runTask, { kind: 'refused', refusal: 'unavailable' } as NotesOutcome, notify,
    // A save that lands behind a waiting publication joins it: the publication is of what is typed last.
    (waiting, next) => ({ body: next.body, publish: waiting.publish || next.publish }));

  return {
    snapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async save(body: string): Promise<SaveOutcome> {
      const outcome = await lane.submit({ body, publish: false });
      return outcome.kind === 'published' ? { kind: 'saved' } : outcome;
    },
    async publish(body: string): Promise<PublishOutcome> {
      const outcome = await lane.submit({ body, publish: true });
      return outcome.kind === 'published' || outcome.kind === 'refused' ? outcome : { kind: 'refused', refusal: 'unavailable' };
    },
  };
}
export type NotesWriter = ReturnType<typeof createNotesWriter>;
