import { expect, test } from 'bun:test';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { showcaseLimits } from '../src/showcase-contract.ts';
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

test('exact command keys survive native candidate reuse through publication', async () => {
  const journal = new ShowcaseJournal(':memory:');
  try {
    const original: BatchCommand = {
      op: 'propose',
      key: 'original',
      subject: id(1),
      source: {
        source: 'bangumi_cross_media',
        external_id: '26',
        record_revision: 'unversioned',
        digest: 'a'.repeat(64),
        converter_revision: 'book-membership@1',
        field_group: 'facts',
      },
      statement: { property: { id: 'wdt:P179' }, value: { type: 'value', content: id(2) }, references: [] },
    };
    const replay = { ...original, key: 'later-generation' };
    for (const command of [original, replay]) {
      journal.prepareCommand(command);
      journal.acknowledgeCommand(command, { key: command.key, status: 200, value: { candidate: id(3), revision: 4 } });
    }
    const selected = await preferCurrentCandidateAcknowledgements(
      journal.acknowledgedCommands(),
      {
        reviewedCandidates() {
          throw new Error('Equal proposal bodies need no citation arbitration');
        },
      },
      new Map(),
    );
    expect(selected.map(({ command }) => command.key).sort()).toEqual(['later-generation', 'original']);
  } finally {
    journal.close();
  }
});

test('an exact selected command remains addressable beyond the historical acknowledgement page', () => {
  const journal = new ShowcaseJournal(':memory:');
  try {
    const command: BatchCommand = {
      op: 'create',
      key: 'z-selected',
      source: {
        source: 'bangumi_cross_media',
        external_id: '26',
        record_revision: 'unversioned',
        digest: 'a'.repeat(64),
        converter_revision: 'book@1',
        field_group: 'facts',
      },
      subject: { type: 'schema:Book', labels: { und: 'Selected volume' } },
    };
    journal.prepareCommand(command);
    journal.acknowledgeCommand(command, { key: command.key, status: 201, value: { id: id(1), revision: 1 } });
    const expected = journal.acknowledgedCommand(command.key);
    for (let n = 0; n < showcaseLimits.candidates + showcaseLimits.records + showcaseLimits.vocabulary; n++) {
      const older = { ...command, key: `a-history-${n}` };
      journal.prepareCommand(older);
      journal.acknowledgeCommand(older, { key: older.key, status: 201, value: { id: id(1), revision: 1 } });
    }
    expect(journal.acknowledgedCommands().some((entry) => entry.command.key === command.key)).toBe(false);
    expect(journal.acknowledgedCommand(command.key)).toEqual(expected);
    expect(journal.acknowledgedCommand('unseen')).toBeNull();
  } finally {
    journal.close();
  }
});
