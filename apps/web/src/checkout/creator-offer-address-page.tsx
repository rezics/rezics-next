import { buttonVariants } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import type { CreatorOfferAddressIssue } from './creator-offer-address';
import { UUID } from './price';

export function CreatorOfferRequested({ requested }: { requested?: string | undefined }) {
  if (!requested) return null;
  return (
    <div className="mb-6 min-w-0 space-y-2 text-sm">
      <p>{m.creator_offer_address_requested()}</p>
      <pre className="whitespace-pre-wrap break-all font-mono">{requested}</pre>
    </div>
  );
}

/** Recovery only navigates to an address. It never creates or retries an offer command. */
export function CreatorOfferAddressPage({
  kind,
  locale,
  issue,
  requested,
}: {
  kind: 'list' | 'editor';
  locale: string;
  issue?: CreatorOfferAddressIssue | undefined;
  requested?: string | undefined;
}) {
  const editor = kind === 'editor';
  return (
    <section className="max-w-4xl min-w-0 space-y-6 text-foreground">
      <PageHeading>{editor ? m.creator_new_offer() : m.creator_offers_heading()}</PageHeading>
      <CreatorOfferRequested requested={issue?.requested ?? requested} />
      <p role={issue ? 'alert' : 'status'}>
        {issue
          ? editor
            ? m.creator_offer_address_invalid_edition()
            : m.creator_offer_address_invalid_cursor()
          : m.creator_offers_preparing()}
      </p>
      {issue &&
        (editor ? (
          <form action={`/${locale}/creator/offers/new`} method="get" className="space-y-4">
            <label className="block space-y-2">
              <span>{m.creator_offer_address_edition()}</span>
              <Input
                name="contentEditionId"
                required
                pattern={UUID.source.replaceAll('a-f', 'a-fA-F')}
                autoComplete="off"
                className="min-h-11"
              />
            </label>
            <button className={buttonVariants({ variant: 'outline', className: 'min-h-11' })} type="submit">
              {m.creator_offer_address_open_edition()}
            </button>
          </form>
        ) : (
          <a
            href={`/${locale}/creator/offers`}
            className={buttonVariants({ variant: 'outline', className: 'min-h-11' })}
          >
            {m.creator_offer_address_first_page()}
          </a>
        ))}
    </section>
  );
}
