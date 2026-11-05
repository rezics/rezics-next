import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createStoryRecordedKernelFetch } from '../src/kernel/fake';
import {
  libraryProgressOriginalHistory,
  originalHistoryCursors,
  originalHistoryNextCursors,
  originalHistorySessionId,
  originalHistoryStaleCursors,
  setLibraryProgressStoryMode,
} from '../src/kernel/fake/library-progress-story';
import { profileSessionId } from '../src/kernel/fake/progress-profiles';
import { loadProgressSession, type ProgressSessionPage } from '../src/library/progress-reads';
import type { SessionEnv } from '../src/session/client';

const origin = 'https://progress-story.test';
const env: Partial<SessionEnv> = {
  SITE_ORIGINS: origin,
  AUTH_ISSUER: 'https://auth.progress-story.test',
  API_RESOURCE: 'https://kernel.progress-story.test',
  WEBSITE_SCOPES: 'openid',
  WEBSITE_CLIENT_ID: 'web',
  WEBSITE_CLIENT_KEY: 'unused',
  SESSIONS: {
    idFromName: (id: string) => id,
    get: () => ({
      credential: async () => ({ status: 'active', accessToken: 'story-viewer', subject: 'owner' }),
    }),
  } as unknown as SessionEnv['SESSIONS'],
};

async function read(
  mode: Parameters<typeof setLibraryProgressStoryMode>[0],
  id: string,
  address: { changes?: string; units?: string },
) {
  setLibraryProgressStoryMode(mode);
  const calls: Request[] = [];
  const replay = createStoryRecordedKernelFetch();
  const client = createKernelClient('https://kernel.progress-story.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      return replay(request);
    },
  });
  const request = new Request(`${origin}/en/library/progress/${id}`, {
    headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}`, origin },
  });
  const page = await loadProgressSession(client, request, env, { id, ...address });
  return { calls, page };
}

function signed(page: ProgressSessionPage): Extract<ProgressSessionPage, { signedIn: true }> {
  expect(page.signedIn).toBe(true);
  if (!page.signedIn) throw new Error('The story response must produce the signed-in session page');
  return page;
}

function cursorsFor(calls: Request[], child: 'changes' | 'completedUnits') {
  return calls
    .filter((call) => new URL(call.url).pathname.endsWith(`/${child}`))
    .map((call) => new URL(call.url).searchParams.get('cursor'));
}

test('Progress detail responses preserve original facts and recover changes and units independently', async () => {
  try {
    const original = signed((await read('detail-original', profileSessionId, {})).page);
    expect(original.session).toMatchObject({
      id: profileSessionId,
      state: 'completed',
      completedAt: '2026-10-30T00:00:00.000Z',
      unit: libraryProgressOriginalHistory.unit,
      locator: libraryProgressOriginalHistory.locator,
      position: '0.000000',
      meaning: 'unknown',
      recordingState: 'unavailable',
    });
    expect(original.session.changes.map(({ locator, position, action }) => [locator, position, action])).toEqual([
      [libraryProgressOriginalHistory.locator, '0.000000', null],
      [libraryProgressOriginalHistory.locator, '0.000000', null],
      [null, null, 'complete'],
    ]);

    const later = signed(
      (
        await read('original-history', originalHistorySessionId, {
          changes: originalHistoryCursors.changes,
          units: originalHistoryCursors.units,
        })
      ).page,
    );
    expect([later.session.id, later.changesCursor, later.unitsCursor, later.session.changes.length]).toEqual([
      originalHistorySessionId,
      originalHistoryCursors.changes,
      originalHistoryCursors.units,
      0,
    ]);
    expect([later.session.changesNext, later.session.unitsNext]).toEqual([
      originalHistoryNextCursors.changes,
      originalHistoryNextCursors.units,
    ]);

    const changesRecovery = await read('original-history', originalHistorySessionId, {
      changes: originalHistoryStaleCursors.changes,
      units: originalHistoryCursors.units,
    });
    const recoveredChanges = signed(changesRecovery.page);
    expect([recoveredChanges.changesCursor, recoveredChanges.unitsCursor]).toEqual([
      undefined,
      originalHistoryCursors.units,
    ]);
    expect(cursorsFor(changesRecovery.calls, 'changes')).toEqual([originalHistoryStaleCursors.changes, null]);
    expect(cursorsFor(changesRecovery.calls, 'completedUnits')).toEqual([originalHistoryCursors.units]);

    const unitsRecovery = await read('original-history', originalHistorySessionId, {
      changes: originalHistoryCursors.changes,
      units: originalHistoryStaleCursors.units,
    });
    const recoveredUnits = signed(unitsRecovery.page);
    expect([recoveredUnits.changesCursor, recoveredUnits.unitsCursor]).toEqual([
      originalHistoryCursors.changes,
      undefined,
    ]);
    expect(cursorsFor(unitsRecovery.calls, 'changes')).toEqual([originalHistoryCursors.changes]);
    expect(cursorsFor(unitsRecovery.calls, 'completedUnits')).toEqual([originalHistoryStaleCursors.units, null]);
  } finally {
    setLibraryProgressStoryMode('recorded');
  }
});
