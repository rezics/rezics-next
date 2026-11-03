import {
  documentText,
  fromPlainText,
  parseDocument,
  withDocumentIds,
  type DocumentNode,
  type DocumentSnapshot,
} from '@rezics/document';

// Fixed slots make even recovery from a broken index bounded. No origin-wide enumeration.
export const writingNamespace = 'rezics:private-writing:v1';
export const writingIndexKey = `${writingNamespace}:index`;
export const writingSlotKey = (slot: number) => `${writingNamespace}:${slot}`;
export const writingLimits = { entries: 16, bytes: 128 * 1024, idle: 750, age: 30 * 86400_000 } as const;
const indexLimit = 64 * 1024;
const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value).byteLength;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128;

export type WritingScope = {
  kind: 'thread' | 'reply';
  boardId?: string;
  threadId?: string;
  parentId?: string;
  // Only selected Subject ids, never fetched labels, citations, receipts or arbitrary caller DTOs.
  subjects: string[];
};
export type WritingPayload = { title: string; body: DocumentSnapshot; text: string; attachmentRepair: boolean };
export type WritingMetadata = {
  slot: number;
  actor: string;
  scope: WritingScope;
  revision: string;
  updated: number;
  bytes: number;
  state: 'unsent' | 'unknown';
};
export type SavedWriting = WritingMetadata & { payload: WritingPayload };
export type WritingIssue = 'storage' | 'corrupt' | 'version' | 'limit' | 'changed' | 'document';
export class WritingError extends Error {
  constructor(readonly issue: WritingIssue) {
    super(`Browser writing: ${issue}`);
  }
}
export type WritingStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Index = { version: 1; entries: WritingMetadata[] };
export type Replacement = { revision: string; updated: number; expired: boolean };
export type SaveResult = { saved: SavedWriting } | { replace: Replacement };

function scopeValue(value: unknown): WritingScope {
  if (!record(value) || !['thread', 'reply'].includes(String(value.kind))) throw new WritingError('corrupt');
  if (!Array.isArray(value.subjects) || value.subjects.length > 16 || !value.subjects.every(identity))
    throw new WritingError('corrupt');
  if (Object.keys(value).some((key) => !['kind', 'boardId', 'threadId', 'parentId', 'subjects'].includes(key)))
    throw new WritingError('corrupt');
  for (const key of ['boardId', 'threadId', 'parentId'])
    if (value[key] !== undefined && !identity(value[key])) throw new WritingError('corrupt');
  if (value.kind === 'thread' ? !identity(value.boardId) : !identity(value.threadId)) throw new WritingError('corrupt');
  return value as WritingScope;
}
export const sameWritingScope = (a: WritingScope, b: WritingScope) => JSON.stringify(a) === JSON.stringify(b);

/** Explicit allowlist at the composer boundary; generic submission context is never serialized. */
export function writingScope(input: {
  boardId?: string | undefined;
  containerId?: string | undefined;
  replyTargetId?: string | null | undefined;
  submissionContext?: unknown;
}): WritingScope | null {
  const context = input.submissionContext;
  const subjects = record(context)
    ? typeof context.subjectId === 'string'
      ? [context.subjectId]
      : Array.isArray(context.subjectIds)
        ? context.subjectIds.filter((id): id is string => typeof id === 'string')
        : []
    : [];
  const scope = input.containerId
    ? { kind: 'reply' as const, threadId: input.containerId, ...(input.replyTargetId ? { parentId: input.replyTargetId } : {}), subjects: [] }
    : input.boardId
      ? { kind: 'thread' as const, boardId: input.boardId, subjects: [...new Set(subjects)].sort() }
      : null;
  if (!scope) return null;
  try { return scopeValue(scope); } catch { return null; }
}

/** No installed reload admission exists for uploaded media or opaque component capabilities. */
export function prepareWriting(title: string, body: DocumentSnapshot): WritingPayload {
  try { parseDocument(body); } catch { throw new WritingError('document'); }
  let attachmentRepair = false;
  const visit = (node: DocumentNode): DocumentNode => {
    if (['image', 'media', 'extensionBlock', 'extensionInline'].includes(node.type)) {
      attachmentRepair = true;
      const label = node.attrs?.alt ?? node.attrs?.caption ?? node.attrs?.fallback;
      const text = typeof label === 'string' ? label : '';
      return node.type === 'extensionInline'
        ? { type: 'text', text: text || ' ' }
        : { type: 'paragraph', content: text ? [{ type: 'text', text }] : [] };
    }
    return { ...node, ...(node.content ? { content: node.content.map(visit) } : {}) };
  };
  const sanitized = { version: body.version, profile: body.profile, doc: withDocumentIds(visit(body.doc)) };
  try { parseDocument(sanitized); } catch { throw new WritingError('document'); }
  return { title, body: sanitized, text: documentText(sanitized), attachmentRepair };
}

