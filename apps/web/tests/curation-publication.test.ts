import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { PROFILE_FORMAT, profileDigest, type PresentationProfile } from '@rezics/composition';
import { publishProfile, withTemplate, type CurationFailure, type PublishInput } from '../src/features/pages/curate';
import { CurationPublication, type ActiveCuration } from '../src/features/pages/curation-publish';

const profile = (): PresentationProfile => ({
  format: PROFILE_FORMAT,
  generic: { root: { props: {} }, content: [] },
  bases: [],
  types: [],
  routes: [],
});
const reader = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10';
const changed = (draft: PresentationProfile) =>
  withTemplate(
    draft,
    { scope: 'route', key: '/books' },
    {
      root: { props: {} },
      content: [{ type: 'Text', props: { id: 'books', text: { en: 'Draft books' } } }],
    },
  );
const response = (status: number, body: unknown, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
type Loss = 'publish-response' | 'activate-before' | 'activate-response' | 'none';

// Wire fixture only: the generated SDK and product publish helper run unchanged.
// Native authorization/receipt proof remains with the existing kernel acceptance.
function wire(loss: Loss) {
  let head = 7;
  let activeProfile = profile();
  let granted = true;
  let lose = loss;
  const seen: { path: string; body: unknown; key: string | null; authorization: string | null }[] = [];
  const receipts = new Map<string, { body: string; result: unknown }>();
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const path = decodeURIComponent(new URL(request.url).pathname);
    const body = (await request.json()) as Record<string, unknown>;
    const key = request.headers.get('idempotency-key');
    seen.push({ path, body, key, authorization: request.headers.get('authorization') });
    if (!granted) return response(403, { code: 'forbidden' });
    const previous = receipts.get(key!);
    if (previous) {
      if (previous.body !== JSON.stringify(body)) return response(422, { code: 'idempotency_conflict' });
      return response(200, previous.result);
    }
    if (path === '/v1/presentation/profiles') {
      const result = { digest: profileDigest(body.profile as PresentationProfile) };
      receipts.set(key!, { body: JSON.stringify(body), result });
      if (lose === 'publish-response') {
        lose = 'none';
        throw new TypeError('connection lost after publish');
      }
      return response(201, result);
    }
    if (lose === 'activate-before') {
      lose = 'none';
      throw new TypeError('connection lost before activation');
    }
    if (body.expected_head !== head) return response(409, { code: 'stale_editorial_head' });
    const digest = path.slice('/v1/presentation/profiles/'.length, -':activate'.length);
    const result = { digest, head: ++head };
    const published = seen.find((entry) => entry.path === '/v1/presentation/profiles')!.body as {
      profile: PresentationProfile;
    };
    activeProfile = published.profile;
    receipts.set(key!, { body: JSON.stringify(body), result });
    if (lose === 'activate-response') {
      lose = 'none';
      throw new TypeError('connection lost after activation');
    }
    return response(200, result);
  }) as typeof globalThis.fetch;
  const client = createKernelClient('https://kernel.invalid', { fetch });
  const transport = {
    publish: (input: PublishInput) => publishProfile(client, { ...input, authorization: 'Bearer current-session' }),
    read: async (): Promise<ActiveCuration> => ({
      ok: true,
      reader,
      head,
      digest: profileDigest(activeProfile),
      profile: activeProfile,
    }),
  };
  return {
    seen,
    receipts,
    transport,
    revoke: () => {
      granted = false;
    },
    restore: () => {
      granted = true;
    },
    moveHead: () => {
      head = 9;
      activeProfile = changed(profile());
    },
  };
}

