import { expect, test } from 'bun:test';
import {
  parseImportedText,
  publicationHref,
  repairableDiagnostics,
  workspacePhase,
} from '../src/features/catalogue/definition-publication/model';
import { definitionPublicationFixture } from '../src/features/catalogue/definition-publication/fixtures';
import { grantedPublicationOperations } from '@rezics/definitions';

test('imported file diagnostics name the repairable field and grant-closed workspaces stay closed', () => {
  const broken = parseImportedText('broken.txt', 'not-json');
  expect('diagnostics' in broken && broken.diagnostics[0]?.pointer).toBe('/document');
  const empty = parseImportedText('empty.json', '   ');
  expect('diagnostics' in empty && empty.diagnostics[0]?.code).toBe('invalid_type');
  const yaml = parseImportedText('game.yaml', 'id: https://example.test/game\n');
  expect('document' in yaml && (yaml.document as { root: string }).root).toBe('game.yaml');
  const release = parseImportedText(
    'release.json',
    JSON.stringify({
      format: 'https://rezics.com/definitions/release/1',
      types: {},
      properties: {},
    }),
  );
  expect('document' in release).toBe(true);
  expect(
    repairableDiagnostics([{ pointer: '/release/types/ex:BoardGame/labels/en', code: 'required', file: null }])[0]
      ?.pointer,
  ).toBe('/release/types/ex:BoardGame/labels/en');
  expect(publicationHref('en')).toBe('/en/catalogue/definitions/publish');
  expect(publicationHref('ja', 'context', '019a1b2c-3d4e-7f00-8a00-def000000001')).toContain('context=');
  expect(
    workspacePhase({
      operations: { grant: 'definition_publication', admitted: false, publish: false, activate: false, build: false },
    }),
  ).toBe('closed');
  expect(
    workspacePhase({ operations: grantedPublicationOperations(), preview: definitionPublicationFixture().preview }),
  ).toBe('ready');
});

test('workspace transport reviews, resumes uncertain delivery, reconciles a stale head and rereads the published digest', async () => {
  const uncertain = definitionPublicationFixture('uncertain');
  const preview = await uncertain.transport.preview({
    format: 'https://rezics.com/definitions/release/1',
    types: {},
    properties: {},
  });
  expect('kind' in preview && preview.identity?.digest.startsWith('sha256:')).toBe(true);
  const first = await uncertain.transport.submit({
    key: 'resume-1',
    operation: 'publish',
    path: '/v1/definitions/releases',
    body: { release: {} },
  });
  expect(first).toEqual({ ok: false, reason: 'uncertain' });
  const resumed = await uncertain.transport.submit({
    key: 'resume-1',
    operation: 'publish',
    path: '/v1/definitions/releases',
    body: { release: {} },
  });
  expect(resumed.ok).toBe(true);
  const stale = definitionPublicationFixture('reconciliation');
  const activation = await stale.transport.submit({
    key: 'activate-1',
    operation: 'activate',
    path: `/v1/definitions/releases/${stale.preview.identity!.digest}:activate`,
    body: { expected_head: 4 },
  });
  expect(activation).toEqual({ ok: false, reason: 'stale', expectedHead: 5 });
  const read = await stale.transport.readRelease(stale.preview.identity!.digest);
  expect(read).toEqual({ ok: true, digest: stale.preview.identity!.digest });
  const closed = await definitionPublicationFixture('closed').transport.open('platform');
  expect(closed.ok && closed.phase).toBe('closed');
});

