import { m } from '../../paraglide/messages.js';
import type { CreatorOffer } from '../creator-offers';

/** Only sanitized, already admitted captured terms. This component has no reader or catalogue port. */
export function CapturedOfferTerms({ offer, headingId }: { offer: CreatorOffer; headingId?: string }) {
  const terms = offer.contentEdition;
  if (terms === null) {
    return (
      <section className="min-w-0 space-y-4" aria-label={m.creator_inspect_terms_heading()}>
        <h3
          id={headingId}
          tabIndex={-1}
          className="text-lg font-semibold focus-visible:outline-2 focus-visible:outline-ring"
        >
          {m.creator_inspect_unknown_heading()}
        </h3>
        <p className="max-w-prose leading-relaxed">{m.creator_inspect_unknown_meaning()}</p>
        <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <dt className="font-medium">{m.creator_inspect_edition_label()}</dt>
            <dd className="text-sm leading-relaxed text-muted-foreground">{m.creator_inspect_unknown_edition()}</dd>
          </div>
          <div className="space-y-1">
            <dt className="font-medium">{m.creator_inspect_revision_label()}</dt>
            <dd className="text-sm leading-relaxed text-muted-foreground">{m.creator_inspect_unknown_revision()}</dd>
          </div>
          <div className="space-y-1">
            <dt className="font-medium">{m.creator_inspect_licence_label()}</dt>
            <dd className="text-sm leading-relaxed text-muted-foreground">{m.creator_inspect_unknown_licence()}</dd>
          </div>
          <div className="space-y-1">
            <dt className="font-medium">{m.creator_inspect_delivery_label()}</dt>
            <dd className="text-sm leading-relaxed text-muted-foreground">{m.creator_inspect_unknown_delivery()}</dd>
          </div>
          <div className="space-y-1">
            <dt className="font-medium">{m.creator_inspect_acquisition_label()}</dt>
            <dd className="text-sm leading-relaxed text-muted-foreground">{m.creator_inspect_unknown_acquisition()}</dd>
          </div>
          <div className="space-y-1">
            <dt className="font-medium">{m.creator_inspect_quantity_label()}</dt>
            <dd className="text-sm leading-relaxed text-muted-foreground">{m.creator_inspect_unknown_quantity()}</dd>
          </div>
        </dl>
        <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
          {m.creator_inspect_unknown_recovery()}
        </p>
      </section>
    );
  }
  return (
    <section className="min-w-0 space-y-5" aria-label={m.creator_inspect_terms_heading()}>
      <div className="space-y-2">
        <h3
          id={headingId}
          tabIndex={-1}
          className="text-lg font-semibold focus-visible:outline-2 focus-visible:outline-ring"
        >
          {m.creator_inspect_terms_heading()}
        </h3>
        <p className="max-w-prose leading-relaxed">{m.creator_inspect_terms_intro()}</p>
      </div>
      <dl className="grid min-w-0 gap-5 sm:grid-cols-2">
        <div className="min-w-0 space-y-2">
          <dt className="font-semibold">{m.creator_inspect_edition_label()}</dt>
          <dd className="space-y-2 text-sm leading-relaxed">
            <p>{m.creator_inspect_edition_meaning()}</p>
            <p className="text-muted-foreground">{m.creator_inspect_edition_distinction()}</p>
          </dd>
        </div>
        <div className="min-w-0 space-y-2">
          <dt className="font-semibold">{m.creator_inspect_revision_label()}</dt>
          <dd className="space-y-2 text-sm leading-relaxed">
            <p>{m.creator_inspect_revision_meaning()}</p>
            <p className="text-muted-foreground">{m.creator_inspect_revision_distinction()}</p>
          </dd>
        </div>
        <div className="min-w-0 space-y-2">
          <dt className="font-semibold">{m.creator_inspect_licence_label()}</dt>
          <dd className="space-y-2 text-sm leading-relaxed">
            <p className="whitespace-pre-wrap break-words rounded-md border p-3 [overflow-wrap:anywhere]">
              {terms.source.licence}
            </p>
            <p className="text-muted-foreground">{m.creator_inspect_licence_meaning()}</p>
          </dd>
        </div>
        <div className="min-w-0 space-y-2">
          <dt className="font-semibold">{m.creator_inspect_delivery_label()}</dt>
          <dd className="space-y-2 text-sm leading-relaxed">
            <p>{m.creator_inspect_delivery_meaning()}</p>
            <p className="text-muted-foreground">{m.creator_inspect_delivery_distinction()}</p>
          </dd>
        </div>
        <div className="min-w-0 space-y-2">
          <dt className="font-semibold">{m.creator_inspect_acquisition_label()}</dt>
          <dd className="space-y-2 text-sm leading-relaxed">
            <p>{m.creator_inspect_acquisition_meaning()}</p>
            <p className="text-muted-foreground">{m.creator_inspect_acquisition_distinction()}</p>
          </dd>
        </div>
        <div className="min-w-0 space-y-2">
          <dt className="font-semibold">{m.creator_inspect_quantity_label()}</dt>
          <dd className="space-y-2 text-sm leading-relaxed">
            <p className="text-lg font-medium tabular-nums">{terms.quantity}</p>
            <p className="text-muted-foreground">{m.creator_inspect_quantity_meaning()}</p>
          </dd>
        </div>
      </dl>
      <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">{m.creator_inspect_current_access()}</p>
    </section>
  );
}

