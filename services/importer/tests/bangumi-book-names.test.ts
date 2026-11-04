import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { converter_revision as bangumiRevision } from '@rezics/conversion/bangumi';
import { extractBangumiSubjectNames } from '../../../packages/conversion/src/bangumi-subject-names.ts';
import {
  crossMediaAliases,
  emptyCrossMediaPlan,
  seedCrossMedia,
  type CrossMediaPort,
} from '../src/cross-media-seed.ts';
import { bangumiCrossMediaSeedRevision, createSourceRegistration } from '../src/source-registry.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';

const bookId = 990401;
const sameTitleId = 990402;
const selectedBook = (corrected = false) => ({
  id: bookId,
  type: 1,
  name: 'Selected Novel',
  name_cn: 'Top-level Chinese title',
  summary: 'A useful independent source field.',
  infobox: `{{Infobox animanga/Book
|中文名=Source Chinese title
|别名=${corrected ? '' : 'Scalar title'}
${corrected ? '* First alias\n* Second alias\n' : '* Must not leak\n'}|作者=Source author
}}`,
});
const sameTitleRow = {
  id: sameTitleId,
  type: 1,
  name: 'Selected Novel',
  infobox: `{{Infobox animanga/Manga
|中文名=Other template title
|别名=Must stay out of Book names
}}`,
};

function selectedPlan(book: ReturnType<typeof selectedBook>) {
  const plan = emptyCrossMediaPlan();
  plan.records.bangumi.push(
    { source: 'bangumi', key: String(book.id), revision: null, payload: book },
    { source: 'bangumi', key: String(sameTitleRow.id), revision: null, payload: sameTitleRow },
  );
  return plan;
}

function names(commands: readonly BatchCommand[], externalId: string) {
  return commands.filter(
    (command): command is Extract<BatchCommand, { op: 'propose' }> =>
      command.op === 'propose' &&
      command.source.external_id === externalId &&
      command.statement.property.id === 'schema:name',
  );
}

function nameText(command: Extract<BatchCommand, { op: 'propose' }>): string | undefined {
  if (command.statement.value.type !== 'value') return;
  const content = command.statement.value.content as { text?: unknown };
  return typeof content.text === 'string' ? content.text : undefined;
}

