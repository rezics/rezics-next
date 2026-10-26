// Two branches that each add a section, table row or list item at the same place in a Markdown file conflict with an
// empty common base. Such a hunk has one safe resolution: keep both insertions, the checked-out side first. A hunk
// whose base holds text means both sides changed the same lines, which is left to a person.

const HUNK = /^<<<<<<< [^\n]*\n([\s\S]*?)^\|\|\|\|\|\|\| [^\n]*\n([\s\S]*?)^=======\n([\s\S]*?)^>>>>>>> [^\n]*\n/gm;

/** The file with every insert-only conflict hunk resolved, or undefined when a hunk changes common text. */
export function resolveInsertedSections(text: string): string | undefined {
  const hunks = [...text.matchAll(HUNK)];
  if (!hunks.length) return undefined;
  let outside = text;
  for (const hunk of hunks) outside = outside.replace(hunk[0], '');
  if (/^(<<<<<<<|\|\|\|\|\|\|\||=======|>>>>>>>)/m.test(outside)) return undefined;
  let result = text;
  for (const hunk of hunks.reverse()) {
    const [whole, ours = '', base = '', theirs = ''] = hunk;
    if (base.trim()) return undefined;
    // A heading needs a blank line before it; rows and items continue their table or list.
    const gap = ours.trim() && !ours.endsWith('\n\n') && /^\s*#/.test(theirs) ? '\n' : '';
    result = result.slice(0, hunk.index) + ours + gap + theirs + result.slice(hunk.index! + whole.length);
  }
  return result;
}
