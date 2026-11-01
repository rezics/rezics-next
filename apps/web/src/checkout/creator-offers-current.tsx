import { useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useOperation } from '../kernel/exposure';
import { personalRead } from '../kernel/query';
import { useSession } from '../session/query';
import { PendingPage } from '../shell/pending';
import { CreatorOfferEditor } from './creator-offer-editor';
import { CreatorOffersPage } from './creator-offers-page';
import {
  readCreatorOfferEditorCurrent,
  readCreatorOffersCurrent,
  type CreatorEditorCurrentRead,
  type CreatorOfferAddress,
  type CreatorOfferGuard,
  type CreatorOffersCurrentRead,
} from './creator-offers';

type Read = CreatorOffersCurrentRead | CreatorEditorCurrentRead;
type Origin = { active: boolean; csrfToken: string | null };
type Props = { initial: Read; address: CreatorOfferAddress; locale: string; offerPageAvailable?: boolean };
const subscribe = () => () => {};

function matches(value: Read | undefined, subject: string, address: CreatorOfferAddress): value is Read {
  if (!value || value.sessionSubject !== subject || value.requested.kind !== address.kind) return false;
  if (address.kind === 'list') {
    return (
      value.requested.kind === 'list' &&
      value.requested.cursor === address.cursor &&
      'page' in value.data &&
      (value.data.page.kind !== 'ready' ||
        value.data.page.offers.every(
          (offer) => offer.contentEdition === null || offer.contentEdition.creatorAccountId === subject,
        ))
    );
  }
  return (
    value.requested.kind === 'editor' &&
    value.requested.contentEditionId === address.contentEditionId &&
    'editor' in value.data &&
    (value.data.editor.kind !== 'ready' ||
      (value.data.editor.edition.editionId === address.contentEditionId &&
        value.data.editor.edition.creatorAccountId === subject))
  );
}

export function CreatorOffersCurrent({
  initial,
  locale,
  cursor,
}: {
  initial: CreatorOffersCurrentRead;
  locale: string;
  cursor?: string | undefined;
}) {
  // Public offer links have their own admission, separate from private seller management.
  const offerPageAvailable = useOperation('offer.get');
  return (
    <CreatorCurrent
      initial={initial}
      address={{ kind: 'list', cursor: cursor || null }}
      locale={locale}
      offerPageAvailable={offerPageAvailable}
    />
  );
}

export function CreatorOfferEditorCurrent({
  initial,
  locale,
  contentEditionId,
}: {
  initial: CreatorEditorCurrentRead;
  locale: string;
  contentEditionId?: string | undefined;
}) {
  return (
    <CreatorCurrent
      initial={initial}
      address={{ kind: 'editor', contentEditionId: contentEditionId || null }}
      locale={locale}
    />
  );
}

function Notice({
  kind,
  address,
  locale,
}: Pick<Props, 'address' | 'locale'> & {
  kind: 'denied' | 'closed' | 'unavailable' | 'preparing';
}) {
  if (address.kind === 'list')
    return (
      <CreatorOffersPage page={{ kind }} locale={locale} {...(address.cursor ? { cursor: address.cursor } : {})} />
    );
  if (kind === 'preparing') return <PendingPage />;
  return (
    <CreatorOfferEditor data={{ editor: { kind }, selling: false, csrfToken: '', createKey: '' }} locale={locale} />
  );
}

