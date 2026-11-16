import { expect, setDefaultTimeout } from 'bun:test';
import type { Page, Response as PlaywrightResponse } from 'playwright';
import { documentText, serializeDocument } from '@rezics/document';
import type { KernelClient } from '@rezics/client';
import { partitionOf, routeOf } from '../../../../services/kernel/src/route/route.ts';
import { startAuthStack, type NativeAuthStack } from './auth-stack.ts';
import {
  createHostedBookJourneySeed,
  createPrepublishedReaderControl,
  lanternFerryCoverPng,
  openHostedBookReadingProgress,
  readNativePost,
  type HostedBookJourneySeed,
  type HostedReaderControl,
  type JourneyPost,
} from './hosted-book-journey-fixture.ts';
import { NativeTestLifecycle, nativeAfterAll, nativeBeforeAll, nativeTest, settledWithin } from './lifecycle.ts';
import { startNativeWebStack, type NativeWebStack } from './stack.ts';

setDefaultTimeout(900_000);

const lifecycle = new NativeTestLifecycle('hosted Book author-to-reader journey');
let stack: NativeWebStack;
let auth: NativeAuthStack;

nativeBeforeAll(lifecycle, 600_000, async () => {
  stack = await startNativeWebStack({ localShowcaseBoardCreation: true });
  auth = await startAuthStack(stack);
  await openHostedBookReadingProgress(stack);
});

nativeAfterAll(lifecycle, 180_000);

type StageState = 'passed' | 'failed' | 'unreached';
type Stage = Readonly<{ label: string; state: StageState; observation: string }>;

class StageJournal {
  private readonly stages: Stage[] = [];

  async run<T>(
    label: string,
    operation: () => Promise<{ value: T; observation: string }>,
    onFailure?: () => Promise<string>,
  ): Promise<T | undefined> {
    try {
      const result = await operation();
      this.stages.push({ label, state: 'passed', observation: result.observation });
      return result.value;
    } catch (cause) {
      let context = '';
      try {
        context = onFailure ? await onFailure() : '';
      } catch (observationError) {
        context = ` failure-observation=${errorText(observationError)}`;
      }
      this.stages.push({
        label,
        state: 'failed',
        observation: `${errorText(cause)}${context ? `; ${context}` : ''}`,
      });
      return undefined;
    }
  }

  unreached(label: string, reason: string) {
    this.stages.push({ label, state: 'unreached', observation: reason });
  }

  async finish(reportName: string) {
    const report = [
      reportName,
      ...this.stages.map(({ label, state, observation }) => `- ${state} | ${label} | ${observation}`),
    ].join('\n');
    console.info(report);
    if (this.stages.some(({ state }) => state !== 'passed')) throw new Error(report);
  }
}

type NativeOccurrence = {
  occurrenceId: string;
  parentId: string | null;
  position: number;
  kind: 'part' | 'chapter';
  availability: 'available' | 'unavailable';
  title?: string;
  target?: { threadId: string; postId: string; revisionId: string; sha256: string };
};
type NativeRevision = { catalogueId: string; revisionId: string; kind: string; sourceRevisionId: string | null };
type NativePage = NativeRevision & { items: NativeOccurrence[]; nextCursor: string | null };
type PrivateActivationOperands = Readonly<{
  catalogueId: string;
  ownerAccountId: string;
  authnEpoch: number;
  expectedDraftHeadRevisionId: string;
  expectedPublicationId: null;
  stageId: string;
  selectedOccurrenceId: string;
  target: Readonly<Pick<JourneyPost, 'postId' | 'threadId' | 'revisionId' | 'sha256'>>;
}>;

function errorText(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  return String(cause);
}

async function pageObservation(page: Page): Promise<string> {
  const alerts = await page
    .getByRole('alert')
    .allInnerTexts()
    .catch(() => [] as string[]);
  const statuses = await page
    .getByRole('status')
    .allInnerTexts()
    .catch(() => [] as string[]);
  return `url=${page.url()} alerts=${JSON.stringify(alerts.slice(-4))} statuses=${JSON.stringify(statuses.slice(-6))}`;
}

async function observeMemberCheckpointFailure(page: Page, subjectId: string): Promise<string> {
  const [browser, refreshed] = await Promise.all([
    pageObservation(page),
    settledWithin(
      stack.refreshKernelRequests().then(() => true),
      1_200,
    ).catch(() => false),
  ]);
  const requests = stack.kernelRequests().flatMap((request) => {
    if (request.fixtureRequest || request.method !== 'GET') return [];
    const url = new URL(request.url);
    if (url.pathname !== '/v1/libraryHostedReading/metadata' || url.searchParams.get('subjectId') !== subjectId)
      return [];
    return [
      {
        status: request.responseStatus ?? null,
        authorization: !!request.authorization,
        authenticated: request.access?.authenticated ?? null,
        authorized: request.access?.authorized ?? null,
      },
    ];
  });
  return `${browser}; checkpoint request trace refreshed=${refreshed === true} metadata reads=${JSON.stringify(requests.slice(-4))}`;
}

async function observeContentFailure(statement: string, parameters: readonly (string | number)[]): Promise<string> {
  const { Pool } = await import('pg');
  const pool = new Pool({
    connectionString: stack.databaseUrl,
    connectionTimeoutMillis: 750,
    statement_timeout: 750,
    query_timeout: 1_000,
    options: '-c default_transaction_read_only=on',
    max: 1,
  });
  try {
    const result = await pool.query(statement, [...parameters]);
    return JSON.stringify(result.rows[0] ?? null);
  } catch {
    return 'unavailable';
  } finally {
    await pool.end();
  }
}

async function observeCoverWork(mediaId: string): Promise<string> {
  const route = routeOf(mediaId);
  if (route === null) return 'unavailable';
  return observeContentFailure(
    `SELECT m.state,b.transaction_id IS NOT NULL AS upload_basis,
       o.event_seq IS NOT NULL AS upload_event,
       CASE WHEN o.event_seq IS NULL OR c.epoch IS NULL THEN NULL
            WHEN c.epoch<>o.epoch THEN 'other-epoch'
            WHEN c.position>=o.position THEN 'reached'
            ELSE 'behind' END AS effects_checkpoint,
       relay.status AS image_effect,s.status AS image_work,
       (SELECT count(*)::int FROM (
          SELECT 1 FROM content.media_variant v WHERE (v.route,v.media_id)=(m.route,m.media_id) LIMIT 13
        ) variants) AS variant_count
     FROM content.media m
     LEFT JOIN editorial.write_basis b ON (b.partition_no,b.transaction_id)=($3,m.transaction_id)
     LEFT JOIN core.outbox o ON (o.partition_no,o.position,o.epoch)=(b.partition_no,b.position,b.epoch)
       AND o.type='com.rezics.content.media.uploaded.v1' AND o.subject=m.media_id::text
     LEFT JOIN core.consumer_checkpoint c ON c.partition_no=o.partition_no AND c.consumer='effects'
     LEFT JOIN dbos.workflow_status relay
       ON relay.workflow_uuid=concat('fx:',o.epoch,':',o.partition_no,':',o.position,':',o.event_seq,':content_media_image')
       AND o.event_seq IS NOT NULL
     LEFT JOIN dbos.workflow_status s
       ON s.workflow_uuid=concat('fx:',o.epoch,':',o.partition_no,':',o.position,':',o.event_seq,':content_image')
       AND o.event_seq IS NOT NULL
     WHERE (m.route,m.media_id)=($1,$2) LIMIT 1`,
    [route, mediaId, partitionOf(route)],
  );
}

async function observeDraftReadiness(authorId: string, postId: string, revisionId: string): Promise<string> {
  const authorRoute = routeOf(authorId);
  const postRoute = routeOf(postId);
  if (authorRoute === null || postRoute === null) return 'unavailable';
  return observeContentFailure(
    `SELECT p.draft_locator_pending,a.draft_state,
       a.draft_revision_id=p.head_revision_id AS exact_head_projected,
       a.thread_id=p.thread_id AS projected_source_thread,
       g.complete AS coverage_complete,
       EXISTS (SELECT 1 FROM content.post pending WHERE pending.author_account_id=$2
         AND pending.post_id<>$4 AND pending.draft_locator_pending
         AND pending.visibility='draft' AND pending.availability='available' LIMIT 1) AS other_author_locator_pending,
       p.head_revision_id=$5 AS saved_revision_is_head,
       b.transaction_id IS NOT NULL AS saved_revision_basis,
       o.position::text AS saved_revision_event_position,
       CASE WHEN o.event_seq IS NULL OR c.epoch IS NULL THEN NULL
            WHEN c.epoch<>o.epoch THEN 'other-epoch'
            WHEN c.position>=o.position THEN 'reached'
            ELSE 'behind' END AS effects_checkpoint,
       l.state AS locator_obligation,s.status AS locator_effect,s.queue_name AS locator_queue
     FROM content.post p
     LEFT JOIN content.revision r ON (r.route,r.thread_id,r.post_id,r.revision_id)=
       (p.route,p.thread_id,p.post_id,$5)
     LEFT JOIN editorial.write_basis b ON (b.partition_no,b.transaction_id)=($6,r.recorded_transaction_id)
     LEFT JOIN core.outbox o ON (o.partition_no,o.epoch,o.position)=(b.partition_no,b.epoch,b.position)
       AND o.type='com.rezics.content.revision.created.v1'
       AND o.data->>'itemId'=p.post_id::text AND o.data->>'revisionId'=r.revision_id::text
     LEFT JOIN core.consumer_checkpoint c ON c.partition_no=o.partition_no AND c.consumer='effects'
     LEFT JOIN LATERAL (
       SELECT concat('fx:',o.epoch,':',o.partition_no,':',o.position,':',o.event_seq,':content_author_item') AS id
       WHERE o.event_seq IS NOT NULL
     ) w ON true
     LEFT JOIN access.erasure_locator_work l ON l.workflow_id=w.id
     LEFT JOIN dbos.workflow_status s ON s.workflow_uuid=w.id
     LEFT JOIN content.author_item a ON (a.route,a.author_account_id,a.item_kind,a.item_id)=($1,$2,'post',$4)
     LEFT JOIN content.own_draft_progress g ON g.singleton=0
     WHERE (p.route,p.post_id,p.author_account_id)=($3,$4,$2) LIMIT 1`,
    [authorRoute, authorId, postRoute, postId, revisionId, partitionOf(postRoute)],
  );
}

