import * as v from 'valibot';
import { bookTocRows } from './book-toc';
import {
  sameExact,
  type BookOrganizerPort,
  type BookPlacement,
  type BookStructure,
  type ExactDocument,
  type PublicationTarget,
  type StudioResult,
} from './contract';
import {
  hostedKey,
  type HostedBook,
  type HostedBookNative,
  type HostedCreate,
  type HostedPlacement,
  type HostedPublish,
  type HostedRevise,
  type HostedTarget,
  type HostedTargetResolver,
} from './hosted-contract';
import { hostedFailure } from './hosted-native';
import { hostedBookStructure, hostedOccurrenceId } from './hosted-structure';

export type HostedBookPublicationInput = Readonly<{
  target: Extract<PublicationTarget, { kind: 'book' }>;
  /** Required even for a first release. A failed read must never be interpreted as null. */
  expectedPublicationId: string | null;
  idempotencyKey: string;
}>;
type Change = Parameters<BookOrganizerPort['change']>[0];
type Attempt = {
  signature: string;
  key: string;
  unresolved: boolean;
  command:
    | { kind: 'create'; body: HostedCreate }
    | { kind: 'revise'; catalogueId: string; body: HostedRevise }
    | { kind: 'publish'; catalogueId: string; body: HostedPublish };
};
const stale = () => hostedFailure('stale', 'Reload the book structure before preparing this operation.');
const invalid = () =>
  hostedFailure('invalid', 'The selected placement or exact document is not valid for this operation.');
const ended = () => hostedFailure('denied', 'This Studio visit has ended. Reopen the workspace.');

/** One private visit. Only placement metadata is retained; drafts and document bodies stay with StudioPort. */
export class HostedBookAdapter implements BookOrganizerPort {
  private book: HostedBook | null = null;
  private attempt: Attempt | null = null;
  private busy = false;

  constructor(
    private readonly native: HostedBookNative,
    private readonly current: () => boolean,
    private readonly resolveTarget: HostedTargetResolver,
  ) {}

  isCurrent = (): boolean => this.current();
  hasUnresolvedCommand = (): boolean => Boolean(this.attempt?.unresolved);
  currentStructure = (): BookStructure | null => (this.book ? hostedBookStructure(this.book) : null);
  chapterTargets = () =>
    this.book?.placements.flatMap((placement) =>
      placement.kind === 'chapter' ? [structuredClone(placement.target)] : [],
    ) ?? [];

  private async exclusive<T>(signal: AbortSignal, run: () => Promise<StudioResult<T>>): Promise<StudioResult<T>> {
    if (!this.current() || signal.aborted) return ended();
    if (this.busy) return hostedFailure('unavailable', 'Finish the current book operation first.');
    this.busy = true;
    try {
      const result = await run();
      if (!this.current() || signal.aborted) {
        this.book = null;
        if (this.current() && this.attempt?.unresolved)
          return hostedFailure(
            'uncertain',
            'The command was interrupted. Retry the same operation to recover its result.',
          );
        return ended();
      }
      return result;
    } catch {
      return this.attempt?.unresolved
        ? hostedFailure('uncertain', 'The command result is unknown. Retry the same operation.')
        : invalid();
    } finally {
      this.busy = false;
    }
  }

  load = (catalogueId: string, signal: AbortSignal, revisionId?: string): Promise<StudioResult<BookStructure>> =>
    this.exclusive(signal, async () => {
      if (this.hasUnresolvedCommand())
        return hostedFailure('uncertain', 'Recover the pending book command before reloading.');
      this.book = null;
      const result = await this.native.read(
        { catalogueId, kind: 'structure', ...(revisionId ? { revisionId } : {}) },
        signal,
      );
      if (!result.ok) return result;
      if (result.value.revision.catalogueId !== catalogueId || result.value.revision.kind !== 'structure')
        return invalid();
      const structure = hostedBookStructure(result.value);
      this.book = structuredClone(result.value);
      return { ok: true, value: structure };
    });

  readPublication = (
    catalogueId: string,
    signal: AbortSignal,
    revisionId?: string,
  ): Promise<StudioResult<HostedBook>> =>
    this.exclusive(signal, async () => {
      const result = await this.native.read(
        { catalogueId, kind: 'publication', ...(revisionId ? { revisionId } : {}) },
        signal,
      );
      if (
        result.ok &&
        (result.value.revision.catalogueId !== catalogueId ||
          result.value.revision.kind !== 'publication' ||
          (revisionId && result.value.revision.revisionId !== revisionId))
      )
        return invalid();
      return result;
    });

