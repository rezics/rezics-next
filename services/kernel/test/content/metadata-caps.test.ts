import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { checkMediaImportRequest, type MediaImportRequest } from '@rezics/definitions/media-import';
import { isSpdxLicense } from '../../src/content/document.ts';
import { validateImportedFieldMetadata } from '../../src/content/imported-contract.ts';
import { validateCoverReferenceMetadata } from '../../src/semantic/cover-reference.ts';
import { newId } from '../../src/route/route.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
afterAll(() => pool.end());

const route = 0x1234;
const transaction = randomUUID();
const title = '漢'.repeat(1024);
const source = {
  source: 'catalogue',
  external_id: 'record-1',
  record_revision: 'edition-1',
  digest: 'a'.repeat(64),
  converter_revision: 'converter-1',
  field_group: 'summary' as const,
  references: [
    {
      parts: [{ property: { id: 'schema:url' }, value: { type: 'value' as const, content: 'https://example.test/' } }],
    },
  ],
};
const rights = { license: 'LicenseRef-local', obligations: [], attribution: 'x'.repeat(1024) };
const url2048 = (prefix: string) => `${prefix}${'x'.repeat(2048 - prefix.length)}`;
const url1024 = (prefix: string) => `${prefix}${'x'.repeat(1024 - prefix.length)}`;
const credit = {
  rightsHolder: 'x'.repeat(1024),
  via: { name: 'x'.repeat(1024), url: url1024('https://example.test/') },
  license: 'LicenseRef-local',
  obligations: [],
};
const provenance = { ...source, field_group: 'cover' as const };

const urlAtCap = url2048('https://example.test/');
const mediaRequest: MediaImportRequest = {
  containerId: newId(route),
  sourceUrl: urlAtCap,
  credit,
  provenance,
};

async function rejected(client: pg.PoolClient, query: () => Promise<unknown>) {
  await client.query('SAVEPOINT rejected_metadata');
  const error = await query().catch((caught: unknown) => caught);
  await client.query('ROLLBACK TO SAVEPOINT rejected_metadata');
  expect(error).toMatchObject({ code: '23514' });
}

test('PostgreSQL accepts every metadata cap and rejects one character or byte beyond it', async () => {
  const client = await pool.connect();
  await client.query('BEGIN');
  try {
    const board = newId(route);
    const thread = newId(route);
    const subject = newId(route);
    await client.query(
      `INSERT INTO content.board (route, board_id, subject_id, title, visibility, security_revision, recorded_transaction_id)
       VALUES ($1, $2, $3, $4, 'published', 1, $5)`,
      [route, board, subject, title, transaction],
    );
    await client.query(
      `INSERT INTO content.thread (route, thread_id, author_account_id, board_id, title, visibility, security_revision, recorded_transaction_id)
       VALUES ($1, $2, $3, $4, $5, 'published', 1, $6)`,
      [route, thread, newId(route), board, title, transaction],
    );
    await rejected(client, () =>
      client.query('UPDATE content.board SET title=$3 WHERE route=$1 AND board_id=$2', [route, board, `${title}x`]),
    );
    await rejected(client, () =>
      client.query('UPDATE content.thread SET title=$3 WHERE route=$1 AND thread_id=$2', [route, thread, `${title}x`]),
    );

    const coverId = newId(route);
    await client.query(
      `INSERT INTO content.media
       (route, media_id, container_id, uploader_id, reservation_request_id, purpose, media_type, byte_count,
        state, key, transaction_id, source_url, credit, provenance)
       VALUES ($1,$2,$3,$4,'request','cover','image/jpeg',1,'reserved',$5,$6,$7,$8,$9)`,
      [
        route,
        coverId,
        newId(route),
        newId(route),
        `m/${coverId}/original`,
        transaction,
        mediaRequest.sourceUrl,
        credit,
        provenance,
      ],
    );
    const coverAtCap = { ...credit, via: { ...credit.via, url: url1024('https://catalogue.example/') } };
    await client.query('UPDATE content.media SET credit=$3 WHERE route=$1 AND media_id=$2', [
      route,
      coverId,
      coverAtCap,
    ]);
    await rejected(client, () =>
      client.query('UPDATE content.media SET credit=$3 WHERE route=$1 AND media_id=$2', [
        route,
        coverId,
        { ...credit, via: { ...credit.via, url: `${coverAtCap.via.url}x` } },
      ]),
    );
    await rejected(client, () =>
      client.query('UPDATE content.media SET source_url=$3 WHERE route=$1 AND media_id=$2', [
        route,
        coverId,
        `${mediaRequest.sourceUrl}x`,
      ]),
    );
    await rejected(client, () =>
      client.query('UPDATE content.media SET credit=$3 WHERE route=$1 AND media_id=$2', [
        route,
        coverId,
        { ...credit, rightsHolder: `${credit.rightsHolder}x` },
      ]),
    );
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('content, imported-field and cover validators reject over-cap metadata before persistence', () => {
  expect(isSpdxLicense(`LicenseRef-${'x'.repeat(117)}`)).toBe(true);
  expect(isSpdxLicense(`LicenseRef-${'x'.repeat(118)}`)).toBe(false);
  expect(validateImportedFieldMetadata({ source, rights })).toEqual([]);
  expect(
    validateImportedFieldMetadata({ source, rights: { ...rights, attribution: `${rights.attribution}x` } }),
  ).not.toEqual([]);
  expect(validateCoverReferenceMetadata(mediaRequest)).toEqual([]);
  expect(validateCoverReferenceMetadata({ ...mediaRequest, sourceUrl: `${mediaRequest.sourceUrl}x` })).not.toEqual([]);
  expect(checkMediaImportRequest(mediaRequest)).toEqual([]);
});
