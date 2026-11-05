import { expect, test } from 'bun:test';
import { act } from 'react';
import type { OwnDraftPageData, OwnDraftReader } from '../src/threads/own-drafts/model';
import { accountId, identity, mountOwnDrafts, row, selected } from './own-drafts-fixture';

function page(title: string | null, next: string | null, state: OwnDraftPageData['state'] = 'ready') {
  return {
    state,
    viewer: { accountId, authnEpoch: identity.authnEpoch },
    drafts: title === null ? [] : [row({ title })],
    next,
  } satisfies OwnDraftPageData;
}

function button(host: HTMLElement, label: string) {
  const found = [...host.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

test('continues through a terminal page, returns with fresh metadata, and deliberately starts over', async () => {
  const requests: (string | undefined)[] = [];
  const reader: OwnDraftReader = {
    async list({ cursor }) {
      requests.push(cursor);
      if (cursor === undefined) return page('First window', 'cursor-one');
      if (cursor === 'cursor-one') return page('Second window', 'cursor-two');
      return page('Terminal window', null);
    },
    async resume() {
      return 'unavailable';
    },
  };
  const f = await mountOwnDrafts();
  try {
    await f.render({ identity, active: true, reader });
    await f.click('Continue to older drafts');
    await f.click('Continue to older drafts');
    expect(f.host.textContent).toContain('Terminal window');
    expect(f.host.textContent).not.toContain('First window');
    await f.click('Previous page');
    expect(f.host.textContent).toContain('Second window');
    await f.click('Restart inventory');
    expect(f.host.textContent).toContain('First window');
    expect(requests).toEqual([undefined, 'cursor-one', 'cursor-two', 'cursor-one', undefined]);
    expect([...f.host.querySelectorAll('button')].some((candidate) => candidate.textContent === 'Previous page')).toBe(
      false,
    );
  } finally {
    await f.close();
  }
});

test('an empty terminal window can return, and preparation never claims the inventory is empty', async () => {
  let firstPageReads = 0;
  const requests: (string | undefined)[] = [];
  const reader: OwnDraftReader = {
    async list({ cursor }) {
      requests.push(cursor);
      if (cursor) return page(null, null);
      firstPageReads++;
      if (firstPageReads < 3) return page('One draft', 'empty-terminal');
      return page(null, null, 'preparing');
    },
    async resume() {
      return 'unavailable';
    },
  };
  const f = await mountOwnDrafts();
  try {
    await f.render({ identity, active: true, reader });
    await f.click('Continue to older drafts');
    expect(f.host.textContent).toContain('No server-saved drafts are available.');
    expect(f.host.querySelectorAll('li')).toHaveLength(0);
    expect(f.host.querySelector('button')?.textContent).not.toBe('Continue to older drafts');
    await f.click('Previous page');
    expect(f.host.textContent).toContain('One draft');
    await f.click('Restart inventory');
    expect(f.host.textContent).toContain('The server is still preparing this inventory.');
    expect(f.host.textContent).not.toContain('No server-saved drafts are available.');
    expect(requests).toEqual([undefined, 'empty-terminal', undefined, undefined]);
  } finally {
    await f.close();
  }
});

test('Previous and cursor-free First retain exact failed targets for Retry', async () => {
  const requests: (string | undefined)[] = [];
  let cursorOneReads = 0;
  let previousFails = true;
  let firstFails = true;
  let firstReads = 0;
  const reader: OwnDraftReader = {
    async list({ cursor }) {
      requests.push(cursor);
      if (cursor === undefined) {
        firstReads++;
        if (firstReads > 1 && firstFails) {
          firstFails = false;
          return 'unavailable';
        }
        return page('First window', 'cursor-one');
      }
      if (cursor === 'cursor-two') return page('Last window', null);
      cursorOneReads++;
      if (cursorOneReads > 1 && previousFails) {
        previousFails = false;
        return 'unavailable';
      }
      return page('Middle window', 'cursor-two');
    },
    async resume() {
      return 'unavailable';
    },
  };
  const f = await mountOwnDrafts();
  try {
    await f.render({ identity, active: true, reader });
    await f.click('Continue to older drafts');
    await f.click('Continue to older drafts');
    await f.click('Previous page');
    expect(f.host.textContent).toContain('This draft page could not be read.');
    expect(f.host.querySelectorAll('li')).toHaveLength(0);
    await f.click('Retry this page');
    expect(f.host.textContent).toContain('Middle window');
    await f.click('Restart inventory');
    expect(f.host.textContent).toContain('This draft page could not be read.');
    await f.click('Retry this page');
    expect(f.host.textContent).toContain('First window');
    expect(requests).toEqual([undefined, 'cursor-one', 'cursor-two', 'cursor-one', 'cursor-one', undefined, undefined]);
    expect([...f.host.querySelectorAll('button')].some((candidate) => candidate.textContent === 'Previous page')).toBe(
      false,
    );
  } finally {
    await f.close();
  }
});

test('keeps eight predecessors and follows a refetched page when branching after Previous', async () => {
  const requests: (string | undefined)[] = [];
  let secondWindowReads = 0;
  const reader: OwnDraftReader = {
    async list({ cursor }) {
      requests.push(cursor);
      if (cursor === undefined) return page('Window 0', 'cursor-1');
      if (cursor === 'branch-after-return') return page('Branched window', null);
      const index = Number(cursor.slice('cursor-'.length));
      if (index === 2 && ++secondWindowReads === 2) return page('Window 2 refreshed', 'branch-after-return');
      return page(`Window ${index}`, `cursor-${index + 1}`);
    },
    async resume() {
      return 'unavailable';
    },
  };
  const f = await mountOwnDrafts();
  try {
    await f.render({ identity, active: true, reader });
    for (let index = 0; index < 10; index++) await f.click('Continue to older drafts');
    expect(f.host.textContent).toContain('Window 10');
    expect(
      [...f.host.querySelectorAll('button')].some((candidate) => candidate.textContent === 'Restart inventory'),
    ).toBe(true);
    for (let index = 0; index < 8; index++) await f.click('Previous page');
    expect(f.host.textContent).toContain('Window 2 refreshed');
    expect([...f.host.querySelectorAll('button')].some((candidate) => candidate.textContent === 'Previous page')).toBe(
      false,
    );
    await f.click('Continue to older drafts');
    expect(f.host.textContent).toContain('Branched window');
    expect(requests.at(-1)).toBe('branch-after-return');
  } finally {
    await f.close();
  }
});

test('rapid activation admits one request; replacement retires a late cursor and a selected body', async () => {
  let finishNext!: (value: Awaited<ReturnType<OwnDraftReader['list']>>) => void;
  let nextSignal: AbortSignal | undefined;
  let finishBody!: (value: Awaited<ReturnType<OwnDraftReader['resume']>>) => void;
  let bodySignal: AbortSignal | undefined;
  let nextCalls = 0;
  const readerA: OwnDraftReader = {
    list(request, signal) {
      if (!request.cursor) return Promise.resolve(page('A first window', 'a-next'));
      nextCalls++;
      nextSignal = signal;
      return new Promise((resolve) => {
        finishNext = resolve;
      });
    },
    resume(_request, signal) {
      bodySignal = signal;
      return new Promise((resolve) => {
        finishBody = resolve;
      });
    },
  };
  const readerB: OwnDraftReader = {
    list: async () => page('B window', null),
    resume: async () => 'unavailable',
  };
  const f = await mountOwnDrafts();
  try {
    await f.render({ identity, active: true, reader: readerA });
    const continueButton = button(f.host, 'Continue to older drafts');
    await act(async () => {
      continueButton.click();
      continueButton.click();
    });
    expect(nextCalls).toBe(1);
    await f.render({ identity, active: true, reader: readerB });
    expect(nextSignal?.aborted).toBe(true);
    await f.render({ identity, active: true, reader: readerA });
    expect(f.host.textContent).toContain('A first window');
    await act(async () => finishNext(page('Late A window', null)));
    expect(f.host.textContent).toContain('A first window');
    expect(f.host.textContent).not.toContain('Late A window');

    await f.click('Inspect draft privately');
    expect(bodySignal?.aborted).toBe(false);
    await f.click('Return to drafts');
    expect(bodySignal?.aborted).toBe(true);
    await f.click('Continue to older drafts');
    await act(async () => finishBody(selected(row(), 'Late selected bytes')));
    expect(f.host.querySelector('article')).toBeNull();
    expect(f.host.textContent).not.toContain('Late selected bytes');
  } finally {
    await f.close();
  }
});

test.each(['viewer', 'epoch'] as const)('%s mismatch permanently retires pagination', async (mismatch) => {
  let reads = 0;
  const reader: OwnDraftReader = {
    async list() {
      reads++;
      return reads === 1
        ? page('Admitted window', 'next')
        : {
            ...page('Retired window', null),
            viewer:
              mismatch === 'viewer'
                ? { accountId: 'another-account', authnEpoch: identity.authnEpoch }
                : { accountId, authnEpoch: identity.authnEpoch + 1 },
          };
    },
    async resume() {
      return 'unavailable';
    },
  };
  const f = await mountOwnDrafts();
  try {
    await f.render({ identity, active: true, reader });
    await f.click('Continue to older drafts');
    expect(f.host.textContent).toContain('This private inventory is unavailable for the current account.');
    expect([...f.host.querySelectorAll('button')]).toHaveLength(0);
    expect(reads).toBe(2);
  } finally {
    await f.close();
  }
});

test('keyboard movement focuses the inventory heading only while its handoff remains active', async () => {
  let finishRestart!: (value: Awaited<ReturnType<OwnDraftReader['list']>>) => void;
  let firstReads = 0;
  const reader: OwnDraftReader = {
    list(request) {
      if (request.cursor) return Promise.resolve(page('Older window', null));
      firstReads++;
      if (firstReads === 1) return Promise.resolve(page('First window', 'older'));
      return new Promise((resolve) => {
        finishRestart = resolve;
      });
    },
    async resume() {
      return 'unavailable';
    },
  };
  const f = await mountOwnDrafts();
  try {
    await f.render({ identity, active: true, reader });
    const restart = button(f.host, 'Restart inventory');
    await act(async () => {
      restart.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      restart.click();
    });
    const outside = f.window.document.createElement('button');
    f.window.document.body.append(outside);
    outside.focus();
    await act(async () => finishRestart(page('First window again', 'older')));
    expect(f.window.document.activeElement).toBe(outside);
    expect(f.host.textContent).toContain('First window again');

    const next = button(f.host, 'Continue to older drafts');
    await act(async () => {
      next.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      next.click();
    });
    expect(f.window.document.activeElement).toBe(f.host.querySelector('h1'));
  } finally {
    await f.close();
  }
});

test('rejects malformed next coordinates and requires explicit First', async () => {
  let reads = 0;
  const requests: (string | undefined)[] = [];
  const reader: OwnDraftReader = {
    async list({ cursor }) {
      requests.push(cursor);
      reads++;
      return reads === 1 ? page('Unadmitted window', '') : page('First window', null);
    },
    async resume() {
      return 'unavailable';
    },
  };
  const f = await mountOwnDrafts();
  try {
    await f.render({ identity, active: true, reader });
    expect(f.host.textContent).toContain('This private inventory is no longer current.');
    expect(f.host.querySelectorAll('li')).toHaveLength(0);
    expect(
      [...f.host.querySelectorAll('button')].some((candidate) => candidate.textContent === 'Continue to older drafts'),
    ).toBe(false);
    await f.click('Restart inventory');
    expect(f.host.textContent).toContain('First window');
    expect(requests).toEqual([undefined, undefined]);
  } finally {
    await f.close();
  }
});