async function observeBookDiscovery(
  book: Pick<HostedReaderControl, 'subjectId' | 'catalogueId'>,
  publicationId: string,
): Promise<string> {
  const subjectRoute = routeOf(book.subjectId);
  const catalogueRoute = routeOf(book.catalogueId);
  if (subjectRoute === null || catalogueRoute === null) return 'unavailable';
  return observeContentFailure(
    `SELECT (c.route=$1 AND $2::uuid=ANY(r.subject_ids)) AS same_route_reference,
       st.source_epoch AS subject_thread_epoch,st.source_position::text AS subject_thread_position,
       c.publication_id=$5 AS exact_current_release,
       p.availability,p.visibility,p.author_erased,s.placement_count::text AS publication_placements,
       o.epoch AS source_epoch,o.position::text AS source_position,
       (o.data->'subjectIds' ? $2::text) AS source_names_subject,
       cp.position::text AS effects_checkpoint,h.state AS subject_thread_consumer,
       w.status AS subject_thread_workflow,w.queue_name AS subject_thread_queue
     FROM content.hosted_catalogue c
     LEFT JOIN content.post p ON (p.route,p.thread_id,p.post_id)=(c.route,c.thread_id,c.catalogue_id)
     LEFT JOIN content.revision r ON (r.route,r.thread_id,r.post_id,r.revision_id)=
       (p.route,p.thread_id,p.post_id,p.head_revision_id)
     LEFT JOIN content.subject_thread st ON (st.route,st.subject_id,st.thread_id)=($1,$2,c.thread_id)
       AND st.thread_route=c.route
     LEFT JOIN content.hosted_version_revision v ON (v.route,v.catalogue_id,v.revision_id)=
       (c.route,c.catalogue_id,c.publication_id) AND v.revision_kind='publication' AND v.generation_kind='candidate'
     LEFT JOIN content.hosted_tree_snapshot_version s ON (s.route,s.catalogue_id,s.generation_id,s.sequence)=
       (v.route,v.catalogue_id,v.generation_id,v.sequence)
     LEFT JOIN editorial.write_basis b ON (b.partition_no,b.transaction_id)=($6,p.recorded_transaction_id)
     LEFT JOIN core.outbox o ON (o.partition_no,o.epoch,o.position)=(b.partition_no,b.epoch,b.position)
       AND o.type='com.rezics.content.thread.created.v1' AND o.subject=c.catalogue_id::text
       AND o.data->>'threadId'=c.thread_id::text
     LEFT JOIN core.consumer_checkpoint cp ON cp.partition_no=o.partition_no AND cp.consumer='effects'
     LEFT JOIN core.history_event_consumer h ON (h.partition_no,h.position,h.event_seq,h.consumer)=
       (o.partition_no,o.position,o.event_seq,'content_subject_thread')
     LEFT JOIN dbos.workflow_status w ON w.workflow_uuid=
       concat('fx:',o.epoch,':',o.partition_no,':',o.position,':',o.event_seq,':content_subject_thread')
     WHERE (c.route,c.catalogue_id)=($3,$4) LIMIT 1`,
    [subjectRoute, book.subjectId, catalogueRoute, book.catalogueId, publicationId, partitionOf(catalogueRoute)],
  );
}

async function hydrate(page: Page) {
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
  await page.getByRole('main').waitFor({ state: 'attached' });
}

function pageFrom(journey: { context: { pages(): Page[] } }): Page {
  const page = journey.context.pages().at(-1);
  if (!page) throw new Error('Native sign-in did not retain its private browser page');
  page.setDefaultTimeout(30_000);
  return page;
}

async function readAnonymousControlPage(href: string, chapter: JourneyPost): Promise<string> {
  const page = await (await auth.context('anonymous')).newPage();
  try {
    page.setDefaultTimeout(30_000);
    await page.goto(href, { waitUntil: 'domcontentloaded' });
    await hydrate(page);
    await page.getByRole('heading', { name: 'Control chapter · Beside the harbor steps', exact: true }).waitFor({
      state: 'visible',
    });
    await page.getByText(documentText(chapter.body), { exact: true }).waitFor({ state: 'visible' });
    return page.url();
  } finally {
    await page.close();
  }
}

function chapterStudioPath(draft: JourneyPost) {
  return `/en/studio?postId=${encodeURIComponent(draft.postId)}`;
}

async function findCurrentControlCatalogue(control: HostedReaderControl, revisionId: string) {
  const timeout = 30_000;
  const signal = AbortSignal.timeout(timeout);
  const deadline = performance.now() + timeout;
  do {
    const listing = await control.member.subjects({ id: control.subjectId }).hostedCatalogues.get({
      query: { includeTitle: '1', limit: '20' },
      fetch: { signal },
    });
    if (listing.status !== 200 || listing.error || !listing.data)
      throw new Error(`Generated member Book discovery returned ${listing.status}`);
    const { items } = listing.data as { items: { catalogueId: string; revisionId: string; title?: string }[] };
    const index = items.findIndex((item) => item.catalogueId === control.catalogueId && item.revisionId === revisionId);
    if (index >= 0) return { index, title: items[index]!.title?.trim() || 'Published book ' + (index + 1) };
    // The Subject-thread effect is independent of committing the Book release.
    await Bun.sleep(Math.max(0, Math.min(1_000, deadline - performance.now())));
  } while (performance.now() < deadline);
  throw new Error('Generated Book subject discovery omitted the separate control');
}

async function saveChapterDraft(
  page: Page,
  author: KernelClient,
  draft: JourneyPost,
  bodyText: string,
  includeCover: boolean,
) {
  const href = new URL(chapterStudioPath(draft), stack.web).href;
  if (page.url() !== href) await page.goto(href, { waitUntil: 'domcontentloaded' });
  await hydrate(page);
  const editor = page.locator('.ProseMirror[contenteditable="true"]').last();
  await editor.waitFor({ state: 'visible' });
  await editor.fill(bodyText);

  let mediaId: string | undefined;
  if (includeCover) {
    const reservationPromise = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/media' && response.request().method() === 'POST',
    );
    const uploadPromise = page.waitForResponse(
      (response) =>
        /^\/media\/[0-9a-f-]+$/i.test(new URL(response.url()).pathname) && response.request().method() === 'PUT',
    );
    await page.getByRole('button', { name: 'Image', exact: true }).click();
    await page.getByLabel('Choose image file', { exact: true }).setInputFiles({
      name: 'lantern-ferry-cover.png',
      mimeType: 'image/png',
      buffer: lanternFerryCoverPng(),
    });
    await page.getByLabel('Alt text', { exact: true }).fill('Original Lantern Ferry cover');
    await page.getByRole('button', { name: 'Insert image', exact: true }).click();
    const reservation = await reservationPromise;
    expect(reservation.status(), 'the native editor reserves the deterministic cover').toBe(201);
    const result = (await reservation.json()) as { media: { id: string } };
    mediaId = result.media.id;
    const mediaPath = `/media/${mediaId}`;
    const polls: PlaywrightResponse[] = [];
    let preview: { method: string; status: number } | undefined;
    const observeCover = (response: PlaywrightResponse) => {
      const method = response.request().method();
      const pathname = new URL(response.url()).pathname;
      if (method === 'GET' && pathname === mediaPath) {
        if (polls.length === 3) polls.shift();
        polls.push(response);
      } else if ((method === 'GET' || method === 'HEAD') && pathname.startsWith(`${mediaPath}/`)) {
        preview = { method, status: response.status() };
      }
    };
    page.on('response', observeCover);
    try {
      const upload = await uploadPromise;
      expect(new URL(upload.url()).pathname).toBe(mediaPath);
      expect(upload.status(), 'the browser uploads the original cover bytes').toBe(200);
      try {
        await page
          .getByRole('img', { name: 'Original Lantern Ferry cover', exact: true })
          .waitFor({ state: 'visible' });
      } catch (cause) {
        const selected = [upload, ...polls];
        const [work, states] = await Promise.all([
          observeCoverWork(mediaId),
          settledWithin(
            Promise.all(
              selected.map(async (response) => {
                const body = (await response.json().catch(() => null)) as { media?: { state?: unknown } } | null;
                const state = body?.media?.state;
                const knownState =
                  state === 'reserved' || state === 'uploaded' || state === 'available' || state === 'rejected';
                return {
                  method: response.request().method(),
                  status: response.status(),
                  state: knownState ? state : null,
                };
              }),
            ),
            1_000,
          ).catch(() => undefined),
        ]);
        throw new Error(
          `${errorText(cause)}; exact cover responses=${JSON.stringify(states ?? selected.map((response) => ({ method: response.request().method(), status: response.status() })))}; preview response=${JSON.stringify(preview ?? null)}; exact image work=${work}`,
          { cause },
        );
      }
    } finally {
      page.off('response', observeCover);
    }
  }

  const save = page.getByRole('button', { name: 'Save draft', exact: true });
  await save.waitFor({ state: 'visible' });
  const readyBy = Date.now() + 30_000;
  while (!(await save.isEnabled()) && Date.now() < readyBy) await Bun.sleep(100);
  expect(await save.isEnabled(), 'the changed exact draft can be saved after its image upload').toBe(true);
  await save.click();
  await page.getByText(/^Saved privately ·/).waitFor({ timeout: 60_000 });

  const post = await readNativePost(author, draft.postId);
  expect(post.revisionId).not.toBe(draft.revisionId);
  expect(post.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(documentText(post.body)).toContain(bodyText);
  if (mediaId) {
    const withMedia = post as typeof post & { mediaIds: readonly string[] };
    expect(withMedia.mediaIds).toContain(mediaId);
  }
  return { post, mediaId };
}

async function readStructure(client: KernelClient, catalogueId: string) {
  const headResult = await client.hostedCatalogues({ id: catalogueId }).get({ query: { kind: 'structure' } });
  if (headResult.status !== 200 || headResult.error || !headResult.data)
    throw new Error(`Generated current Book structure read returned ${headResult.status}`);
  const head = headResult.data as NativeRevision;
  const rootResult = await client.hostedCatalogues({ id: catalogueId }).children.get({
    query: { kind: 'structure', revisionId: head.revisionId, limit: '20' },
  });
  if (rootResult.status !== 200 || rootResult.error || !rootResult.data)
    throw new Error(`Generated Book root occurrence read returned ${rootResult.status}`);
  const root = rootResult.data as NativePage;
  if (root.nextCursor !== null) throw new Error('The Book witness fixture unexpectedly exceeded its root page');
  const items = [...root.items];
  for (const part of root.items.filter((item) => item.kind === 'part' && item.availability === 'available')) {
    const children = await client.hostedCatalogues({ id: catalogueId }).children.get({
      query: { kind: 'structure', revisionId: head.revisionId, parentId: part.occurrenceId, limit: '20' },
    });
    if (children.status !== 200 || children.error || !children.data)
      throw new Error(`Generated Book part read returned ${children.status} for ${part.occurrenceId}`);
    const childPage = children.data as NativePage;
    if (childPage.nextCursor !== null) throw new Error(`Book part ${part.occurrenceId} exceeded its witness page`);
    items.push(...childPage.items);
  }
  return { head, items };
}

async function pickDraft(page: Page, title: string) {
  await page.getByRole('button', { name: 'Open a saved account draft', exact: true }).click();
  const picker = page.getByRole('region', { name: 'Server-saved drafts', exact: true });
  const loaded = picker.and(page.locator('[aria-busy="false"]'));
  const draft = picker.getByRole('button', { name: title, exact: true });
  const preparing = picker.getByText(
    'This list is still being prepared. An empty page does not mean there are no drafts.',
    {
      exact: true,
    },
  );
  const restart = picker.getByRole('button', { name: 'Restart list', exact: true });
  const deadline = performance.now() + 30_000;
  const remaining = () => {
    const ms = Math.ceil(deadline - performance.now());
    if (ms <= 0) throw new Error(`Server-saved drafts did not show ${title} within 30 seconds`);
    return ms;
  };
  for (;;) {
    await loaded.waitFor({ state: 'visible', timeout: remaining() });
    if ((await draft.isVisible()) || !(await preparing.isVisible())) {
      await draft.click({ timeout: remaining() });
      return;
    }
    // Preparing pages are snapshots. Ask for another page through the same mounted picker.
    await Bun.sleep(Math.min(1_000, remaining()));
    await restart.click({ timeout: remaining() });
  }
}

