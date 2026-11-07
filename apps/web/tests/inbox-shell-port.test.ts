import { expect, test } from 'bun:test';
import { createInboxShellPort } from '../src/inbox';
import { unreadCountQuery } from '../src/inbox/inbox-query';
import { personalRead, readQueryKey, SESSION_QUERY_KEY } from '../src/settings/ports/vocabulary';
import { sessionQuery, useSession } from '../src/session';

test('Inbox observes the installed session query and keeps the unread-count prefix', () => {
  const port = createInboxShellPort();
  expect(port.sessionQueryKey).toEqual(SESSION_QUERY_KEY);
  expect(port.sessionQueryKey).toEqual(sessionQuery.queryKey);
  expect(port.useSession).toBe(useSession);
  expect(port.personalRead).toEqual(personalRead);
  expect(port.readQueryKey(['notifications', 'inbox'], 'session')).toEqual(
    readQueryKey(['notifications', 'inbox'], 'session'),
  );
  expect(unreadCountQuery.queryKey).toEqual(['notifications', 'count', 'session']);
});
