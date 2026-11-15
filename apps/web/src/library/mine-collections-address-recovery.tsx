import { useId } from 'react';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@rezics/ui/shadcn/select';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import type { MineCollectionsSearch } from './mine-collections-address';

/** GET recovery requires an explicit submission; no private reader is mounted here. */
export function MineCollectionsAddressRecovery({ address }: { address: MineCollectionsSearch }) {
  const layoutSelectId = useId();
  const cursorId = useId();
  const errors = address.addressError!;
  const badLayout = errors.layout !== undefined;
  const action = `/${getLocale()}/library/collections`;
  const restart = `${action}?${new URLSearchParams({ layout: badLayout ? 'rows' : address.layout })}`;
  const layoutOptions = [
    { value: 'rows', label: m.library_owned_collections_address_rows() },
    { value: 'previews', label: m.library_owned_collections_address_previews() },
  ];
  return (
    <article className="space-y-5 text-foreground" data-collections-state="invalid-address">
      <PageHeading>{m.library_collections_heading()}</PageHeading>
      <p role="alert">{m.library_owned_collections_address_invalid()}</p>
      <dl className="break-all">
        {errors.cursor !== undefined ? (
          <>
            <dt>{m.library_owned_collections_address_cursor()}</dt>
            <dd>{errors.cursor}</dd>
          </>
        ) : null}
        {badLayout ? (
          <>
            <dt>{m.library_owned_collections_address_layout()}</dt>
            <dd>{errors.layout}</dd>
          </>
        ) : null}
      </dl>
      <p>{m.library_owned_collections_address_context()}</p>
      {badLayout ? <p>{m.library_owned_collections_address_layout_restart()}</p> : null}
      <form action={action} method="get" className="flex flex-wrap items-end gap-3">
        {badLayout ? (
          <Field className="w-fit gap-1">
            <FieldLabel id={`${layoutSelectId}-label`} htmlFor={layoutSelectId}>
              {m.library_owned_collections_address_layout()}
            </FieldLabel>
            <Select<string, false> items={layoutOptions} name="layout" defaultValue="rows">
              <SelectTrigger id={layoutSelectId} aria-labelledby={`${layoutSelectId}-label`} className="w-fit">
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectGroup>
                  {layoutOptions.map(({ value, label, ...itemProps }) => (
                    <SelectItem key={value ?? ''} value={value} {...itemProps}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        ) : (
          <>
            <input type="hidden" name="layout" value={address.layout} />
            <Field className="w-fit gap-1">
              <FieldLabel htmlFor={cursorId}>{m.library_owned_collections_address_cursor()}</FieldLabel>
              <Input id={cursorId} name="cursor" type="text" maxLength={4096} autoComplete="off" className="w-64" />
            </Field>
          </>
        )}
        <Button type="submit" variant="outline">
          {m.library_owned_collections_address_correct()}
        </Button>
      </form>
      <a href={restart} className={buttonVariants({ variant: 'outline' })}>
        {badLayout ? m.library_owned_collections_address_restart_rows() : m.library_owned_collections_address_restart()}
      </a>
    </article>
  );
}
