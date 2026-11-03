import { CatalogueCurrentReading, catalogueEditor, useEditorLifetime } from './editor-lifetime';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { ContentItemFrame, ContentItemHeading, ContentItemTitleLink } from '@rezics/ui/content-item';
import { m } from '../../paraglide/messages.js';
import { subjectHref } from '../../subject/subject-href';
import { candidateContext } from '../../subject/candidates';
import type { CandidateTransport } from '../../subject/candidate-review';
import { ViewHeading, ViewHeadingActions } from '../pages/view-heading';
import { definitionText } from './definition-guide';
import { EditorFailure } from './statement-editor-view';
import { SubjectFacts } from './subject-facts-view';
import type { FactsTransport } from './subject-facts';
import type { CreateResult } from './create-subject';
import type { EntityPickerSearch } from '@rezics/ui/entity-picker';
import { peopleBiographyGroups, peopleScalarFields, type PeopleRead, type PeopleTransport } from './people-profile';
import { PeopleCreate } from './people-create';
import { PeopleBiographyGroups } from './people-biography/groups';
import {
  beginCreditTargetReturn,
  creditIdentityTypes,
  discardCreditTargetHandoff,
  readCreditTargetHandoff,
  recordCreatedCreditIdentity,
  type CreditIdentityType,
  type CreditTargetHandoff,
  type CreatedCreditIdentity,
} from './credit-target-handoff';

type Current = Extract<PeopleRead, { ok: true }>;
type Created = Extract<CreateResult, { ok: true }>;
type Session = 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
type CorrectionReloadIntent = { opener: HTMLButtonElement; scope: string; completed: boolean };

const peopleActionTarget =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2 [overflow-wrap:anywhere] md:pointer-fine:min-h-8 md:pointer-fine:min-w-0 md:pointer-fine:py-1';
const peopleLinkTarget =
  'inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal py-2 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:pointer-fine:min-h-8 md:pointer-fine:min-w-0 md:pointer-fine:py-1';

function admittedCreditProfileTypes(read: Current, handoff: CreditTargetHandoff) {
  const property = read.release.properties[handoff.propertyId];
  const targets = property?.targets ?? [];
  if (
    property?.relation?.group !== 'credit' ||
    JSON.stringify([...targets].sort()) !== JSON.stringify([...handoff.targets].sort())
  )
    return [];
  return read.profiles.filter(
    (profile) =>
      creditIdentityTypes.includes(profile.id as CreditIdentityType) &&
      handoff.admittedTypes.includes(profile.id as CreditIdentityType) &&
      targets.includes(profile.id),
  );
}

function createdIdentity(result: Created): CreatedCreditIdentity | undefined {
  const identity = result.reader.state === 'ready' ? result.reader.identity : undefined;
  if (!identity || !creditIdentityTypes.includes(identity.type as CreditIdentityType)) return undefined;
  return identity as CreatedCreditIdentity;
}

const peopleProfileSurface = [
  'min-w-0 w-full [overflow-wrap:anywhere]',
  '[&>article>header>p:first-of-type_a]:inline-flex',
  '[&>article>header>p:first-of-type_a]:min-h-11',
  '[&>article>header>p:first-of-type_a]:min-w-11',
  '[&>article>header>p:first-of-type_a]:max-w-full',
  '[&>article>header>p:first-of-type_a]:min-w-0',
  '[&>article>header>p:first-of-type_a]:items-center',
  '[&>article>header>p:first-of-type_a]:py-2',
  '[&>article>header>p:first-of-type_a]:[overflow-wrap:anywhere]',
  '[&>article>header>p:first-of-type_a]:focus-visible:outline-2',
  '[&>article>header>p:first-of-type_a]:focus-visible:outline-offset-2',
  '[&>article>header>p:first-of-type_a]:focus-visible:outline-ring',
  'md:pointer-fine:[&>article>header>p:first-of-type_a]:min-h-8',
  'md:pointer-fine:[&>article>header>p:first-of-type_a]:min-w-0',
  'md:pointer-fine:[&>article>header>p:first-of-type_a]:py-1',
  '[&>article>nav>a]:h-auto',
  '[&>article>nav>a]:min-h-11',
  '[&>article>nav>a]:min-w-11',
  '[&>article>nav>a]:max-w-full',
  '[&>article>nav>a]:whitespace-normal',
  '[&>article>nav>a]:py-2',
  '[&>article>nav>a]:[overflow-wrap:anywhere]',
  'md:pointer-fine:[&>article>nav>a]:min-h-8',
  'md:pointer-fine:[&>article>nav>a]:min-w-0',
  'md:pointer-fine:[&>article>nav>a]:py-1',
].join(' ');
const peopleRelationsSurface = [
  'min-w-0 max-w-full [overflow-wrap:anywhere]',
  '[&_details]:min-w-0',
  '[&_details]:max-w-full',
  '[&_details>summary]:min-h-11',
  '[&_details>summary]:min-w-11',
  '[&_details>summary]:max-w-full',
  '[&_details>summary]:cursor-pointer',
  '[&_details>summary]:whitespace-normal',
  '[&_details>summary]:py-2',
  '[&_details>summary]:[overflow-wrap:anywhere]',
  '[&_details>summary]:focus-visible:outline-2',
  '[&_details>summary]:focus-visible:outline-offset-2',
  '[&_details>summary]:focus-visible:outline-ring',
  'md:pointer-fine:[&_details>summary]:min-h-8',
  'md:pointer-fine:[&_details>summary]:min-w-0',
  'md:pointer-fine:[&_details>summary]:py-1',
].join(' ');

