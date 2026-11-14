import { Fragment, Mark, Slice, type Node } from '@tiptap/pm/model';

type Parent = { node: Node; start: number; end: number; ancestor: Parent | null };
type Span = { node: Node; from: number; to: number; parent: Parent; group: number };
export type ClosedTextEdit = { from: number; to: number; insert: Slice; parent: Parent };

/** Index original topology once; native resolution otherwise scans large sibling arrays per match. */
export class TextDocumentIndex {
  private parents: Parent[] = [];
  private spans: Span[] = [];
  private slices = new WeakMap<Span, Map<string, Slice>>();
  constructor(readonly doc: Node) {
    const visit = (node: Node, position: number, ancestor: Parent | null) => {
      let parent = ancestor;
      if (node.inlineContent) {
        parent = { node, start: position + 1, end: position + 1 + node.content.size, ancestor };
        this.parents.push(parent);
      }
      node.forEach((child, offset) => {
        const at = position + 1 + offset;
        if (child.isText && parent) {
          const previous = this.spans.at(-1);
          const group =
            previous && previous.parent === parent && previous.to === at ? previous.group : this.spans.length;
          this.spans.push({ node: child, from: at, to: at + child.nodeSize, parent, group });
        } else if (!child.isLeaf) visit(child, at, parent);
      });
    };
    visit(doc, -1, null);
  }

  private before<T>(items: readonly T[], position: number, start: (item: T) => number): number {
    let low = 0,
      high = items.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (start(items[middle]!) <= position) low = middle + 1;
      else high = middle;
    }
    return low - 1;
  }

  edit(from: number, to: number, insert: Slice): { edit: ClosedTextEdit; removed: Slice } | null {
    if (
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to) ||
      from < 0 ||
      to < from ||
      to > this.doc.content.size ||
      insert.openStart ||
      insert.openEnd
    )
      return null;
    let parent = this.parents[this.before(this.parents, from, (item) => item.start)] ?? null;
    while (parent && (from < parent.start || to > parent.end)) parent = parent.ancestor;
    if (
      !parent ||
      !parent.node.type.contentMatch.validEnd ||
      !parent.node.type.contentMatch.matchType(this.doc.type.schema.nodes.text!)?.validEnd
    )
      return null;
    let allowed = true;
    insert.content.forEach((node) => {
      if (!node.isText || node.type !== this.doc.type.schema.nodes.text || !parent!.node.type.allowsMarks(node.marks))
        allowed = false;
    });
    if (!allowed) return null;
    if (from === to) return { edit: { from, to, insert, parent }, removed: Slice.empty };
    const first = this.before(this.spans, from, (item) => item.from);
    const last = this.before(this.spans, to - 1, (item) => item.from);
    const begin = this.spans[first],
      end = this.spans[last];
    if (
      !begin ||
      !end ||
      begin.from > from ||
      begin.to <= from ||
      end.to < to ||
      begin.group !== end.group ||
      begin.parent !== parent
    )
      return null;
    if (first === last) {
      const value = begin.node.text!.slice(from - begin.from, to - begin.from);
      let values = this.slices.get(begin);
      if (!values) {
        values = new Map();
        this.slices.set(begin, values);
      }
      let removed = values.get(value);
      if (!removed) {
        removed = new Slice(Fragment.from(begin.node.cut(from - begin.from, to - begin.from)), 0, 0);
        values.set(value, removed);
      }
      return { edit: { from, to, insert, parent }, removed };
    }
    const nodes: Node[] = [];
    for (let index = first; index <= last; index++) {
      const span = this.spans[index]!;
      nodes.push(span.node.cut(Math.max(from, span.from) - span.from, Math.min(to, span.to) - span.from));
    }
    return { edit: { from, to, insert, parent }, removed: new Slice(Fragment.fromArray(nodes), 0, 0) };
  }

  firstMarks(from: number): readonly Mark[] | null {
    const span = this.spans[this.before(this.spans, from, (item) => item.from)];
    return span && span.from <= from && from < span.to ? span.node.marks : null;
  }
}

