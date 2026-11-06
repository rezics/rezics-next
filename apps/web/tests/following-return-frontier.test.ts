import { expect, test } from 'bun:test';
import {
  FOLLOWING_RETURN_STATE,
  captureFollowingReturn,
  clearFollowingReturn,
  followingDestinationClick,
  followingListHref,
  followingReturnFrontier,
  followingReturnFrontierFromState,
  followingReturnLocationState,
  followingReturnMatchesWindow,
  followingReturnTrigger,
  readFollowingReturn,
} from '../src/library/following-reading/return-context';

const locale = 'en';
const subject = 'owner-session';
const targetId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const cursor = 'opaque/page+';

test('Following return keeps the private list frontier on this history entry and restores the original row', () => {
  const frontier = followingReturnFrontier(locale, subject, cursor, 'subject', targetId);
  expect(frontier).toEqual({ locale, subject, cursor, kind: 'subject', targetId });
  expect(followingListHref(locale, cursor, 'subject')).toBe(
    '/en/library/following?cursor=opaque%2Fpage%2B&kind=subject',
  );
  expect(followingReturnFrontierFromState(followingReturnLocationState(frontier!), 'zh', subject)).toBeNull();
  expect(
    followingReturnFrontierFromState({ [FOLLOWING_RETURN_STATE]: { ...frontier, targetId: 'not-a-uuid' } }, locale, subject),
  ).toBeNull();
  expect(followingReturnMatchesWindow(frontier!, cursor, 'subject')).toBe(true);
  expect(followingReturnMatchesWindow(frontier!, null, 'subject')).toBe(false);

  const href = followingListHref(locale, cursor, 'subject')!;
  let state: unknown = { kept: true };
  const location = { href: `https://site.test${href}` };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location,
      history: {
        get state() {
          return state;
        },
        replaceState(next: unknown, _title: string, url: string) {
          state = next;
          location.href = new URL(url, location.href).href;
        },
      },
    },
  });
  try {
    expect(captureFollowingReturn(frontier!)).toEqual(frontier);
    expect(state).toMatchObject({ kept: true, ...followingReturnLocationState(frontier!) });
    expect(readFollowingReturn(locale, subject)).toEqual(frontier);
    clearFollowingReturn();
    expect(readFollowingReturn(locale, subject)).toBeNull();
    expect(state).toMatchObject({ kept: true });
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }

  let prevented = false;
  const event = {
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault() {
      prevented = true;
    },
  };
  expect(followingDestinationClick(event, () => false, frontier)).toBe(false);
  expect(prevented).toBe(true);
  prevented = false;
  expect(followingDestinationClick({ ...event, metaKey: true }, () => true, frontier)).toBe(false);
  expect(prevented).toBe(false);

  const inspect = {} as HTMLButtonElement;
  const row = { querySelector: (selector: string) => (selector.startsWith('button') ? inspect : null) };
  const root = {
    querySelector: (selector: string) => (selector === `[data-follow-target="${targetId}"]` ? row : null),
  };
  expect(followingReturnTrigger(root as never, targetId)).toBe(inspect);
  expect(followingReturnTrigger(root as never, '0192f3a0-6c1e-7b2a-9d4e-000000000099')).toBeNull();
});
