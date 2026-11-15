import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';

type OfferPurchaseWorkspaceProps = {
  idempotencyKey: string;
  productIdentity: ReactNode;
  priceDecision: ReactNode;
  benefitReview: ReactNode;
  supportingDetails: ReactNode;
  fullTitlesOpen: boolean;
  onFullTitlesOpenChange: (open: boolean) => void;
};

/** Purchase layout only. Offer state and every acquisition decision stay with its owner. */
export function OfferPurchaseWorkspace({
  idempotencyKey,
  productIdentity,
  priceDecision,
  benefitReview,
  supportingDetails,
  fullTitlesOpen,
  onFullTitlesOpenChange,
}: OfferPurchaseWorkspaceProps) {
  const panelId = useId();
  const panelRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const priceHeadingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    if (fullTitlesOpen && !panel.open) panel.showModal();
    else if (!fullTitlesOpen && panel.open) panel.close();
  }, [fullTitlesOpen]);

  function restoreFocus() {
    const opener = openerRef.current;
    if (opener?.isConnected) opener.focus();
    else if (priceHeadingRef.current?.isConnected) priceHeadingRef.current.focus();
  }

  return (
    <article
      className="mx-auto max-w-6xl min-w-0 space-y-6 text-foreground sm:space-y-8"
      data-idempotency-key={idempotencyKey}
    >
      <div className="grid min-w-0 grid-cols-1 items-start gap-8 lg:grid-cols-[minmax(0,1.2fr)_minmax(19rem,0.8fr)] lg:gap-12">
        <div className="min-w-0 space-y-7 sm:space-y-9">
          <div className="min-w-0 space-y-3">
            {productIdentity}
            <Button
              type="button"
              variant="link"
              className="h-auto px-0 text-sm"
              aria-haspopup="dialog"
              aria-expanded={fullTitlesOpen}
              aria-controls={panelId}
              onClick={(event) => {
                openerRef.current = event.currentTarget;
                onFullTitlesOpenChange(true);
              }}
            >
              {m.offer_full_titles()}
            </Button>
          </div>
          <div className="min-w-0">
            {benefitReview}
          </div>
        </div>

        <section
          aria-labelledby={`${panelId}-price`}
          className="min-w-0 space-y-5 rounded-xl border bg-card p-5 shadow-sm sm:p-7"
        >
          <h2
            id={`${panelId}-price`}
            ref={priceHeadingRef}
            tabIndex={-1}
            className="text-lg font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {m.offer_price()}
          </h2>
          {priceDecision}
        </section>
      </div>

      <dialog
        ref={panelRef}
        id={panelId}
        aria-labelledby={`${panelId}-title`}
        className="m-auto max-h-[min(88dvh,48rem)] w-[min(42rem,calc(100%-2rem))] max-w-none overflow-y-auto rounded-xl border bg-background p-0 text-foreground shadow-xl backdrop:bg-black/50"
        onCancel={(event) => {
          event.preventDefault();
          onFullTitlesOpenChange(false);
        }}
        onClose={() => {
          onFullTitlesOpenChange(false);
          restoreFocus();
        }}
      >
        <div className="space-y-5 p-5 sm:p-7">
          <div className="flex items-start justify-between gap-4">
            <h2 id={`${panelId}-title`} className="text-xl font-semibold">
              {m.offer_full_titles()}
            </h2>
            <Button type="button" variant="outline" onClick={() => onFullTitlesOpenChange(false)}>
              {m.close()}
            </Button>
          </div>
          {supportingDetails}
        </div>
      </dialog>
    </article>
  );
}