/** Long identifiers and opaque references are a separate optional reading layer. */
export function CapturedOfferReferences({ offer, summaryId }: { offer: CreatorOffer; summaryId?: string }) {
  const terms = offer.contentEdition;
  return (
    <details className="min-w-0 rounded-lg border px-4">
      <summary
        id={summaryId}
        className="min-h-11 cursor-pointer content-center py-3 font-medium underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {m.creator_inspect_references_heading()}
      </summary>
      <div className="min-w-0 space-y-4 pb-4">
        <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
          {m.creator_inspect_references_intro()}
        </p>
        <dl className="min-w-0 space-y-4 text-sm [&_dd]:mt-1 [&_dd]:break-words [&_dd]:[overflow-wrap:anywhere] [&_dt]:font-medium">
          <div>
            <dt>{m.creator_offers_offer_id()}</dt>
            <dd>
              <code>{offer.id}</code>
            </dd>
          </div>
          <div>
            <dt>{m.creator_offers_offer_revision()}</dt>
            <dd>
              <code>{offer.revision}</code>
            </dd>
          </div>
          <div>
            <dt>{m.creator_inspect_subject_reference()}</dt>
            <dd>
              <code>{offer.targetSubjectId}</code>
            </dd>
          </div>
          {terms !== null && (
            <>
              <div>
                <dt>{m.creator_offers_edition_locator()}</dt>
                <dd>
                  <code>{`${terms.benefit.resource.route}/${terms.benefit.resource.id}`}</code>
                </dd>
              </div>
              <div>
                <dt>{m.creator_inspect_revision_reference()}</dt>
                <dd>
                  <code>{terms.benefit.version.revisionId}</code>
                </dd>
              </div>
              <div>
                <dt>{m.creator_inspect_hash_label()}</dt>
                <dd>
                  <code>{terms.benefit.version.sha256}</code>
                </dd>
              </div>
              <div>
                <dt>{m.creator_inspect_sale_reference()}</dt>
                <dd>
                  <code>{terms.saleTermsReference}</code>
                </dd>
              </div>
              <div>
                <dt>{m.creator_inspect_creator_reference()}</dt>
                <dd>
                  <code>{terms.creatorAccountId}</code>
                </dd>
              </div>
              <div>
                <dt>{m.creator_inspect_action_reference()}</dt>
                <dd>
                  <code>{terms.benefit.action}</code>
                </dd>
              </div>
            </>
          )}
        </dl>
        {terms !== null && (
          <>
            <p className="max-w-prose text-sm leading-relaxed">{m.creator_inspect_hash_meaning()}</p>
            <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
              {m.creator_inspect_reference_meaning()}
            </p>
          </>
        )}
      </div>
    </details>
  );
}
