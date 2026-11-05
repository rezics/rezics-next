import { expect, test } from 'bun:test';
import { loadImportDumpsDriver } from './imports-dumps-driver';
import type { DumpRecord, DumpSource, ImportDumpsDriver } from './imports-dumps-driver';

// Source framing references (fixtures are synthetic, not copied source content):
// https://github.com/bangumi/Archive (subject.jsonlines inside the archive)
// https://vndb.org/d14 and https://www.postgresql.org/docs/current/sql-copy.html
// https://openlibrary.org/developers/dumps
// https://www.wikidata.org/wiki/Wikidata:Database_download
const sources: DumpSource[] = ['bangumi', 'vndb', 'openlibrary', 'wikidata'];
const encoder = new TextEncoder();
const limit = 4096;
const filenames = {
  bangumi: 'bangumi-subject.jsonlines',
  vndb: 'vndb.sql',
  openlibrary: 'openlibrary.tsv',
  wikidata: 'wikidata.json',
};
const fixture = (source: DumpSource) =>
  Bun.file(new URL(`fixtures/imports/dumps/${filenames[source]}`, import.meta.url)).text();

async function scenario(run: (driver: ImportDumpsDriver) => Promise<void>) {
  const driver = await loadImportDumpsDriver();
  try {
    await run(driver);
    expect(await driver.effects()).toEqual({ sql: [], requests: [], fileWrites: [] });
  } finally {
    await driver.close();
  }
}
async function* chunks(text: string, size = 1): AsyncGenerator<Uint8Array> {
  const bytes = encoder.encode(text);
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.slice(offset, offset + size);
}
async function collect(driver: ImportDumpsDriver, source: DumpSource, text: string, maxRecordBytes = limit, size = 1) {
  const records: DumpRecord[] = [];
  for await (const record of driver.read(source, chunks(text, size), { maxRecordBytes })) records.push(record);
  return records;
}
function row(source: DumpSource, key = '41', title = 'Fresh public title 🌙') {
  switch (source) {
    case 'bangumi':
      return JSON.stringify({ id: Number(key), type: 2, name: title, summary: 'Public synopsis' });
    case 'vndb':
      return `v${key}\t${title}\t\\N`;
    case 'openlibrary':
      return `/type/work\t/works/OL${key}W\t7\t2024-01-02T03:04:05.000000\t${JSON.stringify({
        key: `/works/OL${key}W`,
        type: { key: '/type/work' },
        revision: 7,
        title,
      })}`;
    case 'wikidata':
      return JSON.stringify({
        id: `Q${key}`,
        type: 'item',
        lastrevid: 101,
        labels: { en: { language: 'en', value: title } },
        claims: {},
      });
  }
}
function dump(source: DumpSource, rows: string[]) {
  if (source === 'vndb') return `COPY public.vn (id, description, image) FROM stdin;\n${rows.join('\n')}\n\\.\n`;
  return `${rows.join('\n')}\n`;
}
function nativeKey(source: DumpSource, key = '41') {
  return source === 'vndb'
    ? `v${key}`
    : source === 'wikidata'
      ? `Q${key}`
      : source === 'openlibrary'
        ? `/works/OL${key}W`
        : key;
}
async function aborts(
  driver: ImportDumpsDriver,
  source: DumpSource,
  text: string,
  maxRecordBytes = limit,
  chunkSize = 1,
) {
  // Assert rejection of full iteration, not merely absence of a bad record.
  // Wording/codes remain production-owned, but a real diagnostic is mandatory.
  let failure: unknown;
  try {
    await collect(driver, source, text, maxRecordBytes, chunkSize);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message.trim().length).toBeGreaterThan(0);
  expect((failure as Error).message).not.toContain('PRIVATE_ACCOUNT_SENTINEL');
  expect((failure as Error).message).not.toContain('PRIVATE_USER_POST_SENTINEL');
}

test('Bangumi subject JSON lines preserve native keys absent revisions and complete source payload across byte splits', async () => {
  await scenario(async (driver) => {
    const text = await fixture('bangumi');
    const payloads = text
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(payloads.map((p) => p.id)).toEqual([1001, 1002]);
    expect(payloads[0].name).toBe('Lantern 🌙');
    expect(await collect(driver, 'bangumi', text)).toEqual(
      payloads.map((payload) => ({
        source: 'bangumi',
        key: String(payload.id),
        revision: null,
        payload,
      })),
    );
  });
});

