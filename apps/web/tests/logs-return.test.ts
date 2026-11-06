import { expect, test } from 'bun:test';
import {
  LOGS_RETURN_STATE,
  bindLogsReturnVisit,
  captureLogsReturn,
  clearLogsReturn,
  logsDestinationClick,
  logsListHref,
  logsReturnBackClick,
  logsReturnBackHref,
  logsReturnFrontier,
  logsReturnFrontierFromState,
  logsReturnLocationState,
  logsReturnMatchesWindow,
  logsReturnTrigger,
  logsReturnVisitFromState,
  readLogsReturn,
} from '../src/library/logs-return';

const locale = 'en';
const subject = 'owner-session';
const logId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const cursor = 'opaque/page+';

test('My Logs return keeps the private list frontier on this history entry and restores the original row', () => {
  const frontier = logsReturnFrontier(locale, subject, cursor, logId);
  expect(frontier).toEqual({ locale, subject, cursor, logId });
  expect(logsListHref(locale, cursor)).toBe('/en/library/logs?cursor=opaque%2Fpage%2B');
  expect(logsReturnFrontierFromState(logsReturnLocationState(frontier!), 'zh', subject)).toBeNull();
  expect(
    logsReturnFrontierFromState({ [LOGS_RETURN_STATE]: { ...frontier, logId: 'not-a-uuid' } }, locale, subject),
  ).toBeNull();
  expect(logsReturnMatchesWindow(frontier!, cursor)).toBe(true);
  expect(logsReturnMatchesWindow(frontier!, null)).toBe(false);
  expect(logsReturnFrontier(locale, subject, cursor, logId)?.logId).toBe(logId);
  expect(logsListHref(locale, null)).toBe('/en/library/logs');

  const href = logsListHref(locale, cursor)!;
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
    expect(captureLogsReturn(frontier!)).toEqual(frontier);
    expect(state).toMatchObject({ kept: true, ...logsReturnLocationState(frontier!) });
    expect(readLogsReturn(locale, subject)).toEqual(frontier);
    clearLogsReturn();
    expect(readLogsReturn(locale, subject)).toBeNull();
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
  expect(logsDestinationClick(event, () => false, frontier)).toBe(false);
  expect(prevented).toBe(true);
  prevented = false;
  expect(logsDestinationClick({ ...event, metaKey: true }, () => true, frontier)).toBe(false);
  expect(prevented).toBe(false);

  const open = {} as HTMLAnchorElement;
  const root = {
    querySelector: (selector: string) => (selector === `a[data-published-log="${logId}"]` ? open : null),
  };
  expect(logsReturnTrigger(root as never, logId)).toBe(open);
  expect(logsReturnTrigger(root as never, '0192f3a0-6c1e-7b2a-9d4e-000000000099')).toBeNull();
});

test('public log Back uses history only for this captured My Logs visit, log and current session', () => {
  const frontier = logsReturnFrontier(locale, subject, cursor, logId)!;
  const otherLog = '0192f3a0-6c1e-7b2a-9d4e-000000000099';
  expect(logsReturnBackHref(locale)).toBe('/en/library/logs');
  expect(logsReturnBackHref(locale)).not.toContain('cursor');
  expect(logsListHref(locale, cursor)).toContain('cursor=');
  expect(logsReturnVisitFromState(logsReturnLocationState(frontier), locale, subject, logId)).toEqual(frontier);
  expect(logsReturnVisitFromState(logsReturnLocationState(frontier), locale, subject, otherLog)).toBeNull();
  expect(logsReturnVisitFromState(logsReturnLocationState(frontier), locale, 'other-session', logId)).toBeNull();
  expect(logsReturnVisitFromState({}, locale, subject, logId)).toBeNull();

  let prevented = false;
  let backed = 0;
  let state: unknown = {};
  const location = { href: `https://site.test${logsListHref(locale, cursor)}` };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location,
      history: {
        length: 8,
        get state() {
          return state;
        },
        replaceState(next: unknown, _title: string, url: string) {
          state = next;
          location.href = new URL(url, location.href).href;
        },
        back() {
          backed += 1;
        },
      },
    },
  });
  try {
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
    bindLogsReturnVisit(locale, subject, logId);
    state = {};
    expect(logsReturnBackClick(event, logId, locale, subject)).toBe(true);
    expect(prevented).toBe(false);
    expect(backed).toBe(0);

    state = logsReturnLocationState(frontier);
    expect(logsReturnBackClick(event, logId, locale, subject)).toBe(false);
    expect(prevented).toBe(true);
    expect(backed).toBe(1);

    prevented = false;
    expect(logsReturnBackClick(event, logId, locale, 'replaced-session')).toBe(true);
    expect(prevented).toBe(false);
    expect(backed).toBe(1);
    expect(logsReturnBackClick(event, logId, locale, null)).toBe(true);
    expect(logsReturnBackClick(event, otherLog, locale, subject)).toBe(true);
    expect(logsReturnBackClick({ ...event, metaKey: true }, logId, locale, subject)).toBe(false);
    expect(prevented).toBe(false);
    expect(backed).toBe(1);

    bindLogsReturnVisit(locale, subject, logId);
    state = { kept: true };
    expect(logsDestinationClick(event, () => true, frontier)).toBe(true);
    state = { public: true };
    location.href = `https://site.test/${locale}/logs/${logId}`;
    expect(bindLogsReturnVisit(locale, subject, logId)).toEqual(frontier);
    expect(state).toMatchObject({ public: true, ...logsReturnLocationState(frontier) });
    expect(bindLogsReturnVisit(locale, subject, otherLog)).toBeNull();
    prevented = false;
    expect(logsReturnBackClick(event, logId, locale, subject)).toBe(false);
    expect(prevented).toBe(true);
    expect(backed).toBe(2);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
