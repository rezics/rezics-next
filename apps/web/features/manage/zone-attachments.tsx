'use client';

import { Button } from '@rezics/ui/button';
import { LocalizedText } from '@rezics/ui/localized-text';
import { materializeData } from 'native-i18n';
import { useEffect, useState } from 'react';
import { LinkIcon } from 'lucide-react';
import type { UiLocale } from '../../i18n/define.ts';
import { spaceHref } from '../address/path.ts';
import { browserMainApi } from '../api/browser.ts';
import type { ManageMessages } from './messages.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import LocalizedLink from '../shell/localized-link.tsx';

export interface ZoneAttachmentItem {
  zone: string;
  name: string | null;
  language: string;
  direction: 'ltr' | 'rtl';
  address: { prefix: string; key: string };
  attachedAt: string | null;
  /** The attached time already formatted for this page. The client renders it unchanged. */
  when: string | null;
}

/** Later pages format here, in UTC, the same clock the server used for the first page. */
const attachedWhen = (iso: string, locale: UiLocale) =>
  new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(iso));

const realmIriPattern = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

/** The list path takes the Realm id. Withdrawal's body is that Realm's IRI. */
const realmIri = (realm: string) => realmIriPattern.test(realm) ? realm : `https://rezics.com/id/${realm}`;

/** The steward's page of Zones that show this Realm, with withdraw and the next page. */
export function ZoneAttachments({ realm, actingSubject, locale, messages, items, nextCursor }: {
  realm: string;
  actingSubject: string;
  locale: UiLocale;
  messages: ManageMessages;
  items: ZoneAttachmentItem[];
  nextCursor: string | null;
}) {
  const t = materializeData(messages, { locale });
  const [rows, setRows] = useState(items);
  const [cursor, setCursor] = useState(nextCursor);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => { setReady(true); }, []);

  async function withdraw(item: ZoneAttachmentItem) {
    setBusy(item.zone);
    setNotice(null);
    try {
      const key = crypto.randomUUID();
      const bodyRealm = realmIri(realm);
      const send = () => browserMainApi().v1.zones({ id: item.zone.slice(-36) })['realm-attachment-withdrawals'].post(
        { realm: bodyRealm, actingSubject }, { headers: { 'idempotency-key': key } });
      let answer = await send();
      if (answer.error && answer.error.status >= 500) answer = await send();
      if (answer.error && answer.error.status !== 404) {
        setNotice(t.zonesWithdrawFailed);
        return;
      }
      setRows(current => current.filter(row => row.zone !== item.zone));
      setNotice(t.zonesWithdrawn);
    } catch {
      setNotice(t.zonesWithdrawFailed);
    } finally {
      setBusy(null);
    }
  }

  async function more() {
    if (!cursor) return;
    setLoading(true);
    setNotice(null);
    try {
      const answer = await browserMainApi().v1.realms({ realm })['zone-attachments'].get({
        query: { actingSubject, cursor, limit: 24 } });
      if (answer.error || !answer.data) {
        setNotice(t.unavailableHelp);
        return;
      }
      const page = answer.data;
      setRows(current => {
        const seen = new Set(current.map(row => row.zone));
        const incoming = page.items.filter(row => !seen.has(row.zone)).map(row => ({
          zone: row.zone, name: row.name, language: row.language, direction: row.direction,
          address: { prefix: row.address.prefix, key: row.address.key }, attachedAt: row.attachedAt,
          when: row.attachedAt ? attachedWhen(row.attachedAt, locale) : null,
        }));
        return [...current, ...incoming];
      });
      setCursor(page.nextCursor);
    } catch {
      setNotice(t.unavailableHelp);
    } finally {
      setLoading(false);
    }
  }

  return <section className="grid min-w-0 gap-4" aria-labelledby="attached-zones-title">
    <div className="min-w-0 space-y-2">
      <h2 id="attached-zones-title" className="font-semibold text-lg tracking-tight sm:text-xl">{t.zonesTitle}</h2>
      <p className="max-w-2xl text-pretty text-muted-foreground text-sm">{t.zonesHelp}</p>
    </div>
    {notice ? <p className="text-pretty text-sm" role="status">{notice}</p> : null}
    {rows.length === 0 ? <EmptyState icon={LinkIcon} title={t.zonesEmpty} /> : <ul className="grid min-w-0 gap-2" aria-label={t.zonesTitle}>
      {rows.map(item => {
        const label = item.name ?? t.zonesNameFallback;
        return <li key={item.zone} className="grid min-w-0 gap-2 rounded-xl border border-border/60 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <div className="min-w-0">
            <p className="truncate font-medium">
              {item.name ? <LocalizedText text={{ value: item.name, language: item.language, direction: item.direction }} /> : label}
            </p>
            <p className="truncate text-muted-foreground text-sm">
              <LocalizedLink href={spaceHref(item.address.key, 'site')} className="rounded-md underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={t.zonesOpen({ zone: label })}>{item.address.prefix}{item.address.key}</LocalizedLink>
            </p>
            <p className="text-muted-foreground text-sm">{item.attachedAt && item.when
              ? <time dateTime={item.attachedAt}>{t.zonesAttached({ time: item.when })}</time>
              : t.zonesAttachedUnknown}</p>
          </div>
          <Button variant="outline" size="sm" className="justify-self-start" disabled={busy !== null}
            data-hydrated={ready ? 'true' : undefined}
            isLoading={busy === item.zone} onClick={() => void withdraw(item)}>{busy === item.zone ? t.zonesWithdrawing : t.zonesWithdraw}</Button>
        </li>;
      })}
    </ul>}
    {cursor ? <Button variant="outline" size="sm" className="justify-self-start" disabled={loading || busy !== null}
      isLoading={loading} onClick={() => void more()}>{loading ? t.loadingMore : t.loadMore}</Button> : null}
  </section>;
}
