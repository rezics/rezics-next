import { m } from '../paraglide/messages.js';
import { creatorSalesHref } from './creator-sales-page';

export function CreatorSalesAddress({ locale, cursor }: { locale: string; cursor?: string }) {
  const href = creatorSalesHref(locale);
  return (
    <section className="mx-auto w-full max-w-3xl space-y-6 p-6" aria-labelledby="creator-sales-address-title">
      <h1 id="creator-sales-address-title" className="text-2xl font-semibold">
        {m.creator_sales_heading()}
      </h1>
      <p role="alert" className="text-sm text-destructive">
        {m.creator_sales_address_invalid()}
      </p>
      <p className="text-sm text-muted-foreground">{m.creator_sales_address_retained()}</p>
      <form method="get" action={href} className="space-y-4">
        <label htmlFor="creator-sales-cursor" className="block text-sm font-medium">
          {m.creator_sales_address_cursor_label()}
        </label>
        <input
          id="creator-sales-cursor"
          name="cursor"
          type="text"
          autoComplete="off"
          required
          maxLength={4096}
          defaultValue={cursor ?? ''}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
        />
        <button type="submit" className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
          {m.creator_sales_address_correct()}
        </button>
      </form>
      <a className="text-sm underline" href={href}>
        {m.creator_sales_restart()}
      </a>
    </section>
  );
}