test('the actual immutable profile publish-and-activate flow resolves unknown outcomes with stable original operation keys and preserves drafts during current-head conflicts', async () => {
  for (const loss of ['publish-response', 'activate-before', 'activate-response'] as const) {
    const native = wire(loss);
    const publication = new CurationPublication(reader, native.transport);
    const draft = profile();
    expect(await publication.start(draft, 7)).toBeNull();
    const original = publication.getSnapshot().intent!;
    expect(publication.getSnapshot().result).toMatchObject({ ok: false, reason: 'unavailable', outcome: 'unknown' });
    expect(Object.isFrozen(original.profile.generic)).toBe(true);
    expect(original.keys.publish).not.toBe(original.keys.activate);

    // A later editor change cannot replace the pending body or allocate another operation.
    const laterDraft = changed(draft);
    const requests = native.seen.length;
    expect(await publication.start(laterDraft, 9)).toBeNull();
    expect(native.seen).toHaveLength(requests);
    expect(publication.getSnapshot().intent).toBe(original);
    expect(original.profile).toEqual(profile());
    const confirmed = await publication.retry();
    expect(confirmed).toEqual({ intent: original, result: { ok: true, digest: profileDigest(profile()), head: 8 } });
    expect(laterDraft.routes[0]?.route).toBe('/books');
    expect(native.receipts.size).toBe(2);
    for (const request of native.seen) {
      expect(request.authorization).toBe('Bearer current-session');
      if (request.path === '/v1/presentation/profiles') {
        expect(request.key).toBe(original.keys.publish);
        expect(request.body).toEqual({ profile: original.profile });
      } else {
        expect(request.path).toBe(`/v1/presentation/profiles/${profileDigest(original.profile)}:activate`);
        expect(request.key).toBe(original.keys.activate);
        expect(request.body).toEqual({ expected_head: 7 });
      }
    }
  }

  for (const choice of ['keep', 'discard'] as const) {
    const native = wire('none');
    native.moveHead();
    const publication = new CurationPublication(reader, native.transport);
    const draft = profile();
    expect(await publication.start(draft, 7)).toBeNull();
    const pending = publication.getSnapshot().intent!;
    expect(publication.getSnapshot().result).toEqual({ ok: false, reason: 'stale', phase: 'activate' });
    expect(publication.getSnapshot().active?.head).toBe(9);
    expect(draft).toEqual(profile());
    expect(publication.getSnapshot().intent?.profile).toEqual(draft);
    const reviewed = publication.reconcile(draft, choice)!;
    expect(reviewed.head).toBe(9);
    expect(reviewed.profile).toEqual(choice === 'keep' ? draft : changed(profile()));
    expect(publication.getSnapshot().intent).toBeNull();
    await publication.start(reviewed.profile, reviewed.head);
    expect(native.seen.at(-2)?.key).not.toBe(pending.keys.publish);
    expect(native.seen.at(-1)?.key).not.toBe(pending.keys.activate);
    expect(native.seen.at(-1)?.body).toEqual({ expected_head: 9 });
  }
});

test('revocation after an ambiguous activation is checked on replay before any receipt can complete the intent', async () => {
  const native = wire('activate-response');
  const publication = new CurationPublication(reader, native.transport);
  await publication.start(profile(), 7);
  const original = publication.getSnapshot().intent;
  native.revoke();
  expect(await publication.retry()).toBeNull();
  expect(publication.getSnapshot().result).toEqual({ ok: false, reason: 'forbidden', phase: 'publish' });
  expect(publication.getSnapshot().intent).toBe(original);
  expect(native.seen.at(-1)?.path).toBe('/v1/presentation/profiles');
  expect(native.seen.at(-1)?.key).toBe(original?.keys.publish);
  native.restore();
  expect((await publication.retry())?.result.head).toBe(8);
  expect(native.receipts.size).toBe(2);
});

test('an active read, even matching an uncertain activation, never invents confirmation or permits a new intent', async () => {
  const native = wire('activate-response');
  const publication = new CurationPublication(reader, native.transport);
  await publication.start(profile(), 7);
  const original = publication.getSnapshot().intent;
  await publication.inspect();
  expect(publication.getSnapshot().active).toMatchObject({ head: 8, digest: profileDigest(profile()) });
  expect(publication.getSnapshot().result).toMatchObject({ ok: false, outcome: 'unknown' });
  expect(publication.reconcile(changed(profile()), 'keep')).toBeNull();
  expect(publication.getSnapshot().intent).toBe(original);
  expect(await publication.start(changed(profile()), 8)).toBeNull();
});

test('activation validation, rate limits and unavailability retain the original intent and exact draft', async () => {
  const failures: CurationFailure[] = [
    {
      ok: false,
      reason: 'invalid',
      errors: [{ pointer: '/types/0/views/overview/content', code: 'out_of_range' }],
      phase: 'activate',
    },
    { ok: false, reason: 'rate-limited', retryAfter: 30 },
    { ok: false, reason: 'unavailable' },
  ];
  for (const failure of failures) {
    const seen: PublishInput[] = [];
    const publication = new CurationPublication(reader, {
      publish: async (input) => {
        seen.push(input);
        return structuredClone(failure);
      },
      read: async () => {
        throw new TypeError('read unavailable');
      },
    });
    const draft = profile();
    await publication.start(draft, 7);
    const original = publication.getSnapshot().intent;
    await publication.inspect();
    expect(publication.getSnapshot().readFailure).toEqual({ ok: false, reason: 'unavailable' });
    const input = { profile: original!.profile, expectedHead: original!.expectedHead, keys: original!.keys };
    if (failure.reason === 'rate-limited') {
      expect(await publication.retry()).toBeNull();
      expect(seen).toEqual([input]);
    } else {
      await publication.retry();
      expect(seen).toEqual([input, input]);
    }
    expect(draft).toEqual(profile());
    expect(publication.getSnapshot().intent).toBe(original);
    expect(publication.getSnapshot().result).toEqual(failure);
  }
});

