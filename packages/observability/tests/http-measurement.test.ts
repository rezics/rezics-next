import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { commandCounters, fusekiCommandWork } from '../src/http-measurement.ts';

test('native counter export retains known visits and rejects unknown names and unsafe counts', () => {
  const headers = new Headers({
    'x-rezics-command-work': 'rank_group_candidates_visited=13,PRIVATE_ID=7,unknown_visited=8,'
      + 'public_name_labels_visited=9007199254740992,rank_live_witnesses_visited=-1,'
      + 'realm_owner_qualification_visits=9007199254740991,current_adds=0,'
      + 'exact_unit_rdf_rows_visited=21,exact_unit_postings_visited=5,exact_unit_phrase_matches_visited=2,'
      + 'also_enjoyed_writer_probes=52,also_enjoyed_writer_rows=26,also_enjoyed_writer_adds=0,'
      + 'also_enjoyed_writer_deletes=0,also_enjoyed_writer_works=1,also_enjoyed_writer_slots=0',
  });
  expect(fusekiCommandWork(headers)).toEqual({
    'rezics.fuseki.current_adds': 0,
    'rezics.fuseki.rank_group_candidates_visited': 13,
    'rezics.fuseki.exact_unit_rdf_rows_visited': 21,
    'rezics.fuseki.exact_unit_postings_visited': 5,
    'rezics.fuseki.exact_unit_phrase_matches_visited': 2,
    'rezics.fuseki.realm_owner_qualification_visits': Number.MAX_SAFE_INTEGER,
    'rezics.fuseki.also_enjoyed_writer_probes': 52,
    'rezics.fuseki.also_enjoyed_writer_rows': 26,
    'rezics.fuseki.also_enjoyed_writer_adds': 0,
    'rezics.fuseki.also_enjoyed_writer_deletes': 0,
    'rezics.fuseki.also_enjoyed_writer_works': 1,
    'rezics.fuseki.also_enjoyed_writer_slots': 0,
  });
});

test('the shared allowlist covers every authored native visit counter without exporting arbitrary names', () => {
  const native = resolve(import.meta.dir, '../../../infra/jena/command-module/src/main/java/com/rezics/jena');
  const found = new Set<string>();
  for (const file of readdirSync(native).filter(name => name.endsWith('.java'))) {
    const source = readFileSync(resolve(native, file), 'utf8');
    for (const match of source.matchAll(/CommandWork\.count\("([a-z_]+_(?:visited|visits|scanned|seeks))"/g))
      found.add(match[1]!);
  }
  expect(found.size).toBeGreaterThan(0);
  for (const name of found) expect(commandCounters as readonly string[]).toContain(name);
});