/** Retire synchronously on observed replacement, including address/viewer/admission ABA. */
function CreatorCurrent(props: Props) {
  const { initial, address, locale } = props;
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const session = useSession();
  const selling = useOperation('offer.list');
  const subject = hydrated ? (session.state === 'signed-in' ? session.subject : null) : initial.sessionSubject;
  const admitted = hydrated ? selling : initial.data.selling;
  const identity = JSON.stringify([subject ?? null, admitted, address]);
  const [scope, setScope] = useState(() => ({
    identity,
    generation: 0,
    seed: true,
    origin: { active: true, csrfToken: null } as Origin,
  }));
  if (scope.identity !== identity) {
    scope.origin.active = false;
    setScope({ identity, generation: scope.generation + 1, seed: false, origin: { active: true, csrfToken: null } });
  }
  // Token rotation is not a new intent. Retired callbacks keep their retired origin object.
  scope.origin.csrfToken = hydrated ? session.csrfToken : null;
  useLayoutEffect(() => {
    scope.origin.active = true;
    return () => {
      scope.origin.active = false;
    };
  }, [scope.origin]);
  if (!subject) {
    const kind =
      hydrated && session.state === 'unavailable'
        ? 'unavailable'
        : hydrated && (session.state === 'unknown' || session.state === 'signed-in')
          ? 'preparing'
          : 'denied';
    return <Notice kind={kind} address={address} locale={locale} />;
  }
  if (!admitted) return <Notice kind="closed" address={address} locale={locale} />;
  return (
    <CreatorRead
      key={scope.generation}
      {...props}
      subject={subject}
      hydrated={hydrated}
      seed={scope.seed}
      origin={scope.origin}
    />
  );
}

async function read(address: CreatorOfferAddress): Promise<Read> {
  return address.kind === 'list'
    ? readCreatorOffersCurrent({ data: address.cursor ? { cursor: address.cursor } : {} })
    : readCreatorOfferEditorCurrent({
        data: address.contentEditionId ? { contentEditionId: address.contentEditionId } : {},
      });
}

type Outcome = { kind: 'accepted'; value: Read } | { kind: 'failed' };
function CreatorRead({
  initial,
  address,
  locale,
  offerPageAvailable,
  subject,
  hydrated,
  seed,
  origin,
}: Props & {
  subject: string;
  hydrated: boolean;
  seed: boolean;
  origin: Origin;
}) {
  const [lifetime] = useState(() => crypto.randomUUID());
  const [initialData] = useState<Outcome | undefined>(() =>
    seed && matches(initial, subject, address) ? { kind: 'accepted', value: initial } : undefined,
  );
  const [guard] = useState<CreatorOfferGuard>(() => ({
    isCurrent: () => origin.active,
    csrfToken: () => origin.csrfToken,
  }));
  const query = useQuery<Outcome | null>({
    ...personalRead,
    queryKey: ['creator-offers-current', subject, address, lifetime],
    enabled: hydrated && personalRead.enabled,
    queryFn: async () => {
      if (!origin.active) return null;
      try {
        const value = await read(address);
        return origin.active && matches(value, subject, address) ? { kind: 'accepted', value } : null;
      } catch {
        return origin.active ? { kind: 'failed' } : null;
      }
    },
    ...(initialData ? { initialData } : {}),
    refetchOnMount: !initialData,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const [display, setDisplay] = useState(() => ({
    loader: initial,
    outcome: initialData,
    value: initialData?.kind === 'accepted' ? initialData.value : undefined,
  }));
  if (seed && initial !== display.loader) {
    // Ordinary same-origin loader refreshes may update rows without replacing uncertain commands.
    setDisplay({ ...display, loader: initial, value: matches(initial, subject, address) ? initial : display.value });
  } else if (query.data && query.data !== display.outcome) {
    setDisplay({
      ...display,
      outcome: query.data,
      value: query.data.kind === 'accepted' ? query.data.value : undefined,
    });
  }
  const data = display.value?.data;
  if (!data)
    return (
      <Notice
        kind={display.outcome?.kind === 'failed' ? 'unavailable' : 'preparing'}
        address={address}
        locale={locale}
      />
    );
  if (
    !data.selling &&
    (('page' in data && data.page.kind === 'ready') || ('editor' in data && data.editor.kind === 'ready'))
  )
    return <Notice kind="closed" address={address} locale={locale} />;
  if ('page' in data)
    return (
      <CreatorOffersPage
        data={data}
        guard={guard}
        locale={locale}
        offerPageAvailable={offerPageAvailable ?? false}
        {...(address.kind === 'list' && address.cursor ? { cursor: address.cursor } : {})}
      />
    );
  return <CreatorOfferEditor data={data} guard={guard} locale={locale} />;
}
