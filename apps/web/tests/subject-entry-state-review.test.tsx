import { afterAll, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { LibraryStateChoice } from '../src/library/profiles';
import type { SubjectSlotEntry, SubjectLibraryMutationResponse } from '../src/library/subject-slot';
import type { SlotLifetime } from '../src/library/subject-library-current-origin';
import type { SubjectReference } from '../src/library/subject-ref';
import type { EntryStateConflictIntent, ReviewedEntryState } from '../src/library/subject-entry-state-review/review';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/subjects/subject/reader', width: 390, height: 844 });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLDivElement: window.HTMLDivElement,
  HTMLSelectElement: window.HTMLSelectElement,
  PointerEvent: window.PointerEvent,
  KeyboardEvent: window.KeyboardEvent,
  HTMLInputElement: window.HTMLInputElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { createRoot } = await import('react-dom/client');
const { SubjectEntryStateReview } = await import('../src/library/subject-entry-state-review/review');

const subject: SubjectReference = {
  id: '0192f3a0-6c1e-7b2a-9d4e-000000000042',
  type: 'Book',
  label: 'A supplied title that remains readable in a narrow review panel',
  typeLabel: 'Book',
};
const choices: LibraryStateChoice[] = [
  { id: 'planned', label: { text: 'Planned', lang: 'en' } },
  { id: 'in_progress', label: { text: 'In progress', lang: 'en' } },
  { id: 'completed', label: { text: 'Completed', lang: 'en' } },
  { id: 'paused', label: { text: 'Paused', lang: 'en' } },
];
function lifetime(seed: string, active = { value: true }): SlotLifetime {
  return { seed, active: true, current: (..._operations) => active.value };
}
function button(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === label);
  expect(found).toBeDefined();
  return found!;
}
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterAll(async () => {
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await window.happyDOM.close();
});