  private replay(signature: string, key: string): StudioResult<Attempt | null> {
    if (!v.is(hostedKey, key)) return invalid();
    if (this.attempt?.key === key)
      return this.attempt.signature === signature
        ? { ok: true, value: this.attempt }
        : hostedFailure('invalid', 'An operation key cannot be reused for different changes.');
    if (this.hasUnresolvedCommand())
      return hostedFailure('uncertain', 'Retry the pending operation with its original key and input.');
    return { ok: true, value: null };
  }

  private async execute(attempt: Attempt, signal: AbortSignal): Promise<StudioResult<HostedBook>> {
    this.attempt = attempt;
    attempt.unresolved = true;
    const command = attempt.command;
    const result =
      command.kind === 'create'
        ? await this.native.create(command.body, attempt.key, signal)
        : command.kind === 'revise'
          ? await this.native.revise(command.catalogueId, command.body, attempt.key, signal)
          : await this.native.publish(command.catalogueId, command.body, attempt.key, signal);
    if (!this.current() || signal.aborted) return ended();
    if (!result.ok) {
      attempt.unresolved = result.error.kind === 'uncertain' || result.error.kind === 'unavailable';
      return result;
    }
    const expectedCatalogue = command.kind === 'create' ? command.body.postId : command.catalogueId;
    const expectedKind = command.kind === 'publish' ? 'publication' : 'structure';
    if (
      result.value.revision.catalogueId !== expectedCatalogue ||
      result.value.revision.kind !== expectedKind ||
      result.value.revision.sourceRevisionId !== (command.kind === 'publish' ? command.body.expectedRevisionId : null)
    )
      return hostedFailure('uncertain', 'The acknowledged book revision could not be read. Retry the same operation.');
    hostedBookStructure(result.value);
    attempt.unresolved = false;
    if (expectedKind === 'structure') this.book = structuredClone(result.value);
    return result;
  }

  /** Attach a catalogue to an existing Content Post; this does not create another draft or document store. */
  create = (input: HostedCreate, idempotencyKey: string, signal: AbortSignal): Promise<StudioResult<BookStructure>> =>
    this.exclusive(signal, async () => {
      const signature = JSON.stringify(['create', input]);
      const replay = this.replay(signature, idempotencyKey);
      if (!replay.ok) return replay;
      const result = await this.execute(
        replay.value ?? {
          signature,
          key: idempotencyKey,
          unresolved: false,
          command: { kind: 'create', body: structuredClone(input) },
        },
        signal,
      );
      return result.ok ? { ok: true, value: hostedBookStructure(result.value) } : result;
    });

  private async target(document: ExactDocument, signal: AbortSignal): Promise<StudioResult<HostedTarget>> {
    const known = this.book?.placements.find(
      (placement) => placement.kind === 'chapter' && sameExact(placement.target, document),
    );
    if (known?.kind === 'chapter') return { ok: true, value: { ...known.target } };
    const result = await this.resolveTarget(document, signal);
    if (!result.ok) return result;
    return sameExact(result.value, document) ? result : invalid();
  }