test('a revised invalid draft starts only by explicit replacement, with fresh keys and whole-profile validation', async () => {
  const seen: PublishInput[] = [];
  const publication = new CurationPublication(reader, {
    publish: async (input) => {
      seen.push(input);
      return { ok: false, reason: 'invalid', errors: [{ pointer: '/generic', code: 'invalid_format' }] };
    },
    read: async () => ({ ok: false, reason: 'unavailable' }),
  });
  await publication.start(profile(), 7);
  const original = publication.getSnapshot().intent!;
  await publication.start(changed(profile()), 7);
  expect(seen).toHaveLength(1);
  await publication.replaceInvalid(changed(profile()), 7);
  const revised = publication.getSnapshot().intent!;
  expect(revised.keys.publish).not.toBe(original.keys.publish);
  expect(revised.keys.activate).not.toBe(original.keys.activate);
  expect(revised.profile).toEqual(changed(profile()));
  await publication.replaceInvalid(
    { ...profile(), routes: [{ route: 'invalid', document: { root: { props: {} }, content: [] } }] },
    7,
  );
  expect(seen).toHaveLength(2);
  expect(publication.getSnapshot().result).toMatchObject({ ok: false, reason: 'invalid' });
});

test('a pending request cannot be duplicated, and a malformed success cannot discard its intent', async () => {
  let complete!: (result: { ok: true; digest: string; head: number }) => void;
  let calls = 0;
  const publication = new CurationPublication(reader, {
    publish: () => {
      calls++;
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
    read: async () => ({ ok: false, reason: 'unavailable' }),
  });
  const first = publication.start(profile(), 7);
  expect(await publication.retry()).toBeNull();
  expect(await publication.start(changed(profile()), 9)).toBeNull();
  expect(calls).toBe(1);
  complete({ ok: true, digest: profileDigest(profile()), head: 99 });
  expect(await first).toBeNull();
  expect(publication.getSnapshot().intent?.expectedHead).toBe(7);
  expect(publication.getSnapshot().result).toMatchObject({ ok: false, outcome: 'unknown' });
});

// Authored production presentation regressions. Execution is deferred by the delivery contract.
function readableProfile(): PresentationProfile {
  const page = (id: string, text: string) => ({
    root: {
      props: {
        appearance: { density: 'comfortable', radius: 'md', surface: 'flat', cover: 'portrait', headingScale: 'lg' },
      },
    },
    content: [
      {
        type: 'Stack',
        props: {
          id,
          gap: 'md',
          children: [
            { type: 'Heading', props: { id: `${id}-heading`, text: { en: text, ja: '読書ノート' }, level: 2 } },
            {
              type: 'Text',
              props: {
                id: `${id}-text`,
                text: { en: 'Unchanged reading introduction', fr: 'Introduction à la lecture' },
              },
            },
          ],
        },
      },
    ],
  });
  return {
    format: PROFILE_FORMAT,
    generic: { views: { overview: page('generic', 'Saved heading'), details: page('details', 'Saved details') } },
    bases: [{ base: 'schema:CreativeWork', document: page('base', 'Base heading') }],
    types: [
      {
        type: 'schema:Book',
        views: { overview: page('book', 'Book heading'), details: page('book-details', 'Book details') },
      },
    ],
    routes: [{ route: '/books', document: page('books', 'Books heading') }],
  };
}

test('production comparison names actual scoped appearance and nested multilingual values while separating unchanged fields and missing views', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { platformRegistry, validateProfile } = await import('@rezics/composition');
  const { CurationProfileComparison } = await import('../src/features/pages/curation-publish-view');
  const { m } = await import('../src/paraglide/messages.js');
  const active = readableProfile();
  active.types[0]!.views!.details = { root: { props: {} }, content: [] };
  const draft = structuredClone(active);
  if (!('views' in draft.generic)) throw new Error('Expected the actual multi-view fixture');
  draft.generic.views.overview.root.props.appearance = {
    density: 'compact',
    radius: 'md',
    surface: 'flat',
    cover: 'portrait',
    headingScale: 'lg',
  };
  const children = draft.generic.views.overview.content[0]!.props.children as { props: Record<string, unknown> }[];
  children[0]!.props.text = { en: 'New heading', ja: '新しい読書ノート' };
  delete draft.types[0]!.views!.details;
  draft.routes.push({ route: '/notes', document: { root: { props: {} }, content: [] } });
  expect(validateProfile(platformRegistry, active)).toEqual([]);
  expect(validateProfile(platformRegistry, draft)).toEqual([]);
  const html = renderToStaticMarkup(createElement(CurationProfileComparison, { draft, active }));
  const differences = html.slice(0, html.indexOf('<details'));
  expect(differences).toContain(m.curation_review_density());
  expect(differences).toContain(m.curation_review_compact());
  expect(differences).toContain(m.curation_review_comfortable());
  expect(differences).toContain('New heading');
  expect(differences).toContain('Saved heading');
  expect(differences).toContain('新しい読書ノート');
  expect(differences).toContain('読書ノート');
  expect(differences).toContain('schema:Book');
  expect(differences).toContain('/notes');
  expect(differences).toContain(m.curation_review_absent());
  expect(differences).not.toContain('Unchanged reading introduction');
  expect(html).toContain('Unchanged reading introduction');
  expect(html).toContain('schema:CreativeWork');
  expect(html).toContain(m.curation_review_radius());
  expect(html).not.toContain('<pre');
  expect(html).not.toContain('<details open');
});

