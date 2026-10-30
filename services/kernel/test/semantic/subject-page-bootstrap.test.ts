import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createKernel } from '../../src/http/kernel.ts';
import type { Access } from '../../src/request/access.ts';
import { newId } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { itemFacts } from '../../src/semantic/item.ts';
import { createSubjectPagePublicationStore } from '../../src/semantic/subject-page-publication-store.ts';
import {
  createSubjectPagePublication,
  subjectPagePublicationFor,
} from '../../src/semantic/subject-page-publication.ts';
import { openGrowthDatabase } from '../support/growth.ts';
import { createRealAccess } from './real-access.ts';

test('bootstrap durably queues a newly discovered legacy subject before advancing its source checkpoint', async () => {
  const db = await openGrowthDatabase();
  try {
    await bootstrapRelease(db.pool, bundledRelease);
    const clock = () => new Date();
    const routeKey = new Uint8Array(32).fill(95);
    const real = await createRealAccess(db.admin, { editor: newId(0x195) }, ['subject:read']);
    let access!: Access;
    const app = createKernel({
      pool: db.pool,
      routeKey,
      clock,
      access(config) {
        return (access = real.access(config));
      },
    });
    await app.handle(new Request('http://kernel.test/health'));
    const subject = { route: 0, id: newId(0) };
    const transaction = randomUUID();
    const facts = itemFacts(
      subject.id,
      {
        labels: { en: 'Discovered without a feed read' },
        statements: {
          'schema:inLanguage': [{ property: { id: 'schema:inLanguage' }, value: { type: 'value', content: 'ja' } }],
        },
      },
      'schema:Book',
      bundledRelease,
    );
    await db.admin.query(
      `INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id,current_facts,current_release)
       VALUES (0,$1,'schema:Book',$2,$3,$4)`,
      [subject.id, transaction, facts.length, bundledDigest],
    );
    await db.admin.query(
      `INSERT INTO semantic.revision(route,subject_id,revision,kind,release,recorded_transaction_id)
       VALUES (0,$1,1,'create',$2,$3)`,
      [subject.id, bundledDigest, transaction],
    );
    for (const fact of facts) {
      const row = {
        ...fact,
        route: 0,
        subject_id: subject.id,
        recorded_transaction_id: transaction,
        release: fact.kind === 'statement' ? bundledDigest : null,
      };
      const keys = Object.keys(row);
      await db.admin.query(
        `INSERT INTO semantic.fact (${keys.join(',')}) VALUES (${keys.map((_, index) => `$${index + 1}`).join(',')})`,
        Object.entries(row).map(([key, value]) => (key === 'body' ? JSON.stringify(value) : value)),
      );
    }
    await db.admin.query(`INSERT INTO semantic.partition_subjects(partition_no,visible) VALUES (0,1)
      ON CONFLICT(partition_no) DO UPDATE SET visible=semantic.partition_subjects.visible+1`);
    const config = { pool: db.pool, access, clock, routeKey };
    const store = createSubjectPagePublicationStore(config);
    expect(await store.read(subject)).toBeNull();
    await subjectPagePublicationFor(app).step({ limit: 32 });
    expect(
      (
        await db.admin.query('SELECT state FROM semantic.subject_page_repair WHERE route=0 AND subject_id=$1', [
          subject.id,
        ])
      ).rows,
    ).toEqual([{ state: 'pending' }]);

    // Reconstruction must resume the committed handoff without a GET or explicit rebuild.
    const runner = createSubjectPagePublication(config);
    let done = false;
    for (let page = 0; page < 256 && !done; page++) done = (await runner.step({ limit: 32 })).done;
    expect(done).toBe(true);
    expect(await store.readCurrent(subject)).toEqual({
      id: subject.id,
      labels: [{ language: 'en', value: 'Discovered without a feed read' }],
      originalLanguage: 'ja',
    });
    expect(await runner.step({ limit: 32 })).toEqual({ processed: 0, next: null, done: true });
  } finally {
    await db.close();
  }
}, 120_000);
