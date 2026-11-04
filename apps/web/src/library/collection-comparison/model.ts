import { listKeyFacts } from '../../media/type-presentation';
import { resultFactLabel, type ResultFactDefinitions } from '../../search/work-context/facts';
import { subjectHref } from '../../subject/subject-href';
import { subjectVisitReturn } from '../../features/pages/subject-visit-navigation';
import { collectionMemberReturnAddress, collectionViewerActionHref } from '../collection-viewer/model';
import type { CollectionMember } from '../reads';
import type { CollectionListPresentations } from '../collection-presentation';

export type CollectionComparisonDefinitions = ResultFactDefinitions;

/** Project labels for at most four selected properties per row from the one admitted page release. */
export function collectionComparisonDefinitions(
  members: readonly Pick<CollectionMember, 'subject' | 'facts'>[],
  presentations: CollectionListPresentations,
  definitions: CollectionComparisonDefinitions,
): CollectionComparisonDefinitions {
  const properties = new Set(
    members
      .slice(0, 100)
      .flatMap((member) =>
        member.subject
          ? (presentations[member.subject.type]?.keyFacts ?? Object.keys(member.facts ?? {})).slice(0, 4)
          : [],
      ),
  );
  return Object.fromEntries(
    [...properties].flatMap((property) =>
      Object.hasOwn(definitions, property)
        ? [[property, definitions[property]?.labels ? { labels: definitions[property]!.labels! } : {}]]
        : [],
    ),
  );
}

/** Read only the response's finite facts; shared formatting retains recorded date precision. */
export function collectionComparisonFacts(
  member: Pick<CollectionMember, 'subject' | 'facts'>,
  presentations: CollectionListPresentations | undefined,
  definitions: CollectionComparisonDefinitions | undefined,
  locale: string,
) {
  if (!member.subject) return [];
  const properties = presentations?.[member.subject.type]?.keyFacts ?? Object.keys(member.facts ?? {});
  return properties
    .slice(0, 4)
    .flatMap((property) =>
      (member.facts?.[property] ?? []).slice(0, 3).flatMap((value) =>
        listKeyFacts({ [property]: [value] }, [property], [], locale).map((formatted) => ({
          ...formatted,
          label: resultFactLabel(property, definitions, locale),
          ...(value.kind === 'item' && value.id ? { targetId: value.id } : {}),
        })),
      ),
    )
    .slice(0, 4);
}

/** Reuse the Subject visit convention. Filtered projections without occurrence IDs return to their page only. */
export function collectionComparisonHref(
  id: string,
  label: string,
  locale: string,
  currentHref: string | undefined,
  memberId: string | undefined,
) {
  const target = subjectHref({ id, label }, locale).href;
  const returnTo =
    currentHref &&
    (memberId
      ? collectionMemberReturnAddress(currentHref, memberId)
      : subjectVisitReturn(currentHref.split('#')[0], locale));
  return collectionViewerActionHref(target, returnTo || undefined) ?? target;
}
