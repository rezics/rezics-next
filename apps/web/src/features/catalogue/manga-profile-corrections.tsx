import { useMemo, useRef, useState, type ReactNode } from 'react';
import { pickText } from '@rezics/composition';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { subjectHref } from '../../subject/subject-href';
import { CandidateReview, type CandidateTransport } from '../../subject/candidate-review';
import type { FactsTransport, FactDraft } from './subject-facts';
import { factChanged, factLimit, sealFacts, sendFacts, stageFact } from './subject-facts';
import { FactField } from './subject-facts-view';
import { correctionProperty } from './statement-editor';
import { PartValue } from './statement-editor-view';
import { mangaGroups } from './manga-profile';
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
export function MangaCorrections({
  read,
  locale,
  disabled,
  ports,
  reload,
}: {
  read: MangaReady | undefined;
  locale: string;
  disabled: boolean;
  ports?: MangaCorrectionPorts | undefined;
  reload: () => Promise<unknown>;
}) {
  const o = { locale: locale as never };
  const [drafts, setDrafts] = useState<FactDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState<ReviewAddress>();
  const running = useRef(false);
  const subject = read?.public?.subject;
  const current = read?.public
    ? { ok: true as const, release: read.release, public: read.public, source: null }
    : undefined;
  const label = subject ? pickText(subject.labels, locale) : undefined;
  const href = subject ? subjectHref({ id: subject.id, label: label!.text }, locale).href : '';
  const groups = subject && read ? mangaGroups(read.release, subject.type, locale) : undefined;
  const labels = mangaGroupLabels(locale);
  const changed = drafts.filter((draft) => draft.included && factChanged(draft) && !draft.result?.ok);
  async function submit() {
    if (!subject || !read || !ports || disabled || running.current) return;
    const sealed = sealFacts(subject.id, read.release, drafts);
    setDrafts(sealed);
    running.current = true;
    setBusy(true);
    try {
      await sendFacts(sealed, ports.facts.propose, (property, result) =>
        setDrafts((previous) => previous.map((draft) => (draft.property === property ? { ...draft, result } : draft))),
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="space-y-6">
      {subject && current && groups && (
        <>
          <header className="space-y-3 rounded-xl border bg-card p-5">
            <h2 className="font-sans text-2xl font-semibold" lang={label?.lang ?? undefined}>
              <a className="underline" href={href}>
                {label?.text || m.subject_value_unlabelled({}, o)}
              </a>
            </h2>
            <p lang={pickText(read!.release.types[subject.type]?.labels ?? {}, locale).lang ?? undefined}>
              {pickText(read!.release.types[subject.type]?.labels ?? {}, locale).text || subject.type}
            </p>
            <p className="break-all font-mono text-sm text-muted-foreground">{subject.id}</p>
            <div className="flex flex-wrap gap-3">
              <a className={buttonVariants({ variant: 'outline' })} href={`${href}/terms`}>
                {m.catalogue_terms_title({}, o)}
              </a>
              <a className={buttonVariants({ variant: 'outline' })} href={href}>
                {m.candidate_view_public({}, o)}
              </a>
              <DefinitionGuideLink locale={locale} address={{ type: subject.type }} />
            </div>
            <p className="text-sm text-muted-foreground">{m.manga_terms_help({}, o)}</p>
          </header>
          <p className="text-muted-foreground">{m.facts_separate_results({}, o)}</p>
          {Object.entries(groups)
            .filter(([group, fields]) => group !== 'writing' && fields.length)
            .map(([group, fields]) => (
              <section className="space-y-4" key={group}>
                <h2 className="font-sans text-xl font-semibold">{labels[group as keyof typeof labels]}</h2>
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
                      onChange={(next) =>
                        setDrafts((previous) =>
                          previous.map((draft) => (draft.property === next.property ? next : draft)),
                        )
                      }
                      onReview={setReviewing}
                      onStage={(source) => {
                        const next = stageFact(current, property, source);
                        if (next)
                          setDrafts((previous) => (previous.length < factLimit ? [...previous, next] : previous));
                      }}
                    />
                  ) : (
                    <section key={property} className="space-y-3 rounded-xl border bg-card p-4">
                      <h3
                        className="font-semibold"
                        lang={pickText(current.release.properties[property]!.labels, locale).lang ?? undefined}
                      >
                        {pickText(current.release.properties[property]!.labels, locale).text}
                      </h3>
                      {!subject.statements[property]?.length && (
                        <p className="text-sm text-muted-foreground">{m.facts_no_value({}, o)}</p>
                      )}
                      {(subject.statements[property] ?? []).map((statement) => (
                        <div key={statement.id} className="space-y-2">
                          <PartValue part={statement} read={current} locale={locale} />
                          {statement.qualifiers.map((part, index) => (
                            <div key={index} className="text-sm">
                              <span
                                className="text-muted-foreground"
                                lang={
                                  pickText(current.release.properties[part.property.id]?.labels ?? {}, locale).lang ??
                                  undefined
                                }
                              >
                                {pickText(current.release.properties[part.property.id]?.labels ?? {}, locale).text}
                                :{' '}
                              </span>
                              <PartValue part={part} read={current} locale={locale} />
                            </div>
                          ))}
                          {statement.references.map((reference, index) => (
                            <div key={index} className="space-y-1 border-s-2 ps-3 text-sm">
                              {reference.parts.map((part, at) => (
                                <PartValue key={at} part={part} read={current} locale={locale} />
                              ))}
                            </div>
                          ))}
                        </div>
                      ))}
                    </section>
                  ),
                )}
              </section>
            ))}
          <div className="space-y-3 rounded-xl border p-4">
            <p>{m.facts_selection({ count: changed.length, limit: factLimit }, o)}</p>
            <Button disabled={busy || disabled || !ports || !changed.length} onClick={() => void submit()}>
              {busy ? m.correction_saving({}, o) : m.facts_submit({}, o)}
            </Button>
            <Button className="ms-2" variant="outline" disabled={busy} onClick={() => void reload()}>
              {m.correction_reload({}, o)}
            </Button>
          </div>
          {reviewing && ports && (
            <ExactReview id={subject.id} locale={locale} address={reviewing} review={ports.review} />
          )}
        </>
      )}
      {ports && (
        <div hidden={!subject || disabled} className="space-y-6">
          <section className="space-y-4">
            <h2 className="font-sans text-xl font-semibold">{m.relation_title({}, o)}</h2>
            <p className="text-muted-foreground">{m.manga_relation_help({}, o)}</p>
            {ports.relations}
          </section>
          <section hidden={!groups?.writing.length} className="space-y-4">
            <h2 className="font-sans text-xl font-semibold">{m.authored_title({}, o)}</h2>
            {ports.authored}
          </section>
        </div>
      )}
    </div>
  );
}
