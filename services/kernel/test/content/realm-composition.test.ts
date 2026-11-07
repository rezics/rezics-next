import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import type { Access } from '../../src/request/access.ts';
import { AccessWorkAccounting } from '../../src/access/work.ts';
import { composeContentApplication } from '../../src/composition/content.ts';
import { contentRealmApplication, unbindContentApplication } from '../../src/content/adapters/index.ts';
import { tryContentApplication, bindContentApplication } from '../../src/content/adapters/bind.ts';
import { prepareRealmSubjectDisclosure } from '../../src/content/realm-subject-disclosure.ts';

test('default composition installs native producers and refuses missing authority before pool IO', async () => {
  const previous = tryContentApplication();
  let checkouts = 0;
  const pool = {
    connect() {
      checkouts++;
      throw new Error('Unexpected pool checkout');
    },
  } as unknown as Pool;
  const deadline = Date.now() + 30_000;
  try {
    composeContentApplication();
    expect(contentRealmApplication().community.observe).toBeFunction();
    const prepared = await prepareRealmSubjectDisclosure(
      { pool, access: {} as Access },
      {
        realmId: '00000000-0000-4000-8000-000000000001',
        candidates: [
          {
            threadId: '00000000-0000-4000-8000-000000000002',
            openingPostId: '00000000-0000-4000-8000-000000000003',
            subjectId: '00000000-0000-4000-8000-000000000004',
          },
        ],
      },
      {
        actor: { kind: 'anonymous' },
        deadline,
        work: new AccessWorkAccounting({ reserve: () => ({ settle() {} }) }, deadline),
      },
    );
    expect(await prepared.finish()).toEqual([{ state: 'unknown' }]);
    expect(checkouts).toBe(0);
  } finally {
    unbindContentApplication();
    if (previous) {
      bindContentApplication(previous);
      composeContentApplication();
    }
  }
});
