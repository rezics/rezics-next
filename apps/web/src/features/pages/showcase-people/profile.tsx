import { platformRegistry } from '@rezics/composition';
import { projectReadingDocument } from '../reading-overview';
import type { PageDocument } from '../render';

export type PeopleFamily = 'character' | 'person' | 'organization';

/** Exact public families only. Accounts retain their own identity and reader lifetime. */
export function peopleOverviewFamily(
  type: string | undefined,
  view: string,
  account: boolean,
): PeopleFamily | undefined {
  if (account || view !== 'overview') return;
  if (type === 'wd:Q95074') return 'character';
  if (type === 'schema:Person') return 'person';
  if (type === 'schema:Organization') return 'organization';
}

const discussionNodes = new Set(['ThreadList', 'ReviewList']);

/** Reuse the page projection: native plans, node ids and order within each stream stay intact. */
export function peopleOverviewParts(document: PageDocument) {
  const layout = (type: string) => !!platformRegistry.components.find((entry) => entry.type === type)?.slots?.length;
  return {
    lead: projectReadingDocument(document, (node) => node.type !== 'Summary' && !layout(node.type)),
    exploration: projectReadingDocument(
      document,
      (node) => discussionNodes.has(node.type) || node.type === 'Sources' || node.type === 'Summary',
    ),
    discussion: projectReadingDocument(document, (node) => !discussionNodes.has(node.type) && !layout(node.type)),
  };
}