function metadata(value: unknown): WritingMetadata {
  if (!record(value) || !integer(value.slot) || value.slot >= writingLimits.entries || !identity(value.actor) ||
      !identity(value.revision) || !integer(value.updated) || !integer(value.bytes) || value.bytes > writingLimits.bytes ||
      (value.state !== 'unsent' && value.state !== 'unknown') ||
      Object.keys(value).some((key) => !['slot', 'actor', 'scope', 'revision', 'updated', 'bytes', 'state'].includes(key)))
    throw new WritingError('corrupt');
  scopeValue(value.scope);
  return value as WritingMetadata;
}

function parseIndex(raw: string | null): Index {
  if (raw === null) return { version: 1, entries: [] };
  if (raw.length > indexLimit || bytes(raw) > indexLimit) throw new WritingError('corrupt');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new WritingError('corrupt'); }
  if (!record(value)) throw new WritingError('corrupt');
  if (value.version !== 1) throw new WritingError('version');
  if (!Array.isArray(value.entries) || value.entries.length > writingLimits.entries ||
      Object.keys(value).some((key) => !['version', 'entries'].includes(key))) throw new WritingError('corrupt');
  const entries = value.entries.map(metadata);
  if (new Set(entries.map((entry) => entry.slot)).size !== entries.length ||
      new Set(entries.map((entry) => entry.revision)).size !== entries.length) throw new WritingError('corrupt');
  return { version: 1, entries };
}

function decodePayload(raw: string | null, entry: WritingMetadata): WritingPayload {
  if (raw === null || raw.length > writingLimits.bytes || bytes(raw) !== entry.bytes) throw new WritingError('corrupt');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new WritingError('corrupt'); }
  if (!record(value) || value.version !== 1) throw new WritingError('version');
  if (value.revision !== entry.revision || !record(value.payload)) throw new WritingError('corrupt');
  const payload = value.payload;
  if (typeof payload.title !== 'string' || typeof payload.text !== 'string' || typeof payload.attachmentRepair !== 'boolean' ||
      Object.keys(value).some((key) => !['version', 'revision', 'payload'].includes(key)) ||
      Object.keys(payload).some((key) => !['title', 'body', 'text', 'attachmentRepair'].includes(key))) throw new WritingError('corrupt');
  if (!record(payload.body) || payload.body.version !== 'rezics-document-v1') throw new WritingError('version');
  const sanitized = prepareWriting(payload.title, payload.body as unknown as DocumentSnapshot);
  // Stored native capabilities are rejected, including a tampered v1 payload.
  if (sanitized.attachmentRepair || sanitized.text !== payload.text) throw new WritingError('corrupt');
  return { ...sanitized, attachmentRepair: payload.attachmentRepair };
}

/** O(K) index operations and O(B) for one payload. Never reads another account's body. */
export class BrowserWritingStore {
  constructor(private readonly storage: WritingStorage, private readonly now: () => number = Date.now) {}
  private access<T>(action: () => T): T {
    try { return action(); } catch (error) {
      if (error instanceof WritingError) throw error;
      throw new WritingError('storage');
    }
  }
  private index() { return parseIndex(this.storage.getItem(writingIndexKey)); }
  private writeIndex(index: Index) { this.storage.setItem(writingIndexKey, JSON.stringify(index)); }

  load(actor: string, scope: WritingScope): SavedWriting | null {
    return this.access(() => {
      const entry = this.index().entries.filter((item) => item.actor === actor && sameWritingScope(item.scope, scope))
        .sort((a, b) => b.updated - a.updated)[0];
      if (!entry) return null;
      return { ...entry, payload: decodePayload(this.storage.getItem(writingSlotKey(entry.slot)), entry) };
    });
  }

