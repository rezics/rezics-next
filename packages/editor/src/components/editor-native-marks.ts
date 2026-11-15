import { Mark, MarkType, type Node } from '@tiptap/pm/model';
import { RemoveMarkStep } from '@tiptap/pm/transform';

// Equivalent collector adapted from prosemirror-transform 1.12.4 src/mark.ts, removeMark (MIT).
// Index only the previous inline atom's entries instead of scanning every previous match.
// Complete notice and exact source are in ../../THIRD_PARTY_NOTICES.md.
export function collectNativeMarkRemoval(
  source: Pick<Node, 'nodesBetween'>,
  from: number,
  to: number,
  mark: Mark | MarkType | null | undefined,
  emit: (step: RemoveMarkStep) => void,
): void {
  type Entry = { style: Mark; from: number; to: number };
  const matched: Entry[] = [];
  let previous: Entry[] = [];
  source.nodesBetween(from, to, (node, position) => {
    if (!node.isInline || !node.isAtom) return;
    let remove: readonly Mark[] = [];
    if (mark instanceof MarkType) {
      let set = node.marks,
        found: Mark | undefined;
      const styles: Mark[] = [];
      while ((found = mark.isInSet(set))) {
        styles.push(found);
        set = found.removeFromSet(set);
      }
      remove = styles;
    } else if (mark) {
      if (mark.isInSet(node.marks)) remove = [mark];
    } else remove = node.marks;
    const current: Entry[] = [];
    for (const style of remove) {
      let found: Entry | undefined;
      for (const entry of previous) if (style.eq(entry.style)) found = entry;
      if (found) found.to = Math.min(position + node.nodeSize, to);
      else {
        found = { style, from: Math.max(position, from), to: Math.min(position + node.nodeSize, to) };
        matched.push(found);
      }
      current.push(found);
    }
    previous = current;
  });
  for (const entry of matched) emit(new RemoveMarkStep(entry.from, entry.to, entry.style));
}