test('VNDB COPY headers order cells and decode escapes null empty strings and literal terminators', async () => {
  await scenario(async (driver) => {
    expect(await collect(driver, 'vndb', await fixture('vndb'))).toEqual([
      {
        source: 'vndb',
        key: 'v1',
        revision: null,
        payload: {
          description: 'Public synopsis\tcolumn\nnext\\path 🌙',
          id: 'v1',
          image: null,
          olang: 'ja',
        },
      },
      {
        source: 'vndb',
        key: 'v2',
        revision: null,
        payload: {
          description: 'Literal null marker \\N and terminator \\.',
          id: 'v2',
          image: '',
          olang: 'en',
        },
      },
    ]);
  });
});

test('Open Library five column TSV preserves work edition revision and JSON while excluding private user rows', async () => {
  await scenario(async (driver) => {
    const text = await fixture('openlibrary');
    const payloads = text
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line.split('\t')[4]!));
    const actual = await collect(driver, 'openlibrary', text);
    expect(actual).toEqual([
      { source: 'openlibrary', key: '/works/OL1W', revision: '7', payload: payloads[0] },
      { source: 'openlibrary', key: '/books/OL2M', revision: '3', payload: payloads[2] },
    ]);
    expect(actual[0]!.payload).toMatchObject({
      title: 'Lantern 🌙',
      description: { value: 'Public synopsis\nTab\there and \\path' },
    });
  });
});

test('Wikidata dump array bracket and trailing comma lines preserve entities and lastrevid', async () => {
  await scenario(async (driver) => {
    const text = await fixture('wikidata');
    const payloads = JSON.parse(text);
    expect(payloads.map((p: { id: string }) => p.id)).toEqual(['Q1', 'Q2']);
    expect(await collect(driver, 'wikidata', text)).toEqual(
      payloads.map((payload: Record<string, unknown>) => ({
        source: 'wikidata',
        key: payload.id,
        revision: String(payload.lastrevid),
        payload,
      })),
    );
  });
});

test('JSON lines and TSV accept CRLF and a complete final record without a newline', async () => {
  await scenario(async (driver) => {
    for (const source of ['bangumi', 'openlibrary', 'wikidata'] as const) {
      const text = `${row(source)}\r\n${row(source, '42')}`;
      expect((await collect(driver, source, text)).map((r) => r.key)).toEqual([
        nativeKey(source),
        nativeKey(source, '42'),
      ]);
    }
  });
});

test('Wikidata accepts standalone comma framing lines without treating them as entities', async () => {
  await scenario(async (driver) => {
    expect(
      (await collect(driver, 'wikidata', `[\n${row('wikidata')}\n,\n${row('wikidata', '42')}\n]\n`)).map((r) => r.key),
    ).toEqual(['Q41', 'Q42']);
  });
});

test('all readers use incoming keys revisions and payloads rather than canned fixture records', async () => {
  await scenario(async (driver) => {
    const title = `Public ${crypto.randomUUID()} 🌙`;
    for (const source of sources) {
      const actual = await collect(driver, source, dump(source, [row(source, '817', title)]));
      const payload =
        source === 'vndb'
          ? { id: 'v817', description: title, image: null }
          : JSON.parse(
              source === 'openlibrary' ? row(source, '817', title).split('\t')[4]! : row(source, '817', title),
            );
      expect(actual).toEqual([
        {
          source,
          key: nativeKey(source, '817'),
          revision: source === 'wikidata' ? '101' : source === 'openlibrary' ? '7' : null,
          payload,
        },
      ]);
    }
  });
});

test('Wikidata records without a native revision stay unversioned and preserve their raw payload', async () => {
  await scenario(async (driver) => {
    const payload = { id: 'Q818', type: 'item', labels: { en: { language: 'en', value: 'Unversioned' } }, claims: {} };
    expect(await collect(driver, 'wikidata', `${JSON.stringify(payload)}\n`)).toEqual([
      { source: 'wikidata', key: 'Q818', revision: null, payload },
    ]);
  });
});

test('malformed rows after valid records abort every source instead of becoming missing records', async () => {
  await scenario(async (driver) => {
    for (const source of sources) {
      const malformed =
        source === 'vndb'
          ? 'v42\tonly two columns'
          : source === 'openlibrary'
            ? '/type/work\t/works/OL42W\t7\t2024-01-02T03:04:05\t{broken}'
            : '{broken}';
      await aborts(driver, source, dump(source, [row(source), malformed, row(source, '43')]));
    }
  });
});

