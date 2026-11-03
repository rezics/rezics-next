import {
  checkDocument,
  documentText,
  hasDocumentContent,
  normalizeDocument,
  serializeDocument,
  type DocumentNode,
  type DocumentSnapshot,
} from '@rezics/document';
import { portableWritingLimits } from './portable-writing';
import { replyImageLimit } from './upload';
import { threadTitleCodeUnitLimit } from './authoring-limits';

/** Inspection inherits the delivered editor's ceiling, not an HTTP request budget. */
export const writingInspectionLimits = Object.freeze({
  bytes: portableWritingLimits.snapshotBytes,
  depth: portableWritingLimits.depth,
  outline: 100,
  diagnostics: 20,
  labelCodePoints: 80,
  idleMs: 750,
});

export type SnapshotPhase = 'ready' | 'pending' | 'failed';
export type InspectionProblem = 'document' | 'depth' | 'size' | 'profile';
export type OutlineKind =
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'quote'
  | 'code'
  | 'table'
  | 'image'
  | 'media'
  | 'component'
  | 'block';
export type InspectionOutlineEntry = Readonly<{
  id: string | null;
  kind: OutlineKind;
  level: number | null;
  label: string;
  ordinal: number;
}>;
export type InspectionIssue = Readonly<{
  kind: 'empty' | 'title-empty' | 'title-size' | 'images' | 'upload' | 'attachment' | 'refusal' | 'unknown' | 'sending';
  id: string | null;
  detail?: string;
  count?: number;
}>;
export type InspectionFacts = Readonly<{
  pendingUploads: number;
  attachmentIssues: readonly { id: string; state: string }[];
  refusal: string | null;
  unknown: boolean;
  sending: boolean;
}>;
export type InspectionSummary = Readonly<{
  textCodePoints: number;
  jsonBytes: number;
  canonicalBytes: number;
  nodes: number;
  images: number;
  media: number;
  mentions: number;
  links: number;
  titleCodeUnits: number | null;
  titleRemaining: number | null;
  imageRemaining: number;
}>;
export type InspectionProjection = Readonly<{
  body: DocumentSnapshot;
  title: string | null;
  summary: InspectionSummary;
  outline: readonly InspectionOutlineEntry[];
  outlineTotal: number;
  issues: readonly InspectionIssue[];
  issueTotal: number;
}>;
export type InspectionResult =
  | { ok: true; projection: InspectionProjection }
  | { ok: false; problem: InspectionProblem };

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;

/**
 * Inspect JSON iteratively before any recursive codec. Count the emitted JSON bytes,
 * refusing cycles, accessors and deeper input rather than dropping their content.
 * Each value/edge is visited once. A very large scalar is rejected before encoding it.
 */
function boundedJson(value: unknown): { bytes: number } | InspectionProblem {
  type Frame = { value: unknown; depth: number; exit?: boolean };
  const stack: Frame[] = [{ value, depth: 0 }];
  const ancestors = new Set<object>();
  let bytes = 0;
  const addScalar = (scalar: unknown): boolean => {
    if (typeof scalar === 'string' && scalar.length > writingInspectionLimits.bytes) return false;
    const json = JSON.stringify(scalar);
    if (json === undefined) return false;
    bytes += utf8Bytes(json);
    return bytes <= writingInspectionLimits.bytes;
  };
  while (stack.length) {
    const item = stack.pop()!;
    const current = item.value;
    if (item.exit) {
      ancestors.delete(current as object);
      continue;
    }
    if (current === null || typeof current !== 'object') {
      if (!['string', 'number', 'boolean'].includes(typeof current) && current !== null) return 'document';
      if (typeof current === 'number' && !Number.isFinite(current)) return 'document';
      if (!addScalar(current)) return 'size';
      continue;
    }
    if (item.depth > writingInspectionLimits.depth) return 'depth';
    if (ancestors.has(current)) return 'document';
    const array = Array.isArray(current);
    const prototype = Object.getPrototypeOf(current);
    if (!array && prototype !== null && prototype !== Object.prototype) return 'document';
    if (Object.getOwnPropertySymbols(current).length) return 'document';
    ancestors.add(current);
    stack.push({ value: current, depth: item.depth, exit: true });
    const entries = Object.entries(Object.getOwnPropertyDescriptors(current)).filter(
      ([key]) => !(array && key === 'length'),
    );
    if (array && entries.length !== current.length) return 'document';
    bytes += 2 + Math.max(0, entries.length - 1);
    for (let n = entries.length - 1; n >= 0; n--) {
      const [key, descriptor] = entries[n]!;
      if (!descriptor.enumerable || !('value' in descriptor)) return 'document';
      if (array && key !== String(n)) return 'document';
      if (!array) {
        if (!addScalar(key)) return 'size';
        bytes++;
      }
      stack.push({ value: descriptor.value, depth: item.depth + 1 });
    }
    if (bytes > writingInspectionLimits.bytes) return 'size';
  }
  return { bytes };
}