test('selected Book names stay source-bound through ordinary and default imports and refresh', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bangumi-book-names-'));
  const state = join(directory, 'imports.sqlite');
  const sent: BatchCommand[] = [];
  const identities = new Map<string, string>();
  const created: string[] = [];
  const metadata = sourceRecordMetadataFixture();
  const port: CrossMediaPort = {
    async batch(request) {
      sent.push(...structuredClone(request.commands));
      return {
        results: request.commands.map((command) => ({
          key: command.key,
          status: 201 as const,
          value:
            command.op === 'create'
              ? (() => {
                  const externalId = command.source.external_id;
                  created.push(externalId);
                  const id = identities.get(externalId) ?? randomUUID();
                  identities.set(externalId, id);
                  return { id, revision: 1 };
                })()
              : command.op === 'propose'
                ? { candidate: randomUUID(), revision: 1 }
                : { revision: 1 },
        })),
      };
    },
    setSourceRecordMetadata: metadata.setSourceRecordMetadata,
    async fence() {
      return { fenced: false, securityRevision: null };
    },
    async writeSourceStatistic() {},
    async clearSourceStatistic() {},
    async readReviewedSubject(id) {
      const externalId = [...identities].find(([, subjectId]) => subjectId === id)?.[0];
      if (!externalId) throw new Error('Unknown selected Book identity');
      return {
        subject: {
          id,
          type: 'schema:Book',
          statements: {
            'wdt:P5732': [{ value: { type: 'value', content: externalId } }],
          },
        },
      } as unknown as Awaited<ReturnType<CrossMediaPort['readReviewedSubject']>>;
    },
  };
  const run = (book: ReturnType<typeof selectedBook>) =>
    seedCrossMedia(selectedPlan(book), state, port, undefined, { providers: ['bangumi'], mediaDeadlineMs: 0 });

  try {
    const ordinary = createSourceRegistration('bangumi');
    expect(ordinary.converter_revision).toBe(bangumiRevision);
    const standalone = ordinary.convert(
      { external_id: String(bookId), record_revision: null, record: selectedBook() },
      { source: ordinary.source, subjectId: randomUUID() },
    );
    expect(
      extractBangumiSubjectNames(selectedBook(), 'schema:Book').names.find(
        (name) => name.text === 'Source Chinese title',
      )?.pointer,
    ).toBe('/infobox/fields/0');
    const standaloneNames = names(standalone.proposals, String(bookId));
    expect(standaloneNames.map(nameText).sort()).toEqual(
      ['Top-level Chinese title', 'Selected Novel', 'Source Chinese title'].sort(),
    );
    expect(
      standalone.proposals.some(
        (command) => command.op === 'propose' && command.statement.property.id === 'schema:abstract',
      ),
    ).toBe(true);
    expect(standalone.diagnostics).toContainEqual({
      pointer: '/infobox/fields/1',
      code: 'unsupported_infobox_name_form',
    });

    const first = await run(selectedBook());
    expect(first.runs.bangumi?.status).toBe('committed');
    const firstNames = names(sent, String(bookId));
    expect(firstNames.map(nameText).sort()).toEqual(
      ['Top-level Chinese title', 'Selected Novel', 'Source Chinese title'].sort(),
    );
    expect(firstNames.every((command) => command.statement.property.id === 'schema:name')).toBe(true);
    expect(firstNames.every((command) => command.source.source === crossMediaAliases.bangumi)).toBe(true);
    expect(firstNames.every((command) => command.source.record_revision === 'unversioned')).toBe(true);
    expect(firstNames.every((command) => command.source.converter_revision === bangumiCrossMediaSeedRevision)).toBe(true);
    expect(firstNames.every((command) => command.source.digest === firstNames[0]!.source.digest)).toBe(true);
    expect(
      firstNames.every((command) => {
        const citation = command.statement.references?.[0]?.parts[0]?.value;
        return citation?.type === 'value' && citation.content === `https://bgm.tv/subject/${bookId}`;
      }),
    ).toBe(true);
    expect(
      names(sent, String(bookId)).some((command) =>
        ['Scalar title', 'Must not leak'].includes(nameText(command) ?? ''),
      ),
    ).toBe(false);
    expect(
      sent.find((command) => command.op === 'create' && command.source.external_id === String(bookId)),
    ).toMatchObject({
      op: 'create',
      subject: { type: 'schema:Book' },
    });
    expect(names(sent, String(sameTitleId)).map(nameText)).toEqual(['Selected Novel']);
    const selectedUuid = first.readings.find((reading) => reading.externalId === String(bookId))!.subject.subject!.id!;
    const sameTitleUuid = first.readings.find((reading) => reading.externalId === String(sameTitleId))!.subject.subject!
      .id!;
    expect(selectedUuid).not.toBe(sameTitleUuid);
    expect(created.sort()).toEqual([String(bookId), String(sameTitleId)]);

    const changedStart = sent.length;
    const changed = await run(selectedBook(true));
    const refreshed = names(sent.slice(changedStart), String(bookId));
    expect(changed.runs.bangumi?.counts.changed).toBe(1);
    expect(refreshed.map(nameText)).toContain('First alias');
    expect(refreshed.map(nameText)).toContain('Second alias');
    expect(refreshed.every((command) => command.source.record_revision === 'unversioned')).toBe(true);
    expect(refreshed.every((command) => command.source.digest !== firstNames[0]!.source.digest)).toBe(true);
    expect(created.sort()).toEqual([String(bookId), String(sameTitleId)]);
    expect(changed.readings.find((reading) => reading.externalId === String(bookId))!.subject.subject!.id).toBe(
      selectedUuid,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
