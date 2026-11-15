import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
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
      <form method="get" action={href} className="flex flex-col items-start gap-4">
        <Field className="w-full">
          <FieldLabel htmlFor="creator-sales-cursor">{m.creator_sales_address_cursor_label()}</FieldLabel>
          <Input
            id="creator-sales-cursor"
            name="cursor"
            type="text"
            autoComplete="off"
            required
            maxLength={4096}
            defaultValue={cursor ?? ''}
          />
        </Field>
        <Button type="submit">{m.creator_sales_address_correct()}</Button>
      </form>
      <a className="text-sm underline" href={href}>
        {m.creator_sales_restart()}
      </a>
    </section>
  );
}
