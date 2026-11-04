import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, type ComponentProps } from 'react';
import * as start from '../.storybook/react-start';
import type { PersonalEntry, PersonalEntryObservation } from '@rezics/client';
import {
  buildSourceCorrection,
  inspectSourceTimestamp,
  sourceCorrectionDraftOf,
} from '../src/library/rich-private-entry/source-correction';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
afterAll(() => mock.restore());

const guard = { incarnationId: '0192f3a0-6c1e-7b2a-9d4e-000000000001', currentRevision: 3 };

function observation(overrides: Partial<PersonalEntryObservation> = {}): PersonalEntryObservation {
  return {
    provider: 'mal',
    recordId: 'list/17',
    revision: 2,
    privacy: { status: 'unknown', sourceValue: 'private_flag_v2' },
    sourceCreated: { status: 'known', value: '2004-02', precision: 'month', zone: 'unknown' },
    sourceUpdated: { status: 'absent' },
    recordedAt: '2026-01-01T00:00:00.000000Z',
    ...overrides,
  };
}

function entry(source = observation()): PersonalEntry {
  return {
    subjectId: 'subject-1',
    annotationRevision: 4,
    note: 'private note',
    priority: 7,
    annotationUpdatedAt: '2026-01-01T00:00:00Z',
    sourceObservations: [source],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 12));

async function renderedReader(
  current: () => PersonalEntry,
  transportOverride?: Partial<NonNullable<ComponentProps<typeof import('../src/library/rich-private-entry/view').RichPrivateEntry>['transport']>>,
) {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/subjects/subject-1/book' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const exposure = await import('../src/kernel/exposure');
  const allow = spyOn(exposure, 'useOperation').mockReturnValue(true);
  const { RichPrivateEntry } = await import('../src/library/rich-private-entry/view');
  const { m } = await import('../src/paraglide/messages.js');
  type Props = ComponentProps<typeof RichPrivateEntry>;
  type Transport = NonNullable<Props['transport']>;
  type CommandInput = Parameters<Transport['sourceCorrection']>[0]['data'];
  type Outcome = Awaited<ReturnType<Transport['sourceCorrection']>>;
  const writes: { command: CommandInput; reply: ReturnType<typeof deferred<Outcome>> }[] = [];
  const transport: Transport = {
    read: async () => ({
      kind: 'ready',
      viewer: 'A',
      csrfToken: 'captured-csrf',
      credential: 'captured-credential',
      entry: current(),
    }),
    annotations: async () => ({ kind: 'uncertain' }),
    sourceCorrection: async ({ data }) => {
      const reply = deferred<Outcome>();
      writes.push({ command: data, reply });
      return reply.promise;
    },
    ...transportOverride,
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host);
  let props: Props = {
    subject: { id: 'subject-1', label: 'Book' },
    session: { state: 'signed-in', subject: 'A', csrfToken: 'session-csrf' },
    admitted: true,
    returnTo: '/en/subjects/subject-1/book',
    entryGuard: guard,
    origin: { lifetime: 'visit-1', isCurrent: () => true, refreshEntry: async () => true },
    transport,
  };

  const render = async (changes: Partial<Props> = {}) => {
    props = { ...props, ...changes };
    await act(async () => {
      root.render(
        createElement(QueryClientProvider, {
          client,
          children: createElement(RichPrivateEntry, props),
        }),
      );
    });
    await act(async () => pause());
  };
  const button = (label: string) => {
    const value = [...host.querySelectorAll('button')].find((node) => node.textContent?.trim() === label);
    if (!value) throw new Error(`Button not found: ${label}`);
    return value;
  };
  const click = async (label: string) =>
    act(async () => {
      button(label).click();
      await pause();
    });
  const field = (legend: string) => {
    const value = [...host.querySelectorAll('fieldset')].find(
      (item) => item.querySelector('legend')?.textContent?.trim() === legend,
    );
    if (!value) throw new Error(`Fieldset not found: ${legend}`);
    return value;
  };
  const change = async (element: HTMLInputElement | HTMLSelectElement, value: string | boolean) => {
    const key = Object.keys(element).find((name) => name.startsWith('__reactProps$'));
    if (!key) throw new Error('React change handler not found');
    const props = (element as unknown as Record<string, { onChange?: (event: unknown) => void }>)[key]!;
    await act(async () => {
      props.onChange?.({ currentTarget: typeof value === 'boolean' ? { checked: value } : { value } });
      await pause();
    });
  };
  const reply = async (index: number, outcome: Outcome) =>
    act(async () => {
      writes[index]!.reply.resolve(outcome);
      await pause();
    });
  const cleanup = async () => {
    await act(async () => root.unmount());
    client.clear();
    window.close();
    for (const [key, descriptor] of previous)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
    allow.mockRestore();
  };
  return { host, render, button, click, field, change, reply, writes, cleanup, m };
}

