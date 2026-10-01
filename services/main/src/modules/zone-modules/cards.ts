import { readZonePopulation, type ZonePopulation } from '../zone/route-population.ts';
import type { WorkReadSession } from '../work/read-session.ts';

/** Card flags name the detail-route population; clients only choose the URL. */
export async function zoneCards<T extends { id: string }>(session: WorkReadSession,
  population: ZonePopulation, cards: readonly T[]) {
  const members = await readZonePopulation((query, rows) => session.query(query, rows),
    population, cards.map(card => card.id));
  return cards.map(card => ({ ...card, inZone: members.has(card.id) }));
}
