import type { FakeRoute } from '../fake-modules';
import { storyViewerId } from './identities';
import recording from '../recorded/library-published-log.json';

let enabled = false;
let deleted = false;
let refuseRestore = false;
let revision = 1;
const deletionId = '0192f3a0-6c1e-7b2a-9d4e-000000000050';
const log = { ...recording.publishedLog, accountId: storyViewerId };

/** Opt-in response scenarios for the real published-log presenter, not native lifecycle evidence. */
export function setHoldingsLogStory(value: boolean, refuse = false) {
  enabled = value;
  refuseRestore = refuse;
  deleted = false;
  revision = 1;
}

export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: `/v1/publishedLogs/${log.id}`,
    story: () =>
      !enabled
        ? undefined
        : deleted
          ? { status: 200, publishedLog: { id: log.id, deleted: true } }
          : { status: 200, publishedLog: log, headers: { 'Library-Published-Log-Revision': String(revision) } },
  },
  {
    method: 'DELETE',
    path: `/v1/publishedLogs/${log.id}`,
    story: ({ request }) => {
      if (!enabled) return undefined;
      if (deleted || Number(new URL(request.url).searchParams.get('revision')) !== revision)
        return { status: 409, code: 'conflict' };
      deleted = true;
      revision += 1;
      return {
        status: 200,
        publishedLog: log,
        headers: {
          'Library-Published-Log-Deletion-Id': deletionId,
          'Library-Published-Log-Deletion-Revision': String(revision),
        },
      };
    },
  },
  {
    method: 'POST',
    path: `/v1/publishedLogs/${log.id}:restore`,
    story: async ({ request }) => {
      if (!enabled) return undefined;
      if (refuseRestore) return { status: 409, code: 'published_log_restore_expired' };
      const body = await request.json();
      if (
        !deleted ||
        !body ||
        typeof body !== 'object' ||
        !('deletionId' in body) ||
        !('revision' in body) ||
        body.deletionId !== deletionId ||
        body.revision !== revision
      )
        return { status: 409, code: 'published_log_restore_stale' };
      deleted = false;
      revision += 1;
      return { status: 200, publishedLog: log, headers: { 'Library-Published-Log-Revision': String(revision) } };
    },
  },
];
