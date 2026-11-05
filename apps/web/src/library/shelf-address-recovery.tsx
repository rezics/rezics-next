import { m } from '../paraglide/messages.js';
import { shelfAddressCorrectionHref, type ShelfAddressField } from './shelf-params';

type AddressProps = {
  locale: string;
  search: Record<string, unknown>;
};

function fieldLabel(field: ShelfAddressField): string {
  switch (field) {
    case 'type':
      return m.library_shelf_address_type();
    case 'state':
      return m.library_shelf_address_state();
    case 'label':
      return m.library_shelf_address_label();
    case 'cursor':
      return m.library_shelf_address_cursor();
  }
}

export function ShelfAddressRecovery({ locale, search, issues }: AddressProps & { issues: ShelfAddressField[] }) {
  return (
    <section role="alert" className="space-y-3">
      <h1>{m.library_shelf_address_invalid_title()}</h1>
      <p>{m.library_shelf_address_invalid_body()}</p>
      <ul>
        {issues.map((field) => (
          <li key={field}>
            <span>{fieldLabel(field)}</span>{' '}
            <a className="underline" href={shelfAddressCorrectionHref(locale, search, field)}>
              {m.library_shelf_address_clear_field()}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ShelfStaleCursorRecovery({ locale, search }: AddressProps) {
  return (
    <section role="status" className="space-y-2">
      <h2>{m.library_shelf_address_stale_title()}</h2>
      <p>{m.library_shelf_address_stale_body()}</p>
      <a className="underline" href={shelfAddressCorrectionHref(locale, search, 'cursor')}>
        {m.library_shelf_address_first_page()}
      </a>
    </section>
  );
}

/** Current shelf loaders wrap the native page in `page`; the older read adapter returns the page directly. */
export function shelfPageResetCursor(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  if ('cursorReset' in data && data.cursorReset === true) return true;
  if (!('page' in data) || !data.page || typeof data.page !== 'object') return false;
  return 'cursorReset' in data.page && data.page.cursorReset === true;
}