async function associateChapterLanguage(
  page: Page,
  chapterTitle: string,
  language: string,
  title: string,
  makeDefault = false,
) {
  const outline = page.getByRole('region', { name: 'Book table of contents', exact: true });
  await outline.getByRole('button', { name: `Organize ${chapterTitle}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Chapter body languages', exact: true }).click();
  const form = page.getByRole('form', { name: 'Chapter body languages', exact: true });
  await form.getByLabel('Language code', { exact: true }).fill(language);
  await form.getByLabel('Chapter title in this language', { exact: true }).fill(title);
  if (makeDefault)
    await form.getByRole('button', { name: 'Declare this language as the default', exact: true }).click();
  const consent = form.getByRole('region', { name: 'Permission for this saved version', exact: true });
  await consent.getByRole('button', { name: 'Permit this version for this Book', exact: true }).click();
  await consent
    .getByText('Permission was granted for this saved version and this Book. This action did not publish anything.', {
      exact: true,
    })
    .waitFor({ state: 'visible' });
  await form.getByRole('button', { name: 'Attach saved version', exact: true }).click();
  await form.waitFor({ state: 'hidden' });
}

async function activatePreparedBook(page: Page) {
  const activation = page.getByRole('region', { name: 'Activate this prepared Book release', exact: true });
  await activation.getByRole('button', { name: 'Check this sealed candidate', exact: true }).click();
  const confirm = activation.getByRole('button', { name: 'Activate this exact release', exact: true });
  const next = activation.getByRole('button', { name: 'Check next targets', exact: true });
  // The witness has exactly two selected body targets; this is bounded explicit advancement, never a body/Book scan.
  for (let step = 0; step < 4; step++) {
    await confirm.or(next).waitFor({ state: 'visible' });
    if (await confirm.isVisible()) break;
    await next.click();
  }
  await confirm.click();
  await activation
    .getByText('Activation acknowledged for this exact release.', { exact: true })
    .first()
    .waitFor({ state: 'visible' });
  await activation.getByRole('button', { name: 'Read current publication and verify reader', exact: true }).click();
  await activation
    .getByText('The current publication and anonymous exact reader are verified.', { exact: true })
    .waitFor({ state: 'visible' });
}

async function assertPublishedLanguage(
  client: KernelClient,
  catalogueId: string,
  release: string,
  occurrenceId: string,
  language: string,
  expected: JourneyPost,
) {
  const result = await client
    .hostedCatalogues({ id: catalogueId })
    .occurrences({ occurrenceId })
    .body.get({
      query: {
        kind: 'publication',
        revisionId: release,
        language,
        targetPostId: expected.postId,
        targetRevisionId: expected.revisionId,
        targetSha256: expected.sha256,
      },
    });
  if (result.status !== 200 || result.error || !result.data)
    throw new Error(`Exact ${language} body returned HTTP ${result.status}`);
  const value = result.data as {
    selectedLanguage: string | null;
    occurrence: { availability: string; target?: { postId: string; revisionId: string; sha256: string } };
    document: { canonicalBytes: string; sha256: string; licence: string } | null;
  };
  expect(value.selectedLanguage).toBe(language);
  expect(value.occurrence.availability).toBe('available');
  expect(value.occurrence.target).toMatchObject({
    postId: expected.postId,
    revisionId: expected.revisionId,
    sha256: expected.sha256,
  });
  expect(value.document?.sha256).toBe(expected.sha256);
  expect(value.document?.licence).toBe('LicenseRef-rezics-terms');
  expect(Buffer.from(value.document!.canonicalBytes, 'base64').toString('utf8')).toBe(serializeDocument(expected.body));
  return value;
}

async function openBookPlacementForm(page: Page) {
  const outline = page.getByRole('region', { name: 'Book table of contents', exact: true });
  await outline.getByRole('button', { name: 'Add part or chapter', exact: true }).click();
  return page.getByRole('form', { name: 'Add part or chapter', exact: true });
}

async function addChapterFromPicker(page: Page, title: string, draftTitle: string) {
  await pickDraft(page, draftTitle);
  const form = await openBookPlacementForm(page);
  await form.getByLabel('Placement title', { exact: true }).fill(title);
  await form.getByRole('button', { name: 'Add chapter', exact: true }).click();
  await page.getByRole('button', { name: title, exact: true }).waitFor({ state: 'visible' });
}

async function addPartInStudio(page: Page, title: string) {
  const organizer = page.getByRole('region', { name: 'Book table of contents', exact: true });
  const form = await openBookPlacementForm(page);
  await form.getByRole('combobox', { name: 'Add', exact: true }).click();
  await page.getByRole('option', { name: 'Part', exact: true }).click();
  await form.getByLabel('Placement title', { exact: true }).fill(title);
  await form.getByRole('button', { name: 'Add part', exact: true }).click();
  await organizer.getByText(title, { exact: true }).waitFor({ state: 'visible' });
}

async function movePlacementUnderPart(page: Page, placementTitle: string, partTitle: string) {
  const organizer = page.getByRole('region', { name: 'Book table of contents', exact: true });
  await organizer.getByRole('button', { name: `Organize ${placementTitle}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Move to…', exact: true }).click();
  const form = page.getByRole('form', { name: 'Move to…', exact: true });
  await form.getByRole('combobox', { name: 'Destination', exact: true }).click();
  await page.getByRole('option', { name: new RegExp(partTitle) }).click();
  await form.getByRole('button', { name: 'Move placement', exact: true }).click();
  await organizer.getByText(partTitle, { exact: true }).waitFor({ state: 'visible' });
}

async function movePlacementUp(page: Page, placementTitle: string) {
  const organizer = page.getByRole('region', { name: 'Book table of contents', exact: true });
  await organizer.getByRole('button', { name: `Organize ${placementTitle}`, exact: true }).click();
  await page.getByRole('menuitem', { name: `Move up ${placementTitle}`, exact: true }).click();
}

async function openBookStudio(page: Page, catalogueId: string) {
  await page.goto(`${stack.web}/en/studio?catalogueId=${encodeURIComponent(catalogueId)}`, {
    waitUntil: 'domcontentloaded',
  });
  await hydrate(page);
  await page.getByRole('region', { name: 'Book table of contents', exact: true }).waitFor({ state: 'visible' });
}

async function readOwnedBook(client: KernelClient, accountId: string, catalogueId: string) {
  const result = await client.accounts({ accountId }).hostedCatalogues({ id: catalogueId }).get();
  if (result.status !== 200 || result.error || !result.data)
    throw new Error(`Generated exact Book owner read returned ${result.status}`);
  const owner = result.data as {
    viewer: { accountId: string; authnEpoch: number };
    item: { catalogueId: string; headRevisionId: string; publicationId: string | null };
  };
  if (owner.viewer.accountId !== accountId || owner.item.catalogueId !== catalogueId)
    throw new Error('Generated exact Book owner read changed its account or catalogue identity');
  return owner;
}

async function assertPublishedBody(
  anonymous: KernelClient,
  catalogueId: string,
  revisionId: string,
  occurrenceId: string,
  target: JourneyPost,
) {
  const result = await anonymous.hostedCatalogues({ id: catalogueId }).occurrences({ occurrenceId }).get({
    query: { revisionId },
  });
  if (result.status !== 200 || result.error || !result.data)
    throw new Error(`Generated anonymous exact occurrence read returned ${result.status}`);
  const response = result.data as {
    occurrence: { occurrenceId: string; kind: string; target: { postId: string; revisionId: string; sha256: string } };
    document: { encoding: string; canonicalBytes: string; sha256: string } | null;
  };
  const bytes = Buffer.from(serializeDocument(target.body), 'utf8');
  expect(response.occurrence.occurrenceId).toBe(occurrenceId);
  expect(response.occurrence.kind).toBe('chapter');
  expect(response.occurrence.target).toMatchObject({
    postId: target.postId,
    revisionId: target.revisionId,
    sha256: target.sha256,
  });
  expect(response.document).toMatchObject({
    encoding: 'base64',
    canonicalBytes: bytes.toString('base64'),
    sha256: target.sha256,
  });
  const root = await anonymous.hostedCatalogues({ id: catalogueId }).children.get({
    query: { kind: 'publication', revisionId, limit: '20' },
  });
  if (root.status !== 200 || root.error || !root.data)
    throw new Error(`Generated anonymous release occurrence list returned ${root.status}`);
  const publicRoot = root.data as { items: { availability: string; kind: string; occurrenceId: string }[] };
  expect(
    publicRoot.items
      .filter((item) => item.kind === 'chapter' && item.availability === 'available')
      .map((item) => item.occurrenceId),
  ).toContain(occurrenceId);
  return response;
}

function nativeStatus(result: { status: number }) {
  return result.status;
}

nativeTest(
  'mounted private Book drafts bind published languages, activate exact nested selection and preserve frozen reader checkpoints',
  900_000,
  async () => {
    const journal = new StageJournal();
    let seed: HostedBookJourneySeed | undefined;
    let chapterOne: Awaited<ReturnType<typeof readNativePost>> | undefined;
    let chapterTwo: Awaited<ReturnType<typeof readNativePost>> | undefined;
    let chapterFrench: Awaited<ReturnType<typeof readNativePost>> | undefined;
    let authorRelease: string | undefined;
    let frenchExactHref: string | undefined;
    let catalogueId: string | undefined;
    let partTitle: string | undefined;
    let chapterOneTitle: string | undefined;
    let chapterTwoTitle: string | undefined;
    let chapterOneOccurrence: string | undefined;
    let chapterTwoOccurrence: string | undefined;
    let stageId: string | undefined;
    let preparationOperands: string | undefined;
    let activationOperands: PrivateActivationOperands | undefined;
    let candidateSealed = false;
    seed = await journal.run('generated private manuscript setup', async () => {
      const value = await createHostedBookJourneySeed(stack, 'Private draft journey');
      return {
        value,
        observation:
          'subject=' +
          value.subjectId +
          ' author=' +
          value.authorAccountId +
          ' member=' +
          value.memberAccountId +
          ' opening=' +
          value.opening.postId +
          ' chapters=' +
          value.chapterOne.postId +
          ',' +
          value.chapterTwo.postId,
      };
    });

    if (!seed) {
      await journal.finish('Mounted private Hosted Book manuscript setup');
      throw new Error('Mounted Hosted Book setup did not return the author manuscript');
    }
    const ownerJourney = await auth.signIn('alice', { returnTo: chapterStudioPath(seed.chapterOne) });
    const page = pageFrom(ownerJourney);
    await page.setViewportSize({ width: 1440, height: 1000 });

    const frenchText =
      'Mara comptait les lanternes depuis le pont du bac et dessinait le port silencieux sur sa carte.';
    const frenchTitle = 'Les lanternes du port';
    const oneText = 'Mara counted the lanterns from the ferry deck and marked the quiet harbor on her chart.';
    if (seed) {
      const saved = await journal.run(
        'save chapter one and upload the deterministic original cover in Studio',
        async () => {
          const result = await saveChapterDraft(page, seed!.author, seed!.chapterOne, oneText, true);
          chapterOne = result.post;
          return {
            value: result.post,
            observation:
              'post=' +
              result.post.id +
              ' revision=' +
              result.post.revisionId +
              ' sha256=' +
              result.post.sha256 +
              ' media=' +
              result.mediaId,
          };
        },
        () => pageObservation(page),
      );
      if (!saved)
        journal.unreached('chapter one saved-version readback', 'Studio save and generated readback did not complete');

      if (saved) {
        await journal.run(
          'preview the saved chapter privately through the mounted Studio view',
          async () => {
            await page.getByRole('button', { name: 'Preview', exact: true }).click();
            const preview = page.getByRole('region', { name: 'Private draft preview', exact: true });
            await preview.getByText(oneText, { exact: true }).waitFor({ state: 'visible' });
            await preview.getByText('Private preview · saved draft version', { exact: true }).waitFor({
              state: 'visible',
            });
            return {
              value: true,
              observation: 'saved-revision=' + chapterOne!.revisionId + ' preview-body-visible=true',
            };
          },
          () => pageObservation(page),
        );

        await journal.run(
          'compare the original and current saved chapter revisions in Studio',
          async () => {
            await page.getByRole('button', { name: 'Version history', exact: true }).click();
            const versions = page.getByRole('region', { name: 'Document versions', exact: true });
            await expect(versions).toBeVisible();
            const original = versions.locator('li').filter({ hasText: seed!.chapterOne.revisionId });
            await original.getByRole('button', { name: /^Compare /u }).click();
            await versions.getByRole('heading', { name: 'Selected version', exact: true }).waitFor({
              state: 'visible',
            });
            await versions.getByRole('heading', { name: 'Current saved draft', exact: true }).waitFor({
              state: 'visible',
            });
            await versions.getByText(documentText(seed!.chapterOne.body), { exact: true }).waitFor({
              state: 'visible',
            });
            await versions.getByText(oneText, { exact: true }).waitFor({ state: 'visible' });
            expect(await original.innerText()).toContain(seed!.chapterOne.revisionId);
            return {
              value: true,
              observation:
                'compared=' +
                seed!.chapterOne.revisionId +
                ' against=' +
                chapterOne!.revisionId +
                ' original-and-current-bodies-visible=true',
            };
          },
          () => pageObservation(page),
        );
      } else {
        journal.unreached(
          'private saved chapter preview and revision comparison',
          'Chapter one did not save a native exact version',
        );
      }

      const twoText = 'At first light, the ferryman found Mara’s map tucked beneath the warm brass lantern.';
      const second = await journal.run(
        'save chapter two as a separate private exact draft in Studio',
        async () => {
          const result = await saveChapterDraft(page, seed!.author, seed!.chapterTwo, twoText, false);
          chapterTwo = result.post;
          return {
            value: result.post,
            observation:
              'post=' + result.post.id + ' revision=' + result.post.revisionId + ' sha256=' + result.post.sha256,
          };
        },
        () => pageObservation(page),
      );
      if (!second)
        journal.unreached('chapter two saved-version readback', 'Studio save and generated readback did not complete');

      const frenchSaved = await journal.run(
        'save an actual French chapter body as a separate private exact Post in Studio',
        async () => {
          const result = await saveChapterDraft(page, seed!.author, seed!.chapterFrench, frenchText, false);
          chapterFrench = result.post;
          return {
            value: result.post,
            observation: `post=${result.post.id} revision=${result.post.revisionId} sha256=${result.post.sha256} language=fr`,
          };
        },
        () => pageObservation(page),
      );
      if (!frenchSaved)
        journal.unreached('French saved-version readback', 'The French Post did not save through mounted Studio');

      await journal.run('anonymous direct reads conceal private chapter drafts before release', async () => {
        const firstDirect = await seed!.anonymous.posts({ id: seed!.chapterOne.postId }).get();
        const secondDirect = await seed!.anonymous.posts({ id: seed!.chapterTwo.postId }).get();
        const frenchDirect = await seed!.anonymous.posts({ id: seed!.chapterFrench.postId }).get();
        expect(frenchDirect.status).toBe(404);
        expect(nativeStatus(firstDirect)).toBe(404);
        expect(nativeStatus(secondDirect)).toBe(404);
        return {
          value: true,
          observation: 'chapter-one=' + firstDirect.status + ' chapter-two=' + secondDirect.status,
        };
      });

      const book = await journal.run(
        'start the private Book from the saved opening in Studio',
        async () => {
          await page.goto(stack.web + '/en/studio?postId=' + encodeURIComponent(seed!.opening.postId), {
            waitUntil: 'domcontentloaded',
          });
          await hydrate(page);
          await page.getByRole('button', { name: 'Start a Book', exact: true }).click();
          await page.waitForURL((url) => url.searchParams.has('catalogueId'), { timeout: 90_000 });
          await page.getByRole('region', { name: 'Book table of contents', exact: true }).waitFor({ state: 'visible' });
          const id = new URL(page.url()).searchParams.get('catalogueId');
          if (!id) throw new Error('Start a Book did not navigate to the admitted owner Book');
          catalogueId = id;
          const owner = await readOwnedBook(seed!.author, seed!.authorAccountId, id);
          const structure = await readStructure(seed!.author, id);
          expect(owner.item.headRevisionId).toBe(structure.head.revisionId);
          expect(owner.item.publicationId).toBeNull();
          return {
            value: id,
            observation:
              'catalogue=' +
              id +
              ' owner=' +
              owner.viewer.accountId +
              '@' +
              owner.viewer.authnEpoch +
              ' draft=' +
              owner.item.headRevisionId +
              ' publication=null',
          };
        },
        () => pageObservation(page),
      );
      if (!book)
        journal.unreached(
          'Book Studio chapter placement and selected preparation',
          'Book start did not reach its admitted owner route',
        );

      if (book && chapterOne) {
        chapterOneTitle = 'Lanterns at Low Tide';
        await journal.run(
          'place the saved chapter one version through the Book Studio picker',
          async () => {
            await addChapterFromPicker(page, chapterOneTitle!, seed!.chapterOne.title);
            const outline = await readStructure(seed!.author, catalogueId!);
            const placement = outline.items.find(
              (item) => item.kind === 'chapter' && item.target?.postId === chapterOne!.id,
            );
            if (!placement) throw new Error('Book structure readback omitted the saved chapter one Post');
            expect(placement.target).toMatchObject({
              revisionId: chapterOne!.revisionId,
              sha256: chapterOne!.sha256,
            });
            chapterOneOccurrence = placement.occurrenceId;
            return {
              value: placement,
              observation:
                'occurrence=' +
                placement.occurrenceId +
                ' parent=' +
                placement.parentId +
                ' exact=' +
                placement.target?.revisionId,
            };
          },
          () => pageObservation(page),
        );
      } else {
        journal.unreached(
          'Book Studio chapter one placement',
          'Book start or chapter one saved-version readback failed',
        );
      }

      if (book) {
        partTitle = 'Under the Lanterns';
        await journal.run(
          'create a part through the Book Studio outline',
          async () => {
            await addPartInStudio(page, partTitle!);
            const outline = await readStructure(seed!.author, catalogueId!);
            const part = outline.items.find((item) => item.kind === 'part' && item.title === partTitle);
            if (!part) throw new Error('Generated Book structure readback omitted part ' + partTitle);
            return { value: part, observation: 'part=' + part.occurrenceId + ' position=' + part.position };
          },
          () => pageObservation(page),
        );
      } else {
        journal.unreached('Book Studio part creation', 'Book start did not reach its admitted owner route');
      }

      if (book && chapterTwo) {
        chapterTwoTitle = 'The Ferry Map';
        await journal.run(
          'append the second saved draft at Book root through the mounted Root Append route',
          async () => {
            await page.goto(stack.web + '/en/studio?catalogueId=' + encodeURIComponent(catalogueId!) + '&append=1', {
              waitUntil: 'domcontentloaded',
            });
            await hydrate(page);
            await page.getByRole('heading', { name: 'Append a saved chapter', exact: true }).waitFor({
              state: 'visible',
            });
            await pickDraft(page, seed!.chapterTwo.title);
            await page.getByLabel('Chapter title', { exact: true }).fill(chapterTwoTitle!);
            await page.getByRole('button', { name: 'Review append', exact: true }).click();
            await page.getByRole('button', { name: 'Append this saved chapter', exact: true }).click();
            await page.getByText(/Chapter append acknowledged/u).waitFor({ state: 'visible' });
            await openBookStudio(page, catalogueId!);
            const outline = await readStructure(seed!.author, catalogueId!);
            const placement = outline.items.find(
              (item) => item.kind === 'chapter' && item.target?.postId === chapterTwo!.id,
            );
            if (!placement) throw new Error('Generated Book structure omitted the root-appended second Post');
            expect(placement.parentId).toBeNull();
            expect(placement.target).toMatchObject({
              revisionId: chapterTwo!.revisionId,
              sha256: chapterTwo!.sha256,
            });
            chapterTwoOccurrence = placement.occurrenceId;
            return {
              value: placement,
              observation:
                'occurrence=' +
                placement.occurrenceId +
                ' parent=' +
                placement.parentId +
                ' exact=' +
                placement.target?.revisionId,
            };
          },
          async () => {
            const [browser, draft] = await Promise.all([
              pageObservation(page),
              observeDraftReadiness(seed!.authorAccountId, chapterTwo!.id, chapterTwo!.revisionId),
            ]);
            return `${browser}; exact draft readiness=${draft}`;
          },
        );
      } else {
        journal.unreached('mounted Root Append', 'Book start or chapter two saved-version readback failed');
      }

      if (book && chapterTwo && partTitle && chapterTwoTitle && chapterTwoOccurrence) {
        await journal.run(
          'reorder the appended root chapter before its part in Book Studio',
          async () => {
            await openBookStudio(page, catalogueId!);
            await movePlacementUp(page, chapterTwoTitle!);
            const outline = await readStructure(seed!.author, catalogueId!);
            const moved = outline.items.find((item) => item.occurrenceId === chapterTwoOccurrence);
            const part = outline.items.find((item) => item.kind === 'part' && item.title === partTitle);
            if (!moved || !part || moved.parentId !== null || moved.position >= part.position)
              throw new Error('Root sibling reorder did not place the chapter before its part');
            return {
              value: moved,
              observation:
                'occurrence=' + moved.occurrenceId + ' position=' + moved.position + ' before-part=' + part.position,
            };
          },
          () => pageObservation(page),
        );
      } else {
        journal.unreached('chapter reorder before nesting', 'The appended exact root chapter was not read back');
      }

      if (book && chapterTwo && partTitle && chapterTwoTitle && chapterTwoOccurrence) {
        await journal.run(
          'move the reordered exact placement into its part in Book Studio',
          async () => {
            await openBookStudio(page, catalogueId!);
            await movePlacementUnderPart(page, chapterTwoTitle!, partTitle!);
            const outline = await readStructure(seed!.author, catalogueId!);
            const part = outline.items.find((item) => item.kind === 'part' && item.title === partTitle);
            const moved = outline.items.find((item) => item.occurrenceId === chapterTwoOccurrence);
            if (
              !part ||
              !moved ||
              moved.parentId !== part.occurrenceId ||
              moved.target?.revisionId !== chapterTwo!.revisionId ||
              moved.target.sha256 !== chapterTwo!.sha256
            )
              throw new Error('Generated structure did not retain the exact nested placement');
            return {
              value: moved,
              observation:
                'occurrence=' + moved.occurrenceId + ' parent=' + moved.parentId + ' part=' + part.occurrenceId,
            };
          },
          () => pageObservation(page),
        );
      } else {
        journal.unreached('move and nest the second placement', 'The reordered root chapter or part was unavailable');
      }

      if (book && chapterOne && chapterFrench && chapterOneOccurrence && chapterOneTitle) {
        await journal.run(
          'associate exact English default and saved French body through the mounted Book language form',
          async () => {
            await openBookStudio(page, catalogueId!);
            await page.getByRole('button', { name: chapterOneTitle!, exact: true }).click();
            await associateChapterLanguage(page, chapterOneTitle!, 'en', chapterOneTitle!, true);
            await pickDraft(page, seed!.chapterFrench.title);
            await associateChapterLanguage(page, chapterOneTitle!, 'fr', frenchTitle);
            const current = await readStructure(seed!.author, catalogueId!);
            const languages = await seed!.author
              .hostedCatalogues({ id: catalogueId! })
              .occurrences({ occurrenceId: chapterOneOccurrence! })
              .languages.get({ query: { kind: 'structure', revisionId: current.head.revisionId, limit: '20' } });
            if (languages.status !== 200 || languages.error || !languages.data)
              throw new Error(`Draft language readback returned ${languages.status}`);
            const rows = languages.data.items;
            expect(rows.find((row) => row.language === 'en')).toMatchObject({
              isDefault: true,
              target: { postId: chapterOne!.id, revisionId: chapterOne!.revisionId, sha256: chapterOne!.sha256 },
            });
            expect(rows.find((row) => row.language === 'fr')).toMatchObject({
              title: frenchTitle,
              isDefault: false,
              target: {
                postId: chapterFrench!.id,
                revisionId: chapterFrench!.revisionId,
                sha256: chapterFrench!.sha256,
              },
            });
            expect(current.items.find((row) => row.occurrenceId === chapterOneOccurrence)?.target?.postId).toBe(
              chapterOne!.id,
            );
            return {
              value: true,
              observation: `chapter=${chapterOneOccurrence} languages=en,fr canonicalPost=${chapterOne!.id} FrenchPost=${chapterFrench!.id} head=${current.head.revisionId}`,
            };
          },
          () => pageObservation(page),
        );
      } else
        journal.unreached(
          'mounted language association',
          'The canonical chapter or saved French source was unavailable',
        );

      if (book && chapterOne && chapterOneOccurrence && chapterOneTitle && chapterTwo && chapterTwoOccurrence) {
        const prepared = await journal.run(
          'review, recover, and seal the exact selected private candidate',
          async () => {
            await openBookStudio(page, catalogueId!);
            const owner = await readOwnedBook(seed!.author, seed!.authorAccountId, catalogueId!);
            const outline = await readStructure(seed!.author, catalogueId!);
            expect(owner.item.headRevisionId).toBe(outline.head.revisionId);
            expect(owner.item.publicationId).toBeNull();
            expect(outline.items.find((item) => item.occurrenceId === chapterOneOccurrence)?.target).toMatchObject({
              postId: chapterOne!.id,
              revisionId: chapterOne!.revisionId,
              sha256: chapterOne!.sha256,
            });
            const prepareLink = page.getByRole('link', { name: 'Prepare the whole Book', exact: true });
            const prepareHref = await prepareLink.getAttribute('href');
            if (!prepareHref) throw new Error('Book Studio did not expose the mounted preparation route');
            await prepareLink.click();
            await page.waitForURL((url) => url.searchParams.get('prepare') === '1');
            const route = new URL(page.url());
            const routeOwner = route.searchParams.get('ownerAccount');
            const routeEpoch = route.searchParams.get('ownerEpoch');
            expect(routeOwner).toBe(owner.viewer.accountId);
            expect(routeEpoch).toBe(String(owner.viewer.authnEpoch));
            await page.getByRole('heading', { name: 'Prepare a private Book release', exact: true }).waitFor({
              state: 'visible',
            });
            const reviewed = await page.locator('main').innerText();
            expect(reviewed).toContain(owner.item.headRevisionId);
            expect(reviewed).toContain('No current release');
            await page.getByRole('button', { name: 'Use these exact versions', exact: true }).click();
            await page.getByRole('button', { name: 'Choose chapters across draft pages', exact: true }).click();
            await page.waitForFunction(() => new URL(location.href).searchParams.has('stageId'));
            stageId = new URL(page.url()).searchParams.get('stageId') ?? undefined;
            if (!stageId) throw new Error('Selected preparation did not retain its stage locator in the URL');
            await page.reload({ waitUntil: 'domcontentloaded' });
            await hydrate(page);
            await page.getByRole('region', { name: 'Selected draft placements', exact: true }).waitFor({
              state: 'visible',
              timeout: 90_000,
            });
            expect(new URL(page.url()).searchParams.get('stageId')).toBe(stageId);
            const selection = page.getByRole('region', { name: 'Selected draft placements', exact: true });
            const selected = selection.getByRole('checkbox', { name: new RegExp(chapterOneTitle!) });
            const excluded = selection.getByRole('checkbox', { name: new RegExp(chapterTwoTitle ?? 'The Ferry Map') });
            const excludedPart = selection.getByRole('checkbox', {
              name: new RegExp(partTitle ?? 'Under the Lanterns'),
            });
            await selected.click();
            expect(await selected.isChecked()).toBe(true);
            if (await excluded.count()) expect(await excluded.isChecked()).toBe(false);
            if (await excludedPart.count()) expect(await excludedPart.isChecked()).toBe(false);
            await selection.getByRole('button', { name: 'Add checked placements from this page', exact: true }).click();
            await selection.getByRole('button', { name: 'Freeze stored selection', exact: true }).waitFor({
              state: 'visible',
            });
            const count = selection.locator('dd').nth(0);
            await count.waitFor({ state: 'visible' });
            expect(await count.innerText()).toBe('1');
            await selection.getByRole('button', { name: 'Freeze stored selection', exact: true }).click();
            await page.getByRole('button', { name: 'Resume preparation', exact: true }).waitFor({
              state: 'visible',
              timeout: 90_000,
            });
            await page.getByRole('button', { name: 'Resume preparation', exact: true }).click();
            await page.getByRole('button', { name: 'Seal private candidate', exact: true }).waitFor({
              state: 'visible',
              timeout: 120_000,
            });
            const sourceHead = owner.item.headRevisionId;
            activationOperands = {
              catalogueId: catalogueId!,
              ownerAccountId: owner.viewer.accountId,
              authnEpoch: owner.viewer.authnEpoch,
              expectedDraftHeadRevisionId: sourceHead,
              expectedPublicationId: null,
              stageId: stageId!,
              selectedOccurrenceId: chapterOneOccurrence!,
              target: {
                postId: chapterOne!.id,
                threadId: seed!.chapterOne.threadId,
                revisionId: chapterOne!.revisionId,
                sha256: chapterOne!.sha256,
              },
            };
            preparationOperands =
              `catalogue=${activationOperands.catalogueId}` +
              ` owner=${activationOperands.ownerAccountId}@${activationOperands.authnEpoch}` +
              ` expectedHeadRevisionId=${activationOperands.expectedDraftHeadRevisionId}` +
              ` expectedPublicationId=null mode=selection stageId=${activationOperands.stageId}` +
              ` selectedOccurrence=${activationOperands.selectedOccurrenceId}` +
              ` targetPost=${activationOperands.target.postId}` +
              ` targetThread=${activationOperands.target.threadId}` +
              ` targetRevision=${activationOperands.target.revisionId}` +
              ` targetSha256=${activationOperands.target.sha256}` +
              ` unselectedOccurrence=${chapterTwoOccurrence ?? 'unavailable'}` +
              ` unselectedRevision=${chapterTwo?.revisionId ?? 'unavailable'}`;
            await page.getByRole('button', { name: 'Seal private candidate', exact: true }).click();
            await page
              .getByText('Private candidate sealed. It has not been published. The existing release stays current.', {
                exact: true,
              })
              .waitFor({ state: 'visible', timeout: 90_000 });
            const afterSeal = await readOwnedBook(seed!.author, seed!.authorAccountId, catalogueId!);
            expect(afterSeal.item.headRevisionId).toBe(sourceHead);
            expect(afterSeal.item.publicationId).toBeNull();
            const omittedDraft = await seed!.member.posts({ id: chapterTwo!.id }).get();
            expect(omittedDraft.status).toBe(404);
            const view = await page.locator('main').innerText();
            expect(view).toMatch(/Candidate chapters\s+1/u);
            candidateSealed = true;
            return {
              value: stageId,
              observation:
                preparationOperands +
                ' candidateReady=true candidateChapters=1 currentPublication=null memberUnselectedPost=' +
                omittedDraft.status,
            };
          },
          () => pageObservation(page),
        );
        if (!prepared)
          journal.unreached(
            'selected private candidate seal',
            'The current preparation route did not acknowledge a sealed candidate',
          );
      } else {
        journal.unreached(
          'review, selected-stage recovery, and private candidate seal',
          'The selected and unselected exact chapter occurrences are required before preparation',
        );
      }

      if (
        catalogueId &&
        chapterOne &&
        chapterTwo &&
        chapterOneOccurrence &&
        chapterTwoOccurrence &&
        partTitle &&
        chapterOneTitle &&
        preparationOperands &&
        candidateSealed
      ) {
        await journal.run(
          'activate the selected private candidate through mounted checks and explicit publication',
          async () => {
            await activatePreparedBook(page);
            const owner = await readOwnedBook(seed!.author, seed!.authorAccountId, catalogueId!);
            if (!owner.item.publicationId) throw new Error('Mounted activation did not produce a current release');
            authorRelease = owner.item.publicationId;
            expect(owner.item.headRevisionId).toBe(activationOperands!.expectedDraftHeadRevisionId);
            return {
              value: authorRelease,
              observation: `activatedRelease=${authorRelease} sourceHead=${owner.item.headRevisionId} selected=${chapterOneOccurrence} languages=en,fr`,
            };
          },
          () => pageObservation(page),
        );

        const laterText = 'Mara revised the chart after sunrise, adding the ferry’s quiet western landing in blue ink.';
        const changed = await journal.run(
          'save a later private chapter revision after publication',
          async () => {
            const revised = await saveChapterDraft(page, seed!.author, seed!.chapterOne, laterText, false);
            return {
              value: revised.post,
              observation:
                'candidateRevision=' +
                chapterOne!.revisionId +
                ' laterPrivateRevision=' +
                revised.post.revisionId +
                ' laterSha256=' +
                revised.post.sha256,
            };
          },
          () => pageObservation(page),
        );
        if (changed) {
          await journal.run(
            'move the selected source placement after publication',
            async () => {
              await openBookStudio(page, catalogueId!);
              await movePlacementUnderPart(page, chapterOneTitle!, partTitle!);
              const current = await readStructure(seed!.author, catalogueId!);
              const moved = current.items.find((item) => item.occurrenceId === chapterOneOccurrence);
              const currentPost = await readNativePost(seed!.author, chapterOne!.id);
              const owner = await readOwnedBook(seed!.author, seed!.authorAccountId, catalogueId!);
              expect(moved?.parentId).toBe(
                current.items.find((item) => item.kind === 'part' && item.title === partTitle)?.occurrenceId,
              );
              expect(moved?.target).toMatchObject({
                revisionId: chapterOne!.revisionId,
                sha256: chapterOne!.sha256,
              });
              expect(currentPost.revisionId).toBe(changed.revisionId);
              expect(owner.item.headRevisionId).not.toBe(activationOperands!.expectedDraftHeadRevisionId);
              expect(owner.item.publicationId).toBe(authorRelease ?? null);
              return {
                value: moved,
                observation:
                  'selectedOccurrence=' +
                  moved?.occurrenceId +
                  ' remainsPinned=' +
                  moved?.target?.revisionId +
                  ' laterPostHead=' +
                  currentPost.revisionId +
                  ' newDraftHead=' +
                  owner.item.headRevisionId +
                  ' currentPublication=' +
                  authorRelease,
              };
            },
            () => pageObservation(page),
          );
        } else {
          journal.unreached(
            'move after later private revision and candidate source readback',
            'The later chapter version did not save',
          );
        }
        if (authorRelease && chapterFrench) {
          await journal.run(
            'later private French edits do not change either frozen published language',
            async () => {
              const privateText = 'Brouillon privé ultérieur : la carte du port reste secrète après la publication.';
              const laterFrench = await saveChapterDraft(page, seed!.author, seed!.chapterFrench, privateText, false);
              expect(laterFrench.post.revisionId).not.toBe(chapterFrench!.revisionId);
              const frozenEnglish = {
                ...seed!.chapterOne,
                revisionId: chapterOne!.revisionId,
                sha256: chapterOne!.sha256,
                body: chapterOne!.body,
              };
              const frozenFrench = {
                ...seed!.chapterFrench,
                revisionId: chapterFrench!.revisionId,
                sha256: chapterFrench!.sha256,
                body: chapterFrench!.body,
              };
              await assertPublishedLanguage(
                seed!.anonymous,
                catalogueId!,
                authorRelease!,
                chapterOneOccurrence!,
                'en',
                frozenEnglish,
              );
              await assertPublishedLanguage(
                seed!.anonymous,
                catalogueId!,
                authorRelease!,
                chapterOneOccurrence!,
                'fr',
                frozenFrench,
              );
              expect((await seed!.anonymous.posts({ id: seed!.chapterOne.postId }).get()).status).toBe(404);
              expect((await seed!.anonymous.posts({ id: seed!.chapterFrench.postId }).get()).status).toBe(404);
              const publishedLanguages = await seed!.anonymous
                .hostedCatalogues({ id: catalogueId! })
                .occurrences({ occurrenceId: chapterOneOccurrence! })
                .languages.get({ query: { kind: 'publication', revisionId: authorRelease!, limit: '20' } });
              if (publishedLanguages.status !== 200 || publishedLanguages.error || !publishedLanguages.data)
                throw new Error(`Published language page returned ${publishedLanguages.status}`);
              expect(publishedLanguages.data.items.map((row) => row.language).sort()).toEqual(['en', 'fr']);
              expect(publishedLanguages.data.nextCursor).toBeNull();
              expect(JSON.stringify(publishedLanguages.data)).not.toContain(seed!.chapterTwo.postId);

              const excluded = await seed!.anonymous
                .hostedCatalogues({ id: catalogueId! })
                .occurrences({ occurrenceId: chapterTwoOccurrence! })
                .metadata.get({ query: { kind: 'publication', revisionId: authorRelease! } });
              expect(excluded.status).toBe(404);
              return {
                value: laterFrench.post,
                observation: `publishedFrench=${chapterFrench!.revisionId} laterPrivateFrench=${laterFrench.post.revisionId} English=${chapterOne!.revisionId} excludedChapter=${excluded.status}`,
              };
            },
            () => pageObservation(page),
          );

          await journal.run(
            'anonymous reader chooses a published French body, Automatic and exact browser history without changing interface locale',
            async () => {
              const context = await auth.newContext('anonymous');
              try {
                const reader = await context.newPage();
                reader.setDefaultTimeout(60_000);
                await reader.goto(
                  `${stack.web}/en/books/${catalogueId}/read?release=${authorRelease}&occurrence=${chapterOneOccurrence}&subject=${seed!.subjectId}&language=en&preferred=en`,
                  { waitUntil: 'domcontentloaded' },
                );
                await hydrate(reader);
                await reader
                  .getByRole('heading', { name: chapterOneTitle!, exact: true })
                  .waitFor({ state: 'visible' });
                await reader.locator('[data-slot="book-language-controls"] summary').click();
                await reader
                  .locator('[data-slot="book-language-controls"]')
                  .getByRole('button')
                  .filter({ hasText: frenchTitle })
                  .click();
                await reader.waitForURL((url) => url.searchParams.get('bodyLanguage') === 'fr');
                await reader.getByRole('heading', { name: frenchTitle, exact: true }).waitFor({ state: 'visible' });
                await reader
                  .locator('article.book-reading-display')
                  .getByText(frenchText, { exact: true })
                  .waitFor({ state: 'visible' });
                expect(await reader.locator('article.book-reading-display').getAttribute('lang')).toBe('fr');
                expect(await reader.locator('html').getAttribute('lang')).toBe('en');
                const exact = new URL(reader.url());
                expect(exact.searchParams.get('bodyPost')).toBe(chapterFrench!.id);
                expect(exact.searchParams.get('bodyRevision')).toBe(chapterFrench!.revisionId);
                expect(exact.searchParams.get('bodySha256')).toBe(chapterFrench!.sha256);
                frenchExactHref = reader.url();
                expect(await reader.locator('main').innerText()).not.toContain('Brouillon privé ultérieur');
                expect(await reader.locator('main').innerText()).not.toContain(laterText);
                await reader.goBack({ waitUntil: 'domcontentloaded' });
                await reader
                  .getByRole('heading', { name: chapterOneTitle!, exact: true })
                  .waitFor({ state: 'visible' });
                await reader.goForward({ waitUntil: 'domcontentloaded' });
                await reader.getByRole('heading', { name: frenchTitle, exact: true }).waitFor({ state: 'visible' });
                await reader.locator('[data-slot="book-language-controls"] summary').click();
                await reader
                  .locator('[data-slot="book-language-controls"]')
                  .getByRole('button', { name: 'Automatic', exact: true })
                  .click();
                await reader.waitForURL(
                  (url) =>
                    url.searchParams.get('language') === 'automatic' && url.searchParams.get('bodyLanguage') === 'en',
                );
                await reader
                  .getByRole('heading', { name: chapterOneTitle!, exact: true })
                  .waitFor({ state: 'visible' });
                expect(await reader.locator('article.book-reading-display').innerText()).toContain(oneText);
                expect(await reader.locator('html').getAttribute('lang')).toBe('en');
                await reader.goto(frenchExactHref, { waitUntil: 'domcontentloaded' });
                await reader.getByRole('heading', { name: frenchTitle, exact: true }).waitFor({ state: 'visible' });
                expect(await reader.locator('article.book-reading-display').innerText()).toContain(frenchText);
                return {
                  value: frenchExactHref,
                  observation: `exactFrench=${frenchExactHref} automatic=en UI=en backward/forward=true privateLaterBodies=absent`,
                };
              } finally {
                await context.close();
              }
            },
          );

          if (frenchExactHref)
            await journal.run(
              'member checkpoint and Continue retain French exact identity without applying its block position to English',
              async () => {
                const target = new URL(frenchExactHref!);
                const member = await auth.signIn('bob', { returnTo: target.pathname + target.search });
                const reader = pageFrom(member);
                await hydrate(reader);
                await reader.getByRole('heading', { name: frenchTitle, exact: true }).waitFor({ state: 'visible' });
                const anchor = reader.locator('article.book-reading-display [data-block-id]').first();
                const blockId = await anchor.getAttribute('data-block-id');
                if (!blockId) throw new Error('French body did not expose its authored block identity');
                await reader.getByRole('button', { name: 'Save visible block', exact: true }).click();
                await reader.getByText('Reading position saved.', { exact: true }).waitFor({ state: 'visible' });
                const current = await seed!.member.libraryHostedReading.metadata.get({
                  query: { subjectId: seed!.subjectId },
                });
                if (current.status !== 200 || current.error || !current.data)
                  throw new Error(`French checkpoint readback returned ${current.status}`);
                expect(current.data).toMatchObject({
                  state: 'saved',
                  address: {
                    catalogueId,
                    publicationRevisionId: authorRelease,
                    occurrenceId: chapterOneOccurrence,
                    bodyLanguage: 'fr',
                    targetPostId: chapterFrench!.id,
                    targetRevisionId: chapterFrench!.revisionId,
                    targetSha256: chapterFrench!.sha256,
                    documentPosition: { blockId, offset: 0 },
                  },
                });
                await reader.evaluate(() => {
                  const page = window as Window & { __bookLanguageScrollCalls?: unknown[] };
                  page.__bookLanguageScrollCalls = [];
                  const original = window.scrollBy.bind(window);
                  window.scrollBy = ((...args: Parameters<typeof window.scrollBy>) => {
                    page.__bookLanguageScrollCalls!.push(args);
                    return Reflect.apply(original, window, args);
                  }) as typeof window.scrollBy;
                });
                await reader.locator('[data-slot="book-language-controls"] summary').click();
                await reader
                  .locator('[data-slot="book-language-controls"]')
                  .getByRole('button', { name: 'Automatic', exact: true })
                  .click();
                await reader.waitForURL((url) => url.searchParams.get('bodyLanguage') === 'en');
                await reader
                  .getByRole('heading', { name: chapterOneTitle!, exact: true })
                  .waitFor({ state: 'visible' });
                await reader
                  .getByRole('link', { name: 'Resume saved chapter', exact: true })
                  .waitFor({ state: 'visible' });
                expect(
                  await reader.evaluate(
                    () => (window as Window & { __bookLanguageScrollCalls?: unknown[] }).__bookLanguageScrollCalls,
                  ),
                ).toEqual([]);
                const stillFrench = await seed!.member.libraryHostedReading.metadata.get({
                  query: { subjectId: seed!.subjectId },
                });
                expect(stillFrench.data).toMatchObject({
                  address: {
                    bodyLanguage: 'fr',
                    targetRevisionId: chapterFrench!.revisionId,
                    documentPosition: { blockId, offset: 0 },
                  },
                });
                await reader.getByRole('link', { name: 'Resume saved chapter', exact: true }).click();
                await reader.waitForURL((url) => url.searchParams.get('bodyLanguage') === 'fr');
                await reader.getByRole('heading', { name: frenchTitle, exact: true }).waitFor({ state: 'visible' });
                await reader.goto(`${stack.web}/en/library/continue`, { waitUntil: 'domcontentloaded' });
                await hydrate(reader);
                const continuation = reader
                  .locator('a[href*="/books/"][href*="bodyLanguage=fr"]')
                  .filter({ hasText: frenchTitle });
                await continuation.click();
                await reader.getByRole('heading', { name: frenchTitle, exact: true }).waitFor({ state: 'visible' });
                expect(new URL(reader.url()).searchParams.get('bodySha256')).toBe(chapterFrench!.sha256);
                expect(await reader.locator('article.book-reading-display').innerText()).toContain(frenchText);
                return {
                  value: current.data,
                  observation: `savedLanguage=fr savedRevision=${chapterFrench!.revisionId} block=${blockId} EnglishOffsetReuse=false resumed/Continue=fr`,
                };
              },
            );
          else
            journal.unreached(
              'member French checkpoint and Continue',
              'The anonymous exact French reader was not admitted',
            );
        } else
          journal.unreached(
            'published language reader, private edits and checkpoints',
            'The selected private release did not activate',
          );
      } else {
        journal.unreached(
          'later private edit, move isolation, and initial activation boundary',
          'The selected private candidate was not sealed with recorded immutable operands',
        );
        journal.unreached(
          'private author anonymous exact chapter bytes, discovery, progress, and stable old link',
          'No acknowledged initial activation receipt is available',
        );
      }
    } else {
      for (const label of [
        'private saved chapter preview and revision comparison',
        'save chapter two as a separate private exact draft in Studio',
        'save an actual French chapter body as a separate private exact Post in Studio',
        'associate exact English default and saved French body through the mounted Book language form',
        'anonymous direct reads conceal private chapter drafts before release',
        'start Book, add and reorder chapters, create a part, and move chapters under it',
        'review, recover, and seal an exact selected private candidate',
        'later private edit and move isolation',
        'activate the selected private candidate through mounted checks and explicit publication',
        'later private French edits do not change either frozen published language',
        'anonymous reader chooses a published French body, Automatic and exact browser history without changing interface locale',
        'member checkpoint and Continue retain French exact identity without applying its block position to English',
      ])
        journal.unreached(label, 'Generated private fixture setup did not complete');
    }

    await journal.finish('PRIVATE BOOK AUTHOR-TO-READER LANGUAGE JOURNEY');
  },
  lifecycle,
);

nativeTest(
  'separate prepublished control exercises exact point consent, anonymous reader, Library continue, old links, and withdrawal',
  900_000,
  async () => {
    const journal = new StageJournal();
    let control: HostedReaderControl | undefined;
    let exactReaderHref: string | undefined;
    let currentReleaseRevisionId: string | undefined;
    let pointOccurrenceId: string | undefined;
    let partTitle = 'Later control contents';

    control = await journal.run('separate one-chapter prepublished control setup', async () => {
      const value = await createPrepublishedReaderControl(stack);
      return {
        value,
        observation:
          `control=catalogue:${value.catalogueId} subject:${value.subjectId}` +
          ` author=${value.authorAccountId} member=${value.memberAccountId}` +
          ` one-selected-occurrence:${value.occurrenceId} release:${value.publicationRevisionId}` +
          ` post=${value.chapter.postId} thread=${value.chapter.threadId}` +
          ` revision=${value.chapter.revisionId} sha256=${value.chapter.sha256}`,
      };
    });
    if (!control) {
      for (const label of [
        'anonymous public occurrence and exact body',
        'member saves and resumes a reading checkpoint',
        'anonymous direct exact-reader link after a later move',
        'ordinary Studio withdrawal removes current discovery and preserves history',
      ])
        journal.unreached(label, 'The separate generated one-chapter reader control was not created');
      await journal.finish('PREPUBLISHED READER CONTROL');
      return;
    }
    currentReleaseRevisionId = control.publicationRevisionId;

    await journal.run('control chapter Post remains private behind the public Book occurrence', async () => {
      const anonymousPost = await control!.anonymous.posts({ id: control!.chapter.postId }).get();
      expect(anonymousPost.status).toBe(404);
      return {
        value: true,
        observation: `direct-post=${anonymousPost.status} hosted-occurrence=${control!.occurrenceId}`,
      };
    });

    const occurrence = await journal.run('control anonymous occurrence returns its original exact body', async () => {
      const data = await assertPublishedBody(
        control!.anonymous,
        control!.catalogueId,
        control!.publicationRevisionId,
        control!.occurrenceId,
        control!.chapter,
      );
      return {
        value: data,
        observation: `occurrence=${control!.occurrenceId} release=${control!.publicationRevisionId} sha256=${data.document?.sha256}`,
      };
    });

    const ownerJourney = await auth.signIn('alice', { returnTo: chapterStudioPath(control!.chapter) });
    const ownerViewport = { width: 1440, height: 1000 };
    const reopenOwnerPage = async () => {
      const page = await ownerJourney.context.newPage();
      page.setDefaultTimeout(30_000);
      await page.setViewportSize(ownerViewport);
      return page;
    };
    const ownerPage = pageFrom(ownerJourney);
    await ownerPage.setViewportSize(ownerViewport);
    let pointRevision: Awaited<ReturnType<typeof readNativePost>> | undefined;
    const revisedText = 'A later saved version adds a westward tide mark to the harbor map.';
    const revised = await journal.run(
      'save a later private source version through mounted Studio',
      async () => {
        const result = await saveChapterDraft(ownerPage, control!.author, control!.chapter, revisedText, false);
        pointRevision = result.post;
        return {
          value: result.post,
          observation:
            'post=' +
            result.post.id +
            ' oldRevision=' +
            control!.chapter.revisionId +
            ' selectedRevision=' +
            result.post.revisionId +
            ' sha256=' +
            result.post.sha256,
        };
      },
      () => pageObservation(ownerPage),
    );

    if (revised) {
      await journal.run(
        'add the later exact source version as a separate draft occurrence',
        async () => {
          await openBookStudio(ownerPage, control!.catalogueId);
          const title = 'Control chapter · Later tide map';
          await addChapterFromPicker(ownerPage, title, control!.chapter.title);
          const outline = await readStructure(control!.author, control!.catalogueId);
          const placement = outline.items.find(
            (item) =>
              item.kind === 'chapter' && item.title === title && item.target?.revisionId === pointRevision!.revisionId,
          );
          if (!placement) throw new Error('Current Book draft omitted the exact later chapter occurrence');
          expect(placement.target).toMatchObject({
            threadId: control!.chapter.threadId,
            postId: pointRevision!.id,
            revisionId: pointRevision!.revisionId,
            sha256: pointRevision!.sha256,
          });
          pointOccurrenceId = placement.occurrenceId;
          return {
            value: placement,
            observation:
              'occurrence=' +
              placement.occurrenceId +
              ' post=' +
              placement.target?.postId +
              ' revision=' +
              placement.target?.revisionId +
              ' sha256=' +
              placement.target?.sha256,
          };
        },
        async () => {
          const [browser, draft] = await Promise.all([
            pageObservation(ownerPage),
            observeDraftReadiness(control!.authorAccountId, control!.chapter.postId, pointRevision!.revisionId),
          ]);
          return `${browser}; exact draft readiness=${draft}`;
        },
      );
    } else {
      journal.unreached(
        'add a later exact source version as a separate draft occurrence',
        'The mounted Studio source revision did not save',
      );
    }

    if (revised && pointOccurrenceId && pointRevision) {
      const pointPublication = await journal.run(
        'permit the exact private version, then publish that selected occurrence through point review',
        async () => {
          await ownerPage.goto(
            stack.web + '/en/studio?catalogueId=' + encodeURIComponent(control!.catalogueId) + '&points=1',
            { waitUntil: 'domcontentloaded' },
          );
          await hydrate(ownerPage);
          await ownerPage.getByRole('heading', { name: 'Edit this Book draft', exact: true }).waitFor({
            state: 'visible',
          });
          await ownerPage.getByRole('button', { name: 'Review one chapter for publication', exact: true }).click();
          await ownerPage
            .getByRole('heading', { name: 'Review one chapter for publication', exact: true })
            .waitFor({ state: 'visible' });
          await ownerPage.getByRole('button', { name: 'Add a public chapter', exact: true }).click();
          await ownerPage
            .getByRole('button', {
              name: 'Select saved chapter “Control chapter · Later tide map”',
              exact: true,
            })
            .click();
          await ownerPage.getByRole('button', { name: 'Reread this exact saved version', exact: true }).click();
          await ownerPage.getByText(revisedText, { exact: true }).waitFor({ state: 'visible' });
          await ownerPage.getByRole('button', { name: 'Book root', exact: true }).click();
          await ownerPage.getByRole('button', { name: 'Set public placement for the chapter', exact: true }).click();
          await ownerPage.getByRole('button', { name: 'At parent’s end', exact: true }).click();
          const previousOwner = await readOwnedBook(control!.author, control!.authorAccountId, control!.catalogueId);
          expect(previousOwner.item.publicationId).toBe(control!.publicationRevisionId);
          const previousOutline = await readStructure(control!.author, control!.catalogueId);
          expect(previousOwner.item.headRevisionId).toBe(previousOutline.head.revisionId);
          const selectedDraft = previousOutline.items.find(
            (item) => item.occurrenceId === pointOccurrenceId && item.kind === 'chapter',
          );
          expect(selectedDraft?.target).toMatchObject({
            postId: control!.chapter.postId,
            revisionId: pointRevision!.revisionId,
            sha256: pointRevision!.sha256,
          });
          const pointOperands =
            'catalogue=' +
            control!.catalogueId +
            ' owner=' +
            previousOwner.viewer.accountId +
            '@' +
            previousOwner.viewer.authnEpoch +
            ' expectedHeadRevisionId=' +
            previousOwner.item.headRevisionId +
            ' expectedPublicationId=' +
            previousOwner.item.publicationId +
            ' occurrence=' +
            pointOccurrenceId +
            ' post=' +
            control!.chapter.postId +
            ' thread=' +
            control!.chapter.threadId +
            ' revision=' +
            pointRevision!.revisionId +
            ' sha256=' +
            pointRevision!.sha256;
          await ownerPage.getByRole('button', { name: 'Review edit', exact: true }).click();
          const consent = ownerPage.getByRole('region', { name: 'Permission for this saved version', exact: true });
          await consent.getByRole('button', { name: 'Permit this version for this Book', exact: true }).waitFor({
            state: 'visible',
          });
          await consent.getByRole('button', { name: 'Permit this version for this Book', exact: true }).click();
          await consent
            .getByText(
              'Permission was granted for this saved version and this Book. This action did not publish anything.',
              { exact: true },
            )
            .waitFor({ state: 'visible', timeout: 90_000 });
          const afterPermission = await readOwnedBook(control!.author, control!.authorAccountId, control!.catalogueId);
          expect(afterPermission.item.publicationId).toBe(previousOwner.item.publicationId);
          await ownerPage.getByRole('button', { name: 'Confirm this exact publication', exact: true }).click();
          await ownerPage.getByRole('heading', { name: 'Edit acknowledged', exact: true }).waitFor({
            state: 'visible',
            timeout: 90_000,
          });
          const afterPublication = await readOwnedBook(control!.author, control!.authorAccountId, control!.catalogueId);
          if (
            !afterPublication.item.publicationId ||
            afterPublication.item.publicationId === previousOwner.item.publicationId
          )
            throw new Error('Point review did not return a new current Book release');
          const selected: JourneyPost = {
            ...control!.chapter,
            revisionId: pointRevision!.revisionId,
            sha256: pointRevision!.sha256,
            body: pointRevision!.body,
          };
          const exact = await assertPublishedBody(
            control!.anonymous,
            control!.catalogueId,
            afterPublication.item.publicationId,
            pointOccurrenceId!,
            selected,
          );
          const direct = await control!.anonymous.posts({ id: selected.postId }).get();
          expect(direct.status).toBe(404);
          currentReleaseRevisionId = afterPublication.item.publicationId;
          return {
            value: currentReleaseRevisionId,
            observation:
              pointOperands +
              ' exactRevision=' +
              selected.revisionId +
              ' sha256=' +
              exact.document?.sha256 +
              ' permissionIssuedBeforePublication=true directPost=' +
              direct.status +
              ' oldRelease=' +
              previousOwner.item.publicationId +
              ' newRelease=' +
              currentReleaseRevisionId,
          };
        },
        () => pageObservation(ownerPage),
      );
      if (!pointPublication)
        journal.unreached(
          'exact source consent and selected point publication readback',
          'The mounted point review did not acknowledge the exact selected revision',
        );
    } else {
      journal.unreached(
        'exact source consent and selected point publication readback',
        'The later source revision or its exact draft occurrence was unavailable',
      );
    }

    await ownerPage.close();

    const discoveryPath = `/en/books/${encodeURIComponent(control!.subjectId)}/read?view=catalogues`;
    const memberJourney = await auth.signIn('bob', { returnTo: discoveryPath });
    const memberPage = pageFrom(memberJourney);
    await memberPage.setViewportSize({ width: 1280, height: 900 });
    const discovery = await journal.run(
      'member opens the control through current Book subject discovery',
      async () => {
        const { index, title: catalogueTitle } = await findCurrentControlCatalogue(control!, currentReleaseRevisionId!);
        const discoveryHref = new URL(discoveryPath, stack.web).href;
        // Auth can mount an empty snapshot before the Subject-thread effect is visible.
        if (memberPage.url() === discoveryHref) await memberPage.reload({ waitUntil: 'domcontentloaded' });
        else await memberPage.goto(discoveryHref, { waitUntil: 'domcontentloaded' });
        await hydrate(memberPage);
        await memberPage.getByRole('link', { name: catalogueTitle, exact: true }).click();
        await memberPage
          .getByRole('link', { name: 'Read chapter · Control chapter · Beside the harbor steps', exact: true })
          .click();
        await memberPage
          .getByRole('heading', { name: 'Control chapter · Beside the harbor steps', exact: true })
          .waitFor({
            state: 'visible',
          });
        await memberPage.getByText(documentText(control!.chapter.body), { exact: true }).waitFor({ state: 'visible' });
        exactReaderHref = memberPage.url();
        return { value: exactReaderHref, observation: `discovery-index=${index + 1} exact-url=${exactReaderHref}` };
      },
      async () => {
        const [browser, native] = await Promise.all([
          pageObservation(memberPage),
          observeBookDiscovery(control!, currentReleaseRevisionId ?? control!.publicationRevisionId),
        ]);
        return `${browser}; exact discovery readiness=${native}`;
      },
    );

    if (discovery && occurrence) {
      await journal.run(
        'member saves and resumes the exact hosted chapter through the Library checkpoint',
        async () => {
          const visibleBlock = memberPage.locator('[data-block-id]').filter({ visible: true }).first();
          const visibleBlockId = await visibleBlock.getAttribute('data-block-id');
          if (!visibleBlockId) throw new Error('The mounted chapter has no visible stable document block');
          await memberPage.getByRole('button', { name: 'Save visible block', exact: true }).click();
          await memberPage.getByText('Reading position saved.', { exact: true }).waitFor({ state: 'visible' });
          const checkpoint = await control!.member.libraryHostedReading.metadata.get({
            query: { subjectId: control!.subjectId },
          });
          if (checkpoint.status !== 200 || checkpoint.error || !checkpoint.data)
            throw new Error(`Generated member checkpoint readback returned ${checkpoint.status}`);
          const saved = checkpoint.data as {
            state: string;
            subjectId: string;
            address: {
              catalogueId: string;
              publicationRevisionId: string;
              occurrenceId: string;
              targetPostId: string;
              targetRevisionId: string;
              targetSha256: string;
              documentPosition: { blockId: string; offset: number } | null;
            };
          };
          expect(saved).toMatchObject({
            state: 'saved',
            subjectId: control!.subjectId,
            address: {
              catalogueId: control!.catalogueId,
              publicationRevisionId: currentReleaseRevisionId,
              occurrenceId: control!.occurrenceId,
              targetPostId: control!.chapter.postId,
              targetRevisionId: control!.chapter.revisionId,
              targetSha256: control!.chapter.sha256,
              documentPosition: { blockId: visibleBlockId, offset: 0 },
            },
          });
          await memberPage.reload({ waitUntil: 'domcontentloaded' });
          await hydrate(memberPage);
          await memberPage
            .getByRole('link', { name: 'Resume saved chapter', exact: true })
            .waitFor({ state: 'visible' });
          await memberPage.getByRole('link', { name: 'Resume saved chapter', exact: true }).click();
          await memberPage.waitForURL((url) => url.searchParams.get('occurrence') === control!.occurrenceId);
          await memberPage
            .getByRole('heading', { name: 'Control chapter · Beside the harbor steps', exact: true })
            .waitFor({
              state: 'visible',
            });
          exactReaderHref = memberPage.url();
          return {
            value: saved,
            observation: `state=${saved.state} subject=${saved.subjectId} occurrence=${saved.address.occurrenceId} block=${saved.address.documentPosition?.blockId} resumed=${exactReaderHref}`,
          };
        },
        () => observeMemberCheckpointFailure(memberPage, control!.subjectId),
      );
    } else {
      journal.unreached(
        'member save and continue checkpoint',
        'Control occurrence or visible discovery reader did not open',
      );
    }

    await memberPage.close();

    if (discovery && exactReaderHref) {
      await journal.run('anonymous direct exact-reader address returns the selected control body', async () => {
        const url = await readAnonymousControlPage(exactReaderHref!, control!.chapter);
        return { value: url, observation: `status=mounted visible-body=true exact-url=${url}` };
      });

      const movePage = await reopenOwnerPage();
      await journal.run(
        'move the control placement after publication through Book Studio',
        async () => {
          await openBookStudio(movePage, control!.catalogueId);
          await addPartInStudio(movePage, partTitle);
          await movePlacementUnderPart(movePage, 'Control chapter · Beside the harbor steps', partTitle);
          const current = await readStructure(control!.author, control!.catalogueId);
          const part = current.items.find((item) => item.kind === 'part' && item.title === partTitle);
          const moved = current.items.find((item) => item.occurrenceId === control!.occurrenceId);
          if (!part || !moved || moved.parentId !== part.occurrenceId)
            throw new Error('Control structure did not retain the same occurrence after moving it');
          return {
            value: moved,
            observation: `occurrence=${moved.occurrenceId} parent=${moved.parentId} part=${part.occurrenceId}`,
          };
        },
        () => pageObservation(movePage),
      );
      await movePage.close();

      await journal.run('the emitted old reader URL still serves its exact release after a later move', async () => {
        await readAnonymousControlPage(exactReaderHref!, control!.chapter);
        const exact = await assertPublishedBody(
          control!.anonymous,
          control!.catalogueId,
          currentReleaseRevisionId!,
          control!.occurrenceId,
          control!.chapter,
        );
        return {
          value: exact,
          observation: `old-url=${exactReaderHref} historical-occurrence=${control!.occurrenceId} sha256=${exact.document?.sha256}`,
        };
      });

      const withdrawalPage = await reopenOwnerPage();
      let withdrawalObserved = false;
      await journal.run(
        'withdraw the control through Studio and preserve its old exact release',
        async () => {
          await openBookStudio(withdrawalPage, control!.catalogueId);
          await withdrawalPage.getByRole('button', { name: 'Review Book withdrawal…', exact: true }).click();
          await withdrawalPage
            .getByRole('heading', { name: 'Review Book withdrawal', exact: true })
            .waitFor({ state: 'visible' });
          await withdrawalPage
            .getByRole('checkbox', {
              name: 'I want to withdraw this exact current release from discovery.',
              exact: true,
            })
            .click();
          await withdrawalPage.getByRole('button', { name: 'Withdraw reviewed Book', exact: true }).click();
          await withdrawalPage.getByText('The Book was withdrawn from current discovery.', { exact: true }).waitFor({
            state: 'visible',
            timeout: 90_000,
          });
          const current = await control!.anonymous.subjects({ id: control!.subjectId }).hostedCatalogues.get({
            query: { limit: '20' },
          });
          if (current.status !== 200 || current.error || !current.data)
            throw new Error(`Generated post-withdrawal control discovery returned ${current.status}`);
          const discoveryPage = current.data as { items: { catalogueId: string }[] };
          expect(discoveryPage.items.some((item) => item.catalogueId === control!.catalogueId)).toBe(false);
          const historical = await assertPublishedBody(
            control!.anonymous,
            control!.catalogueId,
            currentReleaseRevisionId!,
            control!.occurrenceId,
            control!.chapter,
          );
          withdrawalObserved = true;
          await withdrawalPage.close();
          await readAnonymousControlPage(exactReaderHref!, control!.chapter);
          return {
            value: true,
            observation: `current-discovery=${discoveryPage.items.length} historical-occurrence=${control!.occurrenceId} sha256=${historical.document?.sha256} old-url=${exactReaderHref}`,
          };
        },
        () =>
          withdrawalObserved
            ? Promise.resolve(`Studio withdrawal and native readback completed; historical URL=${exactReaderHref}`)
            : pageObservation(withdrawalPage),
      );
      if (!withdrawalPage.isClosed()) await withdrawalPage.close();
    } else {
      for (const label of [
        'anonymous direct exact-reader address after a later move',
        'move the control placement after publication through Book Studio',
        'old reader link after a later move',
        'withdrawal of the prepublished control through Studio',
      ])
        journal.unreached(label, 'Member discovery did not establish the exact control reader link');
    }

    await journal.finish('PREPUBLISHED READER CONTROL (separate from private-draft outcome)');
  },
  lifecycle,
);
