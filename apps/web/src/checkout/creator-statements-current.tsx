import { useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useOperation } from '../kernel/exposure';
import { personalRead } from '../kernel/query';
import { useSession } from '../session/query';
import {
  acceptsStatementsCurrent,
  readCreatorStatementCurrent,
  readCreatorStatementsCurrent,
  type CreatorStatementCurrentRead,
  type CreatorStatementData,
  type CreatorStatementsAddress,
  type CreatorStatementsCurrentRead,
  type CreatorStatementsData,
} from './creator-statements';
import { CreatorStatementPage } from './creator-statement-page';
import { CreatorStatementsPage } from './creator-statements-page';

const subscribe = () => () => {};
type Page = CreatorStatementsData | CreatorStatementData | { kind: 'preparing' };
type CurrentRead = CreatorStatementsCurrentRead<CreatorStatementsData | CreatorStatementData>;
type Origin = { active: boolean };
type Outcome = { kind: 'accepted'; value: CurrentRead } | { kind: 'failed' };

export function CreatorStatementsCurrent({
  initial,
  locale,
  cursor,
}: {
  initial: CreatorStatementsCurrentRead;
  locale: string;
  cursor?: string;
}) {
  return <StatementsBoundary initial={initial} address={{ kind: 'list', locale, cursor: cursor || null }} />;
}

export function CreatorStatementCurrent({
  initial,
  locale,
  id,
  cursor,
  from,
}: {
  initial: CreatorStatementCurrentRead;
  locale: string;
  id: string;
  cursor?: string;
  from?: string;
}) {
  return (
    <StatementsBoundary
      initial={initial}
      address={{ kind: 'detail', locale, id, cursor: cursor || null, from: from || null }}
    />
  );
}

function StatementPresentation({ address, page }: { address: CreatorStatementsAddress; page: Page }) {
  const search = address.cursor ? { cursor: address.cursor } : {};
  return address.kind === 'list' ? (
    <CreatorStatementsPage
      page={page as CreatorStatementsData | { kind: 'preparing' }}
      locale={address.locale}
      {...search}
    />
  ) : (
    <CreatorStatementPage
      page={page as CreatorStatementData | { kind: 'preparing' }}
      locale={address.locale}
      id={address.id}
      {...search}
      {...(address.from ? { from: address.from } : {})}
    />
  );
}

/** Retirement happens during render, before any retained private child or callback can be used. */
function StatementsBoundary({ initial, address }: { initial: CurrentRead; address: CreatorStatementsAddress }) {
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const session = useSession();
  const selling = useOperation('payout_statement.list');
  const subject = hydrated ? (session.state === 'signed-in' ? session.subject : null) : initial.sessionSubject;
  const admitted = hydrated ? selling : !!initial.sessionSubject;
  const key = JSON.stringify([subject || null, admitted, address]);
  const [scope, setScope] = useState(() => ({ key, generation: 0, seed: true, origin: { active: true } }));
  if (scope.key !== key) {
    scope.origin.active = false;
    setScope({ key, generation: scope.generation + 1, seed: false, origin: { active: true } });
  }
  useLayoutEffect(() => {
    scope.origin.active = true;
    return () => {
      scope.origin.active = false;
    };
  }, [scope.origin]);
  if (!subject || !admitted) {
    const kind =
      hydrated && session.state === 'unavailable'
        ? 'unavailable'
        : hydrated && (session.state === 'unknown' || (session.state === 'signed-in' && !subject))
          ? 'preparing'
          : 'denied';
    return <StatementPresentation address={address} page={{ kind }} />;
  }
  return (
    <StatementsRead
      key={scope.generation}
      initial={initial}
      address={address}
      subject={subject}
      hydrated={hydrated}
      seed={scope.seed}
      origin={scope.origin}
    />
  );
}

async function readCurrent(address: CreatorStatementsAddress): Promise<CurrentRead> {
  const data = { locale: address.locale, ...(address.cursor ? { cursor: address.cursor } : {}) };
  return address.kind === 'list'
    ? readCreatorStatementsCurrent({ data })
    : readCreatorStatementCurrent({
        data: { ...data, id: address.id, ...(address.from ? { from: address.from } : {}) },
      });
}

function StatementsRead({
  initial,
  address,
  subject,
  hydrated,
  seed,
  origin,
}: {
  initial: CurrentRead;
  address: CreatorStatementsAddress;
  subject: string;
  hydrated: boolean;
  seed: boolean;
  origin: Origin;
}) {
  const [lifetime] = useState(() => crypto.randomUUID());
  const [initialData] = useState<Outcome | undefined>(() =>
    seed && acceptsStatementsCurrent(initial, subject, address) ? { kind: 'accepted', value: initial } : undefined,
  );
  const query = useQuery<Outcome | null>({
    ...personalRead,
    queryKey: ['creator-statements-current', subject, address, lifetime],
    enabled: hydrated && personalRead.enabled,
    queryFn: async () => {
      if (!origin.active) return null;
      try {
        const value = await readCurrent(address);
        return origin.active && acceptsStatementsCurrent(value, subject, address) ? { kind: 'accepted', value } : null;
      } catch {
        return origin.active ? { kind: 'failed' } : null;
      }
    },
    ...(initialData ? { initialData } : {}),
    // The actual loader already performed this lifetime's bounded read.
    refetchOnMount: !initialData,
    gcTime: 0,
    retry: false,
    throwOnError: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const [display, setDisplay] = useState(() => ({
    observed: initialData,
    page: initialData?.kind === 'accepted' ? initialData.value.page : ({ kind: 'preparing' } as Page),
  }));
  // Foreign/obsolete responses, including their completion, never replace accepted current data.
  if (query.data && query.data !== display.observed) {
    setDisplay({
      observed: query.data,
      page: query.data.kind === 'accepted' ? query.data.value.page : { kind: 'unavailable' },
    });
  }
  return <StatementPresentation address={address} page={display.page} />;
}
