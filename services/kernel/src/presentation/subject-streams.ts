import {
  MAX_PAGE_READS,
  planReads,
  platformRegistry,
  type CompositionDocument,
  type PageContext,
} from '@rezics/composition';

export type SubjectStream = {
  node: string;
  property: string;
  direction: 'forward' | 'inverse';
};
export type SubjectStreams = { entries: SubjectStream[]; selected?: string };

/** The immutable composition declares destinations; no discovery or per-row hydration is needed. */
export function subjectStreams(document: CompositionDocument, context: PageContext): SubjectStream[] {
  const plan = planReads(platformRegistry, document, context);
  const entries: SubjectStream[] = [];
  const visit = (nodes: CompositionDocument['content']) => {
    for (const node of nodes) {
      const key = plan.nodes[node.props.id];
      const read = key === undefined ? undefined : plan.reads[key];
      if (node.props.paged === true && (read?.kind === 'links' || read?.kind === 'relations'))
        entries.push({
          node: node.props.id,
          property: read.property!,
          direction: read.kind === 'links' ? 'inverse' : 'forward',
        });
      const definition = platformRegistry.components.find((entry) => entry.type === node.type)!;
      for (const slot of definition.slots) visit(node.props[slot] as CompositionDocument['content']);
    }
  };
  visit(document.content);
  return entries;
}

/** Large role directories execute one window; an explicit selection always executes exactly that window. */
export function selectSubjectStream(
  entries: SubjectStream[],
  requested: string | undefined,
  continued: string | undefined,
  counts?: Record<string, number>,
): SubjectStreams | undefined {
  if (entries.length === 0) return;
  // Leave room for the Subject probe, current Context, documents and action advice.
  const first = entries.find((entry) => entry.direction === 'forward' && (counts?.[entry.property] ?? 0) > 0);
  const selected =
    requested ?? continued ?? (entries.length > MAX_PAGE_READS - 4 ? (first ?? entries[0])!.node : undefined);
  return { entries, ...(selected ? { selected } : {}) };
}