function outlineKind(type: string): OutlineKind {
  switch (type) {
    case 'heading':
      return 'heading';
    case 'paragraph':
      return 'paragraph';
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return 'list';
    case 'blockquote':
      return 'quote';
    case 'codeBlock':
      return 'code';
    case 'table':
      return 'table';
    case 'image':
      return 'image';
    case 'media':
      return 'media';
    case 'extensionBlock':
      return 'component';
    default:
      return 'block';
  }
}

/** Bounded excerpts never shorten the document or its serialized representation. */
function appendLabel(current: string, text: string): string {
  if (current.length >= writingInspectionLimits.labelCodePoints * 2) return current;
  let result = current;
  let count = 0;
  for (const point of current) count++;
  for (const point of text) {
    if (count++ >= writingInspectionLimits.labelCodePoints) break;
    result += point;
  }
  return result;
}

/** One explicit, local admission/projection pipeline. No lookup or media read is a dependency. */
export function projectWriting(candidate: unknown, title: string | null, facts: InspectionFacts): InspectionResult {
  const bound = boundedJson(candidate);
  if (typeof bound === 'string') return { ok: false, problem: bound };
  if (!checkDocument(candidate)) return { ok: false, problem: 'document' };
  if (candidate.profile !== 'blocks') return { ok: false, problem: 'profile' };
  // Native normalization preserves IDs, Unicode, targets and profile. It produces the
  // single immutable snapshot; the composer and command owner retain their own identity.
  const body = normalizeDocument(candidate);
  const canonicalBytes = utf8Bytes(serializeDocument(body));
  if (canonicalBytes > writingInspectionLimits.bytes) return { ok: false, problem: 'size' };
  const text = documentText(body);
  let textCodePoints = 0;
  for (const _point of text) textCodePoints++;
  const outline: { id: string | null; kind: OutlineKind; level: number | null; label: string; ordinal: number }[] = [];
  let outlineTotal = 0;
  let nodes = 0;
  let images = 0;
  let media = 0;
  let mentions = 0;
  let links = 0;
  const attachmentNodes = new Map<string, string>();
  type Work = { node: DocumentNode; top: number | null; heading: number | null; topLevel: boolean };
  const stack: Work[] = [{ node: body.doc, top: null, heading: null, topLevel: false }];
  while (stack.length) {
    const work = stack.pop()!;
    const node = work.node;
    nodes++;
    let top = work.top;
    let heading = work.heading;
    if (work.topLevel || node.type === 'heading') {
      const ordinal = ++outlineTotal;
      let entry: number | null = null;
      if (outline.length < writingInspectionLimits.outline) {
        entry = outline.length;
        outline.push({
          id: typeof node.attrs?.id === 'string' ? node.attrs.id : null,
          kind: outlineKind(node.type),
          level: node.type === 'heading' ? Number(node.attrs?.level ?? 1) : null,
          label: '',
          ordinal,
        });
      }
      if (work.topLevel) top = entry;
      if (node.type === 'heading') heading = entry;
    }
    if (node.type === 'image') images++;
    if (node.type === 'media') media++;
    if (
      (node.type === 'image' || node.type === 'media') &&
      typeof node.attrs?.src === 'string' &&
      typeof node.attrs.id === 'string'
    ) {
      const src = node.attrs.src;
      if (!attachmentNodes.has(src)) attachmentNodes.set(src, node.attrs.id);
      // Only a current-site path can alias an admitted native media reference.
      const path = src.startsWith('/')
        ? src
        : typeof window !== 'undefined' && src.startsWith(window.location.origin + '/')
          ? src.slice(window.location.origin.length)
          : '';
      const nativeId = /^\/media\/([0-9a-f-]{36})(?:\/[^/]+)?\/?$/i.exec(path)?.[1];
      if (nativeId && !attachmentNodes.has(nativeId)) attachmentNodes.set(nativeId, node.attrs.id);
    }
    if (node.type === 'mention') mentions++;
    for (const mark of node.marks ?? []) if (mark.type === 'link') links++;
    const label =
      node.type === 'text'
        ? (node.text ?? '')
        : node.type === 'mention'
          ? '@'
          : node.type === 'hardBreak'
            ? ' '
            : node.type === 'image'
              ? String(node.attrs?.alt ?? '')
              : node.type === 'media'
                ? String(node.attrs?.caption ?? '')
                : node.type.startsWith('extension')
                  ? String(node.attrs?.fallback ?? '')
                  : '';
    if (label) {
      if (top !== null) outline[top]!.label = appendLabel(outline[top]!.label, label);
      if (heading !== null && heading !== top) outline[heading]!.label = appendLabel(outline[heading]!.label, label);
    }
    const children = node.content ?? [];
    for (let n = children.length - 1; n >= 0; n--)
      stack.push({ node: children[n]!, top, heading, topLevel: node.type === 'doc' });
  }
  const issues: InspectionIssue[] = [];
  let issueTotal = 0;
  const issue = (item: InspectionIssue) => {
    issueTotal++;
    if (issues.length < writingInspectionLimits.diagnostics) issues.push(Object.freeze(item));
  };
  if (!hasDocumentContent(body)) issue({ kind: 'empty', id: null });
  if (title !== null && !title.trim()) issue({ kind: 'title-empty', id: null });
  if (title !== null && title.length > threadTitleCodeUnitLimit) issue({ kind: 'title-size', id: null });
  if (images > replyImageLimit) issue({ kind: 'images', id: null, count: images });
  if (facts.sending) issue({ kind: 'sending', id: null });
  if (facts.unknown) issue({ kind: 'unknown', id: null });
  if (facts.pendingUploads) issue({ kind: 'upload', id: null, count: facts.pendingUploads });
  if (facts.refusal) issue({ kind: 'refusal', id: null, detail: facts.refusal });
  for (const attachment of facts.attachmentIssues) {
    if (attachment.state === 'available') continue;
    issue({ kind: 'attachment', id: attachmentNodes.get(attachment.id) ?? null, detail: attachment.state });
  }
  return {
    ok: true,
    projection: Object.freeze({
      body,
      title,
      summary: Object.freeze({
        textCodePoints,
        jsonBytes: bound.bytes,
        canonicalBytes,
        nodes,
        images,
        media,
        mentions,
        links,
        titleCodeUnits: title === null ? null : title.length,
        titleRemaining: title === null ? null : threadTitleCodeUnitLimit - title.length,
        imageRemaining: replyImageLimit - images,
      }),
      outline: Object.freeze(outline.map((entry) => Object.freeze(entry))),
      outlineTotal,
      issues: Object.freeze(issues),
      issueTotal,
    }),
  };
}

