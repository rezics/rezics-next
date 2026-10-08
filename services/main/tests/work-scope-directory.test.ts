import { afterEach, expect, spyOn, test } from 'bun:test';
import { CommandForbidden, FusekiClient, type WorkScopeDirectoryPage } from '../src/infrastructure/fuseki.ts';
import { prepareWorkNameScope } from '../src/modules/query/seek-index.ts';
import { WorkReadUnavailable } from '../src/modules/work/read-session.ts';

const restores: (() => void)[] = [];
afterEach(() => { for (const restore of restores.splice(0).reverse()) restore(); });

const maintenance = 'a'.repeat(64);
const command = 'b'.repeat(64);
const client = () => new FusekiClient('http://fuseki.invalid/rezics/', maintenance, command);

function fetchStub(handler: (url: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>) {
  const stub = spyOn(globalThis, 'fetch').mockImplementation(handler as typeof fetch);
  restores.push(() => stub.mockRestore());
  return stub;
}

function headers(init?: RequestInit): Record<string, string> {
  return init?.headers as Record<string, string>;
}

test('the directory page uses the maintenance token and a closed empty body', async () => {
  const fetch = fetchStub(async (url, init) => {
    expect(String(url)).toBe('http://fuseki.invalid/rezics/command');
    expect(init?.method).toBe('POST');
    expect(headers(init).authorization).toBe(`Bearer ${maintenance}`);
    expect(init?.body).toBe(JSON.stringify({ workScopeDirectory: {} }));
    return Response.json({ status: 'prepared', phase: 'owners', more: true });
  });
  expect(await client().prepareWorkScopeDirectory()).toEqual({ status: 'prepared', phase: 'owners', more: true });
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('a complete directory page is accepted and a deadline page stays open', async () => {
  const pages: WorkScopeDirectoryPage[] = [
    { status: 'prepared', phase: 'complete', more: false },
    { status: 'deadline', phase: 'absent', more: true },
  ];
  let index = 0;
  fetchStub(async () => Response.json(pages[index++]!));
  const fuseki = client();
  expect(await fuseki.prepareWorkScopeDirectory()).toEqual(pages[0]);
  expect(await fuseki.prepareWorkScopeDirectory()).toEqual(pages[1]);
});

test('a missing maintenance capability is refused before fetch', async () => {
  const fetch = fetchStub(async () => { throw new Error('missing capability must not fetch'); });
  await expect(new FusekiClient('http://fuseki.invalid/rezics/', '', command).prepareWorkScopeDirectory())
    .rejects.toThrow('maintenance capability');
  expect(fetch).not.toHaveBeenCalled();
});

test('the command capability cannot prepare the directory', async () => {
  fetchStub(async () => new Response(JSON.stringify({ status: 'forbidden' }), { status: 403 }));
  await expect(client().prepareWorkScopeDirectory()).rejects.toBeInstanceOf(CommandForbidden);
});

test('a directory page with the wrong continuation is rejected', async () => {
  const pages = [
    { status: 'prepared', phase: 'complete', more: true },
    { status: 'prepared', phase: 'absent', more: false },
    { status: 'prepared', phase: 'owners', more: false },
    { status: 'deadline', phase: 'owners', more: true },
    { status: 'prepared', phase: 'complete', more: false, extra: true },
  ];
  let index = 0;
  fetchStub(async () => Response.json(pages[index++]!));
  for (let count = 0; count < pages.length; count++) {
    await expect(client().prepareWorkScopeDirectory()).rejects.toThrow('Malformed work name scope preparation');
  }
  expect(index).toBe(pages.length);
});

test('directory preparation repeats owner pages and stops when the phase is complete', async () => {
  const pages = [
    { status: 'prepared' as const, phase: 'owners' as const, more: true },
    { status: 'prepared' as const, phase: 'owners' as const, more: true },
    { status: 'prepared' as const, phase: 'complete' as const, more: false },
  ];
  let index = 0;
  await prepareWorkNameScope({
    prepareWorkScopeDirectory: async () => pages[index++]!,
  }, Date.now() + 60_000);
  expect(index).toBe(3);
});

test('a directory that is already complete performs one page', async () => {
  let calls = 0;
  await prepareWorkNameScope({
    prepareWorkScopeDirectory: async () => {
      calls++;
      return { status: 'prepared' as const, phase: 'complete' as const, more: false };
    },
  }, Date.now() + 60_000);
  expect(calls).toBe(1);
});

test('an expired readiness deadline prepares no page', async () => {
  let now = 5_000;
  const date = spyOn(Date, 'now').mockImplementation(() => now);
  restores.push(() => date.mockRestore());
  let calls = 0;
  await expect(prepareWorkNameScope({
    prepareWorkScopeDirectory: async () => { calls++; return { status: 'prepared', phase: 'complete', more: false }; },
  }, 4_000)).rejects.toBeInstanceOf(WorkReadUnavailable);
  expect(calls).toBe(0);
});

test('native page deadlines continue until the readiness deadline', async () => {
  let now = 1_000;
  const date = spyOn(Date, 'now').mockImplementation(() => now);
  restores.push(() => date.mockRestore());
  let calls = 0;
  await expect(prepareWorkNameScope({
    prepareWorkScopeDirectory: async () => {
      calls++;
      now += 100;
      return { status: 'deadline', phase: 'absent', more: true };
    },
  }, 1_250)).rejects.toThrow('Work name scope preparation exceeds 600 seconds');
  expect(calls).toBe(3);
});

test('a page that is neither an owner continuation nor complete is unqualified', async () => {
  await expect(prepareWorkNameScope({
    prepareWorkScopeDirectory: async () => ({ status: 'prepared', phase: 'absent', more: false }),
  }, Date.now() + 60_000)).rejects.toThrow('Work name scope preparation is unqualified');
});
