import type { PoolClient } from 'pg';
import { FIELD_GROUPS } from '@rezics/definitions/bulk';
import type { CommandTransaction } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { FactRow } from './item.ts';
import { candidateSources, fencedIds, sourceTuple, type CandidateSource } from './fences.ts';
import { slotId } from './slots.ts';

type ScalarField = {
  subject: string;
  property: string;
  field: { facts: FactRow[]; withheld: boolean; unavailable?: boolean };
};

type ProvenanceEntry = ScalarField & {
  route: number;
  statement: string;
};

function unavailable(field: ScalarField['field']): void {
  field.unavailable = true;
  field.withheld = false;
}

/** Apply the ordinary native Source-fence read to the exact selected scalar candidates. */
export async function applyWorkReleaseCardFieldFences(
  client: PoolClient,
  routeKey: Uint8Array,
  clients: ReadonlyMap<number, CommandTransaction>,
  fields: readonly ScalarField[],
): Promise<void> {
  const byHome = new Map<number, ProvenanceEntry[]>();
  for (const field of fields) {
    if (field.field.unavailable || field.field.withheld || !field.field.facts.length) continue;
    const route = routeOf(field.subject);
    if (
      route === null ||
      field.field.facts.some(
        (fact) =>
          fact.kind !== 'statement' ||
          fact.property !== field.property ||
          typeof fact.statement_id !== 'string' ||
          routeOf(fact.statement_id) !== route,
      )
    ) {
      unavailable(field.field);
      continue;
    }
    const home = partitionOf(route);
    const entries = byHome.get(home) ?? [];
    for (const fact of field.field.facts) {
      entries.push({
        subject: field.subject,
        property: field.property,
        field: field.field,
        route,
        statement: fact.statement_id!,
      });
    }
    byHome.set(home, entries);
  }

  const fenceRows: { id: string; source: CandidateSource | null }[] = [];
  const fieldByFenceId = new Map<string, ScalarField['field']>();
  for (const [home, entries] of byHome) {
    const local = clients.get(home);
    if (!local) {
      for (const entry of entries) unavailable(entry.field);
      continue;
    }
    for (let offset = 0; offset < entries.length; offset += 256) {
      const batch = entries.slice(offset, offset + 256);
      const sources = await candidateSources(
        local,
        batch.map((entry) => ({
          route: entry.route,
          subject_id: entry.subject,
          candidate_id: entry.statement,
          slot_id: slotId(entry.subject, entry.property),
        })),
      );
      for (const entry of batch) {
        if (entry.field.unavailable) continue;
        const key = `${entry.subject}\n${entry.statement}`;
        if (!sources.has(key)) {
          unavailable(entry.field);
          continue;
        }
        const source = sources.get(key);
        if (source === undefined) {
          unavailable(entry.field);
          continue;
        }
        if (source === null) continue;
        if ('kind' in source) {
          if (source.kind !== 'agent' || routeOf(source.subject) === null) unavailable(entry.field);
          continue;
        }
        if (!FIELD_GROUPS.includes(source.field_group)) {
          unavailable(entry.field);
          continue;
        }
        try {
          sourceTuple(routeKey, source);
        } catch {
          unavailable(entry.field);
          continue;
        }
        const id = String(fenceRows.length);
        fenceRows.push({ id, source });
        fieldByFenceId.set(id, entry.field);
      }
    }
  }

  if (!fenceRows.length) return;
  const taken = await fencedIds(client, routeKey, fenceRows);
  for (const id of taken) {
    const field = fieldByFenceId.get(id);
    if (field && !field.unavailable) field.withheld = true;
  }
}