test('state choice stays unsent through review and correction; exact current basis, no-change and replacement remain truthful', async () => {
  let currentLife = lifetime('entry-a1');
  let active = currentLife;
  let originKey = 'subject-a/en/entry-a1';
  let entry: SubjectSlotEntry | null = null;
  let receivedLabel = 'Other';
  let conflict: EntryStateConflictIntent | null = null;
  const saves: ReviewedEntryState[] = [];
  const response: SubjectLibraryMutationResponse = {
    result: 'saved',
    entry: { subjectId: subject.id, state: 'in_progress', revision: 1, incarnationId: 'entry-new' },
  };
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const render = async (options = choices) =>
    act(async () => {
      root.render(
        <SubjectEntryStateReview
          subject={subject}
          entry={entry}
          receivedLabel={receivedLabel}
          stateOptions={options}
          canRemove={false}
          originKey={originKey}
          lifetime={active}
          disabled={false}
          busy={false}
          uncertain={false}
          conflict={conflict}
          onSave={async (review) => {
            saves.push(review);
            return response;
          }}
          onRemove={() => {}}
          onDismissConflict={() => {
            conflict = null;
          }}
        />,
      );
      await flush();
    });
  const choose = async (label: string) => {
    const trigger = host.querySelector<HTMLButtonElement>('[data-entry-state-trigger]')!;
    await act(async () => {
      trigger.click();
      await flush();
    });
    const option = [...window.document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (item) => item.textContent?.trim() === label,
    );
    expect(option).toBeDefined();
    await act(async () => {
      option!.click();
      await flush();
    });
  };

  try {
    await render();
    await choose('In progress');
    const firstReview = host.querySelector<HTMLElement>('[data-entry-state-review-card]')!;
    expect(firstReview.textContent).toContain(subject.label);
    expect(firstReview.textContent).toContain(subject.id);
    expect(firstReview.textContent).toContain('No personal entry');
    expect(firstReview.textContent).toContain('In progress');
    expect(saves).toHaveLength(0);
    expect(firstReview.getAttribute('aria-labelledby')).toBe(host.querySelector('h3')?.id);
    expect(host.querySelector('[data-entry-state-review]')?.className).toContain('flex-wrap');
    expect(firstReview.className).toContain('min-w-0');

    await act(async () => button(host, 'Edit choice').click());
    expect(host.querySelector('[data-entry-state-review-card]')).toBeNull();
    expect(host.querySelector('[data-entry-state-editing]')?.textContent).toContain('In progress');
    expect(window.document.activeElement?.hasAttribute('data-entry-state-trigger')).toBe(true);
    await choose('Planned');
    expect(host.querySelector('[data-entry-state-review-card]')?.textContent).toContain('Planned');
    await act(async () => button(host, 'Discard choice').click());
    expect(host.querySelector('[data-entry-state-review-card]')).toBeNull();
    expect(host.querySelector('[data-entry-state-editing]')).toBeNull();
    expect(window.document.activeElement?.hasAttribute('data-entry-state-trigger')).toBe(true);
    expect(saves).toHaveLength(0);

    await choose('In progress');
    const save = button(host, 'Save state');
    await act(async () => {
      save.click();
      save.click();
      await flush();
    });
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({
      subjectId: subject.id,
      subjectLabel: subject.label,
      state: 'in_progress',
      basis: null,
      originKey,
      lifetime: currentLife,
    });
    expect(host.querySelector('[data-entry-state-review-card]')).toBeNull();

    currentLife.active = false;
    entry = { subjectId: subject.id, state: 'future_state', revision: 7, incarnationId: 'incarnation-a' };
    receivedLabel = 'Other';
    currentLife = lifetime('entry-a2');
    active = currentLife;
    originKey = 'subject-a/en/entry-a2';
    await render();
    const trigger = host.querySelector<HTMLButtonElement>('[data-entry-state-trigger]')!;
    expect(trigger.textContent).toContain('Other');
    await act(async () => {
      trigger.click();
      await flush();
    });
    const unknown = [...window.document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (item) => item.textContent?.trim() === 'Other',
    );
    expect(unknown?.getAttribute('aria-disabled')).toBe('true');
    expect(
      [...window.document.querySelectorAll<HTMLElement>('[role="option"]')].some((item) =>
        item.textContent?.includes('future_state'),
      ),
    ).toBe(false);
    await act(async () => {
      [...window.document.querySelectorAll<HTMLElement>('[role="option"]')]
        .find((item) => item.textContent?.trim() === 'Planned')!
        .click();
      await flush();
    });
    expect(host.querySelector('[data-entry-state-review-card]')?.textContent).toContain('Other');
    expect(host.querySelector('[data-entry-state-review-card]')?.textContent).toContain('Planned');
    await act(async () => button(host, 'Discard choice').click());
    await act(async () => button(host, 'Review current state').click());
    const noChange = host.querySelector<HTMLElement>('[data-entry-state-review-card]')!;
    expect(noChange.textContent).toContain('Other');
    expect(noChange.textContent).toContain('No change will be sent.');
    await act(async () => button(host, 'Confirm no change').click());
    expect(host.querySelector('[data-entry-state-no-change-result]')?.textContent).toBe(
      'No change made. No request was sent.',
    );
    expect(saves).toHaveLength(1);

    await choose('Planned');
    await act(async () => button(host, 'Save state').click());
    expect(saves).toHaveLength(2);
    expect(saves[1]?.basis).toEqual({
      subjectId: subject.id,
      state: 'future_state',
      revision: 7,
      incarnationId: 'incarnation-a',
    });

    entry = { subjectId: subject.id, state: 'completed', revision: 8, incarnationId: 'incarnation-b' };
    originKey = 'subject-a/en/entry-a3';
    active = lifetime('entry-a3');
    conflict = {
      state: 'paused',
      stateLabel: 'Paused',
      stateLabelLanguage: 'en',
      originKey,
      hasAcceptedBasis: true,
      acceptedEntry: entry,
    };
    await render();
    expect(host.querySelector('[data-entry-state-conflict]')?.textContent).toContain('Completed');
    expect(host.querySelector('[data-entry-state-conflict]')?.textContent).toContain('Paused');
    await act(async () => button(host, 'Review this choice again').click());
    expect(host.querySelector('[data-entry-state-review-card]')?.textContent).toContain('Completed');
    expect(saves).toHaveLength(2);

    active.active = false;
    entry = { subjectId: subject.id, state: 'completed', revision: 9, incarnationId: 'incarnation-c' };
    originKey = 'subject-a/en/entry-a4';
    active = lifetime('entry-a4');
    conflict = null;
    await render();
    expect(host.querySelector('[data-entry-state-review-card]')).toBeNull();
    expect(host.textContent).not.toContain('Paused');
    expect(saves).toHaveLength(2);

    await act(async () => root.unmount());
    host.remove();
  } finally {
    if (host.isConnected) {
      await act(async () => root.unmount());
      host.remove();
    }
  }
});

test('missing profile options offer only truthful received fallback and no local state choices', async () => {
  const currentLife = lifetime('entry-unsupported');
  const currentEntry = { subjectId: subject.id, state: 'retired_state', revision: 4, incarnationId: null };
  let writes = 0;
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <SubjectEntryStateReview
          subject={subject}
          entry={currentEntry}
          receivedLabel="Other"
          stateOptions={[]}
          canRemove={false}
          originKey="unsupported-entry"
          lifetime={currentLife}
          disabled={false}
          busy={false}
          uncertain={false}
          conflict={null}
          onSave={async () => {
            writes++;
            return { result: 'saved' };
          }}
          onRemove={() => {}}
          onDismissConflict={() => {}}
        />,
      ),
    );
    const trigger = host.querySelector<HTMLButtonElement>('[data-entry-state-trigger]')!;
    expect(trigger.textContent).toContain('Other');
    await act(async () => {
      trigger.click();
      await flush();
    });
    const options = [...window.document.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(options.map((item) => item.textContent?.trim())).toEqual(['Other']);
    expect(options[0]?.getAttribute('aria-disabled')).toBe('true');
    await act(async () => button(host, 'Review current state').click());
    await act(async () => button(host, 'Confirm no change').click());
    expect(writes).toBe(0);
    expect(host.textContent).toContain('No change made. No request was sent.');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
