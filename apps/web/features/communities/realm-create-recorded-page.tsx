'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { buttonVariants } from '@rezics/ui/button';
import { CircleAlertIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { BFF_PREFIX } from '../api/browser.ts';
import { realmHref } from '../realm/route.ts';
import Link from '../shell/localized-link.tsx';
import { PageContainer, PageHeader } from '../shell/page.tsx';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { ownedRealmNotice } from './create-form.tsx';
import { communityText as words } from './messages.ts';
import {
  readRealmCreationRecorded,
  type RealmCreationIdentity,
  type RealmCreationProblem,
  type RealmCreationRecordedLoad,
} from './realm-create-recorded-page.ts';

function CreatedRealm({ identity, locale }: { identity: RealmCreationIdentity; locale: UiLocale }) {
  const id = identity.realm.slice(-36);
  return <section className="grid max-w-2xl gap-3" aria-labelledby="created-realm-name">
    <h2 id="created-realm-name" className="text-xl font-semibold break-words">
      <Link href={realmHref(locale, id)}>{identity.name}</Link>
    </h2>
    <p className="break-all">{identity.handle}</p>
    <p className="break-all">{identity.realm}</p>
    <p>{identity.visibility}</p>
    {identity.listing ? <p>{identity.listing}</p> : null}
    {identity.admission ? <p>{identity.admission}</p> : null}
    <p className="break-all">{identity.owner}</p>
    <p className="break-all">{identity.realmRevision}</p>
    <p className="break-all">{identity.spaceRevision}</p>
    <Link href={`/manage/r/${id}`} className={buttonVariants({ variant: 'outline', className: 'justify-self-start' })}>
      {words.manage[locale]}
    </Link>
  </section>;
}

function RefusedCreation({ problem, locale }: { problem: RealmCreationProblem; locale: UiLocale }) {
  return <Alert variant="destructive" role="alert" className="max-w-2xl">
    <CircleAlertIcon aria-hidden="true" />
    <AlertDescription>
      {words.createFailed[locale]}
      <span className="mt-1 block">{problem.title}</span>
    </AlertDescription>
  </Alert>;
}

function RecordedBody({ load, locale }: { load: RealmCreationRecordedLoad; locale: UiLocale }) {
  const mapped = load.mapped;
  if (mapped.kind === 'discrepancy') return <p role="alert">{mapped.detail}</p>;
  if (mapped.kind === 'refusal') return <RefusedCreation problem={mapped.problem} locale={locale} />;
  if (mapped.kind === 'taken') return <p role="alert">{words.handleTaken[locale]}</p>;
  if (mapped.kind === 'owned') {
    const notice = ownedRealmNotice(mapped.realm, locale);
    return <Alert variant="info" role="alert" className="max-w-2xl">
      <AlertDescription>{notice.notice}{' '}
        <Link href={notice.href} className="font-medium underline">{words.openYours[locale]}</Link>
      </AlertDescription>
    </Alert>;
  }
  return <CreatedRealm identity={mapped.identity} locale={locale} />;
}

/** The creation page from one recorded command. Selections name the answers; the shared mapping decides the page. */
export function RealmCreateRecordedPage({ record, persona, selections, locale }: {
  record: AnswerRecord;
  persona: AnswerPersona;
  selections: readonly RecordedSelection[];
  locale: UiLocale;
}) {
  const [load, setLoad] = useState<RealmCreationRecordedLoad | null>(null);
  useEffect(() => {
    let mounted = true;
    const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
    void readRealmCreationRecorded(replay.fetcher, record, persona, selections).then(result => {
      if (mounted) setLoad(result);
    }).catch((error: unknown) => {
      if (!mounted || (error instanceof DOMException && error.name === 'AbortError')) return;
      setLoad({ mapped: { kind: 'discrepancy', detail: error instanceof Error ? error.message : String(error) } });
    });
    return () => { mounted = false; replay.dispose(); };
  }, [record, persona, selections]);
  return <PageContainer className="grid gap-8">
    <PageHeader title={words.createTitle[locale]} description={words.createIntro[locale]} />
    {load ? <RecordedBody load={load} locale={locale} />
      : <p role="status" aria-busy="true">{words.creating[locale]}</p>}
  </PageContainer>;
}
