import { expect, test } from 'bun:test';
import type { AnswerPersona } from '../../../../scripts/api/answer-record.ts';
import { browserMainApi, BFF_PREFIX } from '../api/browser.ts';
import { seedServedTypes } from '../catalogue/type-fixtures.ts';
import { BrowseReadError, discoveryApi } from '../discover/api.ts';
import { browseHref, parseBrowseState } from '../discover/browse-state.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import { closedDirectoryIdentity, directoryStoryInputs, privateCreationIdentities } from './directory-story-inputs.ts';

seedServedTypes();
const personas: AnswerPersona[] = ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'];

for (const persona of personas) {
  test(`${persona}: production directory reader preserves live rows, exact/lower-bound counts and continuation`, async () => {
    for (const mode of ['populated', 'continuation', 'filtered', 'empty'] as const) {
      const input = directoryStoryInputs(persona, mode);
      const transport = recordedFetch(input.record, persona, [{ label: 'directory', state: mode === 'empty' ? 'empty' : 'populated' }], { pathPrefix: BFF_PREFIX });
      try {
        const page = await discoveryApi(browserMainApi('https://recorded.invalid', {
          anonymous: persona === 'visitor', fetcher: transport.fetcher,
        }), 'en').resources(input.body);
        expect(page).toEqual(input.page);
        expect(page.items.map(item => item.id)).not.toContain(closedDirectoryIdentity);
        for (const privateRealm of privateCreationIdentities) expect(page.items.map(item => item.id)).not.toContain(privateRealm);
        if (page.nextCursor) {
          const successor = new URL(browseHref({ ...input.state, cursor: page.nextCursor }), 'https://recorded.invalid');
          const parsed = parseBrowseState(Object.fromEntries(successor.searchParams));
          expect(parsed?.cursor).toBe(page.nextCursor);
          expect(parsed?.tab).toBe('communities');
          expect(parsed?.conditions).toEqual(input.state.conditions);
          expect(parsed?.q).toBe(input.state.q);
        }
      } finally { transport.dispose(); }
    }
  });
}

test('The directory reader keeps an unavailable response distinct from a changed read basis', async () => {
  for (const mode of ['error', 'moved'] as const) {
    const input = directoryStoryInputs('visitor', mode);
    const transport = recordedFetch(input.record, 'visitor', [{ label: 'directory', state: 'error' }], { pathPrefix: BFF_PREFIX });
    try {
      await expect(discoveryApi(browserMainApi('https://recorded.invalid', { fetcher: transport.fetcher }), 'en').resources(input.body))
        .rejects.toEqual(new BrowseReadError(input.sample.status, mode === 'moved' ? 'read_basis_changed' : 'read_unavailable', input.sample.answer));
    } finally { transport.dispose(); }
  }
});

test('An empty bounded page with a continuation remains incomplete', async () => {
  const input = directoryStoryInputs('visitor');
  input.page.items = [];
  input.page.count = { kind: 'at-least', value: 0 };
  const transport = recordedFetch(input.record, 'visitor', [{ label: 'directory', state: 'empty' }], { pathPrefix: BFF_PREFIX });
  try {
    const page = await discoveryApi(browserMainApi('https://recorded.invalid', { fetcher: transport.fetcher }), 'en').resources(input.body);
    expect(page.complete).toBe(false);
    expect(page.nextCursor).toBe('directory-next-page');
    expect(page.count).toEqual({ kind: 'at-least', value: 0 });
  } finally { transport.dispose(); }
});
