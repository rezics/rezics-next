import { quantityUnitLabel } from '../subject/quantity-presentation';

export type SearchQuantityUnitMessages = {
  missing(): string;
  unitless(): string;
  marker(unit: string): string;
  notAdmitted(unit: string): string;
  unavailable(unit: string): string;
};

/** Reader-facing text uses the shared exact-identity unit presentation owner. */
export function searchQuantityUnitText(
  unit: string | undefined,
  admitted: readonly string[],
  locale: string,
  messages: SearchQuantityUnitMessages,
): string {
  if (unit === undefined || unit === '') return messages.missing();

  const identityLabel =
    unit === '1'
      ? messages.unitless()
      : unit === '*'
        ? messages.marker(unit)
        : (quantityUnitLabel(unit, {}, locale) ?? unit);

  if (!admitted.includes(unit)) return messages.notAdmitted(identityLabel);
  if (unit === '1' || unit === '*') return identityLabel;
  return quantityUnitLabel(unit, {}, locale) ?? messages.unavailable(unit);
}

/** A changed unit with any authored magnitude needs an explicit decision. */
export function quantityUnitChangeNeedsConfirmation(
  from: string | undefined,
  to: string | undefined,
  magnitudes: readonly string[],
): boolean {
  return from !== to && magnitudes.some((value) => value !== '');
}
