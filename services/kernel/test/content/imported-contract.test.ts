import { expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import type { CommandTransaction } from '../../src/command/command.ts';
import type { Actor, Resource } from '../../src/request/access.ts';
import { appendImportedField } from '../../src/content/imported-fields.ts';
import { checkMediaObject } from '../../src/content/cover-reference.ts';
import type {
  ImportedFieldInput,
  ImportedSource,
  Rights,
  SourceReference,
} from '../../src/content/imported-contract.ts';
import { readFences } from '../../src/content/source-fences.ts';
import type { SourceFenceTuple } from '../../src/content/source-fences.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { anchorRoute } from '../../src/route/route.ts';

test('imported field ports retain the core transaction, access and evidence types', () => {
  const sourceReference: SourceReference = { url: 'https://catalogue.example/record/1', title: 'Catalogue record' };
  const source: ImportedSource = {
    source: 'example-catalogue',
    external_id: 'record-1',
    record_revision: 'unversioned',
    digest: 'sha256:abc',
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

// Temporary fail-closed assertions: replace these with real port behavior only in a manager-authorized implementation.
test('unfinished source fence port fails before reading its client', async () => {
  let touched = false;
  const client = new Proxy(
    {},
    {
      get() {
        touched = true;
        throw new Error('dependency touched');
      },
    },
  ) as Pick<PoolClient, 'query'>;
  await expect(readFences(client, [])).rejects.toThrow('not implemented');
  expect(touched).toBe(false);
});

// Temporary fail-closed assertions: replace these with real port behavior only in a manager-authorized implementation.
test('unfinished imported-field port fails before reading its transaction', async () => {
  let touched = false;
  const tx = new Proxy(
    {},
    {
      get() {
        touched = true;
        throw new Error('dependency touched');
      },
    },
  ) as CommandTransaction;
  const input = {} as ImportedFieldInput;
  await expect(appendImportedField(tx, input)).rejects.toThrow('not implemented');
  expect(touched).toBe(false);
});

// Temporary fail-closed assertions: replace these with real port behavior only in a manager-authorized implementation.
test('unfinished cover reference port fails before reading its client', async () => {
  let touched = false;
  const client = new Proxy(
    {},
    {
      get() {
        touched = true;
        throw new Error('dependency touched');
      },
    },
  ) as Pick<PoolClient, 'query'>;
  await expect(checkMediaObject(client, 'media-id', 'cover')).rejects.toThrow('not implemented');
  expect(touched).toBe(false);
});