function ProfileIntro({ read, locale }: { read: Current; locale: string }) {
  const o = { locale: locale as never };
  const subject = read.public?.subject;
  const profile = read.profiles.find((entry) => entry.id === subject?.type);
  const work = read.work?.subject;
  const workTitle = definitionText(work?.labels, locale);
  return (
    <div className="min-w-0 space-y-3 text-sm [overflow-wrap:anywhere]">
      <p>{m.people_profile_intro({}, o)}</p>
      {profile && <p lang={profile.descriptionLang ?? undefined}>{profile.description}</p>}
      {subject && (
        <dl className="grid min-w-0 gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-2">
          {[
            ...new Set([
              ...Object.keys(subject.labels),
              ...Object.keys(subject.descriptions),
              ...Object.keys(subject.aliases),
            ]),
          ].map((language) => (
            <div key={language} className="min-w-0">
              <dt className="text-muted-foreground">{language}</dt>
              {subject.labels[language] && (
                <dd lang={language} className="min-w-0 font-medium [overflow-wrap:anywhere]">
                  {subject.labels[language]}
                </dd>
              )}
              {subject.descriptions[language] && (
                <dd lang={language} className="min-w-0 [overflow-wrap:anywhere]">
                  {subject.descriptions[language]}
                </dd>
              )}
              {!!subject.aliases[language]?.length && (
                <dd lang={language} className="min-w-0 [overflow-wrap:anywhere]">
                  {subject.aliases[language]!.join(' · ')}
                </dd>
              )}
            </div>
          ))}
        </dl>
      )}
      <p className="text-muted-foreground">{m.people_profile_terms({}, o)}</p>
      <p className="text-muted-foreground">{m.people_profile_disclosure({}, o)}</p>
      {profile &&
        peopleBiographyGroups(read.release, profile.id, locale, read.public, !!read.public).map((group) => (
          <p key={group.kind} className="text-sm text-muted-foreground">
            {group.kind === 'biography'
              ? m.people_biography_title({}, o)
              : group.kind === 'occupations'
                ? m.people_occupations_title({}, o)
                : group.kind === 'languages'
                  ? m.people_languages_title({}, o)
                  : m.people_affiliations_title({}, o)}
            {': '}
            {group.fields.every((field) => field.status === 'unsupported')
              ? m.people_biography_unsupported({}, o)
              : group.fields.some((field) => field.status === 'current')
                ? m.people_biography_current({}, o)
                : group.fields.some((field) => field.status === 'unreadable')
                  ? m.people_biography_unreadable({}, o)
                  : m.people_biography_absent({}, o)}
          </p>
        ))}
      {work && (
        <section className="min-w-0 space-y-2 [overflow-wrap:anywhere]">
          <h2 className="font-semibold">{m.people_profile_credit({}, o)}</h2>
          <ContentItemFrame
            as="div"
            data-slot="profile-work-reference"
            className="flex min-w-0 flex-col gap-2 py-3 sm:py-4"
          >
            <ContentItemHeading level={3} className="min-w-0 text-lg leading-snug font-semibold md:text-xl">
              <ContentItemTitleLink
                stretch={false}
                lang={workTitle.lang ?? undefined}
                className={peopleLinkTarget + ' underline underline-offset-4'}
                href={subjectHref({ id: work.id, label: workTitle.text }, locale).href}
              >
                {workTitle.text || m.subject_value_unlabelled({}, o)}
              </ContentItemTitleLink>
            </ContentItemHeading>
            <p>{m.people_profile_credit_help({}, o)}</p>
            {read.credits.length ? (
              <a
                className={buttonVariants({ variant: 'outline', className: peopleActionTarget + ' self-start' })}
                href={`${subjectHref({ id: work.id, label: workTitle.text }, locale).href}/relation-edit`}
              >
                {m.relation_title({}, o)}
              </a>
            ) : (
              <p role="status">{m.people_profile_no_credit({}, o)}</p>
            )}
            <details
              className="min-w-0 max-w-full text-sm"
              aria-label={`${m.people_profile_credit({}, o)} · ${m.profile_work_reference_details({}, o)}`}
            >
              <summary
                className={
                  peopleActionTarget +
                  ' cursor-pointer content-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
                }
              >
                {m.profile_work_reference_details({}, o)}
              </summary>
              <dl className="grid min-w-0 gap-2 py-2">
                <div className="min-w-0">
                  <dt className="text-muted-foreground">{m.profile_work_reference_subject({}, o)}</dt>
                  <dd className="min-w-0">
                    <code
                      tabIndex={0}
                      className="block max-w-full select-text whitespace-normal [overflow-wrap:anywhere]"
                    >
                      {work.id}
                    </code>
                  </dd>
                </div>
              </dl>
            </details>
          </ContentItemFrame>
        </section>
      )}
    </div>
  );
}

