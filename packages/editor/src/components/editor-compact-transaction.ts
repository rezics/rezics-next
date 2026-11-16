import { AddMarkStep, RemoveMarkStep, ReplaceStep, StepResult, type Mappable, type Step } from '@tiptap/pm/transform';
import { Node, type Mark, type MarkType, type ResolvedPos } from '@tiptap/pm/model';
import { Transaction, type Command, type EditorState } from '@tiptap/pm/state';
import { buildTextDocument, TextDocumentIndex, type ClosedTextEdit } from './editor-text-document.ts';
import { maxSnapshotBytes } from './rich-text-editor-snapshot.ts';
import { indexedNativeMapping, withNativeMappingIndex } from './editor-native-mapping.ts';
import { cloneFormattingStep, FormattingPrefix, nativeFormattingStep } from './editor-formatting-prefix.ts';
import { editorSnapshot } from './rich-text-editor-snapshot.ts';
import { collectNativeMarkRemoval } from './editor-native-marks.ts';

type Segment = {
  base: Node;
  index: TextDocumentIndex;
  edits: ClosedTextEdit[];
  direction: 'up' | 'down' | null;
  delta: number;
  firstFrom: number;
  outputEnd: number;
};
type Metrics = {
  fastSteps: number;
  ordinarySteps: number;
  materializations: number;
  cachedInversions: number;
  cacheEntries: number;
  mappedLeaves: number;
  skippedMaps: number;
};
const trusted = new WeakSet<Transaction>();
const textReplayBatches = new WeakSet<Transaction>();
const ownedSteps = new WeakMap<Step, Step['invert'] | null>();
const metrics = new WeakMap<Transaction, Metrics>();
const nativeMaybeStep = Transaction.prototype.maybeStep;
const nativeAddMark = Transaction.prototype.addMark;
// Pinned PM 1.4.4 SPI: use the native recorder so its selection/marks flags remain maintained by PM.
const nativeAddStep = (
  Transaction.prototype as unknown as {
    addStep(this: Transaction, step: Step, doc: Node): void;
  }
).addStep;
const nativeResolveNoCache = (
  Node.prototype as unknown as {
    resolveNoCache(this: Node, position: number): ResolvedPos;
  }
).resolveNoCache;

class PrefixDocument {
  readonly #segment: Segment | FormattingPrefix;
  readonly #count: number;
  readonly #read: (node: Node) => Node;

  constructor(segment: Segment | FormattingPrefix, count: number, read: (node: Node) => Node) {
    this.#segment = segment;
    this.#count = count;
    this.#read = read;
  }

  get type() {
    return this.#segment.base.type;
  }
  get attrs() {
    return this.#segment.base.attrs;
  }
  get marks() {
    return this.#segment.base.marks;
  }
  get content() {
    return this.#read(this.asNode()).content;
  }

  asNode(): Node {
    return this as unknown as Node;
  }

  resolve(position: number): ResolvedPos {
    return nativeResolveNoCache.call(this.asNode(), position);
  }