/** Count JSON-escaped UTF-8 text before joining output, including split surrogate pairs. */
class TextBudget {
  private bytes = 0;
  private high = false;
  constructor(private limit: number) {}
  private add(size: number) {
    this.bytes += size;
    if (this.bytes > this.limit) throw new RangeError('Replacement text exceeds the snapshot byte budget');
  }
  text(value: string) {
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (this.high) {
        this.high = false;
        if (code >= 0xdc00 && code <= 0xdfff) {
          this.add(4);
          continue;
        }
        this.add(6);
      }
      if (code >= 0xd800 && code <= 0xdbff) this.high = true;
      else if (code >= 0xdc00 && code <= 0xdfff) this.add(6);
      else if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13)
        this.add(2);
      else if (code < 32) this.add(6);
      else this.add(code < 128 ? 1 : code < 2048 ? 2 : 3);
    }
  }
  end() {
    if (this.high) {
      this.high = false;
      this.add(6);
    }
  }
}

/** Edits are in original ascending coordinates; equal-position insertions retain their application order. */
export function buildTextDocument(
  doc: Node,
  edits: readonly ClosedTextEdit[],
  limit = Infinity,
  materialize = true,
): Node {
  const groups = new Map<number, ClosedTextEdit[]>();
  for (const edit of edits) {
    const group = groups.get(edit.parent.start);
    if (group) group.push(edit);
    else groups.set(edit.parent.start, [edit]);
  }
  const budget = new TextBudget(limit);
  const walk = (node: Node, position: number): Node => {
    if (node.isText) {
      budget.text(node.text!);
      budget.end();
      return node;
    }
    const own = groups.get(position + 1);
    if (!own) {
      let changed = false;
      const children: Node[] = [];
      node.forEach((child, offset) => {
        const next = walk(child, position + 1 + offset);
        if (next !== child) changed = true;
        if (materialize) children.push(next);
      });
      return materialize && changed ? node.copy(Fragment.fromArray(children)) : node;
    }
    const children: Node[] = [];
    let childIndex = 0,
      offset = 0,
      cursor = 0;
    let marks: readonly Mark[] | null = null;
    let parts: string[] = [];
    let candidate: Node | undefined;
    const flush = () => {
      if (marks) {
        budget.end();
        if (materialize && parts.length) children.push(candidate ?? doc.type.schema.text(parts.join(''), marks));
      }
      marks = null;
      parts = [];
      candidate = undefined;
    };
    const text = (value: string, nextMarks: readonly Mark[], original?: Node) => {
      if (!value) return;
      if (marks && !Mark.sameSet(marks, nextMarks)) flush();
      const empty = marks === null;
      marks = nextMarks;
      budget.text(value);
      if (materialize) {
        candidate = empty ? original : undefined;
        parts.push(value);
      }
    };
    const consume = (target: number, keep: boolean) => {
      if (target < cursor) throw new RangeError('Overlapping text replacements');
      while (cursor < target) {
        const child = node.child(childIndex);
        const end = offset + child.nodeSize;
        if (child.isText) {
          const until = Math.min(target, end);
          if (keep)
            text(
              child.text!.slice(cursor - offset, until - offset),
              child.marks,
              cursor === offset && until === end ? child : undefined,
            );
          cursor = until;
        } else {
          if (!keep || cursor !== offset || target < end)
            throw new RangeError('Replacement crosses a non-text boundary');
          flush();
          const next = walk(child, position + 1 + offset);
          if (materialize) children.push(next);
          cursor = end;
        }
        if (cursor === end) {
          childIndex++;
          offset = end;
        }
      }
    };
    for (const edit of own) {
      consume(edit.from - position - 1, true);
      edit.insert.content.forEach((piece) => text(piece.text!, piece.marks, materialize ? piece : undefined));
      consume(edit.to - position - 1, false);
    }
    consume(node.content.size, true);
    flush();
    return materialize ? node.copy(Fragment.fromArray(children)) : node;
  };
  return walk(doc, -1);
}