export type InspectionSource = {
  signal: AbortSignal;
  /** A caller/target/readiness change creates a new visit, never revives this one. */
  binding: string;
  /** Optional native reading admission identity, separate from the authoring session. */
  authority?: object;
  current: () => boolean;
  revision: () => number;
  snapshot: () => { body: DocumentSnapshot; phase: SnapshotPhase };
  title: () => string | null;
  facts: () => InspectionFacts;
  editor: () => HTMLElement | null;
  titleEditor?: () => HTMLElement | null;
};
export type InspectionView = Readonly<{
  open: boolean;
  phase: 'unmeasured' | 'pending' | 'ready' | 'stale' | 'failed' | 'retired';
  projection: InspectionProjection | null;
  problem: InspectionProblem | 'pending' | 'recovery' | null;
  focusMissing: boolean;
}>;

/** One mounted unsent-writing visit; deliberately has no write, retry or replacement method. */
export class WritingInspection {
  private listeners = new Set<() => void>();
  private state: InspectionView = {
    open: false,
    phase: 'unmeasured',
    projection: null,
    problem: null,
    focusMissing: false,
  };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private revision = -1;
  private factsKey = '';
  private body: DocumentSnapshot | null = null;
  private selection: Range | null = null;
  private focusPlan: { revision: number; id?: string; title?: boolean } | null = null;
  private retired = false;
  private epoch = 0;
  constructor(private source: InspectionSource) {
    source.signal.addEventListener('abort', this.retire, { once: true });
    if (source.signal.aborted) this.retire();
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.state;
  token = () => this.epoch;
  matches = (token: number) => {
    if (
      !this.current() ||
      token !== this.epoch ||
      this.state.phase !== 'ready' ||
      this.revision !== this.source.revision()
    )
      return false;
    const snapshot = this.source.snapshot();
    return (
      this.body === snapshot.body && snapshot.phase === 'ready' && this.factsKey === JSON.stringify(this.source.facts())
    );
  };
  private publish(next: InspectionView) {
    this.state = Object.freeze(next);
    for (const listener of this.listeners) listener();
  }
  private current() {
    if (!this.retired && (!this.source.current() || this.source.signal.aborted)) this.retire();
    return !this.retired;
  }
  private cancel() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
  /** O(1) at input time; optional full measurement waits for quiet and is superseded. */
  changed = () => {
    if (!this.current()) return;
    this.epoch++;
    this.cancel();
    this.body = null;
    this.selection = null;
    this.focusPlan = null;
    this.revision = this.source.revision();
    this.factsKey = JSON.stringify(this.source.facts());
    this.publish({ ...this.state, projection: null, phase: this.state.open ? 'stale' : 'pending', problem: null });
    if (this.state.open) return;
    const revision = this.source.revision();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.current() || this.source.revision() !== revision) return;
      this.measure(false);
    }, writingInspectionLimits.idleMs);
  };
  /** Called after a render too, catching non-text attachment and command-state changes. */
  sync = () => {
    if (!this.current()) return;
    const snapshot = this.source.snapshot();
    if (
      this.revision !== -1 &&
      (this.revision !== this.source.revision() ||
        this.factsKey !== JSON.stringify(this.source.facts()) ||
        (this.body && this.body !== snapshot.body))
    )
      this.changed();
  };
  rememberSelection = () => {
    if (!this.current()) return;
    const editor = this.source.editor();
    const selection = editor?.ownerDocument.getSelection();
    if (
      editor &&
      selection?.rangeCount &&
      editor.contains(selection.anchorNode) &&
      editor.contains(selection.focusNode)
    )
      this.selection = selection.getRangeAt(0).cloneRange();
  };
  open = () => {
    if (!this.current()) return;
    this.rememberSelection();
    this.focusPlan = null;
    this.measure(true);
  };
  refresh = () => {
    if (this.current()) this.measure(true);
  };
  private measure(open: boolean) {
    this.cancel();
    if (!this.current()) return;
    const { body, phase } = this.source.snapshot();
    if (phase !== 'ready') {
      this.body = null;
      this.publish({
        open,
        phase: 'failed',
        projection: null,
        problem: phase === 'pending' ? 'pending' : 'recovery',
        focusMissing: false,
      });
      return;
    }
    const revision = this.source.revision();
    if (this.body === body && this.revision === revision && this.state.projection) {
      this.publish({ ...this.state, open, focusMissing: false });
      return;
    }
    const result = projectWriting(body, this.source.title(), this.source.facts());
    if (!this.current() || revision !== this.source.revision()) return;
    this.revision = revision;
    this.factsKey = JSON.stringify(this.source.facts());
    this.body = result.ok ? body : null;
    this.publish({
      open,
      phase: result.ok ? 'ready' : 'failed',
      projection: result.ok ? result.projection : null,
      problem: result.ok ? null : result.problem,
      focusMissing: false,
    });
  }
  close = () => {
    if (!this.current()) return;
    this.focusPlan = { revision: this.source.revision() };
    this.publish({ ...this.state, open: false });
  };
  repair = (id?: string, title = false, token = this.epoch) => {
    if (!this.current()) return;
    if (!this.matches(token)) return;
    this.focusPlan = { revision: this.revision, ...(id === undefined ? {} : { id }), title };
    this.publish({ ...this.state, open: false });
  };
  /** Dialog final-focus callback resolves only an exact current ID, never a nearby block. */
  returnFocus = (): HTMLElement | false => {
    const plan = this.focusPlan;
    this.focusPlan = null;
    if (!this.current() || !plan || plan.revision !== this.source.revision()) return false;
    if (plan.title) return this.source.titleEditor?.() ?? this.source.editor() ?? false;
    const editor = this.source.editor();
    if (!editor?.isConnected) return false;
    let range: Range | null = null;
    let missing = false;
    if (plan.id) {
      const node = [...editor.querySelectorAll<HTMLElement>('[data-block-id]')].find(
        (node) => node.getAttribute('data-block-id') === plan.id,
      );
      if (node) {
        range = editor.ownerDocument.createRange();
        range.selectNodeContents(node);
        range.collapse(true);
        node.scrollIntoView?.({ block: 'nearest', behavior: 'instant' });
      } else missing = true;
    } else if (
      this.selection &&
      editor.contains(this.selection.startContainer) &&
      editor.contains(this.selection.endContainer)
    ) {
      range = this.selection;
    }
    editor.focus({ preventScroll: true });
    if (range) {
      const selection = editor.ownerDocument.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    this.selection = null;
    if (missing) this.publish({ ...this.state, focusMissing: true });
    return editor;
  };
  retire = () => {
    if (this.retired) return;
    this.retired = true;
    this.epoch++;
    this.cancel();
    this.body = null;
    this.selection = null;
    this.focusPlan = null;
    this.source.signal.removeEventListener('abort', this.retire);
    this.publish({ open: false, phase: 'retired', projection: null, problem: null, focusMissing: false });
  };
}