test('truncated final rows abort every source even after a valid prefix', async () => {
  await scenario(async (driver) => {
    for (const source of sources) {
      const prefix =
        source === 'vndb'
          ? `COPY public.vn (id, description, image) FROM stdin;\n${row(source)}\n`
          : `${row(source)}\n`;
      const truncated =
        source === 'vndb'
          ? 'v42\tcut\\'
          : source === 'openlibrary'
            ? '/type/work\t/works/OL42W\t7\t2024-01-02T03:04:05\t{"title":"cut'
            : '{"id":';
      await aborts(driver, source, prefix + truncated);
    }
  });
});

test('COPY terminators and Wikidata array closing brackets are required when framing was opened', async () => {
  await scenario(async (driver) => {
    await aborts(driver, 'vndb', `COPY public.vn (id, description, image) FROM stdin;\n${row('vndb')}\n`);
    await aborts(driver, 'wikidata', `[\n${row('wikidata')}\n`);
    for (const suffix of [',\n]\n', '\n]\n{}\n', '\n,\n,\n]\n']) {
      await aborts(driver, 'wikidata', `[\n${row('wikidata')}${suffix}`);
    }
    await aborts(driver, 'wikidata', `[\n${row('wikidata')}\n${row('wikidata', '42')}\n]\n`);
  });
});

test('identical and conflicting duplicate native keys remain visible unchanged for durable staging', async () => {
  await scenario(async (driver) => {
    for (const source of sources) {
      for (const second of [row(source), row(source, '41', 'Conflicting title')]) {
        const rows = [row(source), row(source, '42'), second];
        const expected = (await Promise.all(rows.map((text) => collect(driver, source, dump(source, [text]))))).flat();
        expect(await collect(driver, source, dump(source, rows))).toEqual(expected);
      }
    }
  });
});

test('missing identities and invalid explicit source revisions abort instead of being fabricated', async () => {
  await scenario(async (driver) => {
    await aborts(driver, 'bangumi', '{"type":2,"name":"No identity"}\n');
    await aborts(driver, 'vndb', dump('vndb', ['\\N\tNo identity\t\\N']));
    await aborts(
      driver,
      'openlibrary',
      dump('openlibrary', [row('openlibrary').replace('\t7\t', '\tnot-a-revision\t')]),
    );
    for (const lastrevid of [null, 0, -1, 0.5, 'not-a-revision']) {
      await aborts(driver, 'wikidata', JSON.stringify({ id: 'Q41', type: 'item', lastrevid }) + '\n');
    }
  });
});

test('COPY missing and duplicate header columns or row arity mismatches abort', async () => {
  await scenario(async (driver) => {
    for (const text of [
      'COPY public.vn (description, image) FROM stdin;\nNo identity\t\\N\n\\.\n',
      'COPY public.vn (id, id, description) FROM stdin;\nv1\tv2\tAmbiguous\n\\.\n',
      'COPY public.vn (id, description, image) FROM stdin;\nv1\tToo\tmany\tcells\n\\.\n',
    ])
      await aborts(driver, 'vndb', text);
  });
});

test('Open Library rejects wrong column counts broken JSON and envelope identity or revision disagreement', async () => {
  await scenario(async (driver) => {
    const valid = row('openlibrary');
    for (const text of [
      valid.split('\t').slice(1).join('\t'),
      `${valid}\textra`,
      valid.replace('"revision":7', '"revision":8'),
      valid.replace('"key":"/works/OL41W"', '"key":"/works/OL42W"'),
    ]) {
      await aborts(driver, 'openlibrary', `${text}\n`);
    }
  });
});

test('user account and post input never emerges as catalog records', async () => {
  await scenario(async (driver) => {
    for (const source of ['bangumi', 'wikidata'] as const) {
      await aborts(
        driver,
        source,
        '{"id":999,"type":"user","email":"PRIVATE_ACCOUNT_SENTINEL","body":"PRIVATE_USER_POST_SENTINEL"}\n',
      );
    }
    const personal = ['/type/user', '/type/post', '/type/account'].map(
      (type) =>
        `${type}\t/people/private\t1\t2024-01-02T03:04:05\t${JSON.stringify({
          key: '/people/private',
          type: { key: type },
          revision: 1,
          text: 'PRIVATE_USER_POST_SENTINEL',
          email: 'PRIVATE_ACCOUNT_SENTINEL',
        })}`,
    );
    expect(await collect(driver, 'openlibrary', dump('openlibrary', personal))).toEqual([]);
    // The full fixture assertion also requires recovery of vn rows after users.
    expect((await collect(driver, 'vndb', await fixture('vndb'))).map((r) => r.key)).toEqual(['v1', 'v2']);
  });
});