test('source corrections preserve, set, or clear each fact independently and retain timestamp precision and zone', () => {
  const before = observation();
  const preserved = sourceCorrectionDraftOf(before);
  expect(buildSourceCorrection(before, preserved)).toMatchObject({ kind: 'invalid', issues: {} });

  const createdSet = {
    ...preserved,
    sourceCreated: { ...preserved.sourceCreated, operation: 'set' as const, choice: 'known' as const, value: '2004-02-29T23:59:01.123+08:00' },
  };
  const setCreated = buildSourceCorrection(before, createdSet);
  expect(setCreated).toEqual({
    kind: 'ready',
    body: {
      provider: 'mal',
      recordId: 'list/17',
      revision: 2,
      confirmReviewed: true,
      privacy: { op: 'unchanged' },
      sourceCreated: { op: 'set', value: { status: 'known', value: '2004-02-29T23:59:01.123+08:00' } },
      sourceUpdated: { op: 'unchanged' },
    },
  });

  const privacySet = {
    ...preserved,
    privacy: { ...preserved.privacy, operation: 'set' as const, choice: 'unknown' as const, sourceValue: 'private_flag_v2' },
    sourceCreated: { ...preserved.sourceCreated, operation: 'clear' as const },
    sourceUpdated: { ...preserved.sourceUpdated, operation: 'set' as const, choice: 'known' as const, value: '2005' },
  };
  const setPrivacyAndUpdated = buildSourceCorrection(before, privacySet);
  expect(setPrivacyAndUpdated).toMatchObject({
    kind: 'ready',
    body: {
      privacy: { op: 'set', value: { status: 'unknown', sourceValue: 'private_flag_v2' } },
      sourceCreated: { op: 'clear' },
      sourceUpdated: { op: 'set', value: { status: 'known', value: '2005' } },
    },
  });

  const explicitAbsentAndUnknown = buildSourceCorrection(before, {
    ...preserved,
    privacy: { ...preserved.privacy, operation: 'set', choice: 'absent' },
    sourceCreated: { ...preserved.sourceCreated, operation: 'set', choice: 'unknown', sourceValue: 'provider_date_v2' },
    sourceUpdated: { ...preserved.sourceUpdated, operation: 'set', choice: 'absent' },
  });
  expect(explicitAbsentAndUnknown).toMatchObject({
    kind: 'ready',
    body: {
      privacy: { op: 'set', value: { status: 'absent' } },
      sourceCreated: { op: 'set', value: { status: 'unknown', sourceValue: 'provider_date_v2' } },
      sourceUpdated: { op: 'set', value: { status: 'absent' } },
    },
  });

  expect(buildSourceCorrection(before, {
    ...preserved,
    privacy: { ...preserved.privacy, operation: 'set', choice: 'unknown', sourceValue: 'é'.repeat(97) },
  })).toMatchObject({ kind: 'invalid', issues: { privacy: 'privacy-limit' } });
  expect(buildSourceCorrection(before, {
    ...preserved,
    sourceCreated: { ...preserved.sourceCreated, operation: 'set', choice: 'unknown', sourceValue: 'é'.repeat(33) },
  })).toMatchObject({ kind: 'invalid', issues: { sourceCreated: 'native-limit' } });

  const privacyClear = {
    ...preserved,
    privacy: { ...preserved.privacy, operation: 'clear' as const },
    sourceUpdated: { ...preserved.sourceUpdated, operation: 'clear' as const },
  };
  expect(buildSourceCorrection(before, privacyClear)).toMatchObject({
    kind: 'ready',
    body: {
      privacy: { op: 'clear' },
      sourceCreated: { op: 'unchanged' },
      sourceUpdated: { op: 'clear' },
    },
  });

  expect(inspectSourceTimestamp('2004')).toEqual({ precision: 'year', zone: 'unknown' });
  expect(inspectSourceTimestamp('2004-02')).toEqual({ precision: 'month', zone: 'unknown' });
  expect(inspectSourceTimestamp('2004-02-29')).toEqual({ precision: 'day', zone: 'unknown' });
  expect(inspectSourceTimestamp('2004-02-29T23:59')).toEqual({ precision: 'minute', zone: 'unknown' });
  expect(inspectSourceTimestamp('2004-02-29T23:59:01Z')).toEqual({ precision: 'second', zone: 'utc' });
  expect(inspectSourceTimestamp('2004-02-29T23:59:01.123+08:00')).toEqual({ precision: 'fraction', zone: 'offset' });
  expect(inspectSourceTimestamp('2004-02-29T23:59:01-00:00')).toEqual({ precision: 'second', zone: 'unknown' });
  expect(inspectSourceTimestamp('not-a-date')).toBe('malformed');
  expect(inspectSourceTimestamp('0000')).toBe('unsupported-calendar');
  expect(inspectSourceTimestamp('2001-02-29')).toBe('invalid-calendar-date');
  expect(inspectSourceTimestamp('2004-02-29T23:59+15:00')).toBe('invalid-offset');
  expect(inspectSourceTimestamp('2004-02-29T23:59:01.1234567890123456789Z')).toBe('native-limit');
});

