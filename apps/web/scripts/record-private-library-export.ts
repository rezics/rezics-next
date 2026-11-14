import { Pool } from 'pg';
import { resolve } from 'node:path';
import { placeWebCheck } from './check-placement.ts';

// Record the installed HTTP producer, including its signed cursors, without normalizing private record bytes.
// Every database, account and token below belongs to this disposable recording session.
const root = resolve(import.meta.dir, '../../..');
const kernel = `${root}/services/kernel`;

function docker(args: string[]) {
  const result = Bun.spawnSync(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim());
  return result.stdout.toString().trim();
}

async function recordExport(): Promise<number> {
  const { startPostgresContainer } = await import(`${kernel}/scripts/check.ts`);
  const { migrate } = await import(`${kernel}/scripts/database.ts`);
  const { bundledRelease } = await import('@rezics/definitions/bundled');
  const { parseVndb } = await import(`${kernel}/src/library/list-import-vndb-parser.ts`);
  const { parseAniList } = await import(`${kernel}/src/library/list-import-anilist-parser.ts`);
  const { newId } = await import(`${kernel}/src/route/route.ts`);

  const container = startPostgresContainer();
  let pool: Pool | undefined;
  let admin: Pool | undefined;
  let work: { close(): Promise<void> } | undefined;
  try {
    const port = docker(['port', container, '5432/tcp']).match(/127\.0\.0\.1:(\d+)/)?.[1];
    if (!port) throw new Error('The recording database has no published port');
    const url = `postgres://rezics:rezics@127.0.0.1:${port}/rezics?sslmode=disable`;
    migrate(url);
    process.env.DATABASE_URL = url;
    await import(`${kernel}/node_modules/reylo/src/register.js`);
    const { installNativeHistoryPreload } = await import(`${kernel}/src/composition/preload.ts`);
    installNativeHistoryPreload();
    const { createKernel } = await import(`${kernel}/src/http/kernel.ts`);
    const { createPool } = await import(`${kernel}/src/database/pool.ts`);
    const { createWorkClient } = await import(`${kernel}/src/work/client.ts`);
    const { bootstrapRelease } = await import(`${kernel}/src/semantic/definitions.ts`);
    const { createRealAccess } = await import(`${kernel}/test/semantic/real-access.ts`);
    const { testReceiptKeys } = await import(`${kernel}/test/support/receipt-keys.ts`);
    pool = createPool(url);
    admin = new Pool({ connectionString: url });
    await bootstrapRelease(pool, bundledRelease);
    const route = 0x2200;
    const owner = newId(route),
      subject = newId(route),
      upload = newId(route);
    const scopes = [
      'library_entry:list',
      'library_entry:read',
      'copy:list',
      'progress_session:list',
      'progress_session:read',
      'collection:read',
    ];
    const fixture = await createRealAccess(admin, { owner }, scopes);
    const clock = new Date();
    work = await createWorkClient(url);
    const app = createKernel({
      pool,
      workClient: work,
      receiptKeys: testReceiptKeys(),
      routeKey: new Uint8Array(32).fill(93),
      tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(29)]]) },
      access: fixture.access,
      writeRate: fixture.writeRate,
      ratePeer: () => '127.0.0.1',
      clock: () => clock,
    });
    const sql = (text: string, values: unknown[]) => admin!.query(text, values);
    await sql(
      `INSERT INTO access.exposure_opening("group",valid,transaction_id)
    SELECT g,tstzrange('2020-01-01',NULL,'[)'),$1 FROM unnest($2::text[]) g`,
      [owner, ['personal_library', 'reading_progress', 'collections']],
    );
    await sql(
      `INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id) VALUES($1,$2,'schema:Book',$3)`,
      [route, subject, owner],
    );
    for (const units of [null, 0]) {
      await sql(
        `INSERT INTO library.progress_session(route,account_id,session_id,subject_id,mode,unit,
      completed_unit_count,state,revision,started_at,transaction_id,journal_revision,journal_start_year,
      journal_reflection,journal_assessment_meaning_revision,journal_assessment_units)
      VALUES($1,$2,$3,$4,'completed_units','chapter',0,'active',1,$5,$2,1,2004,'',1,$6)`,
        [route, owner, newId(route), subject, clock.toISOString(), units],
      );
    }
    await sql(
      `INSERT INTO library.hosted_reading(route,account_id,subject_id,catalogue_id,publication_revision_id,
      occurrence_id,target_post_id,target_revision_id,target_sha256,document_block_id,document_offset,revision,changed_at,body_language)
      VALUES($1,$2,$3,$4,$5,$6,'0192f3a0-6c1e-7b2a-9d4e-220000000001',$7,$8,'chapter-text',12,1,$9,'zh-Hans')`,
      [
        route,
        owner,
        subject,
        newId(route),
        newId(route),
        newId(route),
        newId(route),
        Buffer.alloc(32, 7),
        clock.toISOString(),
      ],
    );
    const vndb = parseVndb(
      '<vndb-export version="1.0"><vns><vn id="v1"><vote>0</vote><started>2004-02-00</started><label>Unfamiliar</label></vn></vns></vndb-export>',
    );
    const anilist = parseAniList(
      JSON.stringify([
        { mediaId: 1, score: 0, notes: null, status: 'FUTURE_STATUS', startedAt: { year: 2004, month: null, day: 0 } },
      ]),
      'POINT_10_DECIMAL',
    );
    await sql(
      `INSERT INTO library.vndb_import(route,account_id,upload_id,expires_at,xml,rows,state)
    VALUES($1,$2,$3,$4,'recording only',$5,'cancelled')`,
      [route, owner, upload, new Date(+clock + 86400000).toISOString(), JSON.stringify(vndb)],
    );
    await sql(
      `INSERT INTO library.list_import_anilist(route,account_id,import_id,ordinal,payload)
    VALUES($1,$2,$3,-1,$4)`,
      [
        route,
        owner,
        upload,
        JSON.stringify({ scoreFormat: anilist.scoreFormat, cancelled: true, count: anilist.rows.length }),
      ],
    );
    for (const [ordinal, source] of anilist.rows.entries())
      await sql(
        `INSERT INTO library.list_import_anilist(route,account_id,import_id,ordinal,payload)
      VALUES($1,$2,$3,$4,$5)`,
        [route, owner, upload, ordinal, JSON.stringify({ source })],
      );

    async function request(method: string, path: string) {
      const response = await app.handle(
        new Request(`http://kernel.test/v1/${path}`, {
          method,
          headers: {
            authorization: `Bearer ${fixture.bearer('owner')}`,
            'idempotency-key': JSON.stringify(crypto.randomUUID()),
          },
        }),
      );
      if (response.status !== 200) throw new Error(`${response.status}: ${await response.text()}`);
      return response.json();
    }
    const created = await request('POST', 'libraryExports');
    const status = await request('GET', `libraryExports/${created.exportId}`);
    const pages = [];
    let cursor = status.first;
    while (cursor) {
      const page = await request('GET', `libraryExports/${status.exportId}/pages?cursor=${encodeURIComponent(cursor)}`);
      pages.push(page);
      cursor = page.next;
    }
    const capture = {
      status,
      pages,
      artifact: JSON.stringify({ manifest: pages.at(-1).manifest, records: pages.flatMap((page) => page.records) }),
    };
    await request('DELETE', `libraryExports/${status.exportId}`);
    const output = resolve(root, 'apps/web/src/library/private-export/recorded.json');
    await Bun.write(output, JSON.stringify(capture));
    const formatted = Bun.spawnSync([resolve(root, 'node_modules/.bin/oxfmt'), '--write', output], { cwd: root });
    if (formatted.exitCode !== 0) throw new Error('Formatting generated private Library export recording failed');
  } finally {
    await work?.close();
    await pool?.end();
    await admin?.end();
    docker(['rm', '-f', '-v', container]);
  }

  return 0;
}

if (import.meta.main) {
  process.exitCode = await placeWebCheck(
    {
      label: 'web private Library export record',
      root,
      cwd: root,
      command: ['bun', 'apps/web/scripts/record-private-library-export.ts'],
      returns: ['apps/web/src/library/private-export/recorded.json'],
    },
    () => recordExport(),
  );
}
