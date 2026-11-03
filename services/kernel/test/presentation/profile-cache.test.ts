import { expect, test } from 'bun:test';
import { PROFILE_FORMAT, profileDigest, type PresentationProfile } from '@rezics/composition';
import '../../src/commerce/catalogue.ts';
import { createPool } from '../../src/database/pool.ts';
import { readProfile } from '../../src/presentation/profiles.ts';

test('reading later immutable profile history does not retain every earlier body forever', async () => {
  const pool = createPool(process.env.DATABASE_URL!);
  const records: { digest: string; profile: PresentationProfile }[] = [];
  try {
    for (let n = 0; n < 9; n++) {
      const profile: PresentationProfile = {
        format: PROFILE_FORMAT,
        generic: {
          root: { props: {} },
          content: [{ type: 'Heading', props: { id: 'h', text: `Cache ${crypto.randomUUID()} ${n}`, level: 2 } }],
        },
        bases: [],
        types: [],
        routes: [],
      };
      const digest = profileDigest(profile);
      await pool.query(
        'INSERT INTO presentation.profile(route,digest,body,recorded_transaction_id) VALUES(0,$1,$2,$3)',
        [digest, profile, crypto.randomUUID()],
      );
      records.push({ digest, profile });
    }
    const first = await readProfile(pool, records[0]!.digest);
    expect(Object.isFrozen(first)).toBe(true);
    for (const record of records.slice(1)) expect(await readProfile(pool, record.digest)).toEqual(record.profile);
    const reloaded = await readProfile(pool, records[0]!.digest);
    expect(reloaded).toEqual(records[0]!.profile);
    expect(reloaded).not.toBe(first);
    expect(Object.isFrozen(reloaded)).toBe(true);
  } finally {
    for (const record of records)
      await pool.query('DELETE FROM presentation.profile WHERE route=0 AND digest=$1', [record.digest]);
    await pool.end();
  }
});
