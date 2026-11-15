import { Slice, type Node, type Schema } from '@tiptap/pm/model';
import { AddMarkStep, RemoveMarkStep, AttrStep, Step } from '@tiptap/pm/transform';
import { TextDocumentIndex } from './editor-text-document.ts';
import { buildFormattingDocument } from './editor-formatting-document.ts';

type MarkStep = AddMarkStep | RemoveMarkStep;
type MarkSet = Step & { readonly steps: readonly Step[] };
type MarkSetConstructor = { new (steps: readonly Step[]): MarkSet; prototype: object };
const constructors = new WeakMap<Schema, MarkSetConstructor>();
const attributes = new Set(['textAlign', 'language', 'lang', 'dir', 'level']);
function markSet(schema: Schema): MarkSetConstructor {
  let constructor = constructors.get(schema);
  if (!constructor) {
    constructor = Step.fromJSON(schema, { stepType: 'markSet', steps: [] })
      .constructor as unknown as MarkSetConstructor;
    constructors.set(schema, constructor);
  }
  return constructor;
}

export function nativeFormattingStep(step: Step, schema: Schema): boolean {
  const prototype = Object.getPrototypeOf(step);
  return (
    prototype === AddMarkStep.prototype ||
    prototype === RemoveMarkStep.prototype ||
    prototype === AttrStep.prototype ||
    prototype === markSet(schema).prototype
  );
}

export function cloneFormattingStep(step: Step, schema: Schema): Step {
  if (Object.getPrototypeOf(step) === AddMarkStep.prototype) {
    const value = step as AddMarkStep;
    return new AddMarkStep(value.from, value.to, value.mark);
  }
  if (Object.getPrototypeOf(step) === RemoveMarkStep.prototype) {
    const value = step as RemoveMarkStep;
    return new RemoveMarkStep(value.from, value.to, value.mark);
  }
  if (Object.getPrototypeOf(step) === AttrStep.prototype) {
    const value = step as AttrStep;
    return new AttrStep(value.pos, value.attr, value.value);
  }
  return new (markSet(schema))((step as MarkSet).steps);
}

type Operation = { step: MarkStep; order: number };
type Tree = { operation: Operation; priority: number; end: number; left: Tree | null; right: Tree | null };
const refresh = (node: Tree) => {
  node.end = Math.max(node.operation.step.to, node.left?.end ?? -Infinity, node.right?.end ?? -Infinity);
  return node;
};

/** Prior mark intervals, not prefix documents; disjoint many-run formatting queries stay logarithmic. */
class MarkIntervals {
  private root: Tree | null = null;
  private order = 0;
  private random = 0x6d2b79f5;
  add(step: MarkStep) {
    this.random ^= this.random << 13;
    this.random ^= this.random >>> 17;
    this.random ^= this.random << 5;
    const added: Tree = {
      operation: { step, order: this.order++ },
      priority: this.random >>> 0,
      end: step.to,
      left: null,
      right: null,
    };
    const insert = (node: Tree | null): Tree => {
      if (!node) return added;
      if (
        step.from < node.operation.step.from ||
        (step.from === node.operation.step.from && added.operation.order < node.operation.order)
      ) {
        node.left = insert(node.left);
        if (node.left.priority < node.priority) {
          const top = node.left;
          node.left = top.right;
          top.right = refresh(node);
          return refresh(top);
        }
      } else {
        node.right = insert(node.right);
        if (node.right.priority < node.priority) {
          const top = node.right;
          node.right = top.left;
          top.left = refresh(node);
          return refresh(top);
        }
      }
      return refresh(node);
    };
    this.root = insert(this.root);
  }
  between(from: number, to: number): Operation[] {
    const found: Operation[] = [];
    const visit = (node: Tree | null) => {
      if (!node || node.end <= from) return;
      visit(node.left);
      if (node.operation.step.from < to && node.operation.step.to > from) found.push(node.operation);
      if (node.operation.step.from < to) visit(node.right);
    };
    visit(this.root);
    return found.sort((left, right) => left.order - right.order);
  }
}

