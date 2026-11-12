import { expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { fromPlainText } from '@rezics/document';
import { browserObservation } from '../src/reader/lifetime/index';
import { viewerExposureQuery } from '../src/kernel/viewer-exposure';
import { OwnDraftsPage } from '../src/threads/own-drafts/page';
import type {
  OwnDraftCommands,
  OwnDraftLocalWritingReader,
  OwnDraftPageData,
  OwnDraftReader,
  OwnDraftWriteInput,
} from '../src/threads/own-drafts/model';
import type { OwnDraftCommandTransport, OwnDraftVisit } from '../src/threads/own-drafts/visit';
import { useOwnDraftVisit } from '../src/threads/own-drafts/visit';
import { accountId, mountOwnDrafts, row, selected } from './own-drafts-fixture';

const localWritingReader: OwnDraftLocalWritingReader = { load: async () => null };
const entry = row();
const page: OwnDraftPageData = {
  state: 'ready',
  viewer: { accountId, authnEpoch: 2 },
  drafts: [entry],
  next: null,
};
const writeInput: OwnDraftWriteInput = {
  action: 'save',
  postId: entry.id,
  threadId: entry.threadId,
  body: selected(entry).post.body,
  revisionId: entry.revisionId,
  idempotencyKey: '0192f3a0-6c1e-7b2a-9d4e-000000000020',
  mediaIds: [],
};

function harness(collect: { visit?: OwnDraftVisit }) {
  return function DraftsHarness({
    reader,
    transport,
    local = localWritingReader,
  }: {
    reader: OwnDraftReader;
    transport: OwnDraftCommandTransport;
    local?: OwnDraftLocalWritingReader;
  }) {
    const visit = useOwnDraftVisit(reader, local, transport);
    collect.visit = visit;
    return (
      <OwnDraftsPage
        identity={visit.identity}
        active={visit.active}
        visitCurrent={visit.current}
        reader={visit.reader}
        localWritingReader={visit.localWritingReader}
        {...(visit.commands ? { commands: visit.commands } : {})}
      />
    );
  };
}

function emptyPage(viewer: string, authnEpoch: number): OwnDraftPageData {
  return { state: 'ready', viewer: { accountId: viewer, authnEpoch }, drafts: [], next: null };
}

test('mounted route carries the learned epoch into body reads and a late readback cannot dress a later uncertain write', async () => {
  const fixture = await mountOwnDrafts();
  const listed: Parameters<OwnDraftReader['list']>[0][] = [];
  const resumed: Parameters<OwnDraftReader['resume']>[0][] = [];
  const writes: { input: OwnDraftWriteInput; token: string }[] = [];
  const pendingReadbacks: ((value: Awaited<ReturnType<OwnDraftCommands['readback']>>) => void)[] = [];
  let writeAttempt = 0;
  const reader: OwnDraftReader = {
    async list(request) {
      listed.push(request);
      return page;
    },
    async resume(request) {
      resumed.push(request);
      return selected(entry);
    },
  };
  const transport: OwnDraftCommandTransport = {
    async write(input, token) {
      writes.push({ input: structuredClone(input), token });
      writeAttempt++;
      return writeAttempt === 1
        ? { ok: true, post: {} as never }
        : { ok: false, reason: 'unavailable' };
    },
    async erase() {
      return { ok: true };
    },
    readback() {
      return new Promise((resolve) => pendingReadbacks.push(resolve));
    },
  };
  try {
    const { DraftsRoute } = await import('../src/threads/drafts-route');
    await fixture.renderComponent(
      createElement(DraftsRoute, { reader, localWritingReader, transport }),
    );
    expect(listed[0]).toEqual({ accountId });
    await fixture.click('Inspect draft privately');
    expect(resumed[0]).toMatchObject({ accountId, authnEpoch: 2, id: entry.id, threadId: entry.threadId });
    await fixture.click('Use server-saved body in editor');
    await fixture.click('Save changes');
    expect(writes[0]?.token).toBe('fixture-csrf');
    expect(writes[0]?.input).toMatchObject({ postId: entry.id, threadId: entry.threadId, revisionId: entry.revisionId });

    await fixture.click('Read current post');
    await fixture.click('Retry this page');
    await fixture.click('Inspect draft privately');
    await fixture.click('Use server-saved body in editor');
    await fixture.click('Save changes');
    expect(fixture.host.textContent).toContain('Retry save');
    expect(writes[1]?.token).toBe('fixture-csrf');
    await act(async () => pendingReadbacks[0]?.({
      state: 'available',
      revision: 'prior-intent-revision',
      visibility: 'draft',
      body: fromPlainText('Prior acknowledged readback only', 'blocks'),
      mediaIds: [],
    }));
    expect(fixture.host.textContent).not.toContain('Prior acknowledged readback only');
    expect(fixture.host.textContent).toContain('Retry save');
  } finally {
    await fixture.close();
  }
});

test('signed-in null-CSRF route still lists and inspects but does not mount write commands', async () => {
  const fixture = await mountOwnDrafts();
  const listed: string[] = [];
  const reader: OwnDraftReader = {
    async list(request) {
      listed.push(request.accountId);
      return page;
    },
    async resume() {
      return selected(entry);
    },
  };
  const transport: OwnDraftCommandTransport = {
    async write() {
      throw new Error('read-only visit dispatched a write');
    },
    async erase() {
      throw new Error('read-only visit dispatched an erase');
    },
    async readback() {
      throw new Error('read-only visit dispatched a readback');
    },
  };
  try {
    fixture.client.setQueryData(['session'], { state: 'signed-in', subject: accountId, csrfToken: null });
    const { DraftsRoute } = await import('../src/threads/drafts-route');
    await fixture.renderComponent(createElement(DraftsRoute, { reader, localWritingReader, transport }));
    expect(listed).toEqual([accountId]);
    await fixture.click('Inspect draft privately');
    expect(fixture.host.textContent).toContain('The exact selected draft body stays in this private inspection.');
    expect(fixture.host.textContent).not.toContain('Use server-saved body in editor');
    expect(fixture.host.textContent).not.toContain('Erase draft');
  } finally {
    await fixture.close();
  }
});

test('exposure loss retires the mounted visit in-stack; retries keep their first token and stale callbacks never dispatch', async () => {
  const fixture = await mountOwnDrafts();
  const collected: { visit?: OwnDraftVisit } = {};
  const calls: string[] = [];
  let listCalls = 0;
  const reader: OwnDraftReader = {
    async list() {
      listCalls++;
      return page;
    },
    async resume() {
      return selected(entry);
    },
  };
  const transport: OwnDraftCommandTransport = {
    async write(_input, token) {
      calls.push(token);
      return { ok: false, reason: 'unavailable' };
    },
    async erase(_input, token) {
      calls.push(token);
      return { ok: false, reason: 'unavailable' };
    },
    async readback() {
      calls.push('readback');
      return 'unavailable';
    },
  };
  const Harness = harness(collected);
  try {
    await fixture.renderComponent(createElement(Harness, { reader, transport }));
    const original = collected.visit!;
    const originalCommands = original.commands!;
    expect(original.identity.accountId).toBe(accountId);
    expect(original.identity.authnEpoch).toBeNull();
    expect(await originalCommands.write(writeInput, new AbortController().signal)).toMatchObject({
      ok: false,
      reason: 'unavailable',
    });
    expect(await originalCommands.write(writeInput, new AbortController().signal)).toMatchObject({
      ok: false,
      reason: 'unavailable',
    });
    expect(calls).toEqual(['fixture-csrf', 'fixture-csrf']);

    const browser = browserObservation(fixture.client).getSnapshot();
    if (browser.state !== 'signed-in') throw new Error('Expected the mounted signed-in observation');
    const exposureKey = viewerExposureQuery(browser.observation).queryKey;
    let retiredInStack = false;
    await act(async () => {
      fixture.client.setQueryData(exposureKey, { subject: accountId, admitted: [], state: 'ready' });
      fixture.client.removeQueries({ queryKey: exposureKey, exact: true });
      retiredInStack = !original.current();
    });
    expect(retiredInStack).toBe(true);
    expect(await original.reader.list({ accountId, authnEpoch: 2 }, new AbortController().signal)).toBe('unavailable');
    expect(await originalCommands.readback(entry.id, new AbortController().signal)).toBe('unavailable');
    expect(listCalls).toBe(1);
    expect(calls).toEqual(['fixture-csrf', 'fixture-csrf']);
  } finally {
    await fixture.close();
  }
});

test('A/B/A cache replacement closes old readers and command callbacks before the new token can be observed', async () => {
  const fixture = await mountOwnDrafts();
  const collected: { visit?: OwnDraftVisit } = {};
  const listCalls: string[] = [];
  const sent: string[] = [];
  const reader: OwnDraftReader = {
    async list(request) {
      listCalls.push(request.accountId);
      return request.accountId === accountId ? page : emptyPage(request.accountId, 3);
    },
    async resume() {
      return selected(entry);
    },
  };
  const transport: OwnDraftCommandTransport = {
    async write(_input, token) {
      sent.push(token);
      return { ok: false, reason: 'unavailable' };
    },
    async erase(_input, token) {
      sent.push(token);
      return { ok: false, reason: 'unavailable' };
    },
    async readback() {
      sent.push('readback');
      return 'unavailable';
    },
  };
  const Harness = harness(collected);
  try {
    await fixture.renderComponent(createElement(Harness, { reader, transport }));
    const original = collected.visit!;
    const oldCommands = original.commands!;
    await act(async () => {
      fixture.client.setQueryData(['session'], { state: 'signed-in', subject: '0192f3a0-6c1e-7b2a-9d4e-000000000099', csrfToken: 'token-b' });
      fixture.client.setQueryData(['session'], { state: 'signed-in', subject: accountId, csrfToken: 'token-a2' });
    });
    expect(original.current()).toBe(false);
    const callsAfterReplacement = listCalls.length;
    expect(await original.reader.list({ accountId }, new AbortController().signal)).toBe('unavailable');
    expect(await oldCommands.write(writeInput, new AbortController().signal)).toMatchObject({
      ok: false,
      reason: 'unavailable',
    });
    expect(await oldCommands.readback(entry.id, new AbortController().signal)).toBe('unavailable');
    expect(listCalls.length).toBe(callsAfterReplacement);
    expect(sent).toEqual([]);
    expect(collected.visit!.identity.callerEpoch).not.toBe(original.identity.callerEpoch);
  } finally {
    await fixture.close();
  }
});

test('late list and selected-body results are discarded after synchronous session retirement', async () => {
  const fixture = await mountOwnDrafts();
  const collected: { visit?: OwnDraftVisit } = {};
  let releaseList!: (value: OwnDraftPageData) => void;
  let releaseBody!: (value: ReturnType<typeof selected>) => void;
  let listStarted!: () => void;
  let bodyStarted!: () => void;
  const firstListStarted = new Promise<void>((resolve) => (listStarted = resolve));
  const firstBodyStarted = new Promise<void>((resolve) => (bodyStarted = resolve));
  let listCount = 0;
  const reader: OwnDraftReader = {
    list() {
      listCount++;
      if (listCount === 1)
        return new Promise((resolve) => {
          releaseList = resolve;
          listStarted();
        });
      return Promise.resolve(page);
    },
    resume() {
      return new Promise((resolve) => {
        releaseBody = resolve;
        bodyStarted();
      });
    },
  };
  const transport: OwnDraftCommandTransport = {
    async write() {
      return { ok: false, reason: 'unavailable' };
    },
    async erase() {
      return { ok: false, reason: 'unavailable' };
    },
    async readback() {
      return 'unavailable';
    },
  };
  const Harness = harness(collected);
  try {
    await fixture.renderComponent(createElement(Harness, { reader, transport }));
    await firstListStarted;
    const original = collected.visit!;
    await act(async () => {
      fixture.client.setQueryData(['session'], { state: 'unavailable', subject: null, csrfToken: null });
      releaseList(page);
    });
    expect(original.current()).toBe(false);
    expect(fixture.host.textContent).not.toContain(entry.title);

    await act(async () => {
      fixture.client.setQueryData(['session'], { state: 'signed-in', subject: accountId, csrfToken: 'token-new' });
    });
    await fixture.click('Inspect draft privately');
    await firstBodyStarted;
    const bodyVisit = collected.visit!;
    await act(async () => {
      fixture.client.setQueryData(['session'], { state: 'signed-in', subject: '0192f3a0-6c1e-7b2a-9d4e-000000000099', csrfToken: 'token-b' });
      releaseBody(selected(entry, 'late private body'));
    });
    expect(bodyVisit.current()).toBe(false);
    expect(fixture.host.textContent).not.toContain('late private body');
  } finally {
    await fixture.close();
  }
});
