import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement as h, type ReactNode } from 'react';
import type { RelationTransport, RelationConfirmation } from '../src/subject/relation-candidates';

// Authored UNRUN. Actual mounted components + existing native-shaped fixture/transport;
// neither this DOM campaign nor typing proves browser geometry, private SSR or native authorization.
async function mounted() {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en', width: 390, height: 844 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    Element: window.Element,
    Node: window.Node,
    Text: window.Text,
    NodeFilter: window.NodeFilter,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    DOMRect: window.DOMRect,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { createRoot } = await import('react-dom/client');
  const storybook = dirname(Bun.resolveSync('storybook/test', import.meta.dir));
  const { within } = await import(Bun.resolveSync('@testing-library/dom', storybook));
  const { default: userEvent } = await import(Bun.resolveSync('@testing-library/user-event', storybook));
  const { RelationEditor, QualifierInput } = await import('../src/features/catalogue/relation-editor');
  const { relationFixture, relationProperty, relationActor, relationRole } =
    await import('../src/kernel/fake/catalogue-relations');
  const { ConnectedStory } = await import('../src/stories/connected-story');
  const { m } = await import('../src/paraglide/messages.js');
  const { setLocale } = await import('../src/paraglide/runtime');
  setLocale('en', { reload: false });
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const user = userEvent.setup({ document: window.document });
  const render = async (node: ReactNode) =>
    act(async () => root.render(h(ConnectedStory, { storyId: 'relation-family' }, node)));
  const click = async (region: HTMLElement, label: string) =>
    act(async () => user.click(within(region).getByRole('button', { name: label })));
  const select = async (region: HTMLElement, label: string, value: string) =>
    act(async () => user.selectOptions(within(region).getByRole('combobox', { name: label }), value));
  const region = () => within(host).getByRole('region', { name: m.relation_title() }) as HTMLElement;
  const confirm = async (scope: HTMLElement, action: string) => {
    await click(scope, action);
    const group = within(scope).getByRole('group', { name: m.candidate_confirm_title({ action }) }) as HTMLElement;
    expect(within(group).getByRole('heading', { level: 2, name: m.candidate_confirm_title({ action }) })).toBeTruthy();
    expect(group.className).toContain('motion-reduce:before:transition-none');
    // A deliberate keyboard stop reaches confirmation and then its separate Cancel control.
    const submit = within(group).getByRole('button', { name: action }) as HTMLElement;
    submit.focus();
    await act(async () => user.tab());
    expect(window.document.activeElement).toBe(within(group).getByRole('button', { name: m.candidate_cancel() }));
    await act(async () => user.tab({ shift: true }));
    expect(window.document.activeElement).toBe(submit);
    await act(async () => user.keyboard('{Enter}'));
  };
  return {
    window,
    host,
    user,
    within,
    render,
    click,
    select,
    region,
    confirm,
    RelationEditor,
    QualifierInput,
    relationFixture,
    relationProperty,
    relationActor,
    relationRole,
    m,
    setLocale,
    async close() {
      await act(async () => root.unmount());
      await window.happyDOM.close();
      mock.restore();
      for (const [key, descriptor] of previous)
        descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
    },
  };
}

