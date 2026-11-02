import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { personalRead } from '../kernel/query';
import { useCreatorCurrentOrigin } from './creator-current-origin';
import {
  parseCreatorSalesPage,
  readCreatorSalesCurrent,
  type CreatorSalesCurrentRead,
  type CreatorSalesData,
} from './creator-sales';
import { CreatorSalesPage } from './creator-sales-page';

type Origin = ReturnType<typeof useCreatorCurrentOrigin>['origin'];
type Props = { initial: CreatorSalesCurrentRead; locale: string; cursor?: string | undefined };

function matches(value: unknown, subject: string, cursor: string | null): value is CreatorSalesCurrentRead {
  if (
    !value ||
    typeof value !== 'object' ||
    !('sessionSubject' in value) ||
    value.sessionSubject !== subject ||
    !('requested' in value) ||
    !value.requested ||
    typeof value.requested !== 'object' ||
    !('cursor' in value.requested) ||
    value.requested.cursor !== cursor ||
    !('selling' in value) ||
    typeof value.selling !== 'boolean' ||
    !('page' in value) ||
    !value.page ||
    typeof value.page !== 'object' ||
    !('kind' in value.page)
  )
    return false;
  return value.page.kind === 'ready'
    ? value.selling && parseCreatorSalesPage(value.page) !== null
    : ['denied', 'unavailable', 'error', 'stale', 'loading'].includes(String(value.page.kind));
}

export function CreatorSalesCurrent(props: Props) {
  const { initial, locale, cursor } = props;
  const current = useCreatorCurrentOrigin('commerce_sale.list', JSON.stringify([locale, cursor ?? null]));
  const subject = current.hydrated ? current.subject : initial.sessionSubject;
  const admitted = current.hydrated ? current.origin.isCurrent() : initial.selling;
  if (!subject || !admitted) {
    if (!current.hydrated && initial.page.kind !== 'ready')
      return <CreatorSalesPage page={initial.page} locale={locale} {...(cursor === undefined ? {} : { cursor })} />;
    const kind =
      current.state === 'unavailable' || current.admission === 'unavailable'
        ? 'unavailable'
        : current.state === 'signed-out' || current.admission === 'closed'
          ? 'denied'
          : 'loading';
    return <CreatorSalesPage page={{ kind }} locale={locale} {...(cursor === undefined ? {} : { cursor })} />;
  }
  return (
    <CurrentSalesRead
      key={current.origin.id}
      {...props}
      subject={subject}
      origin={current.origin}
      hydrated={current.hydrated}
      seed={current.seed}
    />
  );
}

function CurrentSalesRead({
  initial,
  locale,
  cursor,
  subject,
  origin,
  hydrated,
  seed,
}: Props & {
  subject: string;
  origin: Origin;
  hydrated: boolean;
  seed: boolean;
}) {
  const [initialData] = useState<CreatorSalesCurrentRead | undefined>(() => {
    const retained = origin.workspace.read;
    const value = retained ?? (seed ? initial : undefined);
    return matches(value, subject, cursor ?? null) ? value : undefined;
  });
  const query = useQuery<CreatorSalesCurrentRead | null>({
    ...personalRead,
    queryKey: ['creator-sales-current', subject, locale, cursor ?? null, origin.id],
    enabled: hydrated && origin.isCurrent() && personalRead.enabled,
    queryFn: async () => {
      if (!origin.isCurrent()) return null;
      try {
        const value = await readCreatorSalesCurrent({ data: cursor ? { cursor } : {} });
        return origin.isCurrent() && matches(value, subject, cursor ?? null) ? value : null;
      } catch {
        return origin.isCurrent()
          ? {
              sessionSubject: subject,
              requested: { cursor: cursor ?? null },
              selling: true,
              page: { kind: 'unavailable' },
            }
          : null;
      }
    },
    ...(initialData ? { initialData } : {}),
    refetchOnMount: !initialData,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const value = query.data ?? initialData;
  if (hydrated && !origin.isCurrent())
    return (
      <CreatorSalesPage page={{ kind: 'loading' }} locale={locale} {...(cursor === undefined ? {} : { cursor })} />
    );
  if (value && origin.isCurrent()) origin.workspace.read = value;
  const page: CreatorSalesData = value?.page ?? { kind: 'loading' };
  return <CreatorSalesPage page={page} locale={locale} {...(cursor === undefined ? {} : { cursor })} />;
}
