import { m } from '../paraglide/messages.js';
import { locales } from '../paraglide/runtime.js';
import { quantityUnitLabel } from '../subject/quantity-presentation';

/** Reader-facing text uses the shared exact-identity unit presentation owner. */
export function searchQuantityUnitText(unit: string | undefined, admitted: readonly string[], locale: string): string {
  const options = { locale: locales.find((value) => value === locale) ?? 'en' };
  if (unit === undefined || unit === '') return m.search_quantity_unit_missing({}, options);

  const identityLabel =
    unit === '1'
      ? m.search_quantity_unitless_count({}, options)
      : unit === '*'
        ? m.search_quantity_unit_marker({ unit }, options)
        : (quantityUnitLabel(unit, {}, locale) ?? unit);

  if (!admitted.includes(unit)) return m.search_quantity_unit_not_admitted({ unit: identityLabel }, options);
  if (unit === '1' || unit === '*') return identityLabel;
  return quantityUnitLabel(unit, {}, locale) ?? m.search_quantity_unit_label_unavailable({ unit }, options);
}

/** A changed unit with any authored magnitude needs an explicit decision. */
export function quantityUnitChangeNeedsConfirmation(
  from: string | undefined,
  to: string | undefined,
  magnitudes: readonly string[],
): boolean {
  return from !== to && magnitudes.some((value) => value !== '');
}