test('Relation Editor proposal/exact-slot family keeps independent native associations, complete evidence and deliberate native review/recovery', async () => {
  const ui = await mounted();
  const {
    window,
    host,
    user,
    within,
    render,
    click,
    select,
    region,
    confirm,
    RelationEditor,
    relationFixture,
    relationProperty,
    relationActor,
    relationRole,
    m,
  } = ui;
  const long = 'Original credit — 旅人 العربية Édition complète '.repeat(8);
  const reference = `https://example.org/${'exact-reference-'.repeat(24)}?credit=original%2Brole#source`;
  const scalar = (property: string, content: string) => ({
    property: { id: property, data_type: 'string' as const },
    value: { type: 'value' as const, content },
  });
  const ownLabels = (scope: HTMLElement) => {
    for (const label of scope.querySelectorAll<HTMLLabelElement>('label[for]')) {
      const control = window.document.getElementById(label.htmlFor);
      expect(control).not.toBeNull();
      expect(scope.contains(control)).toBe(true);
      expect([...host.querySelectorAll('[id]')].filter((node) => node.id === label.htmlFor)).toHaveLength(1);
      expect(control!.matches('input,select,[role="checkbox"]')).toBe(true);
    }
  };
  const statementComplete = (scope: HTMLElement, credit = long) => {
    expect(scope.textContent).toContain('Aoi Yuki');
    expect(scope.textContent).toContain('The traveler');
    expect(scope.textContent).toContain(credit);
    expect(scope.textContent).toContain(reference);
    expect([...scope.querySelectorAll('a')].some((link) => link.href === reference)).toBe(true);
    expect(scope.querySelector('[data-slot="list-row-link"]')).toBeNull();
    expect(scope.querySelector('.truncate,.line-clamp-1,.line-clamp-2')).toBeNull();
  };
  try {
    // Independent standalone, embedded and composition mounts all use the real native read.
    // Long supplied qualifiers/references are never reconstructed from a private cache.
    const fixtures = [relationFixture(), relationFixture(), relationFixture()];
    for (const fixture of fixtures) {
      for (const statement of [fixture.original, fixture.candidate.statement, fixture.draft]) {
        statement.qualifiers[1] = scalar('wdt:P1932', long);
        statement.qualifiers.push(scalar('schema:position', '2'));
        statement.references[0]!.parts[0]!.value = { type: 'value', content: reference };
      }
    }
    const reads = await Promise.all(fixtures.map((fixture) => fixture.transport.read()));
    const counts = fixtures.map((fixture) => fixture.calls.length);
    const pair = () =>
      h(
        'div',
        { dir: 'rtl' },
        fixtures.map((fixture, index) =>
          h(RelationEditor, {
            key: `independent-${index}`,
            id: fixture.id,
            locale: 'en',
            initial: reads[index]!,
            embedded: index === 1,
            transport: fixture.transport,
            search: async () => [],
            ...(index === 2
              ? { composition: { statement: fixture.draft, slot: fixture.slot, positionEditable: true } }
              : {}),
          }),
        ),
      );
    await render(pair());
    const regions = within(host).getAllByRole('region', { name: m.relation_title() }) as HTMLElement[];
    expect(within(regions[0]!).getByRole('heading', { level: 1, name: m.relation_title() })).toBeTruthy();
    expect(within(regions[1]!).queryByRole('heading', { name: m.relation_title() })).toBeNull();
    expect(within(regions[2]!).getByRole('heading', { level: 2, name: m.relation_title() })).toBeTruthy();
    for (const scope of regions.slice(0, 2)) {
      await select(scope, m.relation_property(), relationProperty);
      await act(async () => user.click(within(scope).getAllByRole('button', { name: m.relation_edit_existing() })[0]!));
    }
    for (const scope of regions) {
      ownLabels(scope);
      for (const label of scope.querySelectorAll<HTMLLabelElement>('label[for]')) {
        const control = window.document.getElementById(label.htmlFor)!;
        if (!control.matches('input,select') || control.matches(':disabled')) continue;
        await act(async () => user.click(label));
        expect(window.document.activeElement).toBe(control);
        for (const other of regions.filter((node) => node !== scope))
          expect(other.contains(window.document.activeElement)).toBe(false);
      }
      const property = within(scope).getByRole('combobox', { name: m.relation_property() });
      expect(property.tagName).toBe('SELECT');
      expect(scope.querySelector('fieldset > legend [data-content-item-slot="title"]')?.tagName).toBe('H2');
      expect(scope.querySelector('fieldset')?.parentElement?.className).toContain(
        'has-[:focus-visible]:before:opacity-100',
      );
      expect(scope.querySelectorAll('input[id*="-qualifier-"]')).toHaveLength(2);
      expect(scope.querySelector('input[id$="qualifier-0"]')).toBeNull(); // Entity-valued P453 remains a picker.
      expect(scope.querySelector('input[id$="qualifier-1"]')).not.toBeNull();
      const label = [...scope.querySelectorAll<HTMLLabelElement>('label')].find((node) =>
        node.htmlFor.endsWith('-qualifier-1'),
      )!;
      const input = window.document.getElementById(label.htmlFor) as unknown as HTMLInputElement;
      expect(input.value).toBe(long);
      if (scope === regions[2]) expect(input.matches(':disabled')).toBe(true);
      else {
        await act(async () => user.click(label));
        expect(window.document.activeElement).toBe(input);
        for (const other of regions.filter((node) => node !== scope))
          expect(other.contains(window.document.activeElement)).toBe(false);
      }
      const citationLabel = [...scope.querySelectorAll<HTMLLabelElement>('label')].find(
        (node) => node.textContent === m.relation_citation(),
      )!;
      await act(async () => user.click(citationLabel));
      expect(window.document.activeElement?.id).toBe(citationLabel.htmlFor);
      for (const other of regions.filter((node) => node !== scope))
        expect(other.contains(window.document.activeElement)).toBe(false);
    }
    // Ordinary rerender retains ids and values; editing one scalar never changes a sibling editor.
    const beforeIds = [...host.querySelectorAll('label[for]')].map((label) => label.getAttribute('for'));
    await render(pair());
    expect([...host.querySelectorAll('label[for]')].map((label) => label.getAttribute('for'))).toEqual(beforeIds);
    const input = regions[0]!.querySelector('input[id$="qualifier-1"]') as HTMLInputElement;
    await act(async () => {
      await user.clear(input);
      await user.type(input, 'Only the first credit');
    });
    expect((regions[1]!.querySelector('input[id$="qualifier-1"]') as HTMLInputElement).value).toBe(long);
    expect((regions[2]!.querySelector('input[id$="qualifier-1"]') as HTMLInputElement).value).toBe(long);
    expect(fixtures.map((fixture) => fixture.calls.length)).toEqual(counts);

    // Own-consent controls use the actually released source-or-consent relation on Person.
    await render(null);
    const ownFixtures = [relationFixture(), relationFixture()];
    for (const fixture of ownFixtures) fixture.publicRead.subject.type = 'schema:Person';
    const ownReads = await Promise.all(ownFixtures.map((fixture) => fixture.transport.read()));
    await render(
      h(
        'div',
        null,
        ownFixtures.map((fixture, index) =>
          h(RelationEditor, {
            key: index,
            id: fixture.id,
            locale: 'en',
            initial: ownReads[index]!,
            embedded: index === 1,
            transport: fixture.transport,
            search: async () => [],
          }),
        ),
      ),
    );
    const ownRegions = within(host).getAllByRole('region', { name: m.relation_title() }) as HTMLElement[];
    for (const scope of ownRegions) {
      await select(scope, m.relation_property(), 'rezics:penNameOf');
      ownLabels(scope);
    }
    const checkboxes = ownRegions.map((scope) =>
      within(scope).getByRole('checkbox', { name: m.statement_consent_own() }),
    );
    const ownLabel = [...ownRegions[1]!.querySelectorAll<HTMLLabelElement>('label')].find(
      (node) => node.textContent === m.statement_consent_own(),
    )!;
    expect(ownLabel.htmlFor).toBe(checkboxes[1]!.id);
    await act(async () => user.click(ownLabel));
    expect(checkboxes[0]!.getAttribute('aria-checked')).toBe('false');
    expect(checkboxes[1]!.getAttribute('aria-checked')).toBe('true');
    checkboxes[1]!.focus();
    await act(async () => user.keyboard(' '));
    expect(checkboxes[1]!.getAttribute('aria-checked')).toBe('false');
    expect(ownFixtures.map((fixture) => fixture.calls.length)).toEqual([1, 1]);
    expect(ownRegions[1]!.textContent).toContain(m.statement_consent_unsourced());

    // Rank labels belong to separate accepted-candidate review panels, without adoption.
    await render(null);
    const rankFixtures = [relationFixture(), relationFixture()];
    for (const fixture of rankFixtures) fixture.candidate.decision = 'accepted';
    const rankReads = await Promise.all(rankFixtures.map((fixture) => fixture.transport.read(fixture.slot)));
    const rankCounts = rankFixtures.map((fixture) => fixture.calls.length);
    await render(
      h(
        'div',
        null,
        rankFixtures.map((fixture, index) =>
          h(RelationEditor, {
            key: index,
            id: fixture.id,
            locale: 'en',
            initial: rankReads[index]!,
            embedded: index === 1,
            transport: fixture.transport,
            search: async () => [],
            composition: { statement: fixture.draft, slot: fixture.slot, positionEditable: true },
          }),
        ),
      ),
    );
    const rankRegions = within(host).getAllByRole('region', { name: m.relation_title() }) as HTMLElement[];
    for (const scope of rankRegions) {
      await click(scope, m.candidate_review());
      ownLabels(scope);
      const rank = within(scope).getByRole('combobox', { name: m.relation_rank() });
      const label = [...scope.querySelectorAll<HTMLLabelElement>('label')].find((node) => node.htmlFor === rank.id)!;
      await act(async () => user.click(label));
      expect(window.document.activeElement).toBe(rank);
      expect(rankRegions.find((other) => other !== scope)!.contains(window.document.activeElement)).toBe(false);
    }
    await select(rankRegions[0]!, m.relation_rank(), 'preferred');
    expect(
      (within(rankRegions[1]!).getByRole('combobox', { name: m.relation_rank() }) as HTMLSelectElement).value,
    ).toBe('normal');
    expect(rankFixtures.map((fixture) => fixture.calls.length)).toEqual(rankCounts);

    // Native proposal -> independent accept -> deliberate reload -> independent adopt.
    await render(null);
    const journey = relationFixture();
    const commands: RelationConfirmation[] = [];
    const transport: RelationTransport = {
      ...journey.transport,
      confirm: (command) => {
        commands.push(structuredClone(command));
        return journey.transport.confirm(command);
      },
    };
    const initial = await journey.transport.read();
    let selected = 0;
    await render(
      h(RelationEditor, {
        id: journey.id,
        locale: 'en',
        initial,
        transport,
        search: async () => [],
        composition: { statement: journey.draft, slot: journey.slot, positionEditable: true },
        onSelected: () => {
          selected++;
        },
      }),
    );
    await confirm(region(), m.relation_propose());
    expect(region().textContent).toContain(m.relation_proposed());
    expect(journey.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    const proposal = journey.calls.find((call) => call.method === 'POST')!;
    expect(proposal.body).toEqual({
      statement: {
        property: { id: relationProperty },
        value: { type: 'value', content: relationActor },
        qualifiers: [
          { property: { id: 'wdt:P453' }, value: { type: 'value', content: relationRole } },
          { property: { id: 'wdt:P1932' }, value: { type: 'value', content: 'Original credit' } },
        ],
        references: [
          {
            parts: [
              { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.org/credits' } },
            ],
          },
        ],
      },
    });
    expect(proposal.authorization).toBe('Bearer fixture');
    expect(proposal.session).toBe('relation-session');
    expect(proposal.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(selected).toBe(0);
    await confirm(region(), m.candidate_accept());
    expect(commands[0]).toMatchObject({ operation: 'accept', head: null, slot: journey.slot });
    expect(region().textContent).toContain(m.candidate_accepted());
    expect(journey.adopted).toBe(false);
    expect(within(region()).queryByRole('link', { name: m.candidate_view_public() })).toBeNull();
    await click(region(), m.candidate_reload());
    await act(async () => user.click(within(region()).getAllByRole('button', { name: m.candidate_review() }).at(-1)!));
    ownLabels(region());
    expect(within(region()).getByRole('heading', { level: 2, name: m.relation_review_slot() })).toBeTruthy();
    for (const name of [m.candidate_current(), m.candidate_proposed()])
      expect(within(region()).getByRole('heading', { level: 3, name })).toBeTruthy();
    await select(region(), m.relation_rank(), 'preferred');
    await confirm(region(), m.candidate_adopt());
    expect(commands[1]).toMatchObject({ operation: 'adopt', head: 7, rank: 'preferred', slot: journey.slot });
    expect(commands[1]!.key).not.toBe(commands[0]!.key);
    expect(selected).toBe(1);
    expect(region().textContent).toContain(m.candidate_selected());
    expect(within(region()).getByRole('link', { name: m.candidate_view_public() })).toBeTruthy();
    expect(journey.calls.find((call) => call.path.endsWith(':adopt'))!.body).toMatchObject({
      ...journey.slot,
      expected_head: 7,
      selection: [{ candidate: journey.candidates.at(-1)!.id, rank: 'preferred' }],
    });
    expect(journey.calls.filter((call) => call.method === 'GET')).toHaveLength(13);
    expect(journey.calls.filter((call) => call.method === 'POST')).toHaveLength(3);

    // Exact immutable uncertain replay and truthful empty/denied/stale/invalid/unavailable/pending states.
    for (const scenario of [
      'empty',
      'denied',
      'stale',
      'invalid',
      'unavailable',
      'pending',
      'lost-response',
      'retracted',
    ] as const) {
      await render(null);
      const fixture = relationFixture(scenario);
      if (scenario === 'stale') fixture.candidate.decision = 'accepted';
      const supplied = await fixture.transport.read();
      await render(
        h(RelationEditor, {
          key: scenario,
          id: fixture.id,
          locale: 'en',
          initial: supplied,
          transport: fixture.transport,
          search: async () => [],
          composition: { statement: fixture.draft, slot: fixture.slot, positionEditable: true },
        }),
      );
      await click(region(), m.relation_review_slot());
      if (scenario === 'empty') {
        expect(region().textContent).toContain(m.candidate_empty());
        continue;
      }
      if (scenario === 'denied' || scenario === 'unavailable') {
        expect(within(region()).getByRole('alert').textContent).toContain(
          scenario === 'denied' ? m.candidate_denied() : m.candidate_unavailable(),
        );
        expect(region().querySelector('[data-relation-statement]')).toBeNull();
        if (scenario === 'unavailable') {
          await click(region(), m.statement_consent_retry_page());
          expect(within(region()).getByRole('button', { name: m.candidate_review() })).toBeTruthy();
        }
        continue;
      }
      // Retraction must be present in the returned DTO, not inferred from a fixture mode switch.
      if (scenario === 'retracted') {
        fixture.candidate.retracted = 4;
        await click(region(), m.candidate_reload());
        expect(
          (within(region()).getByRole('button', { name: m.candidate_retracted() }) as HTMLButtonElement).disabled,
        ).toBe(true);
        continue;
      }
      await click(region(), m.candidate_review());
      const decision = scenario === 'stale' ? m.candidate_adopt() : m.candidate_accept();
      await confirm(region(), decision);
      if (scenario === 'stale' || scenario === 'invalid') {
        expect(within(region()).getByRole('alert').textContent).toContain(
          scenario === 'stale' ? m.relation_stale() : m.candidate_invalid(),
        );
        const group = within(region()).getByRole('group', {
          name: m.candidate_confirm_title({ action: decision }),
        });
        expect((within(group).getByRole('button', { name: decision }) as HTMLButtonElement).disabled).toBe(true);
        expect(region().textContent).toContain('Original credit');
        continue;
      }
      await click(region(), m.candidate_reload());
      await click(region(), m.candidate_review());
      await confirm(region(), m.candidate_adopt());
      if (scenario === 'pending') {
        expect(region().textContent).toContain(m.candidate_pending());
        expect(within(region()).queryByRole('link', { name: m.candidate_view_public() })).toBeNull();
      } else {
        expect(within(region()).getByRole('alert').textContent).toContain(m.candidate_unavailable());
        const frozen = structuredClone(fixture.calls.find((call) => call.path.endsWith(':adopt'))!);
        expect(within(region()).queryByRole('button', { name: m.candidate_reload() })).toBeNull();
        const group = within(region()).getByRole('group', {
          name: m.candidate_confirm_title({ action: m.candidate_adopt() }),
        });
        expect((within(group).getByRole('button', { name: m.candidate_cancel() }) as HTMLButtonElement).disabled).toBe(
          true,
        );
        await click(group, m.candidate_adopt());
        expect(fixture.calls.filter((call) => call.path.endsWith(':adopt'))).toEqual([frozen, frozen]);
        expect(region().textContent).toContain(m.candidate_selected());
      }
    }

    // Deprecated acceptance does not unlock a review/adoption action.
    await render(null);
    const deprecated = relationFixture();
    deprecated.candidate.decision = 'accepted';
    deprecated.candidate.rank = 'deprecated';
    const deprecatedRead = await deprecated.transport.read(deprecated.slot);
    await render(
      h(RelationEditor, {
        id: deprecated.id,
        locale: 'en',
        initial: deprecatedRead,
        transport: deprecated.transport,
        search: async () => [],
        composition: { statement: deprecated.draft, slot: deprecated.slot, positionEditable: false },
      }),
    );
    expect(
      (within(region()).getByRole('button', { name: m.relation_deprecated() }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(within(region()).queryByRole('button', { name: m.candidate_adopt() })).toBeNull();
    expect(deprecated.calls.filter((call) => call.method === 'POST')).toHaveLength(0);

    // A real native read can finish late; retiring its mount cannot render or move focus.
    await render(null);
    const retired = relationFixture();
    const retiredRead = await retired.transport.read();
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const delivery = new Promise<void>((resolve) => {
      release = resolve;
    });
    const late: RelationTransport = {
      ...retired.transport,
      read: async (...args) => {
        const result = await retired.transport.read(...args);
        entered();
        await delivery;
        return result;
      },
    };
    await render(
      h(RelationEditor, {
        id: retired.id,
        locale: 'en',
        initial: retiredRead,
        transport: late,
        search: async () => [],
        composition: { statement: retired.draft, slot: retired.slot, positionEditable: true },
      }),
    );
    await click(region(), m.relation_review_slot());
    await pending;
    expect(region().getAttribute('aria-busy')).toBe('true');
    expect(region().textContent).toContain(m.candidate_loading());
    await render(h('button', null, 'Fresh reading'));
    const fresh = host.querySelector('button')!;
    fresh.focus();
    const retiredCalls = retired.calls.length;
    await act(async () => release());
    expect(retired.calls).toHaveLength(retiredCalls);
    expect(window.document.activeElement).toBe(fresh);
    expect(within(host).queryByRole('region', { name: m.relation_title() })).toBeNull();

    // Unresolved external identity retains its exact reference and somevalue meaning.
    await render(null);
    const unresolved = relationFixture('unresolved');
    const externalSlot = { property: 'schema:author', sameAs: 'https://example.org/people/original' };
    const externalRead = await unresolved.transport.read(externalSlot);
    await render(
      h(RelationEditor, {
        id: unresolved.id,
        locale: 'en',
        initial: externalRead,
        transport: unresolved.transport,
        search: async () => [],
        composition: { statement: unresolved.draft, slot: externalSlot, positionEditable: false },
      }),
    );
    expect(region().textContent).toContain(m.relation_unresolved());
    expect(region().textContent).toContain(externalSlot.sameAs);
    expect((within(region()).getByRole('combobox', { name: m.relation_target() }) as HTMLInputElement).value).toBe('');
    expect(unresolved.calls.find((call) => call.path.endsWith('/candidates'))!.query).toMatchObject(externalSlot);
    expect(unresolved.calls.find((call) => call.path.endsWith('/candidates'))!.query.target).toBeUndefined();

    // Supplied-data growth only: 1/8/64 reference parts fit in <=8 references of <=8 parts,
    // inside the native 16x16 reference bound. No claim about database examined work.
    for (const count of [1, 8, 64]) {
      await render(null);
      const fixture = relationFixture();
      const references = Array.from({ length: Math.ceil(count / 8) }, (_, group) => ({
        hash: `reference-${group}`,
        parts: Array.from({ length: Math.min(8, count - group * 8) }, (_, at) => ({
          property: { id: 'schema:url', data_type: 'url' as const },
          value: { type: 'value' as const, content: `https://example.org/evidence/${group * 8 + at}` },
        })),
      }));
      fixture.original.references = references;
      fixture.candidate.statement.references = structuredClone(references);
      const supplied = await fixture.transport.read(fixture.slot);
      if (!supplied.ok) throw new Error('Expected supplied native-shaped reading');
      // Point lookups are allowed; any hidden enumeration of unrelated populations fails.
      const noEnumeration = <T extends object>(value: T): T =>
        new Proxy(value, {
          ownKeys() {
            throw new Error('Whole-population traversal');
          },
        });
      supplied.public.related = noEnumeration(supplied.public.related);
      supplied.names = noEnumeration(supplied.names);
      const readCount = fixture.calls.length;
      await render(
        h(RelationEditor, {
          key: count,
          id: fixture.id,
          locale: 'en',
          initial: supplied,
          transport: fixture.transport,
          search: async () => [],
          composition: { statement: { ...fixture.draft, references }, slot: fixture.slot, positionEditable: false },
        }),
      );
      await click(region(), m.candidate_review());
      for (const statement of region().querySelectorAll<HTMLElement>('[data-relation-statement]')) {
        expect(statement.querySelectorAll('a[href^="https://example.org/evidence/"]')).toHaveLength(count);
        expect(statement.querySelectorAll('*').length).toBeLessThan(30 + count * 5);
      }
      await click(region(), m.relation_propose());
      const group = within(region()).getByRole('group', {
        name: m.candidate_confirm_title({ action: m.relation_propose() }),
      });
      expect(group.querySelectorAll('a[href^="https://example.org/evidence/"]')).toHaveLength(count);
      expect(fixture.calls).toHaveLength(readCount);
      expect(fixture.calls.filter((call) => call.path.endsWith('/candidates'))[0]!.query.limit).toBe('20');
    }

    // Long supplied review values and references remain complete at either declared width and RTL.
    for (const width of [390, 1280]) {
      window.happyDOM.setWindowSize({ width, height: 900 });
      for (const [direction, locale] of [
        ['ltr', 'de'],
        ['rtl', 'ja'],
      ] as const) {
        await render(null);
        ui.setLocale(locale, { reload: false });
        const fixture = fixtures[0]!;
        const supplied = await fixture.transport.read(fixture.slot);
        const before = fixture.calls.length;
        await render(
          h(
            'div',
            { dir: direction },
            h(RelationEditor, {
              key: `${width}-${direction}`,
              id: fixture.id,
              locale,
              initial: supplied,
              transport: fixture.transport,
              search: async () => [],
              composition: { statement: fixture.draft, slot: fixture.slot, positionEditable: true },
            }),
          ),
        );
        await click(region(), m.candidate_review());
        for (const statement of region().querySelectorAll<HTMLElement>('[data-relation-statement]'))
          statementComplete(statement);
        await click(region(), m.relation_propose());
        statementComplete(
          within(region()).getByRole('group', { name: m.candidate_confirm_title({ action: m.relation_propose() }) }),
        );
        expect(fixture.calls).toHaveLength(before);
      }
    }

    ui.setLocale('en', { reload: false });

    // Work Parts' scalar qualifier-0 suffix and standalone QualifierInput consumers remain supported.
    await render(null);
    await render(
      h(
        'div',
        null,
        [0, 1].map((index) =>
          h(ui.QualifierInput, {
            key: index,
            index: 0,
            definition: undefined,
            snak: scalar('schema:position', '3'),
            label: `Position ${index}`,
            search: async () => [],
            target: () => [],
            remember: () => {},
            disabled: false,
            onChange: () => {},
          }),
        ),
      ),
    );
    const positions = host.querySelectorAll('input[id$="qualifier-0"]');
    expect(positions).toHaveLength(2);
    expect(positions[0]!.id).not.toBe(positions[1]!.id);
    ownLabels(host);
  } finally {
    await ui.close();
  }
}, 60_000);

test('initial Relation Open orients only admitted keyboard results after its opener disappears', async () => {
  const ui = await mounted();
  const { render, region, within, user, m, RelationEditor, relationFixture, window } = ui;
  const outside = window.document.createElement('button');
  window.document.body.append(outside);
  try {
    const fixture = relationFixture();
    const ready = await fixture.transport.read();
    if (!ready.ok) throw new Error('Expected admitted relation fields');
    for (const state of 'standalone embedded empty context failed denied moved pointer retired'.split(' ')) {
      let finish!: (read: Awaited<ReturnType<RelationTransport['read']>>) => void;
      const pending = new Promise<Awaited<ReturnType<RelationTransport['read']>>>((resolve) => (finish = resolve));
      let reads = 0;
      await render(
        h(RelationEditor, {
          key: state,
          id: fixture.id,
          locale: 'en',
          embedded: state === 'embedded',
          search: async () => [],
          transport: {
            ...fixture.transport,
            read: () => {
              reads++;
              return pending;
            },
          },
        }),
      );
      const opener = within(region()).getByRole('button', { name: m.relation_open() });
      opener.focus();
      await act(async () => (state === 'pointer' ? user.click(opener) : user.keyboard('{Enter}')));
      expect(opener.isConnected).toBe(false);
      if (state === 'moved') outside.focus();
      if (state === 'retired') {
        await render(null);
        outside.focus();
      }
      await act(async () =>
        finish(
          state === 'failed' || state === 'denied'
            ? { ok: false, reason: state === 'failed' ? 'unavailable' : 'denied' }
            : state === 'empty'
              ? { ...ready, fields: [] }
              : state === 'context'
                ? { ...ready, public: { ...ready.public, subject: { ...ready.public.subject, context: 'other' } } }
                : ready,
        ),
      );
      expect(reads).toBe(1);
      if (state === 'retired' || state === 'moved') expect(window.document.activeElement).toBe(outside);
      else if (state === 'pointer')
        expect(window.document.activeElement).not.toBe(
          within(region()).getByRole('combobox', { name: m.relation_property() }),
        );
      else if (state === 'failed' || state === 'denied')
        expect(window.document.activeElement).toBe(within(region()).getByRole('alert'));
      else if (state === 'empty' || state === 'context')
        expect(window.document.activeElement?.textContent).toBe(
          state === 'empty' ? m.relation_no_fields() : m.relation_context(),
        );
      else
        expect(window.document.activeElement).toBe(
          within(region()).getByRole('combobox', { name: m.relation_property() }),
        );
    }
  } finally {
    outside.remove();
    await ui.close();
  }
});

test('Relation candidate recovery repeats the failed page and explicitly restarts or retires the slot', async () => {
  const ui = await mounted();
  const { render, click, region, within, m, RelationEditor, relationFixture } = ui;
  try {
    const fixture = relationFixture();
    const ready = await fixture.transport.read(fixture.slot);
    if (!ready.ok || !ready.page) throw new Error('Expected candidate page');
    const calls: unknown[][] = [];
    let outcome: 'empty' | 'failed' | 'denied' | 'late' = 'empty';
    let release!: (value: typeof ready) => void;
    const transport: RelationTransport = {
      ...fixture.transport,
      read: async (...args) => {
        calls.push(structuredClone(args));
        if (outcome === 'late')
          return await new Promise((resolve) => {
            release = resolve;
          });
        if (outcome === 'denied') return { ok: false, reason: 'denied' };
        if (args[1] === 'next-page' && outcome === 'failed') throw new Error('Connection lost');
        return { ...ready, session: 'read-token', page: { ...ready.page!, candidates: [], next: 'next-page' } };
      },
    };
    const editor = (slot = fixture.slot) =>
      h(RelationEditor, {
        id: fixture.id,
        locale: 'en',
        initial: ready,
        transport,
        search: async () => [],
        composition: { statement: fixture.draft, slot, positionEditable: true, session: 'original-token' },
      });
    await render(editor());
    await click(region(), m.candidate_review());
    await click(region(), m.relation_review_slot());
    expect(region().textContent).toContain(m.candidate_empty());
    expect(within(region()).queryByRole('button', { name: m.candidate_accept() })).toBeNull();
    outcome = 'failed';
    await click(region(), m.candidate_more());
    const failedAddress = structuredClone(calls.at(-1));
    expect(failedAddress).toEqual([fixture.slot, 'next-page', 'read-token']);
    expect(within(region()).queryByRole('button', { name: m.candidate_more() })).toBeNull();
    await click(region(), m.statement_consent_retry_page());
    expect(calls.at(-1)).toEqual(failedAddress);
    outcome = 'empty';
    await click(region(), m.statement_consent_restart());
    expect(calls.at(-1)).toEqual([fixture.slot, undefined, 'read-token']);
    outcome = 'denied';
    await click(region(), m.candidate_more());
    expect(region().querySelector('[data-relation-statement]')).toBeNull();
    expect(within(region()).queryByRole('button', { name: m.candidate_review() })).toBeNull();
    outcome = 'late';
    await click(region(), m.statement_consent_retry_page());
    const nextSlot = { ...fixture.slot, key: fixture.id };
    await render(editor(nextSlot));
    expect(within(region()).queryByRole('button', { name: m.statement_consent_retry_page() })).toBeNull();
    await act(async () => release(ready));
    expect(region().textContent).not.toContain(m.candidate_denied());
    outcome = 'empty';
    await click(region(), m.relation_review_slot());
    expect(calls.at(-1)).toEqual([nextSlot, undefined, 'original-token']);
  } finally {
    await ui.close();
  }
});

test('Relation page completion belongs only to its initiating current keyboard reader', async () => {
  const ui = await mounted();
  const { render, region, within, user, m, RelationEditor, relationFixture, window } = ui;
  const outside = window.document.createElement('button');
  window.document.body.append(outside);
  try {
    const fixture = relationFixture();
    const ready = await fixture.transport.read(fixture.slot);
    if (!ready.ok || !ready.page) throw new Error('Expected candidate page');
    const page = { ...ready, page: { ...ready.page, next: 'next-page' } };
    for (const scenario of `more:page more:empty more:failed more:pointer more:background more:moved
      more:tab more:blur more:retired more:replaced retry:keep retry:lost retry:return retry:failed
      retry:pointer restart:keep restart:lost reload:keep reload:lost`.split(/\s+/)) {
      const [action, mode] = scenario.split(':');
      const calls: unknown[][] = [];
      let finish!: (read: Awaited<ReturnType<RelationTransport['read']>>) => void;
      const transport: RelationTransport = {
        ...fixture.transport,
        read: (...args) => {
          calls.push(structuredClone(args));
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      };
      const editor = (key: string) =>
        h(RelationEditor, {
          key,
          id: fixture.id,
          locale: 'en',
          initial: page,
          transport,
          search: async () => [],
          composition: {
            statement: fixture.draft,
            slot: fixture.slot,
            positionEditable: true,
            session: 'original-token',
          },
        });
      outside.focus();
      await render(editor(scenario));
      if (action === 'restart') {
        await ui.click(region(), m.candidate_reload());
        await act(async () => finish(page));
        calls.length = 0;
      }
      if (action === 'retry') {
        await ui.click(region(), m.candidate_more());
        await act(async () => finish({ ok: false, reason: 'unavailable' }));
      }
      const label =
        action === 'more'
          ? m.candidate_more()
          : action === 'retry'
            ? m.statement_consent_retry_page()
            : action === 'restart'
              ? m.statement_consent_restart()
              : m.candidate_reload();
      const opener = within(region()).getByRole('button', { name: label });
      if (mode !== 'background') opener.focus();
      await act(async () =>
        mode === 'pointer' ? user.click(opener) : mode === 'background' ? opener.click() : user.keyboard('{Enter}'),
      );
      if (mode === 'moved' || mode === 'return') outside.focus();
      if (mode === 'return') opener.focus();
      if (mode === 'lost') opener.blur(); // Native disabling can leave focus on the document.
      if (mode === 'tab') await act(async () => user.tab());
      if (mode === 'blur') window.dispatchEvent(new window.Event('blur'));
      if (mode === 'retired' || mode === 'replaced') {
        await render(mode === 'retired' ? null : editor('replacement'));
        outside.focus();
      }
      const before = window.document.activeElement;
      await act(async () =>
        finish(
          mode === 'failed'
            ? { ok: false, reason: 'unavailable' }
            : mode === 'empty'
              ? { ...page, page: { ...page.page, candidates: [] } }
              : page,
        ),
      );
      expect(calls).toHaveLength(action === 'retry' ? 2 : 1);
      expect(calls.at(-1)).toEqual([
        fixture.slot,
        action === 'more' || action === 'retry' ? 'next-page' : undefined,
        'original-token',
      ]);
      if (mode === 'page' || mode === 'lost')
        expect(window.document.activeElement).toBe(
          within(region()).getByRole('region', { name: m.relation_review_slot() }),
        );
      else if (mode === 'empty') expect(window.document.activeElement?.textContent).toBe(m.candidate_empty());
      else if (mode === 'failed' && action === 'more')
        expect(window.document.activeElement).toBe(within(region()).getByRole('alert'));
      else expect(window.document.activeElement).toBe(before);
    }
  } finally {
    outside.remove();
    await ui.close();
  }
});

test('relation editor keeps an edited proposal on Stay and leaves only after an explicit choice', async () => {
  const ui = await mounted();
  const { host, window, render, user, within, RelationEditor, relationFixture, m, confirm } = ui;
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, Link, Outlet, RouterProvider } =
    await import('@tanstack/react-router');
  const fixture = relationFixture();
  const initial = await fixture.transport.read();
  let arrivals = 0;
  const rootRoute = createRootRoute({ component: Outlet });
  const editorRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/relation-edit',
    component: () =>
      h(
        'div',
        null,
        h(Link, { to: '/subject' }, 'Back to subject'),
        h(RelationEditor, {
          id: fixture.id,
          locale: 'en',
          initial,
          transport: fixture.transport,
          search: async () => [],
          composition: { statement: fixture.draft, slot: fixture.slot, positionEditable: true },
        }),
      ),
  });
  const subjectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/subject',
    onEnter: () => arrivals++,
    component: () => h('h1', null, 'Subject'),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([editorRoute, subjectRoute]),
    history: createMemoryHistory({ initialEntries: ['/subject', '/relation-edit'] }),
  });
  const goToSubject = () => act(async () => user.click(within(host).getByRole('link', { name: 'Back to subject' })));
  const backToEditor = () => act(async () => router.history.back());
  try {
    await router.load();
    await render(h(RouterProvider, { router }));
    const region = ui.region();
    const citation = within(region).getByRole('textbox', { name: m.relation_citation() }) as HTMLInputElement;
    await act(async () => user.type(citation, 'https://example.org/new-source'));
    const unload = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    await goToSubject();
    const dialog = window.document.querySelector('[role="alertdialog"]')!;
    await act(async () => user.click(within(dialog).getByRole('button', { name: m.thread_authoring_stay() })));
    expect(router.state.location.pathname).toBe('/relation-edit');
    expect(region.textContent).toContain('Aoi Yuki');
    expect(region.textContent).toContain('The traveler');
    expect(region.textContent).toContain('Original credit');
    expect([...region.querySelectorAll('a')].some((link) => link.href === 'https://example.org/credits')).toBe(true);
    expect(citation.value).toBe('https://example.org/new-source');
    expect(fixture.calls.filter((call) => call.method === 'POST')).toHaveLength(0);

    await act(async () => user.clear(citation));
    await goToSubject();
    expect(window.document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(router.state.location.pathname).toBe('/subject');
    await backToEditor();

    const secondCitation = within(ui.region()).getByRole('textbox', { name: m.relation_citation() });
    await act(async () => user.type(secondCitation, 'https://example.org/new-source'));
    await goToSubject();
    const leaveDialog = window.document.querySelector('[role="alertdialog"]')!;
    await act(async () => user.click(within(leaveDialog).getByRole('button', { name: m.thread_authoring_leave() })));
    expect(router.state.location.pathname).toBe('/subject');
    expect(arrivals).toBe(2);
    await backToEditor();

    await confirm(ui.region(), m.relation_propose());
    await goToSubject();
    expect(window.document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(router.state.location.pathname).toBe('/subject');
    expect(arrivals).toBe(3);
  } finally {
    await ui.close();
  }
}, 60_000);

// Retain callbacks from the real mounted controls, including composite picker/consent props.
function relationControlProps(node: Element): Record<string, unknown> {
  const key = Object.keys(node).find((key) => key.startsWith('__reactProps'))!;
  return Reflect.get(node, key);
}
function relationCallback(node: Element, event: string): (value?: unknown) => void {
  return relationControlProps(node)[event] as (value?: unknown) => void;
}
function relationChildCallback(node: Element, event: string): (value: unknown) => void {
  const children = relationControlProps(node.closest('[data-slot="field"]')!).children as {
    props?: Record<string, (value: unknown) => void>;
  }[];
  return children.find((child) => typeof child.props?.[event] === 'function')!.props![event]!;
}

test('Relation draft revisions retire retained input callbacks while current mounted controls keep editing', async () => {
  const ui = await mounted();
  const { render, select, click, region, within, user, RelationEditor, relationFixture, relationProperty, m } = ui;
  try {
    const fixture = relationFixture();
    const ready = await fixture.transport.read();
    await render(
      h(RelationEditor, {
        id: fixture.id,
        locale: 'en',
        initial: ready,
        transport: fixture.transport,
        search: async () => [],
      }),
    );
    const scope = region();
    await select(scope, m.relation_property(), relationProperty);
    const sources = () => within(scope).getAllByRole('button', { name: m.relation_edit_existing() });
    await act(async () => user.click(sources()[0]!));
    const scalar = () => scope.querySelector('input[id*="-qualifier-"]') as HTMLInputElement;
    const citation = () => within(scope).getByRole('textbox', { name: m.relation_citation() }) as HTMLInputElement;
    const capture = () => {
      const target = relationChildCallback(scope.querySelector('[data-slot="entity-picker"]')!, 'onValueChange');
      const value = relationCallback(scalar(), 'onChange');
      const add = relationCallback(within(scope).getByRole('combobox', { name: m.relation_qualifier() }), 'onChange');
      const cite = relationCallback(citation(), 'onChange');
      const attach = relationCallback(
        within(scope).getByRole('button', { name: m.relation_add_citation() }),
        'onClick',
      );
      const stage = relationCallback(sources()[0]!, 'onClick');
      return () => {
        target([{ id: fixture.id, title: 'Retired target', types: [], typeLabel: '', cover: null }]);
        value({ target: { value: 'Retired qualifier' } });
        add({ target: { value: 'wdt:P1932' } });
        cite({ target: { value: 'https://retired.test' } });
        attach();
        stage();
      };
    };
    await act(async () => user.type(citation(), 'https://example.org/unsent'));
    const oldSource = capture();
    await act(async () => user.click(sources()[2]!));
    await act(async () => oldSource());
    expect((within(scope).getByRole('combobox', { name: m.relation_target() }) as HTMLInputElement).value).toBe(
      'Kana Hanazawa',
    );
    expect(scalar().value).toBe('Original credit');
    expect(citation().value).toBe('');
    expect(scope.querySelectorAll('button[aria-label^="' + m.relation_remove() + ':"]')).toHaveLength(2);
    const current = scalar();
    await act(async () => {
      await user.clear(current);
      await user.type(current, 'Current credit');
    });
    expect(scalar()).toBe(current);
    expect(current.value).toBe('Current credit');
    const oldQualifier = relationCallback(current, 'onChange');
    await act(async () => user.click(scope.querySelector('button[aria-label^="' + m.relation_remove() + ':"]')!));
    await act(async () => oldQualifier({ target: { value: 'Retired shifted qualifier' } }));
    expect(scalar().value).toBe('Current credit');
    expect(scope.querySelectorAll('button[aria-label^="' + m.relation_remove() + ':"]')).toHaveLength(1);
    const oldProperty = capture();
    await select(scope, m.relation_property(), '');
    await select(scope, m.relation_property(), relationProperty);
    await act(async () => oldProperty());
    expect(scope.querySelector('input[id*="-qualifier-"]')).toBeNull();
    expect((within(scope).getByRole('combobox', { name: m.relation_target() }) as HTMLInputElement).value).toBe('');
    expect(citation().value).toBe('');
    expect(fixture.calls.filter((call) => call.method === 'POST')).toHaveLength(0);

    await render(null);
    fixture.publicRead.subject.type = 'schema:Person';
    await render(
      h(RelationEditor, {
        id: fixture.id,
        locale: 'en',
        initial: await fixture.transport.read(),
        transport: fixture.transport,
        search: async () => [],
      }),
    );
    await select(region(), m.relation_property(), 'rezics:penNameOf');
    const consent = () => within(region()).getByRole('checkbox', { name: m.statement_consent_own() });
    const oldConsent = relationChildCallback(consent(), 'onCheckedChange');
    await select(region(), m.relation_property(), '');
    await select(region(), m.relation_property(), 'rezics:penNameOf');
    await act(async () => oldConsent(true));
    expect(consent().getAttribute('aria-checked')).toBe('false');
    await act(async () => user.click(consent()));
    expect(consent().getAttribute('aria-checked')).toBe('true');
  } finally {
    await ui.close();
  }
});

test('Relation qualifier choice stages without draft mutation; only a current explicit Add admits and orients', async () => {
  const ui = await mounted();
  const {
    window,
    host,
    user,
    within,
    render,
    click,
    select,
    region,
    RelationEditor,
    relationFixture,
    relationProperty,
    m,
  } = ui;
  try {
    const fixture = relationFixture();
    const initial = await fixture.transport.read();
    let dirty = false;
    const editor = (positionEditable = true) =>
      h(RelationEditor, {
        id: fixture.id,
        locale: 'en',
        initial,
        transport: fixture.transport,
        search: async () => [],
        composition: { statement: fixture.draft, slot: fixture.slot, positionEditable },
        navigation: (state) => {
          dirty = state.dirty;
          return null;
        },
      });
    await render(editor());
    const chooser = within(region()).getByRole('combobox', { name: m.relation_qualifier() }) as HTMLSelectElement;
    const add = () => within(region()).getByRole('button', { name: m.relation_add_qualifier() }) as HTMLButtonElement;
    chooser.focus();
    // A native keyboard selection emits change; happy-dom does not implement select arrow defaults.
    await act(async () => {
      await user.keyboard('{ArrowDown}');
      chooser.value = 'schema:position';
      chooser.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    expect(chooser.value).toBe('schema:position');
    expect(dirty).toBe(false);
    expect(region().querySelector('input[id$="qualifier-2"]')).toBeNull();
    expect(fixture.calls).toHaveLength(1);
    await act(async () => {
      add().focus();
      await user.keyboard('{Enter}');
    });
    const position = region().querySelector('input[id$="qualifier-2"]') as HTMLInputElement;
    expect(position).not.toBeNull();
    expect(window.document.activeElement).toBe(position);
    expect(dirty).toBe(true);
    expect(chooser.value).toBe('');
    expect(add().disabled).toBe(true);
    expect(region().querySelectorAll('input[id*="-qualifier-"]')).toHaveLength(2);
    expect((region().querySelector('input[id$="qualifier-1"]') as HTMLInputElement).value).toBe('Original credit');
    expect(within(region()).getByRole('link', { name: 'https://example.org/credits' })).toBeTruthy();
    expect(fixture.calls).toHaveLength(1);

    // A choice withdrawn by a composition restriction cannot add when that restriction returns.
    await render(null);
    await render(editor());
    await select(region(), m.relation_qualifier(), 'schema:position');
    await render(editor(false));
    await render(editor());
    expect((within(region()).getByRole('combobox', { name: m.relation_qualifier() }) as HTMLSelectElement).value).toBe(
      '',
    );
    await click(region(), m.relation_add_qualifier());
    expect(region().querySelector('input[id$="qualifier-2"]')).toBeNull();
    expect(dirty).toBe(false);

    // Moving away and back before the admission commits cancels keyboard orientation.
    await select(region(), m.relation_qualifier(), 'schema:position');
    const origin = add();
    const moveFocus = () => {
      (within(region()).getByRole('textbox', { name: m.relation_citation() }) as HTMLElement).focus();
      origin.focus();
    };
    host.addEventListener('click', moveFocus, { once: true });
    await act(async () => {
      origin.focus();
      origin.click();
    });
    expect(region().querySelector('input[id$="qualifier-2"]')).not.toBeNull();
    expect(window.document.activeElement).not.toBe(region().querySelector('input[id$="qualifier-2"]'));

    // Two current fields may admit the same qualifier, but a field change never carries the choice over.
    await render(null);
    if (!initial.ok) throw new Error('Expected fixture read');
    const fields = [
      ...initial.fields,
      { ...initial.fields.find((field) => field.id === relationProperty)!, id: 'test:other' },
    ];
    await render(
      h(RelationEditor, {
        id: fixture.id,
        locale: 'en',
        initial: { ...initial, fields },
        transport: fixture.transport,
        search: async () => [],
      }),
    );
    await select(region(), m.relation_property(), relationProperty);
    await select(region(), m.relation_qualifier(), 'wdt:P1932');
    await select(region(), m.relation_property(), 'test:other');
    const currentChooser = within(region()).getByRole('combobox', {
      name: m.relation_qualifier(),
    }) as HTMLSelectElement;
    expect(currentChooser.value).toBe('');
    await click(region(), m.relation_add_qualifier());
    expect(region().querySelector('input[id$="qualifier-0"]')).toBeNull();
    await select(region(), m.relation_qualifier(), 'wdt:P1932');
    await click(region(), m.relation_add_qualifier());
    expect(region().querySelector('input[id$="qualifier-0"]')).not.toBeNull();
    expect(window.document.activeElement).not.toBe(region().querySelector('input[id$="qualifier-0"]'));
    expect(currentChooser.value).toBe('');
    expect(host.querySelectorAll('input[id*="-qualifier-"]')).toHaveLength(1);
  } finally {
    await ui.close();
  }
});
