import { partitionOf, routeOf } from '../route/route.ts';
import type { ProgressActivity, ShelfHeads, ShelfWrite } from './shelf-contract.ts';
import ensureHead from './shelf-head-ensure.sql';
import touchHead from './shelf-head-touch.sql';
import raiseEntry from './shelf-entry-raise.sql';

function parameters(write: ShelfWrite, subjectId: string) {
  partitionOf(write.route);
  const accountRoute = routeOf(write.accountId);
  if (accountRoute === null) throw new TypeError('Account id must carry a valid route');
  if (accountRoute !== write.route) throw new RangeError('Account id routes to a different route');
  if (routeOf(subjectId) === null) throw new TypeError('Subject id must carry a valid route');
  return { route: write.route, account_id: write.accountId, subject_id: subjectId };
}

/** The caller supplies the authorized, fenced owner transaction and retains the head lock until it ends. */
export function createShelfHeads(): ShelfHeads {
  return {
    async ensure(write, subjectId) {
      const input = parameters(write, subjectId);
      return ensureHead.run({ query: write.client.query.bind(write.client) }, input);
    },
  };
}

/** Called only after a successful session write, on that command's exact transaction client. */
export function createProgressActivity(): ProgressActivity {
  return {
    async touch(write, touch) {
      const input = { ...parameters(write, touch.subjectId), time: touch.time, completed: touch.completed };
      const client = { query: write.client.query.bind(write.client) };
      await touchHead.run(client, input);
      // READ COMMITTED needs a fresh statement snapshot after waiting for an entry writer's head lock.
      await raiseEntry.run(client, input);
    },
  };
}
