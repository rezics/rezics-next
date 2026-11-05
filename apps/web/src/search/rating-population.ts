/** Search population selection is independent of the authored resource membership filter. */
export const RATING_POPULATION_FIELD = 'ratingPopulation' as const;

export type RealmRatingPopulationOption = Readonly<{
  id: string;
  label: string;
}>;

export type RealmRatingReadiness =
  | Readonly<{ status: 'ready'; question: 'standard'; partition: number }>
  | Readonly<{ status: 'preparing' }>
  | Readonly<{ status: 'unavailable' }>
  | Readonly<{ status: 'refused' }>
  | Readonly<{ status: 'generation-change' }>;

const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Admit only canonical Realm IDs. Global has no Realm ID and is represented by an empty field. */
export function canonicalRealmRatingPopulationId(value: unknown): string | undefined {
  return typeof value === 'string' && canonicalUuid.test(value) ? value : undefined;
}

/** Display only the authorized choices supplied by the native Search owner. */
export function supportedRealmRatingPopulations(
  values: readonly RealmRatingPopulationOption[] | undefined,
): RealmRatingPopulationOption[] {
  if (!values) return [];
  const seen = new Set<string>();
  const choices: RealmRatingPopulationOption[] = [];
  for (const value of values) {
    const id = canonicalRealmRatingPopulationId(value.id);
    const label = value.label.trim();
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    choices.push({ id, label });
  }
  return choices;
}
