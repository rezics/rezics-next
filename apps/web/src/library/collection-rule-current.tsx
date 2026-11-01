import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { operationIsAdmitted } from '../kernel/exposure';
import { exposureQuery, sessionQuery, useSession } from '../session/query';
import { CollectionRuleEditor } from './collection-rule-editor';
import type { RulePage } from './collection-rule-read';
import { readCollectionRule, readCollectionRuleChoices, saveCollectionRule } from './collection-rule-actions';

type Session = { state: string; subject?: string | null; csrfToken?: string | null };

/** Observe every cache transition, including an ABA that React has not rendered yet. */
export function useCollectionOwnerCurrent(address: string, withLabels = false) {
  const session = useSession();
  useQuery({ ...exposureQuery, enabled: session.state === 'signed-in' });
  const client = useQueryClient();
  const store = useMemo(() => {
    let snapshot = { scope: '', generation: 0 };
    function read() {
      const actual = client.getQueryData<Session>(sessionQuery.queryKey);
      const groups = client.getQueryData<readonly string[]>(exposureQuery.queryKey);
      const subject = actual?.state === 'signed-in' && actual.subject && actual.csrfToken ? actual.subject : null;
      const scope = JSON.stringify([
        subject,
        operationIsAdmitted('collection.get', groups),
        withLabels && operationIsAdmitted('library_label.list', groups),
      ]);
      if (snapshot.scope !== scope) snapshot = { scope, generation: snapshot.generation + 1 };
      return snapshot;
    }
    return {
      read,
      subscribe: (notify: () => void) =>
        client.getQueryCache().subscribe(() => {
          read();
          notify();
        }),
    };
  }, [client, withLabels]);
  const snapshot = useSyncExternalStore(store.subscribe, store.read, store.read);
  const groups = client.getQueryData<readonly string[]>(exposureQuery.queryKey);
  const actual = client.getQueryData<Session>(sessionQuery.queryKey);
  const subject =
    session.state === 'signed-in' &&
    session.subject &&
    session.csrfToken &&
    actual?.state === 'signed-in' &&
    actual.subject === session.subject &&
    actual.csrfToken
      ? session.subject
      : null;
  const admitted = !!subject && operationIsAdmitted('collection.get', groups);
  const canLabel = admitted && operationIsAdmitted('library_label.list', groups);
  const scope = JSON.stringify([snapshot.generation, subject, admitted, address]);
  const boundary = useRef<{ scope: string; generation: number; lifetime: string; active: boolean } | null>(null);
  if (!boundary.current) boundary.current = { scope, generation: 0, lifetime: crypto.randomUUID(), active: true };
  if (boundary.current.scope !== scope) {
    boundary.current.active = false;
    boundary.current = {
      scope,
      generation: boundary.current.generation + 1,
      lifetime: crypto.randomUUID(),
      active: true,
    };
  }
  const origin = boundary.current;
  useLayoutEffect(() => {
    origin.active = true;
    return () => {
      origin.active = false;
    };
  }, [origin]);
  function isCurrent() {
    return origin.active && admitted && store.read() === snapshot;
  }
  function credential() {
    if (!isCurrent()) return null;
    const current = client.getQueryData<Session>(sessionQuery.queryKey);
    return current?.state === 'signed-in' && current.subject === subject && current.csrfToken
      ? current.csrfToken
      : null;
  }
  return {
    subject,
    admitted,
    canLabel,
    isCurrent,
    credential,
    generation: origin.generation,
    lifetime: origin.lifetime,
  };
}

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
  // A retired loader object cannot seed a returning viewer/admission/address lifetime.
  const history = useRef({ generation: owner.generation, seen: new Set<string>(), retired: new Set<string>() });
  if (history.current.generation !== owner.generation) {
    for (const value of history.current.seen) history.current.retired.add(value);
    history.current.seen.clear();
    history.current.generation = owner.generation;
  }
  const identity = page.state === 'ready' || page.state === 'new' ? JSON.stringify([page.viewerId, page.intent]) : '';
  const valid = owner.admitted && matches(page, owner.subject, collectionId) && !history.current.retired.has(identity);
  if (valid) history.current.seen.add(identity);
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
      csrfToken={owner.credential() ?? ''}
      isCurrent={owner.isCurrent}
      currentCsrf={owner.credential}
      save={(data, csrf) =>
        owner.isCurrent()
          ? saveCollectionRule({ data, headers: { 'X-CSRF-Token': csrf } })
          : Promise.resolve({ ok: false, reason: 'unauthorized' })
      }
      reload={async () => {
        if (!owner.isCurrent()) return { state: 'denied' };
        const value = await readCollectionRule({ data: collectionId ?? undefined });
        if (!owner.isCurrent() || !matches(value, owner.subject, collectionId)) return { state: 'denied' };
        if (value.state === 'ready' || value.state === 'new')
          history.current.seen.add(JSON.stringify([value.viewerId, value.intent]));
        return value;
      }}
      labels={async (q, cursor) => {
        if (!owner.isCurrent() || !owner.canLabel) return null;
        const value = await readCollectionRuleChoices({ data: { q, ...(cursor === undefined ? {} : { cursor }) } });
        return owner.isCurrent() &&
          value?.viewerId === owner.subject &&
          value.address?.q === q &&
          value.address.cursor === (cursor ?? null)
          ? value
          : null;
      }}
      {...(navigate
        ? {
            navigate: (id: string) => {
              if (owner.isCurrent()) navigate(id);
            },
          }
        : {})}
    />
  );
}