/** One guided surface composed from the existing creation, multi-field and exact native review controls. */
export const PeopleProfileEditor = catalogueEditor(PeopleProfileEditorLive);

function PeopleProfileEditorLive({
  id,
  work,
  locale,
  session,
  transport,
  propose,
  review,
  relations,
  onNavigate,
  search,
  creditHandoffToken,
  handoffReader = '',
  handoffReaderLive = () => false,
}: {
  id?: string;
  work?: string;
  locale: string;
  session: Session;
  transport: PeopleTransport;
  propose: FactsTransport['propose'];
  review: (property: string, session?: string) => CandidateTransport;
  search?: EntityPickerSearch;
  relations?: ReactNode;
  onNavigate: (href: string) => void;
  creditHandoffToken?: string;
  handoffReader?: string;
  handoffReaderLive?: () => boolean;
}) {
  const lifetime = useEditorLifetime();
  const o = { locale: locale as never };
  const client = useQueryClient();
  const [creditHandoff, setCreditHandoff] = useState<CreditTargetHandoff>();
  const returningToCreditDraft = useRef(false);
  useEffect(() => {
    if (!creditHandoffToken) {
      setCreditHandoff(undefined);
      return;
    }
    returningToCreditDraft.current = false;
    const handoff = readCreditTargetHandoff(creditHandoffToken);
    if (
      !handoff ||
      handoff.phase !== 'creating' ||
      handoff.workId !== work ||
      handoff.reader !== handoffReader ||
      handoff.context !== candidateContext ||
      !handoffReaderLive()
    ) {
      discardCreditTargetHandoff(creditHandoffToken);
      setCreditHandoff(undefined);
      return;
    }
    setCreditHandoff(handoff);
    return () => {
      if (!returningToCreditDraft.current) discardCreditTargetHandoff(creditHandoffToken);
    };
  }, [creditHandoffToken, handoffReader, handoffReaderLive, work]);
  const retryHeading = useRef<HTMLHeadingElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  const correctionRetryButton = useRef<HTMLButtonElement>(null);
  const nextRetryOrigin = useRef(0);
  const retryInFlight = useRef(false);
  const [retryOrigin, setRetryOrigin] = useState(0);
  const [retryCompleted, setRetryCompleted] = useState(0);
  const correctionIntent = useRef<CorrectionReloadIntent | undefined>(undefined);
  const correctionScope = JSON.stringify([id ?? null, work ?? null, locale, session, lifetime.generation]);
  const correctionScopeRef = useRef(correctionScope);
  if (correctionScopeRef.current !== correctionScope) {
    correctionScopeRef.current = correctionScope;
    correctionIntent.current = undefined;
  }
  // Retained metadata supports private holders; only an admitted query supplies public authority.
  const retained = useRef<Current | undefined>(undefined);
  function matching(next: PeopleRead): PeopleRead {
    const expectedWork = work ?? retained.current?.work?.subject.id;
    if (id && next.ok) {
      const subject = next.public?.subject;
      const originalType = retained.current?.public?.subject.type;
      if (
        !subject ||
        subject.id !== id ||
        (originalType !== undefined && subject.type !== originalType) ||
        !['schema:Person', 'schema:Organization'].includes(subject.type) ||
        !next.release.types[subject.type] ||
        !next.profiles.some((profile) => profile.id === subject.type) ||
        ((work !== undefined || retained.current !== undefined) && next.work?.subject.id !== expectedWork)
      )
        return { ok: false, reason: 'stale' };
    }
    const anchored = work !== undefined || retained.current !== undefined;
    if (!id && next.ok && (next.public || (anchored && next.work?.subject.id !== expectedWork)))
      return { ok: false, reason: 'stale' };
    return next;
  }
  function recordCreditHandoffCreated(result: Created) {
    const handoff = creditHandoff;
    if (!handoff || !lifetime.active() || !handoffReaderLive()) return;
    const next = recordCreatedCreditIdentity(
      handoff.token,
      handoff.workId,
      handoff.reader,
      result.id,
      createdIdentity(result),
    );
    if (!next) {
      discardCreditTargetHandoff(handoff.token);
      setCreditHandoff(undefined);
      return;
    }
    setCreditHandoff(next);
  }
  function returnToCreditDraft(identity: CreatedCreditIdentity) {
    const handoff = creditHandoff;
    const workSubject = retained.current?.work?.subject;
    if (
      !handoff ||
      !workSubject ||
      workSubject.id !== handoff.workId ||
      handoff.reader !== handoffReader ||
      handoff.identity?.id !== identity.id ||
      !handoff.admittedTypes.includes(identity.type) ||
      !lifetime.active() ||
      !handoffReaderLive() ||
      !beginCreditTargetReturn(handoff.token, handoff.workId, handoffReader)
    ) {
      if (handoff) discardCreditTargetHandoff(handoff.token);
      setCreditHandoff(undefined);
      return;
    }
    returningToCreditDraft.current = true;
    const workLabel = definitionText(workSubject.labels, locale).text;
    const href = `${subjectHref({ id: workSubject.id, label: workLabel }, locale).href}/relation-edit?creditHandoff=${encodeURIComponent(handoff.token)}`;
    window.location.assign(href);
  }
  const query = useQuery({
    queryKey: [...['people-profile', id ?? 'new', work ?? '', locale], lifetime.generation],
    queryFn: async () => matching(await transport.load()),
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: Infinity,
    gcTime: 0,
  });
  const observed = query.data && matching(query.data);
  const [refreshing, setRefreshing] = useState(false);
  const refreshingNow = useRef(false);
  // Commit the pause before I/O so nested holders retire callbacks even for an immediate read.
  useEffect(() => {
    if (!refreshing) return;
    void query.refetch({ cancelRefetch: false }).finally(() => {
      if (!lifetime.active()) {
        correctionIntent.current = undefined;
        return;
      }
      const intent = correctionIntent.current;
      if (intent?.scope === correctionScopeRef.current) intent.completed = true;
      else correctionIntent.current = undefined;
      refreshingNow.current = false;
      setRefreshing(false);
    });
  }, [refreshing]);
  useEffect(() => {
    const cancel = (event: Event) => {
      const intent = correctionIntent.current;
      if (!intent) return;
      if (event.type === 'pointerdown') {
        correctionIntent.current = undefined;
        return;
      }
      if (event.target !== intent.opener && event.target !== document.body && event.target !== document.documentElement)
        correctionIntent.current = undefined;
    };
    document.addEventListener('pointerdown', cancel, true);
    document.addEventListener('focusin', cancel, true);
    return () => {
      document.removeEventListener('pointerdown', cancel, true);
      document.removeEventListener('focusin', cancel, true);
    };
  }, []);
  function reloadCorrection(event: MouseEvent<HTMLButtonElement>) {
    if (!lifetime.active() || refreshingNow.current || query.isFetching) return;
    correctionIntent.current =
      event.detail === 0 && event.currentTarget === document.activeElement && event.currentTarget.isConnected
        ? { opener: event.currentTarget, scope: correctionScopeRef.current, completed: false }
        : undefined;
    refreshingNow.current = true;
    setRefreshing(true);
  }
  const read = query.isError || (id && (query.isFetching || refreshing)) ? undefined : observed;
  const current = !!read?.ok && !query.isFetching;
  if (current && read?.ok) retained.current = read;
  const retryPending = retryOrigin !== 0 && (retryCompleted !== retryOrigin || query.isFetching);
  function retryInitialRead() {
    if (!lifetime.active() || retryInFlight.current || query.isFetching) return;
    const origin = ++nextRetryOrigin.current;
    retryInFlight.current = true;
    setRetryOrigin(origin);
    void query.refetch().finally(() => {
      if (!lifetime.active()) return;
      retryInFlight.current = false;
      setRetryCompleted(origin);
    });
  }
  useEffect(() => {
    if (!retryOrigin || retryCompleted !== retryOrigin || query.isFetching || !lifetime.active()) return;
    if (read?.ok) retryHeading.current?.focus();
    else retryButton.current?.focus();
    setRetryOrigin((currentOrigin) => (currentOrigin === retryOrigin ? 0 : currentOrigin));
  }, [lifetime, query.dataUpdatedAt, query.errorUpdatedAt, query.isFetching, read?.ok, retryCompleted, retryOrigin]);
  useEffect(() => {
    const intent = correctionIntent.current;
    if (!intent) return;
    if (!lifetime.active() || intent.scope !== correctionScopeRef.current) {
      correctionIntent.current = undefined;
      return;
    }
    if (!intent.completed || refreshing || query.isFetching) return;
    const active = document.activeElement;
    if (intent.opener.isConnected && active === intent.opener) {
      correctionIntent.current = undefined;
      return;
    }
    if (active && active !== document.body && active !== document.documentElement) {
      correctionIntent.current = undefined;
      return;
    }
    correctionIntent.current = undefined;
    (current && read?.ok ? retryHeading.current : correctionRetryButton.current)?.focus();
  }, [correctionScope, current, lifetime, query.isFetching, read?.ok, refreshing]);
  if (id && session === 'signed-in' && retained.current?.public) {
    const privateRead = retained.current;
    const visible = current;
    return (
      <div className={peopleProfileSurface}>
        {!visible && (
          <article className="mx-auto w-full min-w-0 max-w-4xl space-y-4 p-4 sm:p-6">
            <ViewHeadingActions label={m.people_profile_title({}, o)} headingClassName="font-sans" />
            {query.isFetching || refreshing ? (
              <p role="status">{m.catalogue_create_loading({}, o)}</p>
            ) : (
              <EditorFailure reason={observed && !observed.ok ? observed.reason : 'unavailable'} locale={locale} />
            )}
            <Button
              ref={correctionRetryButton}
              type="button"
              variant="outline"
              className={peopleActionTarget}
              aria-disabled={query.isFetching || refreshing}
              onClick={reloadCorrection}
            >
              {m.correction_retry({}, o)}
            </Button>
          </article>
        )}
        <CatalogueCurrentReading
          visible={visible}
          ready={visible}
          revision={`${query.dataUpdatedAt}:${query.errorUpdatedAt}`}
        >
          <SubjectFacts
            locale={locale}
            initial={{ ok: true, public: privateRead.public!, release: privateRead.release, source: null }}
            profile={{
              title: m.people_profile_title({}, o),
              intro: m.facts_intro({}, o),
              empty: m.facts_empty({}, o),
              path: 'people',
              properties: (current) => peopleScalarFields(current.release, current.public.subject.type, locale),
            }}
            profileHeadingRef={retryHeading}
            profileIntro={<ProfileIntro read={privateRead} locale={locale} />}
            transport={{
              propose,
              read: async () => {
                const next = matching(await transport.load());
                return next.ok && next.public
                  ? { ok: true, public: next.public, release: next.release, source: null }
                  : next.ok
                    ? { ok: false, reason: 'unavailable' }
                    : next;
              },
            }}
            onReload={reloadCorrection}
            review={review}
          />
          <PeopleBiographyGroups
            read={{ ok: true, public: privateRead.public!, release: privateRead.release, source: null }}
            locale={locale}
            {...(search ? { search } : {})}
            transport={{
              propose,
              read: async () => {
                const next = matching(await transport.load());
                return next.ok && next.public
                  ? { ok: true, public: next.public, release: next.release, source: null }
                  : next.ok
                    ? { ok: false, reason: 'unavailable' }
                    : next;
              },
            }}
            review={review}
          />
          {relations && <div className={peopleRelationsSurface}>{relations}</div>}
        </CatalogueCurrentReading>
      </div>
    );
  }
  if (!id && retained.current)
    return (
      <PeopleCreate
        read={retained.current}
        current={current}
        recovering={query.isFetching}
        recovery={
          query.isFetching ? (
            <p role="status">{m.catalogue_create_loading({}, o)}</p>
          ) : (
            <EditorFailure reason={read && !read.ok ? read.reason : 'unavailable'} locale={locale} />
          )
        }
        refresh={async () => {
          const next = await query.refetch();
          if (!lifetime.active()) return { ok: false, reason: 'denied' };
          return next.isError || next.isFetching || !next.data
            ? { ok: false, reason: 'unavailable' }
            : matching(next.data);
        }}
        work={work ?? retained.current.work?.subject.id}
        locale={locale}
        session={session}
        transport={transport}
        onNavigate={onNavigate}
        {...(creditHandoff ? { handoff: creditHandoff } : {})}
        onCreated={recordCreditHandoffCreated}
        onReturnToCreditDraft={returnToCreditDraft}
        headingRef={retryHeading}
        intro={<ProfileIntro read={retained.current} locale={locale} />}
        admittedProfiles={
          creditHandoff ? admittedCreditProfileTypes(retained.current, creditHandoff) : retained.current.profiles
        }
      />
    );
  if (!read?.ok)
    return (
      <article className="mx-auto w-full min-w-0 max-w-4xl space-y-4 p-4 sm:p-6 [overflow-wrap:anywhere]">
        <ViewHeadingActions label={m.people_profile_title({}, o)} headingClassName="font-sans" />
        {query.isPending || retryPending ? (
          <p role="status">{m.catalogue_create_loading({}, o)}</p>
        ) : (
          <EditorFailure reason={read && !read.ok ? read.reason : 'unavailable'} locale={locale} />
        )}
        {!query.isPending && (
          <Button
            ref={retryButton}
            type="button"
            variant="outline"
            className={peopleActionTarget}
            aria-disabled={retryPending}
            onClick={retryInitialRead}
          >
            {m.catalogue_create_retry({}, o)}
          </Button>
        )}
      </article>
    );
  if (session !== 'signed-in')
    return (
      <article className="mx-auto w-full min-w-0 max-w-4xl space-y-4 p-4 sm:p-6 [overflow-wrap:anywhere]">
        <ViewHeading
          label={m.people_profile_title({}, o)}
          headingClassName="font-sans"
          headingRef={retryHeading}
          headingTabIndex={-1}
        />
        <ProfileIntro read={read} locale={locale} />
        <p role="status">
          {session === 'signed-out'
            ? m.catalogue_create_signed_out({}, o)
            : session === 'unavailable'
              ? m.catalogue_create_unavailable({}, o)
              : m.catalogue_create_loading({}, o)}
        </p>
        {session === 'unavailable' && (
          <Button
            type="button"
            variant="outline"
            className={peopleActionTarget}
            onClick={() => void client.invalidateQueries({ queryKey: ['session'] })}
          >
            {m.catalogue_create_retry({}, o)}
          </Button>
        )}
        {session === 'signed-out' && (
          <a
            className={peopleLinkTarget + ' underline'}
            href={`/auth/sign-in?return_to=${encodeURIComponent(
              id && read.public
                ? `${subjectHref({ id, label: definitionText(read.public.subject.labels, locale).text }, locale).href}/people`
                : `/${locale}/catalogue/people${work ? `?work=${encodeURIComponent(work)}` : ''}`,
            )}`}
          >
            {m.account_sign_in({}, o)}
          </a>
        )}
      </article>
    );
  return <EditorFailure reason="unavailable" locale={locale} />;
}
