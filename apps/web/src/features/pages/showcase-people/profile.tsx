import { pickText, platformRegistry } from '@rezics/composition';
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
    exploration: projectReadingDocument(
      document,
      (node) => discussionNodes.has(node.type) || node.type === 'Sources' || node.type === 'Summary',
    ),
    discussion: projectReadingDocument(document, (node) => !discussionNodes.has(node.type) && !layout(node.type)),
  };
}

/** Terms supply short context; the family's native reader owns the admitted biography document. */
export function PeopleProfileContext({
  descriptions,
  locale,
}: {
  descriptions: Record<string, string>;
  locale: string;
}) {
  const description = pickText(descriptions, locale);
  return description.text ? (
    <p
      data-slot="people-profile-context"
      lang={description.lang ?? undefined}
      className="max-w-prose text-lg leading-relaxed text-muted-foreground [overflow-wrap:anywhere]"
    >
      {description.text}
    </p>
  ) : null;
}