test('dump SQL and SQL looking cell text are inert and parsing makes no external writes', async () => {
  await scenario(async (driver) => {
    const sql = "DROP TABLE users; SELECT pg_sleep(60); COPY users TO PROGRAM 'false';";
    const actual = await collect(driver, 'vndb', `${sql}\n${dump('vndb', [row('vndb', '41', sql)])}`);
    expect(actual).toEqual([
      { source: 'vndb', key: 'v41', revision: null, payload: { id: 'v41', description: sql, image: null } },
    ]);
  });
});

test('invalid and incomplete UTF-8 abort every source instead of inserting replacement characters', async () => {
  await scenario(async (driver) => {
    for (const source of sources) {
      for (const tail of [
        [0xff, 0x0a],
        [0xf0, 0x9f],
      ]) {
        async function* invalid() {
          yield encoder.encode(
            source === 'vndb' ? 'COPY public.vn (id, description, image) FROM stdin;\nv41\t' : '{"text":"',
          );
          yield new Uint8Array(tail);
        }
        await expect(
          (async () => {
            for await (const _record of driver.read(source, invalid(), { maxRecordBytes: limit })) {
              /* drain to EOF */
            }
          })(),
        ).rejects.toBeInstanceOf(Error);
      }
    }
  });
});

test('record limits count encoded bytes and accept the exact boundary for every format', async () => {
  await scenario(async (driver) => {
    for (const source of sources) {
      const record = row(source);
      const size = encoder.encode(record).length;
      expect((await collect(driver, source, dump(source, [record]), size)).map((r) => r.key)).toEqual([
        nativeKey(source),
      ]);
      await aborts(driver, source, dump(source, [record]), size - 1);
      // A complete over-limit line in one chunk must not bypass the bound.
      await aborts(driver, source, dump(source, [record]), size - 1, limit);
    }
  });
});

test('oversized unterminated records fail before pulling an unbounded tail', async () => {
  await scenario(async (driver) => {
    for (const source of sources) {
      let exhaustedLimit = false;
      async function* oversized() {
        if (source === 'vndb') yield encoder.encode('COPY public.vn (id, description, image) FROM stdin;\n');
        yield encoder.encode(
          source === 'vndb'
            ? 'v41\t'
            : source === 'openlibrary'
              ? '/type/work\t/works/OL41W\t7\t2024-01-02T03:04:05\t{"title":"'
              : '{"name":"',
        );
        for (let i = 0; i < 6; i++) yield encoder.encode('x'.repeat(128));
        exhaustedLimit = true;
        throw new Error('Unbounded tail was pulled');
      }
      await expect(
        (async () => {
          for await (const _record of driver.read(source, oversized(), { maxRecordBytes: 256 })) {
            /* drain */
          }
        })(),
      ).rejects.toBeInstanceOf(Error);
      expect(exhaustedLimit).toBe(false);
    }
  });
});

test('async iterable readers yield before requesting the complete dump and cancellation closes input', async () => {
  await scenario(async (driver) => {
    for (const source of sources) {
      let closed = false;
      let requestedTail = false;
      async function* lazy() {
        try {
          const prefix = source === 'vndb' ? 'COPY public.vn (id, description, image) FROM stdin;\n' : '';
          yield encoder.encode(`${prefix}${row(source)}\n`);
          requestedTail = true;
          throw new Error('Complete dump must not be requested before the first record');
        } finally {
          closed = true;
        }
      }
      const iterator = driver.read(source, lazy(), { maxRecordBytes: limit })[Symbol.asyncIterator]();
      try {
        const first = await iterator.next();
        expect(first.done).toBe(false);
        expect(first.value.key).toBe(nativeKey(source));
        expect(requestedTail).toBe(false);
      } finally {
        await iterator.return?.();
      }
      expect(closed).toBe(true);
    }
  });
});

test('upstream failures propagate and fresh iterators independently yield the same native key', async () => {
  await scenario(async (driver) => {
    for (const source of sources) {
      const failure = new Error('Synthetic source transport failure');
      async function* broken() {
        yield encoder.encode(dump(source, [row(source)]));
        throw failure;
      }
      await expect(
        (async () => {
          for await (const _record of driver.read(source, broken(), { maxRecordBytes: limit })) {
            /* drain */
          }
        })(),
      ).rejects.toBe(failure);
      for (let attempt = 0; attempt < 2; attempt++) {
        expect((await collect(driver, source, dump(source, [row(source)]))).map((r) => r.key)).toEqual([
          nativeKey(source),
        ]);
      }
    }
  });
});