test('production comparison treats equal structured values and overview shorthand honestly and retains unknown fields and tokens', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { CurationProfileComparison } = await import('../src/features/pages/curation-publish-view');
  const { m } = await import('../src/paraglide/messages.js');
  const active = readableProfile();
  const equal = structuredClone(active);
  if (!('views' in equal.generic)) throw new Error('Expected multi-view generic');
  equal.generic.views.overview.root.props.appearance = {
    headingScale: 'lg',
    cover: 'portrait',
    surface: 'flat',
    radius: 'md',
    density: 'comfortable',
  };
  const html = renderToStaticMarkup(createElement(CurationProfileComparison, { draft: equal, active }));
  expect(html).toContain(m.curation_review_same());
  const shorthand = profile();
  expect(
    renderToStaticMarkup(
      createElement(CurationProfileComparison, {
        draft: {
          ...shorthand,
          generic: { views: { overview: shorthand.generic as import('@rezics/composition').CompositionDocument } },
        },
        active: shorthand,
      }),
    ),
  ).toContain(m.curation_review_same());
  const unknown = structuredClone(active);
  if (!('views' in unknown.generic)) throw new Error('Expected multi-view generic');
  unknown.generic.views.overview.root.props.appearance = { density: 'future-density', futureTone: 'violet' };
  unknown.generic.views.overview.content.push({
    type: 'FutureWidget',
    props: { id: 'future', futureSetting: 'kept exactly' },
  });
  (unknown as unknown as Record<string, unknown>).futureEnvelope = 'extra value';
  const future = renderToStaticMarkup(createElement(CurationProfileComparison, { draft: unknown, active }));
  expect(future).toContain(m.curation_review_unknown_value({ value: 'future-density' }));
  expect(future).toContain(m.curation_review_unknown_field({ field: 'futureTone' }));
  expect(future).toContain(m.curation_review_unknown_component({ type: 'FutureWidget' }));
  expect(future).toContain(m.curation_review_unknown_field({ field: 'futureSetting' }));
  expect(future).toContain(m.curation_review_unknown_field({ field: 'futureEnvelope' }));
  expect(future).toContain('kept exactly');
  expect(future).not.toContain(m.curation_review_same());
  const empty = structuredClone(unknown);
  (unknown as unknown as Record<string, unknown>).futureEnvelope = {};
  (empty as unknown as Record<string, unknown>).futureEnvelope = m.curation_review_empty();
  const emptyComparison = renderToStaticMarkup(
    createElement(CurationProfileComparison, { draft: empty, active: unknown }),
  );
  expect(emptyComparison).not.toContain(m.curation_review_same());
  expect(emptyComparison).toContain(m.curation_review_empty_object());
});