  materialize(): Node {
    if (this.#segment instanceof FormattingPrefix) return this.#segment.document(this.#count);
    const edits = this.#segment.edits.slice(0, this.#count);
    if (this.#segment.direction === 'down') edits.reverse();
    return buildTextDocument(this.#segment.base, edits, maxSnapshotBytes);
  }
}

// Share the lazy accessors across prefixes while retaining the native Node methods on their own receiver.
Object.setPrototypeOf(PrefixDocument.prototype, Node.prototype);

function mapOwnedStep(this: Step, mapping: Mappable): Step | null {
  const mapped = (Object.getPrototypeOf(this) as Step).map.call(this, indexedNativeMapping(mapping));
  return mapped ? ownStep(mapped) : null;
}

function mergeOwnedStep(this: Step, other: Step): Step | null {
  const merged = (Object.getPrototypeOf(this) as Step).merge.call(this, other);
  return merged ? ownStep(merged) : null;
}

function ownStep<T extends Step>(step: T, inversion?: Step['invert']): T {
  step.map = mapOwnedStep;
  step.merge = mergeOwnedStep;
  if (inversion) step.invert = inversion;
  ownedSteps.set(step, inversion ?? null);
  return step;
}

function unmodifiedStep(step: Step): boolean {
  if (Object.hasOwn(step, 'apply') || Object.hasOwn(step, 'getMap') || Object.hasOwn(step, 'toJSON')) return false;
  const inversion = ownedSteps.get(step);
  if (inversion === undefined)
    return !Object.hasOwn(step, 'invert') && !Object.hasOwn(step, 'map') && !Object.hasOwn(step, 'merge');
  return (
    step.map === mapOwnedStep &&
    step.merge === mergeOwnedStep &&
    (inversion ? step.invert === inversion : !Object.hasOwn(step, 'invert'))
  );
}

function nativeTextStep(step: Step): step is ReplaceStep {
  return (
    Object.getPrototypeOf(step) === ReplaceStep.prototype &&
    !(step as Step & { structure?: boolean }).structure &&
    unmodifiedStep(step)
  );
}

/** Private proof, never a caller-supplied metadata string. Marks cannot change topology or IDs. */
function nativeMarksOnly(transaction: Transaction): boolean {
  return (
    transaction.steps.length > 0 &&
    transaction.steps.every(
      (step) =>
        (Object.getPrototypeOf(step) === AddMarkStep.prototype ||
          Object.getPrototypeOf(step) === RemoveMarkStep.prototype) &&
        !['apply', 'getMap'].some((key) => Object.hasOwn(step, key)),
    )
  );
}

export function identityPreservingBatch(transactions: readonly Transaction[]): boolean {
  return (
    transactions.some((transaction) => transaction.docChanged) &&
    transactions.every(
      (transaction) => !transaction.docChanged || trusted.has(transaction) || nativeMarksOnly(transaction),
    )
  );
}

/** Seal the actual appended batch before Tiptap's asynchronous Delete listener considers replaying it. */
export function recordTextReplayBatch(transaction: Transaction, appended: readonly Transaction[] = []): void {
  const stats = metrics.get(transaction);
  if (stats && stats.fastSteps > 0 && trusted.has(transaction) && identityPreservingBatch([transaction, ...appended]))
    textReplayBatches.add(transaction);
  else textReplayBatches.delete(transaction);
}

export function skipProvenTextReplay(transaction: Transaction): boolean {
  return textReplayBatches.has(transaction);
}

export function compactTransactionMetrics(transaction: Transaction): Readonly<Metrics> | undefined {
  const value = metrics.get(transaction);
  return value ? { ...value } : undefined;
}

/**
 * Owned monotone text recorder; native Steps/maps/history remain unchanged. Prefix nodes expose immutable values,
 * resolve on their own receiver without PM's per-prefix resolution cache, and never enter the live editor state.
 */
export function compactTransaction(state: EditorState): Transaction {
  const transaction = state.tr;
  const stats: Metrics = {
    fastSteps: 0,
    ordinarySteps: 0,
    materializations: 0,
    cachedInversions: 0,
    cacheEntries: 0,
    mappedLeaves: 0,
    skippedMaps: 0,
  };
  metrics.set(transaction, stats);
  const cache = new Map<Node, Node>();
  let logical = state.doc;
  let observed: { logical: Node; real: Node } | null = { logical, real: state.doc };
  let recording = false;
  let segment: Segment | null = null;
  let formatting: FormattingPrefix | null = null;
  let proof = true;

  const materialize = (node: Node): Node => {
    if (observed?.logical === node) return observed.real;
    const found = cache.get(node);
    if (found) {
      cache.delete(node);
      cache.set(node, found);
      return found;
    }
    if (!(node instanceof PrefixDocument)) return node;
    const real = node.materialize();
    stats.materializations++;
    cache.set(node, real);
    if (cache.size > 2) cache.delete(cache.keys().next().value!);
    stats.cacheEntries = cache.size;
    return real;
  };
  const publicDoc = () => {
    if (observed?.logical !== logical) observed = { logical, real: materialize(logical) };
    return observed.real;
  };
  Object.defineProperty(transaction, 'doc', {
    configurable: false,
    enumerable: true,
    get: () => (recording ? logical : publicDoc()),
    set: (value: Node) => {
      logical = value;
    },
  });
  const inversionAt = (before: Node, inverse: Step): Step['invert'] =>
    function (this: Step, doc: Node) {
      if (doc === before) {
        stats.cachedInversions++;
        return inverse;
      }
      return (Object.getPrototypeOf(this) as Step).invert.call(this, doc);
    };
  const ordinary = (step: Step): StepResult => {
    publicDoc();
    segment = null;
    formatting = null;
    const count = transaction.steps.length;
    const result = nativeMaybeStep.call(transaction, step);
    if (transaction.steps.length !== count) {
      stats.ordinarySteps++;
      const mark =
        Object.getPrototypeOf(step) === AddMarkStep.prototype ||
        Object.getPrototypeOf(step) === RemoveMarkStep.prototype;
      if (!mark || Object.hasOwn(step, 'apply') || Object.hasOwn(step, 'getMap')) proof = false;
      if (proof) trusted.add(transaction);
      else trusted.delete(transaction);
    }
    return result;
  };
  Object.defineProperty(transaction, 'maybeStep', {
    value(step: Step): StepResult {
      if (nativeFormattingStep(step, state.schema) && unmodifiedStep(step)) {
        if (!formatting) {
          formatting = new FormattingPrefix(publicDoc());
          segment = null;
        }
        const inverse = formatting.append(step, unmodifiedStep);
        if (!inverse) return ordinary(step);
        const native = ownStep(cloneFormattingStep(step, state.schema), inversionAt(logical, ownStep(inverse)));
        const after = new PrefixDocument(formatting, formatting.steps.length, materialize).asNode();
        recording = true;
        try {
          nativeAddStep.call(transaction, native, after);
        } finally {
          recording = false;
        }
        stats.fastSteps++;
        if (proof) trusted.add(transaction);
        return StepResult.ok(after);
      }
      formatting = null;
      if (!nativeTextStep(step)) return ordinary(step);
      if (!segment) {
        const base = publicDoc();
        segment = {
          base,
          index: new TextDocumentIndex(base),
          edits: [],
          direction: null,
          delta: 0,
          firstFrom: step.from,
          outputEnd: step.from,
        };
      }
      const owner = segment;
      let from = step.from,
        to = step.to;
      let direction = owner.direction;
      if (owner.edits.length) {
        if (direction !== 'up' && to <= owner.firstFrom) direction = 'down';
        else if (direction !== 'down' && from >= owner.outputEnd) {
          direction = 'up';
          from -= owner.delta;
          to -= owner.delta;
        } else return ordinary(step);
      }
      const admitted = owner.index.edit(from, to, step.slice);
      if (!admitted) return ordinary(step);
      owner.direction = direction;
      const inverse = ownStep(new ReplaceStep(step.from, step.from + step.slice.size, admitted.removed));
      const native = ownStep(new ReplaceStep(step.from, step.to, step.slice), inversionAt(logical, inverse));
      owner.edits.push(admitted.edit);
      owner.delta += step.slice.size - (to - from);
      owner.firstFrom = Math.min(owner.firstFrom, from);
      owner.outputEnd = to + owner.delta;
      const after = new PrefixDocument(owner, owner.edits.length, materialize).asNode();
      recording = true;
      try {
        nativeAddStep.call(transaction, native, after);
      } finally {
        recording = false;
      }
      stats.fastSteps++;
      if (proof) trusted.add(transaction);
      return StepResult.ok(after);
    },
  });
  const markSource = (from: number, to: number): Pick<Node, 'nodesBetween'> => {
    if (!formatting) {
      formatting = new FormattingPrefix(publicDoc());
      segment = null;
    }
    return formatting.markSource(from, to) ?? publicDoc();
  };
  Object.defineProperties(transaction, {
    addMark: {
      value(from: number, to: number, mark: Mark) {
        const recorder = {
          doc: markSource(from, to),
          step: (step: Step) => {
            transaction.step(step);
            return recorder;
          },
        };
        nativeAddMark.call(recorder as unknown as Transaction, from, to, mark);
        return transaction;
      },
    },
    removeMark: {
      value(from: number, to: number, mark?: Mark | MarkType | null) {
        collectNativeMarkRemoval(markSource(from, to), from, to, mark, (step) => transaction.step(step));
        return transaction;
      },
    },
  });
  return transaction;
}

/** Native history reads the same plugin state; only construction of its owned transaction changes. */
export function compactHistoryState(state: EditorState): EditorState {
  return Object.create(state, { tr: { get: () => compactTransaction(state) } }) as EditorState;
}

/** Owned authored formatting producer; no caller-supplied identity token or document builder. */
export function compactIdentityTransaction(state: EditorState, steps: readonly Step[]): Transaction | null {
  const transaction = compactTransaction(state);
  for (const step of steps) transaction.step(step);
  const result = transaction.doc;
  try {
    editorSnapshot(result, state.schema.nodes.image ? 'blocks' : 'text');
  } catch {
    return null;
  }
  if (result.eq(state.doc)) return state.tr;
  return transaction.setSelection(transaction.selection).setStoredMarks(state.storedMarks);
}

export function compactHistory(
  command: Command,
  state: EditorState,
  dispatch: (transaction: Transaction) => void,
): boolean {
  return withNativeMappingIndex((index) =>
    command(compactHistoryState(state), (transaction) => {
      const stats = metrics.get(transaction);
      if (stats) {
        stats.mappedLeaves = index.leafVisits;
        stats.skippedMaps = index.skippedMaps;
      }
      dispatch(transaction);
    }),
  );
}
