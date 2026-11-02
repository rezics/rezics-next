import { useRef } from 'react';
import { CollectionRuleEditor } from './collection-rule-editor';
import type { RulePage } from './collection-rule-read';
import { readCollectionRule, readCollectionRuleChoices, saveCollectionRule } from './collection-rule-actions';
import { useCollectionOwnerCurrent } from './collection-owner-current';

export { useCollectionOwnerCurrent } from './collection-owner-current';

function matches(page: RulePage, subject: string | null, collectionId: string | null) {
  return (
    (page.state === 'new' || page.state === 'ready') &&
    page.viewerId === subject &&
    page.address?.collectionId === collectionId &&
    (page.state === 'ready' ? page.id === collectionId : collectionId === null)
  );
}

/** Actual routes consume groups; the standalone editor retains its explicit operation fixtures. */
export function CollectionRuleCurrent({
  page,
  collectionId,
  navigate,
}: {
  page: RulePage;
  collectionId: string | null;
  navigate?: (id: string) => void;
}) {
  const owner = useCollectionOwnerCurrent(JSON.stringify(['rule', collectionId]), true);
  // A retired loader object cannot seed a returning viewer/address lifetime.
  const history = useRef({ generation: owner.generation, seen: new Set<string>(), retired: new Set<string>() });
  if (history.current.generation !== owner.generation) {
    for (const value of history.current.seen) history.current.retired.add(value);
    history.current.seen.clear();
    history.current.generation = owner.generation;
  }
  const identity = page.state === 'ready' || page.state === 'new' ? JSON.stringify([page.viewerId, page.intent]) : '';
  const valid = matches(page, owner.subject, collectionId) && !history.current.retired.has(identity);
  if (valid && owner.admitted) history.current.seen.add(identity);
  const operations = owner.admitted
    ? [
        'collection.create',
        'collection_rule.get',
        'collection_rule.update',
        ...(owner.canLabel ? ['library_label.list'] : []),
      ]
    : undefined;
  return (
    <CollectionRuleEditor
      key={owner.generation}
      page={valid ? page : { state: page.state === 'unavailable' ? 'unavailable' : 'denied' }}
      viewerId={owner.subject}
      collectionId={collectionId}
      admitted={operations}
      csrfToken={owner.csrfToken}
      isCurrent={owner.isCurrent}
      isOwnerCurrent={owner.isOwnerCurrent}
      canLabelCurrent={owner.canLabelCurrent}
      currentCsrf={owner.credential}
      requireProvenance
      save={(data, csrf) =>
        owner.isCurrent() && owner.credential()
          ? saveCollectionRule({ data, headers: { 'X-CSRF-Token': csrf } })
          : Promise.resolve({ ok: false, reason: 'unauthorized' })
      }
      captureSave={() => {
        if (!owner.isCurrent() || !owner.credential()) return null;
        const send = saveCollectionRule;
        return (data, csrf) => send({ data, headers: { 'X-CSRF-Token': csrf } });
      }}
      reload={async () => {
        if (!owner.isCurrent()) return { state: 'denied' };
        const value = await readCollectionRule({ data: collectionId ?? undefined });
        if (!owner.isCurrent() || !matches(value, owner.subject, collectionId)) return { state: 'denied' };
        if (value.state === 'ready' || value.state === 'new')
          history.current.seen.add(JSON.stringify([value.viewerId, value.intent]));
        return value;
      }}
      labels={async (q, cursor) => {
        if (!owner.canLabelCurrent()) return null;
        const value = await readCollectionRuleChoices({ data: { q, ...(cursor === undefined ? {} : { cursor }) } });
        return owner.canLabelCurrent() &&
          value?.viewerId === owner.subject &&
          value.address?.q === q &&
          value.address.cursor === (cursor ?? null)
          ? value
          : null;
      }}
      {...(navigate
        ? {
            navigate: (id: string) => {
              if (owner.isOwnerCurrent()) navigate(id);
            },
          }
        : {})}
    />
  );
}
