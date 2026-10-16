export interface NativeExportContent {
  reference: { target: string; selector: { grain: string; revision?: string } };
  document?: unknown; body?: string;
}
export interface NativeExportPage {
  structure: string; revision: string; parent: string; next: string | null;
  occurrences: unknown[]; contents: NativeExportContent[];
  measures: unknown[]; rights: unknown[];
  containers?: string[];
}
export interface NativeExportCheckpoint<Page extends NativeExportPage = NativeExportPage> {
  pages: Page[]; parents: string[]; parentIndex: number; after?: string;
  derivations: unknown[]; contentIndex: number; derivationCursor?: string;
}
export function nativeExportCheckpoint<Page extends NativeExportPage = NativeExportPage>(structure: string): NativeExportCheckpoint<Page> {
  return { pages: [], parents: [structure], parentIndex: 0, derivations: [], contentIndex: 0 };
}
export function nativeExportContents(pages: readonly NativeExportPage[]) {
  return [...new Map(pages.flatMap(page => page.contents)
    .map(item => [JSON.stringify(item.reference), item])).values()];
}

/** Advance only after a successful bounded response. JSON checkpoints preserve
 * sibling order, exact revisions, container visits and dependency cursors. */
export async function continueNativeExport<Page extends NativeExportPage>(checkpoint: NativeExportCheckpoint<Page>,
  readPage: (parent: string, after?: string) => Promise<Page>,
  readDerivations: (revision: string, cursor?: string) => Promise<{ items: unknown[]; nextCursor: string | null }>,
  containers: (page: Page) => readonly string[] = page => page.containers ?? []) {
  const visited = new Set(checkpoint.parents);
  while (checkpoint.parentIndex < checkpoint.parents.length) {
    const parent = checkpoint.parents[checkpoint.parentIndex]!;
    const page = await readPage(parent, checkpoint.after);
    const first = checkpoint.pages[0];
    if (page.parent !== parent || page.next && page.next === checkpoint.after
      || first && (page.structure !== first.structure || page.revision !== first.revision)
      || page.structure !== checkpoint.parents[0]) throw new Error('Invalid native export continuation');
    const children = containers(page);
    if (children.some(child => visited.has(child)) || new Set(children).size !== children.length) {
      throw new Error('Invalid native export containers');
    }
    checkpoint.pages.push(page);
    checkpoint.parents.push(...children);
    for (const child of children) visited.add(child);
    checkpoint.after = page.next ?? undefined;
    if (!page.next) checkpoint.parentIndex++;
  }
  const revisions = [...new Set(nativeExportContents(checkpoint.pages).flatMap(item =>
    item.reference.selector.grain === 'content' && item.reference.selector.revision ? [item.reference.selector.revision] : []))];
  while (checkpoint.contentIndex < revisions.length) {
    const page = await readDerivations(revisions[checkpoint.contentIndex]!, checkpoint.derivationCursor);
    if (page.nextCursor && page.nextCursor === checkpoint.derivationCursor) throw new Error('Invalid derivation continuation');
    checkpoint.derivations.push(...page.items);
    checkpoint.derivationCursor = page.nextCursor ?? undefined;
    if (!page.nextCursor) checkpoint.contentIndex++;
  }
}

export function assembleNativeExport(pages: readonly NativeExportPage[], derivations: unknown[]) {
  const first = pages[0];
  if (!first) throw new Error('Native export has no pages');
  const { structure, revision, rights, measures } = first;
  if (pages.some(page => page.structure !== structure || page.revision !== revision)) throw new Error('Native export revisions differ');
  return { format: 'native' as const, structure, revision, rights,
    occurrences: pages.flatMap(page => page.occurrences), measures,
    contents: nativeExportContents(pages), derivations };
}