test('native catalogue transport builds the imported root and activates its own observed head', async () => {
  const { createKernelClient } = await import('@rezics/client');
  const { CATALOGUE_FORMAT, KIND_FORMAT, KIND_REDUCTION } = await import('@rezics/definitions/catalogue');
  const { definitionPublicationNative, publicationCommand } =
    await import('../src/features/catalogue/definition-publication/native');
  const root = `sha256:${'12'.repeat(32)}`;
  const pin = { format: CATALOGUE_FORMAT, kindSpec: KIND_FORMAT, reduction: KIND_REDUCTION, rootDigest: root };
  const requests: { path: string; body: unknown; key: string | null }[] = [];
  let state = 'building';
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const path = decodeURIComponent(new URL(request.url).pathname);
      const body = request.method === 'POST' ? await request.json() : null;
      requests.push({ path, body, key: request.headers.get('idempotency-key') });
      expect(request.headers.get('authorization')).toBe('Bearer publisher');
      if (path === '/v1/platform/exposure') return Response.json({ admitted: ['definition_publication'] });
      if (path === '/v1/definitions/catalogue')
        return Response.json({ pin: { ...pin, rootDigest: `sha256:${'34'.repeat(32)}` }, head: 7 });
      if (path === '/v1/definitions/imports') return Response.json(definitionPublicationFixture().preview);
      if (path.endsWith(':activate')) return Response.json({ pin, head: 8 });
      if (path.endsWith(':step')) state = 'ready';
      return Response.json({ pin, state, phase: 'release', steps: '1', missing_digest: null, error: null });
    }) as typeof fetch,
  });
  const native = definitionPublicationNative(client, { authorization: 'Bearer publisher' });
  const preview = await native.preview(pin);
  expect('kind' in preview && preview.kind).toBe('catalogue');
  if (!('kind' in preview)) throw new Error('Catalogue preview failed');
  expect(preview.current?.head).toBe(7);
  expect(preview.identity?.digest).toBe(root);
  expect(
    await native.submit(publicationCommand('platform', 'build', 'build-root', preview.identity, { pin })),
  ).toMatchObject({ ok: true, result: { digest: root } });
  expect(await native.readBuild(root)).toMatchObject({ state: 'building' });
  expect(await native.submit(publicationCommand('platform', 'step', 'step-root', preview.identity, {}))).toMatchObject({
    ok: true,
  });
  expect(await native.readBuild(root)).toMatchObject({ state: 'ready' });
  expect(
    await native.submit(
      publicationCommand('platform', 'activate', 'activate-root', preview.identity, {
        expected_head: preview.current!.head,
      }),
    ),
  ).toMatchObject({ ok: true, result: { digest: root, head: 8 } });
  expect(requests.filter((request) => request.key).map(({ path, body, key }) => ({ path, body, key }))).toEqual([
    { path: '/v1/definitions/catalogues', body: { pin }, key: '"build-root"' },
    { path: `/v1/definitions/catalogues/${root}:step`, body: {}, key: '"step-root"' },
    { path: `/v1/definitions/catalogues/${root}:activate`, body: { expected_head: 7 }, key: '"activate-root"' },
  ]);
  expect(
    await native.preview({ format: 'https://rezics.com/definitions/release/1', types: {}, properties: {} }),
  ).toMatchObject({ kind: 'release' });
  expect(requests.at(-1)?.path).toBe('/v1/definitions/imports');
  const imported = parseImportedText('catalogue.json', JSON.stringify(pin));
  expect('document' in imported && imported.document).toEqual(pin);
  expect(parseImportedText('too-big.json', 'é'.repeat(2_097_153))).toMatchObject({
    diagnostics: [{ code: 'out_of_range' }],
  });
});

test('mounted publication retains the original uncertain command and locks replacement imports until readback', async () => {
  const { dirname } = await import('node:path');
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/catalogue/definitions/publish' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    Event: window.Event,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const descriptors = Object.keys(globals).map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { DefinitionPublicationWorkspace } = await import('../src/features/catalogue/definition-publication/workspace');
  const { m } = await import('../src/paraglide/messages.js');
  const fixture = definitionPublicationFixture('uncertain');
  const commands: import('../src/features/catalogue/definition-publication/model').PublicationCommand[] = [];
  const transport = {
    ...fixture.transport,
    submit: async (command: (typeof commands)[number]) => {
      commands.push(structuredClone(command));
      return fixture.transport.submit(command);
    },
  };
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const button = (label: string) => [...host.querySelectorAll('button')].find((node) => node.textContent === label)!;
  const options = { locale: 'en' as const };
  try {
    await act(async () =>
      root.render(
        <DefinitionPublicationWorkspace locale="en" scope="platform" initial={fixture.initial} transport={transport} />,
      ),
    );
    const input = host.querySelector<HTMLInputElement>('input[type=file]')!;
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [{ name: 'release.json', text: async () => JSON.stringify(fixture.preview.document) }],
    });
    await act(async () => {
      input.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    expect(commands).toHaveLength(0);
    await act(async () => button(m.definition_publication_publish({}, options)).click());
    expect(commands).toHaveLength(1);
    expect(input.disabled).toBe(true);
    expect(button(m.definition_publication_publish({}, options)).disabled).toBe(true);
    await act(async () => button(m.definition_publication_resume({}, options)).click());
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    expect(input.disabled).toBe(false);
    expect(host.textContent).toContain(fixture.preview.identity!.digest);
    await act(async () => button(m.definition_publication_activate({}, options)).click());
    expect(commands.at(-1)?.body).toEqual({ expected_head: 4 });
    expect(host.textContent).toContain(m.definition_publication_completed({}, options));
  } finally {
    await act(async () => root.unmount());
    host.remove();
    window.happyDOM.abort();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
