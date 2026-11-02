import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@rezics/ui/shadcn/button';
import { useOperation } from '../kernel/exposure';
import { personalRead } from '../kernel/query';
import { m } from '../paraglide/messages.js';
import { useCreatorCurrentOrigin, useCreatorIntent } from './creator-current-origin';
import { CreatorOfferAddressPage, CreatorOfferRequested } from './creator-offer-address-page';
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
type Origin = ReturnType<typeof useCreatorCurrentOrigin>['origin'];
type Props = { initial: Read; address: CreatorOfferAddress; locale: string; offerPageAvailable?: boolean };

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
  if (kind === 'preparing') return <CreatorOfferAddressPage kind="editor" locale={locale} />;
  return (
    <CreatorOfferEditor data={{ editor: { kind }, selling: false, csrfToken: '', createKey: '' }} locale={locale} />
  );
}

/** Cache observation fences retained reads and commands before React commits a replacement. */
function CreatorCurrent(props: Props) {
  const requested = props.address.kind === 'list' ? props.address.cursor : props.address.contentEditionId;
  return <><CreatorOfferRequested requested={requested ?? undefined} /><CreatorCurrentContent {...props} /></>;
}

function CreatorCurrentContent(props: Props) {
  const { initial, address, locale } = props;
  const current = useCreatorCurrentOrigin('offer.list', JSON.stringify([locale, address]));
  const { hydrated, origin, seed } = current;
  const subject = hydrated ? current.subject : initial.sessionSubject;
  const admitted = hydrated ? origin.isCurrent() : initial.data.selling;
  if (!subject || !admitted) {
    const kind =
      current.state === 'unavailable' || current.admission === 'unavailable'
        ? 'unavailable'
        : current.state === 'signed-out'
          ? 'denied'
          : current.admission === 'closed'
            ? 'closed'
            : 'preparing';
    return <Notice kind={kind} address={address} locale={locale} />;
  }
  return <CreatorRead key={origin.id} {...props} subject={subject} hydrated={hydrated} seed={seed} origin={origin} />;
}

async function read(address: CreatorOfferAddress): Promise<Read> {
  return address.kind === 'list'
    ? readCreatorOffersCurrent({ data: address.cursor ? { cursor: address.cursor } : {} })
    : readCreatorOfferEditorCurrent({
        data: address.contentEditionId ? { contentEditionId: address.contentEditionId } : {},
      });
}

type Outcome = { kind: 'accepted'; value: Read } | { kind: 'failed' };

/** An explicit nonprivate response withdraws display even when session preparation lost its subject. */
function withdraws(value: Read, address: CreatorOfferAddress): boolean {
  const sameAddress =
    value.requested.kind === address.kind &&
    (address.kind === 'list'
      ? value.requested.kind === 'list' && value.requested.cursor === address.cursor
      : value.requested.kind === 'editor' && value.requested.contentEditionId === address.contentEditionId);
  const kind = 'page' in value.data ? value.data.page.kind : value.data.editor.kind;
  return sameAddress && (kind === 'denied' || kind === 'closed' || kind === 'unavailable');
}

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
  const [initialData] = useState<Outcome | undefined>(() => {
    const retained = origin.workspace.read as Read | undefined;
    const value = retained ?? (seed ? initial : undefined);
    return matches(value, subject, address) ? { kind: 'accepted', value } : undefined;
  });
  const guard: CreatorOfferGuard = origin;
  const refreshFailure = useCreatorIntent<boolean>(guard, 'offer-refresh-failed');
  const query = useQuery<Outcome | null>({
    ...personalRead,
    queryKey: ['creator-offers-current', subject, locale, address, origin.id],
    enabled: hydrated && origin.isCurrent() && personalRead.enabled,
    queryFn: async () => {
      if (!origin.isCurrent()) return null;
      try {
        const value = await read(address);
        return origin.isCurrent() && (matches(value, subject, address) || withdraws(value, address))
          ? { kind: 'accepted', value }
          : null;
      } catch {
        return origin.isCurrent() ? { kind: 'failed' } : null;
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
    outcome: initialData,
    value: initialData?.kind === 'accepted' ? initialData.value : undefined,
  }));
  // A loader refresh is not a new admitted origin. Keep its observed rows/edition and
  // command operands mounted, even if that refresh omits a row or temporarily fails.
  if (origin.isCurrent() && query.data && query.data !== display.outcome) {
    refreshFailure.value = query.data.kind === 'failed';
    setDisplay({
      ...display,
      outcome: query.data,
      value: query.data.kind === 'accepted' ? query.data.value : display.value,
    });
  }
  if (hydrated && !origin.isCurrent()) return <Notice kind="preparing" address={address} locale={locale} />;
  if (display.value && origin.isCurrent()) origin.workspace.read = display.value;
  const data = display.value?.data;
  let content;
  if (!data)
    content = (
      <Notice
        kind={display.outcome?.kind === 'failed' ? 'unavailable' : 'preparing'}
        address={address}
        locale={locale}
      />
    );
  else if (
    !data.selling &&
    (('page' in data && data.page.kind === 'ready') || ('editor' in data && data.editor.kind === 'ready'))
  )
    content = <Notice kind="closed" address={address} locale={locale} />;
  else if ('page' in data)
    content = (
      <CreatorOffersPage
        data={data}
        guard={guard}
        onRefresh={() => void query.refetch()}
        onConfirm={async (id) => {
          const refreshed = await query.refetch({ cancelRefetch: true });
          const outcome = refreshed.data;
          if (!origin.isCurrent() || outcome?.kind !== 'accepted' || !matches(outcome.value, subject, address))
            return null;
          const latest = outcome.value.data;
          return 'page' in latest && latest.selling && latest.page.kind === 'ready'
            ? (latest.page.offers.find((offer) => offer.id === id) ?? null)
            : null;
        }}
        refreshing={query.isFetching}
        locale={locale}
        offerPageAvailable={offerPageAvailable ?? false}
        {...(address.kind === 'list' && address.cursor ? { cursor: address.cursor } : {})}
      />
    );
  else
    content =
      data.editor.kind === 'ready' ? (
        <CreatorOfferEditor data={data} guard={guard} locale={locale} />
      ) : (
        <CreatorOfferEditor data={data} locale={locale} />
      );
  return (
    <>
      {refreshFailure.value && (
        <div role="alert" className="mb-6 space-y-3 rounded-xl border bg-card p-5 text-card-foreground">
          <p>{m.creator_unavailable()}</p>
          <Button
            variant="outline"
            className="min-h-11"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            {m.creator_offers_refresh()}
          </Button>
        </div>
      )}
      {content}
    </>
  );
}