  change = (input: Change, signal: AbortSignal): Promise<StudioResult<BookStructure>> =>
    this.exclusive(signal, async () => {
      const signature = JSON.stringify(['revise', input]);
      const replay = this.replay(signature, input.idempotencyKey);
      if (!replay.ok) return replay;
      let attempt = replay.value;
      if (!attempt) {
        const book = this.book;
        if (
          !book ||
          book.revision.catalogueId !== input.catalogueId ||
          book.revision.revisionId !== input.expectedRevision
        )
          return stale();
        const structure = hostedBookStructure(book);
        const rows = bookTocRows(structure);
        let placements = [...structure.placements];
        const change = structuredClone(input.change);
        const selected =
          change.kind === 'insert' ? null : placements.find((entry) => entry.occurrenceId === change.occurrenceId);
        if (change.kind !== 'insert' && !selected) return invalid();
        if (change.kind === 'remove') {
          const removed = new Set(
            rows
              .filter(
                (row) =>
                  row.placement.occurrenceId === change.occurrenceId || row.ancestors.includes(change.occurrenceId),
              )
              .map((row) => row.placement.occurrenceId),
          );
          placements = placements.filter((entry) => !removed.has(entry.occurrenceId));
        } else if (change.kind === 'rename') {
          placements = placements.map((entry) => (entry === selected ? { ...entry, title: change.title } : entry));
        } else if (change.kind === 'pin') {
          if (selected?.target.kind !== 'chapter' || selected.target.document.postId !== change.document.postId)
            return invalid();
          placements = placements.map((entry) =>
            entry === selected ? { ...entry, target: { kind: 'chapter', document: change.document } } : entry,
          );
        } else {
          const entry: BookPlacement =
            change.kind === 'insert'
              ? {
                  occurrenceId: await hostedOccurrenceId(input.catalogueId, input.idempotencyKey),
                  parentOccurrenceId: change.parentOccurrenceId,
                  title: change.title,
                  target: change.target,
                }
              : { ...selected!, parentOccurrenceId: change.parentOccurrenceId };
          if (change.kind === 'move') placements = placements.filter((candidate) => candidate !== selected);
          const siblings = placements.filter((candidate) => candidate.parentOccurrenceId === change.parentOccurrenceId);
          const before =
            change.beforeOccurrenceId === null
              ? null
              : siblings.find((candidate) => candidate.occurrenceId === change.beforeOccurrenceId);
          if (change.beforeOccurrenceId !== null && !before) return invalid();
          const index = before
            ? placements.indexOf(before)
            : siblings.length
              ? placements.indexOf(siblings[siblings.length - 1]!) + 1
              : placements.length;
          placements.splice(index, 0, entry);
        }
        const next = bookTocRows({ ...structure, placements });
        const nativePlacements: HostedPlacement[] = [];
        for (const row of next) {
          const entry = row.placement;
          const address = {
            occurrenceId: entry.occurrenceId,
            parentId: entry.parentOccurrenceId,
            position: row.index,
            title: entry.title,
          };
          if (entry.target.kind === 'part') nativePlacements.push({ ...address, kind: 'part' });
          else {
            const target = await this.target(entry.target.document, signal);
            if (!target.ok) return target;
            nativePlacements.push({ ...address, kind: 'chapter', target: target.value });
          }
        }
        // Validate exact native addresses and bounds before retaining a command for replay.
        hostedBookStructure({ revision: book.revision, placements: nativePlacements });
        attempt = {
          signature,
          key: input.idempotencyKey,
          unresolved: false,
          command: {
            kind: 'revise',
            catalogueId: input.catalogueId,
            body: { expectedRevisionId: input.expectedRevision, placements: nativePlacements },
          },
        };
      }
      if (!this.current() || signal.aborted) return ended();
      const result = await this.execute(attempt, signal);
      return result.ok ? { ok: true, value: hostedBookStructure(result.value) } : result;
    });

  /** Local selection review is not a native review token. Content checks both heads atomically on publish. */
  publish = (input: HostedBookPublicationInput, signal: AbortSignal): Promise<StudioResult<HostedBook>> =>
    this.exclusive(signal, async () => {
      const signature = JSON.stringify(['publish', input]);
      const replay = this.replay(signature, input.idempotencyKey);
      if (!replay.ok) return replay;
      let attempt = replay.value;
      if (!attempt) {
        const book = this.book;
        const target = input.target;
        if (
          !book ||
          book.revision.catalogueId !== target.catalogueId ||
          book.revision.revisionId !== target.structureRevision
        )
          return stale();
        const rows = bookTocRows(hostedBookStructure(book));
        const ids = new Set<string>();
        const chapters = new Set<string>();
        if (!target.chapters.length) return invalid();
        for (const chapter of target.chapters) {
          const row = rows.find((entry) => entry.placement.occurrenceId === chapter.occurrenceId);
          if (
            !row ||
            row.placement.target.kind !== 'chapter' ||
            chapters.has(chapter.occurrenceId) ||
            !sameExact(row.placement.target.document, chapter.document)
          )
            return invalid();
          chapters.add(chapter.occurrenceId);
          ids.add(chapter.occurrenceId);
          row.ancestors.forEach((id) => ids.add(id));
        }
        attempt = {
          signature,
          key: input.idempotencyKey,
          unresolved: false,
          command: {
            kind: 'publish',
            catalogueId: target.catalogueId,
            body: {
              expectedRevisionId: target.structureRevision,
              expectedPublicationId: input.expectedPublicationId,
              occurrenceIds: rows
                .filter((row) => ids.has(row.placement.occurrenceId))
                .map((row) => row.placement.occurrenceId),
            },
          },
        };
      }
      return this.execute(attempt, signal);
    });
}
