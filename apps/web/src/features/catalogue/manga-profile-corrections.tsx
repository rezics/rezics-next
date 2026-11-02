import { useMemo, useRef, useState, type ReactNode } from 'react';
import { pickText } from '@rezics/composition';
import { pageText } from '../pages/data';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { useCatalogueLifetime } from '../../subject/candidate-lifetime';
import {
  AuthoringDepartureBoundary,
  useAuthoringDeparture,
  type AuthoringLocation,
} from '../../threads/authoring-departure';
import { subjectHref } from '../../subject/subject-href';
import { CandidateReview, type CandidateTransport } from '../../subject/candidate-review';
import type { FactsTransport, FactDraft } from './subject-facts';
import { factChanged, factLimit, factLocked, sealFacts, sendFacts, stageFact } from './subject-facts';
import { ExcludedFact, FactField } from './subject-facts-view';
import { correctionProperty } from './statement-editor';
import { EditorFailure, PartValue } from './statement-editor-view';
import { isMangaType, mangaGroups } from './manga-profile';
import { CatalogueCurrentReading, useCurrentReadingActive } from './editor-lifetime';
import { mangaGroupLabels, type MangaReady } from './manga-profile-view';
import { DefinitionGuideLink } from './definition-guide-view';

export type MangaCorrectionPorts = {
  facts: FactsTransport;
  review: (property: string, session?: string) => CandidateTransport;
  relations: ReactNode;
  authored: ReactNode;
};
type ReviewAddress = { property: string; candidate: string; session?: string | undefined };
function ExactReview({
  address,
  id,
  locale,
  review,
}: {
  address: ReviewAddress;
  id: string;
  locale: string;
  review: MangaCorrectionPorts['review'];
}) {
  const transport = useMemo(
    () => review(address.property, address.session),
    [review, address.property, address.session],
  );
  return (
    <CandidateReview
      id={id}
      locale={locale}
      initialProperty={address.property}
      exactCandidate={address.candidate}
      transport={transport}
    />
  );
}
type CorrectionProps = {
  read: MangaReady | undefined;
  locale: string;
  disabled: boolean;
  ports?: MangaCorrectionPorts | undefined;
  revision?: string | undefined;
  reload: () => Promise<unknown>;
};

const correctionAddress = (location: AuthoringLocation) => JSON.stringify([location.pathname, location.search]);

export function MangaCorrections(props: CorrectionProps) {
  const reading = useRef({ read: props.read, generation: 0 });
  if (reading.current.read !== props.read)
    reading.current = { read: props.read, generation: reading.current.generation + 1 };
  const original = useRef<{ id: string; type: string } | undefined>(undefined);
  const subject = props.read?.public?.subject;
  if (!original.current && subject && isMangaType(subject.type))
    original.current = { id: subject.id, type: subject.type };
  const visible =
    !!subject && !props.disabled && subject.id === original.current?.id && subject.type === original.current?.type;
  return (
    <AuthoringDepartureBoundary sessionBound={false} navigationContext={correctionAddress}>
      <CatalogueCurrentReading
        visible={visible}
        ready={visible}
        revision={`${props.revision ?? ''}:${reading.current.generation}`}
      >
        <MangaCorrectionsLive {...props} read={visible ? props.read : undefined} />
      </CatalogueCurrentReading>
    </AuthoringDepartureBoundary>
  );
}

