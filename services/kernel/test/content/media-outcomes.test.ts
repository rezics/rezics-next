process.env.CONTENT_MEDIA_DRIVER = new URL('./media-driver.ts', import.meta.url).href;

await import('../../../../specs/content-media-outcomes.test.ts');

const { beforeEach, test, expect } = await import('bun:test');
const { checkGrowth, openGrowthDatabase } = await import('../support/growth.ts');
const { currentMediaScenario } = await import('./media-driver.ts');
const { mediaGrowthFixture } = await import('./support/media-fixtures.ts');

beforeEach(async () => {
  const { system } = currentMediaScenario();
  const context = { pool: system.database.pool, deadline: Date.now() + 20_000 };
  for (const actor of [
    system.actors.author,
    system.actors.other,
    system.actors.moderator,
    system.actors.worker,
    system.actors.otherWorker,
  ])
    await system.access.authenticate(actor.bearer, context);
});

test.serial('media requests and jobs obey the three-scale bound with native PostgreSQL plans', async () => {
  const { system, anchors } = currentMediaScenario();
  const db = await openGrowthDatabase(system.database.pool.options.connectionString);
  try {
    const fixture = await mediaGrowthFixture(system, db, anchors);
    try {
      const spare = await mediaGrowthFixture(system, db, {
        containers: {
          thread: anchors.containers.remote,
          sibling: anchors.containers.thread,
          remote: anchors.containers.sibling,
        },
        posts: anchors.posts,
      });
      try {
        const staged = new Map<number, string>();
        const report = await checkGrowth(db, {
          name: 'Media HTTP and trusted jobs with fixed bytes, references, lineage and changed set',
          scales: [32, 256, 2048],
          bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
          repetitions: 1,
          grow: async (database, scale, previous) => {
            await fixture.grow(database, scale, previous);
            const result = await database.admin.query<{ media_id: string }>(
              `SELECT media_id::text
               FROM content.media
               WHERE route=$1 AND reservation_request_id=$2`,
              [anchors.containers.remote.route, `growth-collection-${scale}`],
            );
            const mediaId = result.rows[0]?.media_id;
            if (!mediaId) throw new Error('Growth collection probe was not staged');
            staged.set(scale, mediaId);
            await database.admin.query(
              "UPDATE content.media SET created_at='2030-01-02T00:00:00.000Z' WHERE route=$1 AND media_id=$2",
              [anchors.containers.remote.route, mediaId],
            );
            await spare.grow(database, scale, scale);
          },
          warmup: async (database, scale, repetition) => {
            await spare.operation(database, scale, repetition);
            const mediaId = staged.get(scale);
            if (!mediaId) throw new Error('Growth collection probe was not retained');
            await database.admin.query(
              "UPDATE content.media SET created_at='2030-01-01T00:00:00.000Z' WHERE route=$1 AND media_id=$2",
              [anchors.containers.remote.route, mediaId],
            );
          },
          operation: fixture.operation,
        });
        expect(report.samples.map((sample) => sample.scale)).toEqual([32, 256, 2048]);
        for (const { cost } of report.samples) {
          expect(cost.rows).toBeGreaterThan(0);
          expect(cost.blocks).toBeGreaterThan(0);
          expect(cost.statements).toBeGreaterThan(0);
        }
        fixture.varyChangedSet();
        spare.varyChangedSet();
        const changed = await checkGrowth(db, {
          name: 'Media collection intentional changed rows and source bytes with fixed unrelated population',
          scales: [1, 4, 16],
          bounds: { rows: 'linear', statements: 'linear', blocks: 'linear' },
          repetitions: 1,
          grow: async (database, scale, previous) => {
            await spare.grow(database, scale, previous);
            await fixture.grow(database, scale, previous);
          },
          warmup: spare.collectChanged,
          operation: fixture.collectChanged,
        });
        await Bun.write(
          new URL('../../../../.temp/media-growth-report.json', import.meta.url),
          JSON.stringify({ unrelated: report, changed }),
        );
        console.info('Media GrowthReport', JSON.stringify(report));
        console.info('Media changed-set GrowthReport', JSON.stringify(changed));
      } finally {
        await spare.close();
      }
    } finally {
      await fixture.close();
    }
  } finally {
    await db.close();
  }
});
