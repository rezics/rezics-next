import { buttonVariants } from '@rezics/ui/shadcn/button';
import { ChoiceSelect } from '@rezics/ui/choice-select';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import type { MineCollectionsSearch } from './mine-collections-address';

/** GET recovery requires an explicit submission; no private reader is mounted here. */
export function MineCollectionsAddressRecovery({ address }: { address: MineCollectionsSearch }) {
  const errors = address.addressError!;
  const badLayout = errors.layout !== undefined;
  const action = `/${getLocale()}/library/collections`;
  const restart = `${action}?${new URLSearchParams({ layout: badLayout ? 'rows' : address.layout })}`;
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
          <ChoiceSelect
            label={m.library_owned_collections_address_layout()}
            fieldClassName="w-fit gap-1"
            triggerClassName="w-fit block rounded border p-2"
            name="layout"
            defaultValue="rows"
            options={[
              { value: 'rows', label: m.library_owned_collections_address_rows() },
              { value: 'previews', label: m.library_owned_collections_address_previews() },
            ]}
          />
        ) : (
          <>
            <input type="hidden" name="layout" value={address.layout} />
            <label>
              {m.library_owned_collections_address_cursor()}
              <input
                name="cursor"
                type="text"
                maxLength={4096}
                autoComplete="off"
                className="block rounded border p-2"
              />
            </label>
          </>
        )}
        <button type="submit" className={buttonVariants({ variant: 'outline' })}>
          {m.library_owned_collections_address_correct()}
        </button>
      </form>
      <a href={restart} className={buttonVariants({ variant: 'outline' })}>
        {badLayout ? m.library_owned_collections_address_restart_rows() : m.library_owned_collections_address_restart()}
      </a>
    </article>
  );
}