test('production recovery distinguishes refused, unknown, inspected matching and failed-read states with closed exact snapshots', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { CurationPublicationRecovery } = await import('../src/features/pages/curation-publish-view');
  const { m } = await import('../src/paraglide/messages.js');
  const original = readableProfile();
  const current = changed(original);
  const render = (publication: CurationPublication) =>
    renderToStaticMarkup(
      createElement(CurationPublicationRecovery, {
        publication,
        profile: current,
        head: 7,
        onPublished: () => {},
        onReviewed: () => {},
      }),
    );
  const refused = new CurationPublication(reader, {
    publish: async () => ({ ok: false, reason: 'unavailable' }),
    read: async () => ({ ok: false, reason: 'unavailable' }),
  });
  await refused.start(original, 7);
  const notApplied = render(refused);
  expect(notApplied).toContain(m.curation_unavailable());
  expect(notApplied).not.toContain(m.curation_unknown());
  expect(notApplied).not.toContain(m.curation_partial());
  expect(notApplied).toContain(m.curation_review_no_active());
  expect(notApplied).toContain(m.curation_retry_original());
  let readFails = false;
  const unknown = new CurationPublication(reader, {
    publish: async () => ({ ok: false, reason: 'unavailable', outcome: 'unknown', phase: 'activate' }),
    read: async () =>
      readFails
        ? { ok: false, reason: 'unavailable' }
        : { ok: true, reader, head: 8, digest: profileDigest(original), profile: original },
  });
  await unknown.start(original, 7);
  let html = render(unknown);
  expect(html).toContain(m.curation_unknown());
  expect(html).toContain(m.curation_partial());
  expect(html).toContain(m.curation_review_no_active());
  expect(html).not.toContain(`aria-label="${m.curation_compare()}"`);
  expect(html).toContain(m.curation_review_later());
  expect(html).toContain(m.curation_review_retry_help());
  expect(html).not.toContain('<details open');
  await unknown.inspect();
  html = render(unknown);
  expect(html).toContain(m.curation_compare());
  expect(html).toContain(m.curation_resolve_first());
  expect(html).not.toContain(m.curation_reconcile());
  expect(html).not.toContain(m.presentation_editor_published());
  expect(unknown.getSnapshot().result).toMatchObject({ ok: false, outcome: 'unknown' });
  readFails = true;
  await unknown.inspect();
  html = render(unknown);
  expect(html).toContain(m.curation_review_read_failed());
  expect(html).toContain(m.curation_review_no_active());
  expect(html).not.toContain(`aria-label="${m.curation_compare()}"`);
  const stale = new CurationPublication(reader, {
    publish: async () => ({ ok: false, reason: 'stale' }),
    read: async () => ({ ok: true, reader, head: 9, digest: profileDigest(original), profile: original }),
  });
  await stale.start(original, 7);
  html = render(stale);
  expect(html).toContain(m.curation_stale());
  expect(html).toContain(m.curation_review_help());
  expect(html).toContain(m.curation_review_discard_help());
  expect(html.indexOf(m.curation_reconcile())).toBeLessThan(html.indexOf(m.curation_retry_original()));
  // All three objects remain distinct in the rendered technical disclosures.
  const { Window } = await import(
    Bun.resolveSync(
      'happy-dom',
      (await import('node:path')).dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)),
    )
  );
  const window = new Window();
  try {
    window.document.body.innerHTML = html;
    const snapshots = [...window.document.querySelectorAll('pre')].map((node) => JSON.parse(node.textContent!));
    expect(snapshots).toEqual([original, original, current]);
    expect([...window.document.querySelectorAll('details')].every((details) => !details.open)).toBe(true);
    for (const pre of window.document.querySelectorAll('pre')) expect(pre.tabIndex).toBe(0);
  } finally {
    await window.happyDOM.close();
  }
});

test('production comparison bounds long localized values in every launch locale without mutating their exact originals', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { CurationProfileComparison } = await import('../src/features/pages/curation-publish-view');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
  const before = getLocale();
  const active = readableProfile();
  const draft = structuredClone(active);
  const long = '長い見出しと説明文'.repeat(160);
  const longRoute = `/${'long'.repeat(60)}`;
  draft.routes.push({
    route: longRoute,
    document: {
      root: { props: {} },
      content: [
        { type: 'Text', props: { id: 'long', text: { en: long, fr: 'Une description détaillée '.repeat(60) } } },
      ],
    },
  });
  try {
    for (const locale of ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'de', 'fr', 'es'] as const) {
      setLocale(locale, { reload: false });
      const html = renderToStaticMarkup(createElement(CurationProfileComparison, { draft, active }));
      expect(html).toContain(m.curation_compare());
      expect(html).toContain(m.curation_review_scope());
      expect(html).toContain(longRoute);
      expect(html).toContain(`${long.slice(0, 180)}…`);
      expect(html).not.toContain(long);
      expect(html).toContain('min-w-0');
      expect(html).toContain('overflow-wrap:anywhere');
      expect(html).toContain('sm:grid-cols-2');
      expect(html.length).toBeLessThan(90000);
    }
    expect((draft.routes.at(-1)!.document!.content[0]!.props.text as Record<string, string>).en).toBe(long);
  } finally {
    setLocale(before, { reload: false });
  }
});
