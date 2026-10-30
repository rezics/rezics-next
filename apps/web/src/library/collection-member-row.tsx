import { MetaLine } from '@rezics/ui/meta-line';
import { listKeyFacts } from '../media/type-presentation';
import { getLocale } from '../paraglide/runtime.js';
import type { CollectionListPresentations } from './collection-presentation';
import type { CollectionMember } from './reads';

/** Only the supplied FULL facts and the member's actual released Type decide these details. */
export function CollectionMemberDetails({
  member,
  listPresentations,
}: {
  member: Pick<CollectionMember, 'subject' | 'facts'>;
  listPresentations?: CollectionListPresentations | undefined;
}) {
  if (!member.subject) return null;
  const facts = listKeyFacts(member.facts, listPresentations?.[member.subject.type]?.keyFacts, [], getLocale());
  return (
    <>
      {member.subject.typeLabel ? <p className="text-sm text-muted-foreground">{member.subject.typeLabel}</p> : null}
      {facts.length ? (
        <p data-slot="member-list-row-facts" className="text-sm text-muted-foreground">
          <MetaLine
            items={facts.map((fact, index) => (
              <span key={index} lang={fact.lang}>
                {fact.text}
              </span>
            ))}
          />
        </p>
      ) : null}
    </>
  );
}