test('review and recovery retry the exact command, then require re-review after a source revision conflict', async () => {
  let latest = entry();
  const reader = await renderedReader(() => latest);
  try {
    await reader.render();
    await reader.click(reader.m.library_rich_entry_edit_source_facts());

    const privacy = reader.field(reader.m.library_rich_entry_privacy());
    const privacySelects = [...privacy.querySelectorAll('select')];
    await reader.change(privacySelects[0]!, 'set');
    await reader.change(privacySelects[1]!, 'unknown');
    await reader.change(privacy.querySelector('input[type="text"]') as HTMLInputElement, 'private_flag_v2');

    const created = reader.field(reader.m.library_rich_entry_source_created());
    const createdSelects = [...created.querySelectorAll('select')];
    await reader.change(createdSelects[0]!, 'set');
    await reader.change(createdSelects[1]!, 'known');
    await reader.change(created.querySelector('input[type="text"]') as HTMLInputElement, '2004-02-29T23:59:01.123+08:00');

    const updated = reader.field(reader.m.library_rich_entry_source_updated());
    await reader.change(updated.querySelector('select')!, 'clear');
    expect(reader.host.textContent).toContain('2004-02-29T23:59:01.123+08:00');
    expect(reader.button(reader.m.library_rich_entry_save_source_correction()).disabled).toBe(true);
    await reader.change(reader.host.querySelector('input[type="checkbox"]') as HTMLInputElement, true);
    await reader.click(reader.m.library_rich_entry_save_source_correction());

    expect(reader.writes).toHaveLength(1);
    const original = reader.writes[0]!.command;
    expect(original).toMatchObject({
      subjectId: 'subject-1',
      viewer: 'A',
      csrfToken: 'captured-csrf',
      credential: 'captured-credential',
      originLifetime: 'visit-1',
      entryGuard: guard,
      body: {
        provider: 'mal',
        recordId: 'list/17',
        revision: 2,
        confirmReviewed: true,
        privacy: { op: 'set', value: { status: 'unknown', sourceValue: 'private_flag_v2' } },
        sourceCreated: { op: 'set', value: { status: 'known', value: '2004-02-29T23:59:01.123+08:00' } },
        sourceUpdated: { op: 'clear' },
      },
    });

    await reader.reply(0, { kind: 'uncertain' });
    expect(reader.host.textContent).toContain(reader.m.library_rich_entry_source_unknown_outcome());
    await reader.click(reader.m.library_rich_entry_source_retry_original());
    expect(reader.writes).toHaveLength(2);
    expect(reader.writes[1]!.command).toEqual(original);

    const current = observation({
      revision: 3,
      privacy: { status: 'known', meaning: 'source_visible' },
      sourceCreated: { status: 'known', value: '2005', precision: 'year', zone: 'unknown' },
      sourceUpdated: { status: 'known', value: '2006-01-02T03:04Z', precision: 'minute', zone: 'utc' },
    });
    latest = entry(current);
    await reader.reply(1, { kind: 'conflict' });
    expect(reader.host.textContent).toContain(reader.m.library_rich_entry_source_conflict());
    expect(reader.host.textContent).toContain(reader.m.library_rich_entry_current_source_revision({ revision: 3 }));
    await reader.click(reader.m.library_rich_entry_review_latest());
    expect(reader.host.textContent).toContain('2005');
    expect((reader.host.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(false);
    expect(reader.button(reader.m.library_rich_entry_save_source_correction()).disabled).toBe(true);
    await reader.change(reader.host.querySelector('input[type="checkbox"]') as HTMLInputElement, true);
    await reader.click(reader.m.library_rich_entry_save_source_correction());
    expect(reader.writes).toHaveLength(3);
    expect(reader.writes[2]!.command.body.revision).toBe(3);
    expect(reader.writes[2]!.command.key).not.toBe(original.key);
    expect(reader.writes[2]!.command.body.sourceCreated).toEqual(original.body.sourceCreated);
    expect(reader.writes[2]!.command.body.sourceUpdated).toEqual(original.body.sourceUpdated);

    const saved = observation({
      revision: 4,
      privacy: { status: 'unknown', sourceValue: 'private_flag_v2' },
      sourceCreated: { status: 'known', value: '2004-02-29T23:59:01.123+08:00', precision: 'fraction', zone: 'offset' },
      sourceUpdated: { status: 'cleared' },
    });
    latest = entry(saved);
    await reader.reply(2, { kind: 'saved', entry: latest, observation: saved });
    expect(reader.host.textContent).toContain(reader.m.library_rich_entry_source_saved({ revision: 4 }));
    expect(reader.host.textContent).toContain(reader.m.library_rich_entry_source_field_saved({ value: reader.m.library_rich_source_cleared() }));
    expect(reader.host.textContent).toContain(
      reader.m.library_rich_entry_before() +
        reader.m.library_rich_source_timestamp({
          value: '2004-02',
          precision: reader.m.library_rich_entry_precision_month(),
          zone: reader.m.library_rich_entry_zone_unknown(),
        }),
    );
    await reader.click(reader.m.library_rich_entry_cancel());
    expect(reader.host.ownerDocument.activeElement).toBe(reader.button(reader.m.library_rich_entry_edit_source_facts()));
  } finally {
    await reader.cleanup();
  }
});

test('private source facts and late results retire when account, incarnation, or visit changes', async () => {
  const transitions = ['account', 'incarnation', 'visit'] as const;
  for (const transition of transitions) {
    let latest = entry();
    let readCount = 0;
    const refreshed = deferred<Awaited<ReturnType<NonNullable<ComponentProps<typeof import('../src/library/rich-private-entry/view').RichPrivateEntry>['transport']>['read']>>>();
    const reader = await renderedReader(() => latest, {
      read: async () => {
        readCount++;
        if (readCount === 1) return { kind: 'ready', viewer: 'A', csrfToken: 'captured-csrf', credential: 'captured-credential', entry: latest };
        return refreshed.promise;
      },
    });
    try {
      await reader.render();
      await reader.click(reader.m.library_rich_entry_edit_source_facts());
      const created = reader.field(reader.m.library_rich_entry_source_created());
      const selects = [...created.querySelectorAll('select')];
      await reader.change(selects[0]!, 'set');
      await reader.change(selects[1]!, 'known');
      await reader.change(created.querySelector('input[type="text"]') as HTMLInputElement, '2007-08');
      await reader.change(reader.host.querySelector('input[type="checkbox"]') as HTMLInputElement, true);
      await reader.click(reader.m.library_rich_entry_save_source_correction());
      expect(reader.writes).toHaveLength(1);
      expect(reader.host.textContent).toContain('private_flag_v2');

      if (transition === 'account') {
        await reader.render({ session: { state: 'signed-in', subject: 'B', csrfToken: 'new-csrf' } });
      } else if (transition === 'incarnation') {
        await reader.render({ entryGuard: { ...guard, incarnationId: '0192f3a0-6c1e-7b2a-9d4e-000000000002', currentRevision: 4 } });
      } else {
        await reader.render({ origin: { lifetime: 'visit-2', isCurrent: () => true, refreshEntry: async () => true } });
      }
      expect(reader.host.textContent).not.toContain('private_flag_v2');

      const lateObservation = observation({ revision: 3, privacy: { status: 'known', meaning: 'private' } });
      await reader.reply(0, { kind: 'saved', entry: entry(lateObservation), observation: lateObservation });
      expect(reader.host.textContent).not.toContain('private_flag_v2');
      expect(reader.host.textContent).not.toContain('2007-08');

      if (transition !== 'account') {
        const refreshedObservation = observation({ revision: 3, privacy: { status: 'unknown', sourceValue: 'current-private-value' } });
        latest = entry(refreshedObservation);
        refreshed.resolve({
          kind: 'ready',
          viewer: 'A',
          csrfToken: 'captured-csrf',
          credential: 'new-captured-credential',
          entry: latest,
        });
        await act(async () => pause());
        expect(reader.host.textContent).toContain('current-private-value');
        expect(reader.host.textContent).not.toContain('private_flag_v2');
      }
    } finally {
      await reader.cleanup();
    }
  }
});

