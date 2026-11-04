import { useEffect, useRef, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@rezics/ui/shadcn/dialog';
import { m } from '../../../paraglide/messages.js';
import { CandidateValue } from '../../pages/data';
import type { LinkProps, Snak } from '../../pages/shared';
import { candidateContext } from '../../../subject/candidates';
import { useCatalogueLifetime } from '../../../subject/candidate-lifetime';
import type { RelationTransport } from '../../../subject/relation-candidates';
import type { EntityPickerSearch } from '@rezics/ui/entity-picker';
import { RelationEditor } from '../relation-editor';
import type { DetailRead } from '../subject-changes';
import { ChangeExplanation } from '../subject-changes-page';
import {
  creditCorrection,
  creditRelated,
  creditWindowHref,
  type CreditAssertion,
  type CreditCorrection,
  type CreditVisit,
} from './model';

/** Independent destinations keep the bounded original credit window mounted in its original tab. */
function DisclosedTarget({ children, ...props }: LinkProps) {
  return (
    <a {...props} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

export function CreditInspection({
  credit,
  visit,
  title,
  propertyLabel,
  locale,
  onClose,
  metadata,
  transport,
  signedIn,
  search,
  isCurrent,
  returnFocus,
}: {
  credit: CreditAssertion;
  visit: CreditVisit;
  title: string;
  propertyLabel: string;
  locale: string;
  onClose: () => void;
  metadata: () => Promise<DetailRead>;
  transport: RelationTransport;
  signedIn: boolean;
  search: EntityPickerSearch;
  isCurrent: () => boolean;
  returnFocus?: (() => HTMLElement | null) | undefined;
}) {
  const lifetime = useCatalogueLifetime(JSON.stringify([credit, visit, locale]));
  const current = () => lifetime.active() && isCurrent();
  const [detail, setDetail] = useState<DetailRead>();
  const [readingMetadata, setReadingMetadata] = useState(false);
  const metadataActive = useRef(false);
  const [correction, setCorrection] = useState<CreditCorrection>();
  const [readingCorrection, setReadingCorrection] = useState(false);
  const [editing, setEditing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const o = { locale: locale as never };
  const statement = credit.statement;
  const related = creditRelated(credit);
  useEffect(() => {
    let cancelled = false;
    if (!signedIn || !credit.slot || visit.context !== candidateContext || !current()) return;
    setReadingCorrection(true);
    void transport
      .read(credit.slot)
      .then((read) => {
        if (!cancelled && current()) setCorrection(creditCorrection(credit, visit, read));
      })
      .catch(() => {
        if (!cancelled && current()) setCorrection({ state: 'unavailable' });
      })
      .finally(() => {
        if (!cancelled && current()) setReadingCorrection(false);
      });
    return () => {
      cancelled = true;
    };
  }, [credit, visit, signedIn, transport, lifetime, attempt]);

  async function inspectRevision() {
    if (metadataActive.current || !current()) return;
    metadataActive.current = true;
    setReadingMetadata(true);
    try {
      const result = await metadata();
      if (current())
        setDetail(
          result.kind !== 'ready' ||
            (result.detail.id === credit.holder && result.detail.revision === statement.rezics.revision)
            ? result
            : { kind: 'unavailable' },
        );
    } catch {
      if (current()) setDetail({ kind: 'unavailable' });
    } finally {
      metadataActive.current = false;
      if (current()) setReadingMetadata(false);
    }
  }
  function value(snak: Snak) {
    // CandidateValue has a generic unlabelled-item link. An inspector must never invent a hidden target link.
    if (
      snak.property.data_type === 'wikibase-item' &&
      snak.value.type === 'value' &&
      (typeof snak.value.content !== 'string' || !related[snak.value.content])
    )
      return <span>{m.subject_value_unlabelled({}, o)}</span>;
    const Target = (props: LinkProps) => (
      <DisclosedTarget
        {...props}
        href={visit.realm ? `${props.href}?${new URLSearchParams({ realm: visit.realm })}` : props.href}
      />
    );
    return <CandidateValue snak={snak} related={related} locale={locale} link={Target} />;
  }
  function part(snak: Snak, index: number) {
    return (
      <li key={index} className="min-w-0 space-y-1" data-property={snak.property.id}>
        <span className="text-muted-foreground">{snak.property.id}</span> {value(snak)}
      </li>
    );
  }
  const failedDetail = detail && detail.kind !== 'ready';
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !editing && current()) onClose();
      }}
    >
      <DialogContent showCloseButton={false} finalFocus={returnFocus} className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {m.credit_inspect({}, o)}: {title}
          </DialogTitle>
          <DialogDescription>{m.credit_original({}, o)}</DialogDescription>
        </DialogHeader>
        <div className="min-w-0 space-y-5 whitespace-pre-wrap [overflow-wrap:anywhere]">
          <p>
            {propertyLabel} <span className="text-muted-foreground">({statement.property.id})</span> →{' '}
            {value(statement)}
          </p>
          <p>{m.credit_inverse({}, o)}</p>
          {statement.qualifiers.length > 0 && (
            <ul className="space-y-2" aria-label={m.credit_qualifiers({}, o)}>
              {statement.qualifiers.map(part)}
            </ul>
          )}
          <section aria-label={m.credit_citations({}, o)} className="space-y-2">
            <h3 className="font-medium">{m.credit_citations({}, o)}</h3>
            {statement.references.length ? (
              <ol className="list-decimal space-y-3 ps-5">
                {statement.references.map((reference, index) => (
                  <li key={index}>
                    <ul className="space-y-2">{reference.parts.map(part)}</ul>
                  </li>
                ))}
              </ol>
            ) : (
              <p>{m.credit_no_disclosed_citations({}, o)}</p>
            )}
          </section>
          <section aria-label={m.credit_revision({}, o)} className="space-y-2">
            <h3 className="font-medium">{m.credit_revision({}, o)}</h3>
            <p>
              {m.credit_identity(
                { statement: statement.id, revision: statement.rezics.revision, release: statement.rezics.release },
                o,
              )}
            </p>
            <p className="text-muted-foreground">{m.credit_metadata_meaning({}, o)}</p>
            <Button variant="outline" disabled={readingMetadata || editing} onClick={() => void inspectRevision()}>
              {readingMetadata
                ? m.candidate_loading({}, o)
                : failedDetail
                  ? m.credit_retry_revision({}, o)
                  : m.credit_read_revision({}, o)}
            </Button>
            {failedDetail && <p role="status">{m.credit_revision_unavailable({}, o)}</p>}
            {detail?.kind === 'ready' && (
              <ChangeExplanation detail={detail.detail} revision={statement.rezics.revision} locale={locale} />
            )}
          </section>
          <section aria-label={m.credit_correct({}, o)} className="space-y-3">
            {editing && correction?.state === 'ready' ? (
              <RelationEditor
                id={credit.holder}
                locale={locale}
                initial={correction.read}
                composition={correction.composition}
                transport={transport}
                search={search}
                propertyIds={[statement.property.id]}
                initialProperty={statement.property.id}
                embedded
                requireCloseConfirmation
                onClose={() => {
                  if (current()) setEditing(false);
                }}
              />
            ) : (
              <>
                <p role="status">
                  {readingCorrection
                    ? m.candidate_loading({}, o)
                    : !signedIn
                      ? m.relation_sign_in({}, o)
                      : correction?.state === 'denied'
                        ? m.credit_correction_denied({}, o)
                        : correction?.state === 'stale'
                          ? m.credit_correction_stale({}, o)
                          : correction?.state === 'ready'
                            ? m.credit_proposal_meaning({}, o)
                            : m.credit_correction_unavailable({}, o)}
                </p>
                {correction?.state === 'ready' && (
                  <Button
                    disabled={readingMetadata}
                    onClick={() => {
                      if (current()) setEditing(true);
                    }}
                  >
                    {m.credit_correct({}, o)}
                  </Button>
                )}
                {correction?.state === 'stale' && (
                  <a
                    className="underline"
                    href={creditWindowHref(visit, locale)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {m.credit_refresh_window({}, o)}
                  </a>
                )}
                {correction?.state === 'unavailable' && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      if (current()) setAttempt((value) => value + 1);
                    }}
                  >
                    {m.credit_retry_correction({}, o)}
                  </Button>
                )}
              </>
            )}
          </section>
        </div>
        {!editing && (
          <Button
            variant="outline"
            onClick={() => {
              if (current()) onClose();
            }}
          >
            {m.credit_close({}, o)}
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
