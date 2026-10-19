'use client';

import { useEffect, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { signInPath } from '../auth/paths.ts';
import { seedServedTypes } from '../catalogue/type-fixtures.ts';
import type { ReaderActions } from '../catalogue/reader-actions.tsx';
import { createReaderStore } from '../catalogue/reader-store.ts';
import type { MainClient } from '../discover/types.ts';
import { copyOf as entityCopy } from '../entity-page/messages.ts';
import { workExperience } from '../entity-page/experience.ts';
import { WorkFactsView } from './work-sources.tsx';
import { copyOf as levelsCopy } from '../work-levels/messages.ts';
import { EditionsPreviewView } from '../work-levels/previews.tsx';
import { EDITION_SAVED } from '../tracking/series-progress-panel.tsx';
import type { EditionPreference } from '../tracking/types.ts';
import { booksEditionReads, readBooksEditionStatus } from './books-edition-page.read.ts';
import { messages } from './messages.ts';
import { IdentityStatus, nextAction, NextActionView } from './primary-action.tsx';
import { YourEdition } from './your-edition.tsx';
import { WorkCredits } from './credits.tsx';
import { Region } from './region.tsx';
import { workHref } from './route.ts';
import { WorkFrame } from './work-frame.tsx';
import { readDatedAnimeHub, readUndatedAnimeHub } from './anime-hub-recorded-page.ts';

seedServedTypes();

type Identity = Awaited<ReturnType<typeof readBooksEditionStatus>>;
type Dated = Extract<Awaited<ReturnType<typeof readDatedAnimeHub>>, { statements: unknown }>;
type Undated = Extract<Awaited<ReturnType<typeof readUndatedAnimeHub>>, { statements: unknown }>;

/** The acting person is labeled beside the hub. Visitor has none, and the frame does not send it to follow-state. */
export function AnimeHubRecordedPage({ persona, actingSubject, main, workId, kind, factsHref, locale }: {
  persona: string; actingSubject?: string; main: MainClient; workId: string; kind: 'dated' | 'undated' | 'loading';
  factsHref?: string; locale: UiLocale;
}) {
  const [dated, setDated] = useState<Dated | null>(null);
  const [undated, setUndated] = useState<Undated | null>(null);
  const [actions, setActions] = useState<ReaderActions | undefined>(undefined);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  const pageMessages = messages[locale];
  useEffect(() => {
    setDated(null);
    setUndated(null);
    setActions(undefined);
    setIdentity(null);
    setFault(null);
    if (kind === 'loading') {
      const reads = booksEditionReads({ main, actingSubject });
      void reads.readWorkHeader(workId);
      return;
    }
    let mounted = true;
    const fail = (error: unknown) => { if (mounted) setFault(String(error)); };
    if (kind === 'undated') {
      if (!factsHref) { setFault('Missing the recorded statements link'); return; }
      void readUndatedAnimeHub(main, actingSubject, workId, factsHref).then(page => {
        if (!mounted) return;
        if (!page.header.ok) { setFault(`Work header: ${page.header.failure}`); return; }
        setUndated(page as Undated);
      }).catch(fail);
      return () => { mounted = false; };
    }
    const storeActions = { current: undefined as ReaderActions | undefined };
    let identityRevision = 0;
    void readBooksEditionStatus(booksEditionReads({ main, actingSubject }), workId, locale)
      .then(status => { if (mounted && identityRevision === 0) setIdentity(status); }).catch(fail);
    void readDatedAnimeHub(main, actingSubject, workId).then(page => {
      if (!mounted) return;
      if (!page.header.ok) { setFault(`Work header: ${page.header.failure}`); return; }
      if (!page.statements) { setFault('The projection did not link statements'); return; }
      const ready = actingSubject ? createReaderStore({
        actingSubject, seed: page.seed ?? {}, main: () => main }) : undefined;
      storeActions.current = ready;
      setActions(ready);
      setDated(page as Dated);
    }).catch(fail);
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<{ work: string; preference: EditionPreference | null }>).detail;
      const tracking = storeActions.current?.kind === 'ready' ? storeActions.current.tracking : undefined;
      if (!tracking || detail.work.slice(-36) !== workId) return;
      const revision = ++identityRevision;
      void readBooksEditionStatus({ ...booksEditionReads({ main, actingSubject }),
        readProgressSummary: (resource, language) => tracking.series(resource, language) },
      workId, locale, { ok: true, data: detail.preference }).then(status => {
        if (mounted && identityRevision === revision) setIdentity(status);
      }).catch(fail);
    };
    window.addEventListener(EDITION_SAVED, refresh);
    return () => { mounted = false; window.removeEventListener(EDITION_SAVED, refresh); };
  }, [persona, actingSubject, main, workId, kind, factsHref, locale]);
  const who = <p className="break-all text-muted-foreground text-sm">{persona} · {actingSubject ?? 'none'}</p>;
  if (fault) return <div className="grid gap-2 p-4">{who}<pre role="alert" className="whitespace-pre-wrap break-words">{fault}</pre></div>;
  if (kind === 'loading' || (kind === 'dated' && !dated) || (kind === 'undated' && !undated)) {
    return <div className="grid gap-2 p-4">{who}<p role="status" aria-busy="true">{pageMessages.loading}</p></div>;
  }
  const facts = entityCopy(locale);
  const signInHref = signInPath(localizedPath(workHref(workId), locale));
  if (undated?.header.ok) {
    return <div lang={locale}>
      {who}
      <WorkFrame workRef={workId} work={undated.header.data} credits={null} readAction={null}
        locale={locale} messages={pageMessages} signedIn={Boolean(actingSubject)} signInHref={signInHref}
        statementSources={undated.statements}>
      <WorkFactsView page={undated.statements} names={new Map()} hrefFor={() => workHref(workId)}
        locale={locale} t={facts} messages={pageMessages} />
      </WorkFrame>
    </div>;
  }
  if (!dated?.header.ok || !dated.statements) return null;
  const inventory = dated.releases.ok
    ? { entries: dated.releases.data.items, nextCursor: dated.releases.data.nextCursor } : null;
  const action = identity ? nextAction({ start: null, progress: identity.progress.ok ? identity.progress : null, preference: identity.preference,
    releases: inventory?.entries.length ?? 0 }) : null;
  const experience = workExperience(dated.projection.ok ? dated.projection.data : null, dated.header.data.types);
  return <div className="grid min-w-0 gap-3" lang={locale}>
    <div className="px-4 pt-4 sm:px-6">{who}</div>
    <WorkFrame workRef={workId} work={dated.header.data} experience={experience} locale={locale} messages={pageMessages}
      signedIn={Boolean(actingSubject)} signInHref={signInHref} readerActions={actions} readerSeed={dated.seed ?? undefined}
      statementSources={dated.statements}
      credits={<WorkCredits agentCredits={dated.agentCredits} credits={dated.credits} locale={locale} messages={pageMessages} />}
      readAction={action ? <NextActionView action={action}
        workRef={workId} locale={locale} messages={pageMessages} /> : null}
      status={identity ? <IdentityStatus {...identity} locale={locale} messages={pageMessages} /> : undefined}
      sections={[{ id: 'statements', label: facts.statements }, { id: 'availability', label: pageMessages.sectionAvailability }]}>
      <WorkFactsView page={dated.statements} names={new Map()} ownName={dated.header.data.title.value}
        hrefFor={() => workHref(workId)} locale={locale} t={facts} messages={pageMessages} />
      {dated.shown ? <Region id="availability" title={pageMessages.sectionAvailability}>
        <YourEdition work={dated.header.data.id} signInHref={signInHref} locale={locale} messages={pageMessages} />
        <EditionsPreviewView realizations={dated.realizations} releases={dated.releases} workRef={workId} locale={locale}
          pageMessages={pageMessages} t={levelsCopy(locale)} />
      </Region> : null}
    </WorkFrame>
  </div>;
}