  save(actor: string, scope: WritingScope, payload: WritingPayload, previous: SavedWriting | null, consent?: string): SaveResult {
    return this.access(() => {
      if (!identity(actor)) throw new WritingError('corrupt');
      scopeValue(scope);
      const index = this.index();
      const exact = previous && index.entries.find((entry) => entry.revision === previous.revision && entry.actor === actor);
      if (previous && !exact) throw new WritingError('changed');
      if (exact?.state === 'unknown') throw new WritingError('changed');
      const matched = index.entries.find((entry) => entry.actor === actor && sameWritingScope(entry.scope, scope));
      const oldest = [...index.entries].sort((a, b) => a.updated - b.updated)[0];
      const victim = exact ? undefined : (matched ?? (index.entries.length === writingLimits.entries ? oldest : undefined));
      if (victim && consent !== victim.revision)
        return { replace: { revision: victim.revision, updated: victim.updated, expired: this.now() - victim.updated > writingLimits.age } };
      const occupied = new Set(index.entries.map((entry) => entry.slot));
      const slot = exact?.slot ?? victim?.slot ?? Array.from({ length: writingLimits.entries }, (_, n) => n).find((n) => !occupied.has(n))!;
      const revision = crypto.randomUUID();
      // Revalidate the allowlisted envelope even for callers other than the mounted composer.
      const safe = prepareWriting(payload.title, payload.body);
      safe.attachmentRepair ||= payload.attachmentRepair;
      const raw = JSON.stringify({ version: 1, revision, payload: safe });
      if (bytes(raw) > writingLimits.bytes) throw new WritingError('limit');
      const entry: WritingMetadata = { slot, actor, scope, revision, updated: this.now(), bytes: bytes(raw), state: 'unsent' };
      // A failed/crashed payload/index pair cannot be decoded as a different revision.
      // Restore the old bytes on an index failure where possible; live writing always stays with the caller.
      const oldRaw = this.storage.getItem(writingSlotKey(slot));
      this.storage.setItem(writingSlotKey(slot), raw);
      try { this.writeIndex({ version: 1, entries: [...index.entries.filter((item) => item.slot !== slot), entry] }); }
      catch (error) {
        try {
          if (oldRaw === null) this.storage.removeItem(writingSlotKey(slot));
          else this.storage.setItem(writingSlotKey(slot), oldRaw);
        } catch { /* A mismatched revision remains unavailable, never restored. */ }
        throw error;
      }
      return { saved: { ...entry, payload: safe } };
    });
  }

  /** Fence reload recovery before starting transport; failure prevents starting that transport. */
  mark(saved: SavedWriting, state: 'unsent' | 'unknown'): SavedWriting {
    return this.access(() => {
      const index = this.index();
      const exact = index.entries.find((entry) => entry.revision === saved.revision && entry.actor === saved.actor);
      if (!exact) throw new WritingError('changed');
      this.writeIndex({ version: 1, entries: index.entries.map((entry) => entry === exact ? { ...entry, state } : entry) });
      return { ...saved, state };
    });
  }

  discard(saved: SavedWriting): void {
    this.access(() => {
      const index = this.index();
      const exact = index.entries.find((entry) => entry.revision === saved.revision && entry.actor === saved.actor);
      if (!exact) return; // A different visit's replacement must survive exact cleanup.
      this.writeIndex({ version: 1, entries: index.entries.filter((entry) => entry !== exact) });
      this.storage.removeItem(writingSlotKey(exact.slot));
    });
  }

  /** Explicit recovery choice; fixed slots only, never scans unrelated localStorage. */
  discardNamespace(): void {
    this.access(() => {
      for (let slot = 0; slot < writingLimits.entries; slot++) this.storage.removeItem(writingSlotKey(slot));
      this.storage.removeItem(writingIndexKey);
    });
  }
}

export type WritingStatus = {
  enabled: boolean;
  preview: SavedWriting | null;
  saved: SavedWriting | null;
  replacement: Replacement | null;
  issue: WritingIssue | null;
  pending: boolean;
};

