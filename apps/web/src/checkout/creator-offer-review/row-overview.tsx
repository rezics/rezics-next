import { m } from '../../paraglide/messages.js';
import type { CreatorOffer } from '../creator-offers';

/** A compact reading layer on the supplied ContentItem, with full references left to disclosure. */
export function CreatorOfferRowOverview({ offer }: { offer: CreatorOffer }) {
  const terms = offer.contentEdition;
  return (
    <details className="min-w-0 space-y-2">
      <summary className="min-h-11 cursor-pointer content-center text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        {m.creator_inspect_row_terms()}
      </summary>
      <div className="min-w-0 space-y-4 rounded-lg border p-3 text-sm leading-relaxed">
        <p className="font-medium">{m.creator_inspect_row_basis({ revision: offer.revision })}</p>
        {terms === null ? (
          <>
            <p>{m.creator_inspect_row_unknown()}</p>
            <p className="text-muted-foreground">{m.creator_inspect_row_unknown_limits()}</p>
          </>
        ) : (
          <>
            <dl className="min-w-0 space-y-3 [&_dt]:font-medium [&_dd]:mt-1 [&_dd]:break-words [&_dd]:[overflow-wrap:anywhere]">
              <div>
                <dt>{m.creator_inspect_edition_label()}</dt>
                <dd>{m.creator_inspect_row_fixed()}</dd>
              </div>
              <div>
                <dt>{m.creator_inspect_revision_label()}</dt>
                <dd>{m.creator_inspect_row_revision()}</dd>
              </div>
              <div>
                <dt>{m.creator_inspect_licence_label()}</dt>
                <dd className="whitespace-pre-wrap">{terms.source.licence}</dd>
              </div>
              <div>
                <dt>{m.creator_inspect_delivery_label()}</dt>
                <dd>{m.creator_inspect_row_delivery()}</dd>
              </div>
              <div>
                <dt>{m.creator_inspect_acquisition_label()}</dt>
                <dd>{m.creator_inspect_row_acquisition()}</dd>
              </div>
              <div>
                <dt>{m.creator_inspect_quantity_label()}</dt>
                <dd className="tabular-nums">{terms.quantity}</dd>
              </div>
            </dl>
            <p className="text-muted-foreground">{m.creator_inspect_row_not_verified()}</p>
          </>
        )}
        <p className="text-muted-foreground">{m.creator_inspect_row_inspection_hint()}</p>
      </div>
    </details>
  );
}
