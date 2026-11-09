import { expect, test } from 'bun:test';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { GLOBAL_CONTEXT } from '../src/public-bulk-client.ts';
import { preferCurrentCandidateAcknowledgements, ShowcaseJournal } from '../src/showcase-publication.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('a later reciprocal receipt cannot displace the current native candidate citation', async () => {
  const journal = new ShowcaseJournal(':memory:');
  try {
    const proposal = (
      direction: string,
      citation: string,
      digest: string,
    ): Extract<BatchCommand, { op: 'propose' }> => ({
      op: 'propose',
      key: `vndb_cross_media:p24:${direction}`,
      subject: id(1),
      source: {
        source: 'vndb_cross_media',
        external_id: 'p24',
        record_revision: 'unversioned',
        digest: digest.repeat(64),
        converter_revision: `producer-parent:${direction}`,
        field_group: 'facts',
      },
      statement: {
        property: { id: 'wdt:P749' },
        value: { type: 'value', content: id(2) },
        references: [{ parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: citation } }] }],
      },
    });
    const original = proposal('a-original', 'https://vndb.org/p993#/producers_relations/p993/p24', 'a');
    const alias = proposal('z-alias', 'https://vndb.org/p24#/producers_relations/p24/p993', 'b');
    for (const [command, status] of [
      [original, 201],
      [alias, 200],
    ] as const) {
      journal.prepareCommand(command);
      journal.acknowledgeCommand(command, { key: command.key, status, value: { candidate: id(3), revision: 4 } });
    }
    const acks = journal.acknowledgedCommands();
    expect(acks.map(({ command }) => command.key)).toEqual([original.key, alias.key]);
    let reads = 0;
    const cache = new Map();
    const review = {
      async reviewedCandidates(subject: string, query: { context: string; property: string }) {
        reads++;
        expect(subject).toBe(id(1));
        expect(query).toMatchObject({ context: GLOBAL_CONTEXT, property: 'wdt:P749' });
        return {
          candidates: [{ id: id(3), source: original.source, statement: original.statement, rank: null }],
          next: null,
          adoption: null,
        } as never;
      },
    };
    const selected = await preferCurrentCandidateAcknowledgements(acks, review, cache, journal);
    expect(selected.map(({ command }) => command)).toEqual([original]);
    expect(await preferCurrentCandidateAcknowledgements(acks, review, cache, journal)).toEqual(selected);
    expect(reads).toBe(1);
    expect(journal.acknowledgedCommands()).toEqual(acks);
  } finally {
    journal.close();
  }
});
