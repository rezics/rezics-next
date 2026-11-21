import type { Pool } from 'pg';
import { activeRelease } from '../semantic/definitions.ts';
import type { BookPagePublication } from './service-contract.ts';

type ReleaseHead = NonNullable<Awaited<ReturnType<typeof activeRelease>>>;
const openings = new WeakMap<object, { pool: Pool; deadline: number; release: ReleaseHead }>();

export function createBookPagePublication(pool: Pool, deadline: number) {
  const page: BookPagePublication = {};
  return {
    page,
    async readRelease() {
      // Inherit the page's profile snapshot. A separate current-head check follows Search execution.
      const release = await activeRelease(pool, 'native', deadline);
      if (release) openings.set(page, { pool, deadline, release: Object.freeze(release) });
      return release;
    },
  };
}

export function bookPageRelease(page: object | undefined, pool: Pool, deadline: number) {
  const opening = page && openings.get(page);
  return opening?.pool === pool && deadline <= opening.deadline && Date.now() < deadline ? opening.release : undefined;
}
