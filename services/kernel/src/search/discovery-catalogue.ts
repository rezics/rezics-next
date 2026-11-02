import { parseCataloguePin, type KindCataloguePin } from '@rezics/definitions';

/** Meaning Release and catalogue identity are independent native operands. This
 * decoder neither obtains a catalogue nor establishes Source readiness. */
export function publicFilterCatalogue(
  consumer: Readonly<{ catalogue?: unknown }>,
  mixed = false,
): KindCataloguePin | null {
  if (consumer.catalogue === undefined) {
    if (mixed) throw new TypeError('Mixed discovery requires an explicit retained catalogue identity');
    return null;
  }
  return canonicalDiscoveryCatalogue(consumer.catalogue);
}

export function canonicalDiscoveryCatalogue(value: unknown): KindCataloguePin | null {
  if (value === null) return null;
  try {
    return Object.freeze(parseCataloguePin(value));
  } catch (cause) {
    throw new TypeError('Invalid retained discovery catalogue identity', { cause });
  }
}
