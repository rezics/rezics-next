import { Fragment, Mark, Slice, type Node } from '@tiptap/pm/model';
import { AddMarkStep, RemoveMarkStep, AttrStep, Step } from '@tiptap/pm/transform';
import { TextDocumentIndex } from './editor-text-document.ts';

type MarkOperation = { from: number; to: number; mark: Mark; remove: boolean; order: number };
const markSetConstructors = new WeakMap<object, Function>();

/** Replay native identity steps in one traversal, without retaining a document for every step. */
export function buildFormattingDocument(baseDoc: Node, steps: readonly Step[], prefixCount: number): Node {
  if (!Number.isInteger(prefixCount) || prefixCount < 0 || prefixCount > steps.length)
    throw new RangeError('Invalid formatting prefix');
  let markSet = markSetConstructors.get(baseDoc.type.schema);
  if (!markSet) {
    markSet = Step.fromJSON(baseDoc.type.schema, { stepType: 'markSet', steps: [] }).constructor;
    markSetConstructors.set(baseDoc.type.schema, markSet);
  }
  const marks: MarkOperation[] = [];
  const index = new TextDocumentIndex(baseDoc);
  const attributes = new Map<number, Record<string, unknown>>();
  const collect = (step: Step) => {
    if (step.constructor === AddMarkStep || step.constructor === RemoveMarkStep) {
      const current = step as AddMarkStep | RemoveMarkStep;
      if (current.from === current.to) return;
      if (!index.edit(current.from, current.to, Slice.empty))
        throw new RangeError('Formatting range must be closed text in one inline parent');
      marks.push({
        from: current.from,
        to: current.to,
        mark: current.mark,
        remove: current.constructor === RemoveMarkStep,
        order: marks.length,
      });
    } else if (step.constructor === AttrStep) {
      const current = step as AttrStep;
      attributes.set(current.pos, { ...attributes.get(current.pos), [current.attr]: current.value });
    } else if (step.constructor === markSet) {
      for (const child of (step as Step & { steps: readonly Step[] }).steps) collect(child);
    } else throw new RangeError('Unknown formatting step');
  };
  for (let index = 0; index < prefixCount; index++) collect(steps[index]!);
  const events = marks
    .flatMap((operation) => [
      { position: operation.from, add: true, operation },
      { position: operation.to, add: false, operation },
    ])
    .sort((left, right) => left.position - right.position || Number(left.add) - Number(right.add));
  let event = 0;
  const active = new Map<number, MarkOperation>();
  const advance = (position: number) => {
    while (event < events.length && events[event]!.position <= position) {
      const current = events[event++]!;
      if (current.add) active.set(current.operation.order, current.operation);
      else active.delete(current.operation.order);
    }
  };
  const join = (children: Node[]): Node[] => {
    const result: Node[] = [];
    let text: Node | null = null;
    let chunks: string[] = [];
    const flush = () => {
      if (text) result.push(text.type.schema.text(chunks.join(''), text.marks));
      text = null;
      chunks = [];
    };
    for (const node of children) {
      if (node.isText) {
        if (text && !text.sameMarkup(node)) flush();
        text ??= node;
        chunks.push(node.text!);
      } else {
        flush();
        result.push(node);
      }
    }
    flush();
    return result;
  };
  const visit = (node: Node, position: number): Node => {
    if (node.isText) return node;
    const children: Node[] = [];
    let changed = false;
    node.forEach((child, offset) => {
      const from = position + 1 + offset;
      if (child.isText) {
        const end = from + child.nodeSize;
        let at = from;
        advance(at);
        while (at < end) {
          const to = Math.min(events[event]?.position ?? end, end);
          let current = child.marks;
          for (const operation of [...active.values()].sort((a, b) => a.order - b.order)) {
            if (operation.remove) current = operation.mark.removeFromSet(current);
            else if (node.type.allowsMarkType(operation.mark.type)) current = operation.mark.addToSet(current);
          }
          const part = at === from && to === end ? child : child.cut(at - from, to - from);
          const next = Mark.sameSet(current, child.marks) ? part : part.mark(current);
          if (next !== child) changed = true;
          children.push(next);
          at = to;
          advance(at);
        }
      } else {
        const next = visit(child, from);
        changed ||= next !== child;
        children.push(next);
      }
    });
    const patch = attributes.get(position);
    if (!changed && !patch) return node;
    const content = changed ? Fragment.fromArray(join(children)) : node.content;
    return patch ? node.type.create({ ...node.attrs, ...patch }, content, node.marks) : node.copy(content);
  };
  return visit(baseDoc, -1);
}