function MangaCorrectionsLive({ read, locale, disabled, ports, reload }: CorrectionProps) {
  // Reading recovery keeps this holder; departure and caller retirement never do.
  const workspace = useCatalogueLifetime('manga-corrections');
  const readingActive = useCurrentReadingActive();
  const active = () => workspace.active() && readingActive();
  const o = { locale: locale as never };
  const [drafts, setDrafts] = useState<FactDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState<ReviewAddress>();
  const running = useRef(false);
  const subject = read?.public?.subject;
  const current = useMemo(
    () => read?.public ? { ok: true as const, release: read.release, public: read.public, source: null } : undefined,
    [read],
  );
  const label = subject ? pickText(subject.labels, locale) : undefined;
  const href = subject ? subjectHref({ id: subject.id, label: label!.text }, locale).href : '';
  const groups = subject && read ? mangaGroups(read.release, subject.type, locale) : undefined;
  const labels = mangaGroupLabels(locale);
  const authored = useRef(false);
  if (groups?.writing.length) authored.current = true;
  const previousReading = useRef(readingActive);
  if (previousReading.current !== readingActive) {
    previousReading.current = readingActive;
    running.current = false;
    setBusy(false);
    setDrafts((previous) =>
      previous.map((draft) =>
        draft.command && !draft.result ? { ...draft, result: { ok: false, reason: 'unavailable' } } : draft,
      ),
    );
  }
  const admitted = new Set(
    Object.entries(groups ?? {}).flatMap(([group, fields]) =>
      group === 'writing' ? [] : fields.filter((property) =>
        !!current && !!subject && correctionProperty(current.release, subject.type, property)),
    ),
  );
  const excluded = drafts.filter((draft) => !admitted.has(draft.property));
  // A retained unsent holder must be reconciled before any new batch is sealed.
  // Existing commands keep their original native replay boundary.
  const needsReconciliation = excluded.some((draft) => !draft.command && !draft.result?.ok);
  const draftLabels = useRef(new Map<string, ReturnType<typeof pageText>>());
  const changed = drafts.filter((draft) => draft.included && factChanged(draft) && !draft.result?.ok);
  // Batch inclusion does not release private assertions. Inspection is pure: no
  // validation, command preparation or sealing belongs in a departure predicate.
  const unresolved = () =>
    drafts.some(
      (draft) =>
        !!draft.command &&
        (!draft.result || (!draft.result.ok && ['uncertain', 'unavailable'].includes(draft.result.reason))),
    );
  useAuthoringDeparture(
    () => workspace.active() && (unresolved() || drafts.some((draft) => !draft.result?.ok && factChanged(draft))),
    unresolved,
    String(workspace.generation),
    undefined,
    () => {
      // Release only local editing/retry recovery; native proposals may still finish.
      workspace.retire();
      running.current = false;
      setBusy(false);
      setDrafts([]);
      setReviewing(undefined);
    },
    undefined,
    undefined,
    correctionAddress,
  );
  const discardState = useRef({ read, disabled, ports, busy });
  discardState.current = { read, disabled, ports, busy };
  function discard(original: FactDraft) {
    const now = discardState.current;
    if (!active() || !now.read?.public || now.read !== read || now.disabled || !now.ports || now.busy || running.current)
      return;
    setDrafts((previous) => previous.filter((item) => item !== original || !!item.command || factLocked(item)));
  }
  async function submit() {
    if (!active() || !subject || !read || !ports || disabled || running.current || needsReconciliation) return;
    const sealed = sealFacts(subject.id, read.release, drafts);
    setDrafts(sealed);
    running.current = true;
    setBusy(true);
    try {
      await sendFacts(
        sealed,
        (command) => {
          if (!active()) throw new Error('Retired Manga corrections');
          return ports.facts.propose(command);
        },
        (property, result) =>
          active() &&
          setDrafts((previous) =>
            previous.map((draft) => (draft.property === property ? { ...draft, result } : draft)),
          ),
      );
    } finally {
      if (active()) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  if (!workspace.active()) return null;
  return (
    <div className="space-y-6">
      {subject && current && groups && (
        <>
          <header className="min-w-0 max-w-full whitespace-normal break-words [overflow-wrap:anywhere] space-y-3 rounded-xl border bg-card p-5">
            <h2
              className="min-w-0 max-w-full whitespace-normal break-words [overflow-wrap:anywhere] font-sans text-2xl font-semibold"
              lang={label?.lang ?? undefined}
            >
              <a
                className="underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                href={href}
              >
                {label?.text || m.subject_value_unlabelled({}, o)}
              </a>
            </h2>
            <p
              className="min-w-0 max-w-full whitespace-normal break-words [overflow-wrap:anywhere]"
              lang={pickText(read!.release.types[subject.type]?.labels ?? {}, locale).lang ?? undefined}
            >
              {pickText(read!.release.types[subject.type]?.labels ?? {}, locale).text || m.guide_missing({}, o)}
            </p>
            <p className="text-sm font-medium">{m.specialist_identity_scope({}, o)}</p>
            <div className="flex min-w-0 flex-wrap gap-3 [&>a]:h-auto [&>a]:max-w-full [&>a]:whitespace-normal [&>a]:break-words [&>a]:[overflow-wrap:anywhere]">
              <a className={buttonVariants({ variant: 'outline' })} href={`${href}/terms`}>
                {m.catalogue_terms_title({}, o)}
              </a>
              <a className={buttonVariants({ variant: 'outline' })} href={href}>
                {m.candidate_view_public({}, o)}
              </a>
              <DefinitionGuideLink locale={locale} address={{ type: subject.type }} />
            </div>
            <details className="min-w-0 max-w-full whitespace-normal break-words [overflow-wrap:anywhere] space-y-3">
              <summary className="min-h-8 cursor-pointer whitespace-normal break-words [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-md:min-h-11 pointer-coarse:min-h-11">
                {m.specialist_identity_names({}, o)}
              </summary>
              <dl className="mt-3 min-w-0 space-y-3">
                {Array.from(
                  new Set([
                    ...Object.keys(subject.labels),
                    ...Object.keys(subject.descriptions),
                    ...Object.keys(subject.aliases),
                  ]),
                ).map((language) => (
                  <div key={language} className="min-w-0">
                    <dt className="text-sm text-muted-foreground">{language}</dt>
                    <dd
                      lang={language}
                      className="min-w-0 max-w-full whitespace-normal break-words [overflow-wrap:anywhere]"
                    >
                      {subject.labels[language]}
                    </dd>
                    {subject.descriptions[language] && (
                      <dd
                        lang={language}
                        className="min-w-0 max-w-full whitespace-normal break-words [overflow-wrap:anywhere] text-sm"
                      >
                        {subject.descriptions[language]}
                      </dd>
                    )}
                    {!!subject.aliases[language]?.length && (
                      <dd
                        lang={language}
                        className="min-w-0 max-w-full whitespace-normal break-words [overflow-wrap:anywhere] text-sm text-muted-foreground"
                      >
                        {subject.aliases[language]!.join(' · ')}
                      </dd>
                    )}
                  </div>
                ))}
              </dl>
            </details>
            <details className="min-w-0 max-w-full whitespace-normal break-words [overflow-wrap:anywhere] space-y-3 rounded-xl border border-border p-4">
              <summary className="min-h-8 cursor-pointer whitespace-normal break-words [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-md:min-h-11 pointer-coarse:min-h-11">
                {m.specialist_identity_reference({}, o)}
              </summary>
              <dl className="mt-3 min-w-0 space-y-3">
                <div className="min-w-0">
                  <dt className="text-sm text-muted-foreground">{m.specialist_identity_subject_id({}, o)}</dt>
                  <dd className="min-w-0">
                    <code dir="ltr" className="select-text whitespace-normal break-words [overflow-wrap:anywhere]">
                      {subject.id}
                    </code>
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-sm text-muted-foreground">{m.specialist_identity_type({}, o)}</dt>
                  <dd className="min-w-0">
                    <code dir="ltr" className="select-text whitespace-normal break-words [overflow-wrap:anywhere]">
                      {subject.type}
                    </code>
                  </dd>
                </div>
              </dl>
              <p className="text-sm text-muted-foreground">{m.manga_terms_help({}, o)}</p>
            </details>
          </header>
          <p className="text-muted-foreground">{m.facts_separate_results({}, o)}</p>
          {!!excluded.length && <EditorFailure reason="stale" locale={locale} />}
          {excluded.map((draft) => (
            <ExcludedFact
              key={draft.property}
              draft={draft}
              read={current}
              locale={locale}
              label={draftLabels.current.get(draft.property)}
              busy={busy || disabled || !ports}
              onDiscard={discard}
            />
          ))}
          {Object.entries(groups)
            .filter(([group, fields]) => group !== 'writing' && fields.length)
            .map(([group, fields]) => (
              <section className="min-w-0 space-y-4 [overflow-wrap:anywhere]" key={group}>
                <ContentItemHeading level={2} className="font-sans text-xl font-semibold">
                  {labels[group as keyof typeof labels]}
                </ContentItemHeading>
                {group === 'membership' && <p className="text-sm text-muted-foreground">{m.manga_order_help({}, o)}</p>}
                {group === 'classification' && (
                  <p className="text-sm text-muted-foreground">{m.manga_classification_help({}, o)}</p>
                )}
                {fields.map((property) =>
                  correctionProperty(current.release, subject.type, property) ? (
                    <FactField
                      key={property}
                      property={property}
                      read={current}
                      locale={locale}
                      href={href}
                      busy={busy || disabled || !ports}
                      canStage={drafts.length < factLimit}
                      draft={drafts.find((draft) => draft.property === property)}
                      onDiscard={discard}
                      onChange={(next) =>
                        active() &&
                        setDrafts((previous) =>
                          previous.map((draft) => (draft.property === next.property ? next : draft)),
                        )
                      }
                      onReview={(address) => active() && setReviewing(address)}
                      onStage={(source) => {
                        if (!active()) return;
                        const next = stageFact(current, property, source);
                        if (next)
                          draftLabels.current.set(property, pageText(current.release.properties[property]!.labels, locale));
                        if (next)
                          active() &&
                            setDrafts((previous) => (previous.length < factLimit ? [...previous, next] : previous));
                      }}
                    />
                  ) : (
                    <section key={property} className="min-w-0 [overflow-wrap:anywhere]">
                      <ContentItemFrame
                        as="div"
                        className="min-w-0 space-y-3 rounded-xl bg-card p-4 sm:p-5 [&_a]:inline-flex [&_a]:min-h-11 md:pointer-fine:[&_a]:min-h-8 [&_a]:min-w-11 [&_a]:max-w-full [&_a]:items-center [&_a]:whitespace-normal [&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-offset-2 [&_a:focus-visible]:outline-ring"
                      >
                        <ContentItemHeading
                          level={3}
                          className="min-w-0 whitespace-normal text-lg font-semibold"
                          lang={pickText(current.release.properties[property]!.labels, locale).lang ?? undefined}
                        >
                          {pickText(current.release.properties[property]!.labels, locale).text}
                        </ContentItemHeading>
                        {!subject.statements[property]?.length && (
                          <p className="text-sm text-muted-foreground">{m.facts_no_value({}, o)}</p>
                        )}
                        {(subject.statements[property] ?? []).map((statement) => (
                          <div key={statement.id} className="min-w-0 space-y-2">
                            <PartValue part={statement} read={current} locale={locale} />
                            <dl className="min-w-0 space-y-2 text-sm">
                              {statement.qualifiers.map((part, index) => (
                                <div key={index} className="min-w-0 space-y-1">
                                  <dt
                                    className="text-muted-foreground"
                                    lang={
                                      pickText(current.release.properties[part.property.id]?.labels ?? {}, locale)
                                        .lang ?? undefined
                                    }
                                  >
                                    {pickText(current.release.properties[part.property.id]?.labels ?? {}, locale).text}
                                    :{' '}
                                  </dt>
                                  <dd className="min-w-0">
                                    <PartValue part={part} read={current} locale={locale} />
                                  </dd>
                                </div>
                              ))}
                            </dl>
                            {statement.references.map((reference, index) => (
                              <div key={index} className="min-w-0 space-y-2 border-s-2 border-border ps-3 text-sm">
                                <p className="text-muted-foreground">
                                  {m.correction_references({}, o)} {index + 1}
                                </p>
                                <dl className="min-w-0 space-y-2">
                                  {reference.parts.map((part, at) => (
                                    <div key={at} className="min-w-0 space-y-1">
                                      <dt
                                        className="text-muted-foreground"
                                        lang={
                                          pickText(current.release.properties[part.property.id]?.labels ?? {}, locale)
                                            .lang ?? undefined
                                        }
                                      >
                                        {
                                          pickText(current.release.properties[part.property.id]?.labels ?? {}, locale)
                                            .text
                                        }
                                      </dt>
                                      <dd className="min-w-0">
                                        <PartValue key={at} part={part} read={current} locale={locale} />
                                      </dd>
                                    </div>
                                  ))}
                                </dl>
                              </div>
                            ))}
                          </div>
                        ))}
                      </ContentItemFrame>
                    </section>
                  ),
                )}
              </section>
            ))}
          <ContentItemFrame
            as="div"
            className="min-w-0 space-y-3 rounded-xl bg-card p-4 sm:p-5 [overflow-wrap:anywhere]"
          >
            <ContentItemHeading level={2} className="text-lg font-semibold">
              {m.facts_selection({ count: changed.length, limit: factLimit }, o)}
            </ContentItemHeading>
            <div className="flex min-w-0 flex-col flex-wrap gap-2 sm:flex-row">
              <Button
                className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words py-2 [overflow-wrap:anywhere] md:pointer-fine:min-h-8 md:pointer-fine:py-1"
                disabled={busy || disabled || !ports || !changed.length || needsReconciliation}
                onClick={() => void submit()}
              >
                {busy ? m.correction_saving({}, o) : m.facts_submit({}, o)}
              </Button>
              <Button
                className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words py-2 [overflow-wrap:anywhere] md:pointer-fine:min-h-8 md:pointer-fine:py-1"
                variant="outline"
                disabled={busy}
                onClick={() => active() && void reload()}
              >
                {m.correction_reload({}, o)}
              </Button>
            </div>
          </ContentItemFrame>
          {reviewing && ports && (
            <ExactReview id={subject.id} locale={locale} address={reviewing} review={ports.review} />
          )}
        </>
      )}
      {ports && (
        <div className="space-y-6">
          <section className="space-y-4">
            {subject && (
              <>
                <h2 className="font-sans text-xl font-semibold">{m.relation_title({}, o)}</h2>
                <p className="text-muted-foreground">{m.manga_relation_help({}, o)}</p>
              </>
            )}
            {ports.relations}
          </section>
          {authored.current && (
            <section className="space-y-4">
              {subject && !!groups?.writing.length && (
                <h2 className="font-sans text-xl font-semibold">{m.authored_title({}, o)}</h2>
              )}
              {ports.authored}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