/** Exact local prefix observations for the original native mark/attribute inversion methods. */
export class FormattingPrefix {
  readonly kind = 'identity';
  readonly steps: Step[] = [];
  private index: TextDocumentIndex;
  private nodes = new Map<number, Node>();
  private attrs = new Map<number, Record<string, unknown>>();
  private marks = new MarkIntervals();
  constructor(readonly base: Node) {
    this.index = new TextDocumentIndex(base);
    base.descendants((node, position) => {
      if (!node.isText) this.nodes.set(position, node);
    });
  }
  private project(from: number, to: number): Node | null {
    const range = this.index.edit(from, to, Slice.empty);
    if (!range || range.edit.parent.node.isInline) return null;
    const local = this.marks.between(from, to).map(({ step }) => {
      const start = Math.max(from, step.from) - from,
        end = Math.min(to, step.to) - from;
      return Object.getPrototypeOf(step) === AddMarkStep.prototype
        ? new AddMarkStep(start, end, step.mark)
        : new RemoveMarkStep(start, end, step.mark);
    });
    const source = range.edit.parent.node.copy(range.removed.content);
    return local.length ? buildFormattingDocument(source, local, local.length) : source;
  }
  markSource(from: number, to: number): Pick<Node, 'nodesBetween'> | null {
    let start = from,
      end = to;
    const block = this.nodes.get(from);
    if (block?.isTextblock && !block.isInline && to === from + block.nodeSize) {
      start++;
      end--;
    }
    const current = this.project(start, end);
    if (!current) return null;
    return {
      nodesBetween(_from, _to, callback) {
        current.nodesBetween(0, end - start, (node, position, parent, index) =>
          callback(node, position + start, parent, index),
        );
      },
    };
  }
  private leaves(step: Step, accept: (step: Step) => boolean, ancestors = new Set<Step>()): Step[] | null {
    if (!accept(step) || ancestors.has(step)) return null;
    if (Object.getPrototypeOf(step) === markSet(this.base.type.schema).prototype) {
      ancestors.add(step);
      const all: Step[] = [];
      for (const child of (step as MarkSet).steps) {
        if (Object.getPrototypeOf(child) === AttrStep.prototype) return null;
        const nested = this.leaves(child, accept, ancestors);
        if (!nested) return null;
        for (const leaf of nested) all.push(leaf);
      }
      ancestors.delete(step);
      return all;
    }
    if (Object.getPrototypeOf(step) === AttrStep.prototype) {
      const attr = step as AttrStep,
        node = this.nodes.get(attr.pos);
      return attributes.has(attr.attr) && node && Object.hasOwn(node.attrs, attr.attr) ? [step] : null;
    }
    if (
      Object.getPrototypeOf(step) !== AddMarkStep.prototype &&
      Object.getPrototypeOf(step) !== RemoveMarkStep.prototype
    )
      return null;
    const mark = step as MarkStep;
    return this.index.edit(mark.from, mark.to, Slice.empty) ? [step] : null;
  }
  append(step: Step, accept: (step: Step) => boolean): Step | null {
    const leaves = this.leaves(step, accept);
    if (!leaves) return null;
    const probe = {
      nodeAt: (position: number) => {
        const node = this.nodes.get(position);
        return node ? node.type.create(this.attrs.get(position) ?? node.attrs, node.content, node.marks) : null;
      },
      nodesBetween: (
        from: number,
        to: number,
        callback: (node: Node, position: number, parent: Node | null, index: number) => boolean | void,
      ) => {
        if (from === to) return;
        const range = this.index.edit(from, to, Slice.empty);
        if (!range) throw new RangeError('Native formatting inversion left its proved text range');
        const local = this.marks.between(from, to).map(({ step }) => {
          const start = Math.max(from, step.from) - from,
            end = Math.min(to, step.to) - from;
          return Object.getPrototypeOf(step) === AddMarkStep.prototype
            ? new AddMarkStep(start, end, step.mark)
            : new RemoveMarkStep(start, end, step.mark);
        });
        const source = range.edit.parent.node.copy(range.removed.content);
        const current = local.length ? buildFormattingDocument(source, local, local.length) : source;
        current.nodesBetween(0, to - from, (node, position, parent, index) =>
          callback(node, position + from, parent, index),
        );
      },
    } as unknown as Node;
    const inverse = (Object.getPrototypeOf(step) as Step).invert.call(step, probe);
    for (const leaf of leaves) {
      if (Object.getPrototypeOf(leaf) === AttrStep.prototype) {
        const attr = leaf as AttrStep,
          node = this.nodes.get(attr.pos)!;
        this.attrs.set(
          attr.pos,
          node.type.create(
            { ...(this.attrs.get(attr.pos) ?? node.attrs), [attr.attr]: attr.value },
            node.content,
            node.marks,
          ).attrs,
        );
      } else this.marks.add(leaf as MarkStep);
    }
    this.steps.push(step);
    return inverse;
  }
  document(count: number): Node {
    return buildFormattingDocument(this.base, this.steps, count);
  }
}
