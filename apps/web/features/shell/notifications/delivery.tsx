'use client';

import { Button } from '@rezics/ui/button';
import { materializeData } from 'native-i18n';
import { useRef, useState } from 'react';
import { signInPath } from '../../auth/paths.ts';
import { failureText, type Loaded, type MainClient } from '../../feed/types.ts';
import { localizedPath } from '../../../i18n/locale.ts';
import { failureDetail } from '../empty-state.tsx';
import { useShell } from '../shell-provider.tsx';
import { messages } from './messages.ts';
import { readNotificationDelivery, type NotificationDelivery, type StreamItem } from './window.ts';

/** Only requested recipient delivery reads are shown; status never supplies content or process authority. */
export function NotificationDeliveries({ item, main, isCurrent }: {
  item: StreamItem; main: () => MainClient; isCurrent: () => boolean;
}) {
  const { t, locale } = useShell();
  const copy = materializeData(messages[locale], { locale });
  const [reads, setReads] = useState<Loaded<NotificationDelivery>[] | null>(null);
  const [loading, setLoading] = useState(false);
  const busy = useRef(false);
  async function load() {
    if (busy.current || !isCurrent()) return;
    busy.current = true;
    setLoading(true);
    const next = await Promise.all(item.deliveries.map(delivery =>
      readNotificationDelivery(main(), delivery.id, item.id)));
    if (!isCurrent()) return;
    busy.current = false;
    setLoading(false);
    setReads(next);
  }
  if (!item.deliveries.length) return null;
  const status: Record<string, string> = { pending: copy.deliveryWaiting, sending: copy.deliverySending,
    uncertain: copy.deliveryUncertain, delivered: copy.deliveryDelivered, failed: copy.deliveryFailed,
    cancelled: copy.deliveryCancelled, suppressed: copy.deliverySuppressed };
  return <div className="relative z-10 grid justify-items-start gap-2 text-sm">
    <Button size="sm" variant="ghost" disabled={loading} isLoading={loading}
      onClick={() => void load()}>{copy.deliveryDetails}</Button>
    {loading ? <p role="status" aria-busy="true">{t.loading}</p> : null}
    {reads ? <ul className="grid gap-2" aria-label={copy.deliveryDetails}>
      {reads.map((read, index) => {
        if (read.ok) return <li key={item.deliveries[index]!.id}>
          <p role="status">{status[read.data.state] ?? copy.deliveryUnknown}</p>
        </li>;
        const text = failureText(read.failure, { failedTitle: copy.deliveryFailedTitle, offline: t.notificationsFailedBody,
          server: t.notificationsServerBody, missingTitle: copy.deliveryMissing, missingBody: '',
          deniedTitle: t.signInForNotifications, deniedBody: t.signInForNotificationsBody,
          movedTitle: t.notificationsMoved, movedBody: t.notificationsMovedBody, budget: t.notificationsBudgetBody });
        if (text.kind === 'absent') return null;
        return <li key={item.deliveries[index]!.id}>
          <p role={text.action === 'none' ? 'status' : 'alert'}>{text.title} {failureDetail(text.description,
            read.reference, t.errorReference, text.reference)}</p>
          {text.action === 'sign-in' ? <a className="underline" href={signInPath(localizedPath('/notifications', locale))}>
            {t.signIn}</a> : null}
        </li>;
      })}
    </ul> : null}
  </div>;
}