/** Mounted visit ownership and debounce are independent of React scheduling. */
export class LocalWritingDraft {
  private active = true;
  private previewFenced = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queued: (() => WritingPayload) | undefined;
  private state: WritingStatus = { enabled: false, preview: null, saved: null, replacement: null, issue: null, pending: false };
  private listeners = new Set<() => void>();
  constructor(
    private readonly store: () => BrowserWritingStore,
    readonly actor: string,
    readonly scope: WritingScope,
    private readonly current: () => boolean,
    readonly signal: AbortSignal,
    private readonly clock: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: setTimeout, clear: clearTimeout },
  ) { signal.addEventListener('abort', this.retire, { once: true }); }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private valid() { if (!this.current() || this.signal.aborted) this.retire(); return this.active; }
  private update(next: Partial<WritingStatus>) {
    this.state = { ...this.state, ...next };
    this.listeners.forEach((listener) => listener());
  }
  private fail(error: unknown) { this.update({ issue: error instanceof WritingError ? error.issue : 'storage', pending: false }); }
  cancel = () => {
    if (this.timer !== undefined) this.clock.clear(this.timer);
    this.timer = undefined;
    this.queued = undefined;
  };
  retire = () => {
    if (!this.active) return;
    this.active = false;
    this.cancel();
    this.signal.removeEventListener('abort', this.retire);
    this.update({ enabled: false, preview: null, saved: null, replacement: null, pending: false, issue: null });
  };
  load() {
    if (!this.valid()) return;
    try { this.update({ preview: this.store().load(this.actor, this.scope), issue: null }); }
    catch (error) { this.fail(error); }
  }
  enable(read: () => WritingPayload) {
    if (!this.valid() || this.state.pending || this.state.preview) return;
    this.update({ enabled: true, issue: null });
    this.schedule(read);
  }
  pause() { this.cancel(); this.update({ enabled: false, replacement: null }); }
  retry(read: () => WritingPayload) {
    if (!this.valid() || this.state.pending || this.state.preview) return;
    this.update({ issue: null, enabled: true });
    this.schedule(read);
  }
  schedule(read: () => WritingPayload) {
    this.cancel();
    if (!this.valid() || !this.state.enabled || this.state.pending || this.state.preview || this.state.issue || this.state.replacement) return;
    this.queued = read;
    this.timer = this.clock.set(() => {
      this.timer = undefined;
      const queued = this.queued;
      this.queued = undefined;
      if (this.valid() && queued && !this.state.pending) this.persist(queued);
    }, writingLimits.idle);
  }
  private persist(read: () => WritingPayload, consent?: string) {
    if (!this.valid()) return;
    try {
      const result = this.store().save(this.actor, this.scope, read(), this.state.saved, consent);
      if ('replace' in result) this.update({ replacement: result.replace });
      else this.update({ saved: result.saved, replacement: null, issue: null });
    } catch (error) { this.fail(error); }
  }
  replace(read: () => WritingPayload) {
    if (!this.valid() || this.state.pending || !this.state.replacement) return;
    this.persist(read, this.state.replacement.revision);
  }
  restore(): WritingPayload | null {
    if (!this.valid() || this.state.pending || !this.state.preview || this.state.preview.state === 'unknown') return null;
    try {
      const fresh = this.store().load(this.actor, this.scope);
      if (!fresh || fresh.revision !== this.state.preview.revision || fresh.state !== 'unsent') throw new WritingError('changed');
      this.update({ preview: null, saved: fresh, issue: null, enabled: false });
      return fresh.payload;
    } catch (error) { this.fail(error); return null; }
  }
  discard() {
    if (!this.valid() || this.state.pending) return;
    this.cancel();
    try {
      const saved = this.state.preview ?? this.state.saved;
      if (saved) this.store().discard(saved);
      this.update({ enabled: false, preview: null, saved: null, replacement: null, issue: null });
    } catch (error) { this.fail(error); }
  }
  discardBroken() {
    if (!this.valid() || this.state.pending) return;
    this.cancel();
    try {
      this.store().discardNamespace();
      this.update({ enabled: false, preview: null, saved: null, replacement: null, issue: null });
    } catch (error) { this.fail(error); }
  }
  /** Save uncertainty first. A denied marker never permits a saved draft to become a new replay. */
  beginSubmission(): boolean {
    this.cancel();
    if (!this.valid()) return false;
    try {
      if (this.state.saved) this.update({ saved: this.store().mark(this.state.saved, 'unknown') });
      // Unchosen reload preview may contain this writing: conservatively fence it too.
      if (this.state.preview && this.state.preview.state === 'unsent') {
        this.update({ preview: this.store().mark(this.state.preview, 'unknown') });
        this.previewFenced = true;
      }
      this.update({ pending: true });
      return true;
    } catch (error) { this.fail(error); return false; }
  }
  settle(outcome: 'success' | 'refused' | 'unknown') {
    if (!this.valid()) return;
    try {
      if (outcome === 'success') {
        if (this.state.saved) this.store().discard(this.state.saved);
        this.update({ enabled: false, saved: null, pending: false });
      } else if (outcome === 'refused') {
        if (this.state.saved) this.update({ saved: this.store().mark(this.state.saved, 'unsent') });
        if (this.state.preview && this.previewFenced) {
          this.update({ preview: this.store().mark(this.state.preview, 'unsent') });
          this.previewFenced = false;
        }
        this.update({ pending: false });
      }
      // Unknown stays suspended through the exact current-visit retry.
    } catch (error) { this.fail(error); this.update({ pending: outcome === 'unknown' }); }
  }
}
