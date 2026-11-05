import { expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import type { BatchReference } from '@rezics/definitions/bulk';
import type { CommandTransaction } from '../../src/command/command.ts';
import type { Actor, Resource } from '../../src/request/access.ts';
import { appendImportedField, type ImportedFieldResult } from '../../src/content/imported-fields.ts';
import { checkMediaObject, type CoverReference } from '../../src/semantic/cover-reference.ts';
import type {
  ImportedFieldInput,
  ImportedSource,
  Rights,
  SourceReference,
} from '../../src/content/imported-contract.ts';
import { readFences } from '../../src/content/source-fences.ts';
import type { SourceFence, SourceFenceTuple } from '../../src/content/source-fences.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { anchorRoute } from '../../src/route/route.ts';

test('imported field ports retain the core transaction, access and evidence types', () => {
  const citation: BatchReference = {
    parts: [
      { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://catalogue.example/record/1' } },
      {
        property: { id: 'schema:name' },
        value: { type: 'value', content: { language: 'en', text: 'Catalogue record' } },
      },
      { property: { id: 'schema:author' }, value: { type: 'somevalue' } },
      { property: { id: 'schema:datePublished' }, value: { type: 'novalue' } },
    ],
  };
  const sourceReference: SourceReference = citation;
  const portable: BatchReference = sourceReference;
  expect(JSON.parse(JSON.stringify(portable))).toEqual(citation);
  const source: ImportedSource = {
    source: 'example-catalogue',
    external_id: 'record-1',
    record_revision: 'unversioned',
    digest: 'a'.repeat(64),
    converter_revision: 'converter-1',
    field_group: 'summary',
    references: [sourceReference],
  };
  const rights: Rights = {
    license: 'CC-BY-SA-3.0',
    obligations: ['cc:Attribution', 'cc:ShareAlike'],
    attribution: 'Example Catalogue record 1',
  };
  const input: ImportedFieldInput = {
    subject: '00000000-0000-8000-8000-000000000000',
    candidate: '00000000-0000-8000-8000-000000000001',
    revision: 1,
    source,
    rights,
    language: 'en',
    document: { version: 1 },
  };
  const actor: Actor = { kind: 'anonymous' };
  const resource: Resource = { route: 0, id: input.subject };
  const tuple: SourceFenceTuple = {
    route: 0,
    source: source.source,
    external_id: source.external_id,
    field_group: 'summary',
  };
  const client: Pick<PoolClient, 'query'> = { query: async () => ({ rows: [] }) as never };
  const tx: CommandTransaction = client;

  expect(input.source.references).toEqual([sourceReference]);
  expect([actor.kind, resource.route, tuple.field_group, tx.query]).toBeTruthy();
});

test('tupleRoute anchors exactly the source and external id and rejects ambiguous control characters', () => {
  const key = new Uint8Array(32).fill(7);
  expect(tupleRoute(key, 'example-catalogue', 'record-1')).toBe(anchorRoute(key, 'example-catalogue\nrecord-1'));
  expect(() => tupleRoute(key, 'example\ncatalogue', 'record-1')).toThrow(RangeError);
  expect(() => tupleRoute(key, 'example-catalogue', 'record-1\nother')).toThrow(RangeError);
  expect(() => tupleRoute(key, 'example-catalogue', 'record-1\u0085other')).toThrow(RangeError);
});

test('imported ports preserve uncalled transaction and evidence signature compatibility', () => {
  const fences: (
    client: Pick<PoolClient, 'query'>,
    tuples: readonly SourceFenceTuple[],
  ) => Promise<readonly SourceFence[]> = readFences;
  const append: (tx: CommandTransaction, input: ImportedFieldInput) => Promise<ImportedFieldResult> =
    appendImportedField;
  const cover: (client: Pick<PoolClient, 'query'>, id: string, role: 'cover') => Promise<CoverReference | null> =
    checkMediaObject;
  expect([fences, append, cover].every((port) => typeof port === 'function')).toBe(true);
});
