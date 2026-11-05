import { expect as bunExpect } from 'bun:test';
import type { Locator, Page } from 'playwright';
import { NativeTestLifecycle, nativeAfterAll, nativeBeforeAll, nativeTest } from './lifecycle.ts';
import { startNativeModerationFixture, type NativeModerationFixture } from './native-moderation-fixture.ts';

let fixture: NativeModerationFixture | undefined;
const lifecycle = new NativeTestLifecycle('native moderation');

function expect(actual: unknown) {
  const locator = actual as Partial<Locator> | null;
  if (typeof locator?.innerText === 'function') {
    const contains = async (expected: string, negated = false) => {
      const deadline = Date.now() + 15_000;
      let text = '';
      while (Date.now() < deadline) {
        try {
          text = await locator.innerText!({ timeout: 250 });
        } catch {
          text = '';
        }
        if (text.includes(expected) !== negated) return;
        await Bun.sleep(50);
      }
      bunExpect(text.includes(expected)).toBe(!negated);
    };
    return {
      toContainText: (expected: string) => contains(expected),
      not: { toContainText: (expected: string) => contains(expected, true) },
    };
  }
  return bunExpect(actual);
}

nativeBeforeAll(lifecycle, 300_000, async () => {
  fixture = await startNativeModerationFixture();
});

nativeAfterAll(lifecycle, 300_000);

function pageFor(journey: Awaited<ReturnType<NativeModerationFixture['auth']['signIn']>>): Page {
  const page = journey.context.pages().at(-1);
  if (!page) throw new Error('Auth did not keep the served browser page open');
  return page;
}

async function visit(page: Page, url: string): Promise<Awaited<ReturnType<Page['goto']>>> {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
  return response;
}

async function reload(page: Page): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
}

async function nativeJson<T>(response: Response, path: string): Promise<T> {
  const body = await response.text();
  if (!response.ok) throw new Error(`GET ${path}: ${response.status} ${body}`);
  return JSON.parse(body) as T;
}

async function waitForDecisionId(): Promise<string> {
  const current = fixture!;
  const accountId = current.identities['moderation-author'].accountId;
  const path = `/v1/accounts/${accountId}/notifications?limit=50`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const response = await current.stack.kernel(path, {}, 'moderation-author');
    if (response.ok) {
      const body = (await response.json()) as {
        items: { kind: string; decisionId: string | null; postId: string | null }[];
      };
      const notice = body.items.find(
        (item) => item.kind === 'moderation_decision' && item.postId === current.postId && item.decisionId,
      );
      if (notice?.decisionId) return notice.decisionId;
    }
    await Bun.sleep(250);
  }
  throw new Error(`No native decision notice was delivered to ${accountId} within 20 seconds`);
}

async function waitForReport(postId: string): Promise<{
  reports: {
    id: string;
    target: { kind: string; id: string };
    reason: string;
    evidence: string | null;
  }[];
}> {
  const current = fixture!;
  const path = `/v1/posts/${postId}/reports?limit=20`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const response = await current.stack.kernel(path, {}, 'moderator');
    const text = await response.text();
    if (!response.ok) throw new Error(`GET ${path}: ${response.status} ${text}`);
    const page = JSON.parse(text) as {
      reports: {
        id: string;
        target: { kind: string; id: string };
        reason: string;
        evidence: string | null;
      }[];
    };
    if (page.reports.some((report) => report.target.id === postId)) return page;
    await Bun.sleep(250);
  }
  throw new Error(`The report projection for post ${postId} was not available within 20 seconds`);
}

async function waitForReportOutcome(
  postId: string,
  reportId: string,
  outcome: 'actioned' | 'dismissed',
): Promise<void> {
  const current = fixture!;
  const path = `/v1/posts/${postId}/reports?limit=20`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const response = await current.stack.kernel(path, {}, 'moderator');
    const text = await response.text();
    if (!response.ok) throw new Error(`GET ${path}: ${response.status} ${text}`);
    const page = JSON.parse(text) as { reports: { id: string; outcome: string | null }[] };
    const report = page.reports.find((item) => item.id === reportId);
    if (report?.outcome === outcome) return;
    await Bun.sleep(250);
  }
  throw new Error(`The native report ${reportId} did not reach ${outcome} within 20 seconds`);
}

nativeTest(
  'native moderation reports, decisions and appeals stay private, scoped and receipt-backed through served pages',
  300_000,
  async () => {
    const current = fixture!;
    const reportEvidence = 'PRIVATE_REPORT_SENTINEL_native-report-details';
    const appealStatement =
      'I did not intend to share identifying information. Please review the decision independently.';
    const decisionReason = 'The visible reply exposed personal information.';
    const decisionStatement = 'The reply is withheld while its personal information is reviewed.';

    const alice = await current.auth.signIn('moderation-alice');
    const alicePage = pageFor(alice);
    const threadUrl = `${current.stack.web}/en/threads/${current.threadId}`;
    await visit(alicePage, threadUrl);
    await expect(alicePage.locator(`#post-${current.postId}`)).toContainText('A visible reply that Alice can report.');
    expect((await alice.requestHeaders()).every((headers) => !headers.has('authorization'))).toBe(true);
    expect(
      (await current.auth.context('moderation-alice').then((context) => context.cookies(current.stack.web))).some(
        ({ name }) => name === '__Host-rezics_session',
      ),
    ).toBe(true);

    const postActions = alicePage.locator(`#post-${current.postId}`).getByRole('button', { name: 'More actions' });
    await postActions.focus();
    await postActions.press('Enter');
    const reportMenuItem = alicePage.getByRole('menuitem', { name: 'Report', exact: true });
    await reportMenuItem.focus();
    await reportMenuItem.press('Enter');
    await alicePage.getByRole('radio', { name: 'Other', exact: true }).check();
    await alicePage.getByLabel('Additional details').fill(reportEvidence);
    const reportSubmission = alicePage.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && new URL(response.url()).origin === new URL(current.stack.web).origin,
    );
    const reportSuccess = alicePage
      .getByRole('status', { name: 'Thank you for your report.', exact: true })
      .waitFor({ timeout: 15_000 })
      .then(
        () => true,
        () => false,
      );
    const submitReport = alicePage.getByRole('button', { name: 'Submit report', exact: true });
    await submitReport.focus();
    await submitReport.press('Enter');
    const reportReceipt = await reportSubmission;
    const reportReceiptBody = await reportReceipt.text();
    expect(reportReceipt.status()).toBe(200);
    expect(await reportSuccess).toBe(true);
    const preModerationPost = await current.stack.kernel(`/v1/posts/${current.postId}`, {}, 'moderation-alice');
    expect(preModerationPost.status).toBe(200);
    const reportRequests = current.stack
      .kernelRequests()
      .filter((request) => request.method === 'POST' && request.url === '/v1/reports');
    console.info(
      'served report response',
      JSON.stringify({
        url: reportReceipt.url(),
        status: reportReceipt.status(),
        body: reportReceiptBody,
        nativeRequests: reportRequests.map(({ method, url, failure }) => ({
          method,
          url,
          ...(failure ? { failure } : {}),
        })),
      }),
    );
    expect(reportReceipt.status()).toBe(200);
    const reportPath = `/v1/posts/${current.postId}/reports?limit=20`;
    const reportPage = await waitForReport(current.postId);
    const report = reportPage.reports.find((item) => item.target.id === current.postId);
    console.info('native moderation report recording', JSON.stringify(report));
    expect(report).toMatchObject({
      target: { kind: 'post', id: current.postId },
      reason: 'other',
      evidence: reportEvidence,
    });
    if (!report) throw new Error('The native report queue omitted Alice’s report');

    const ordinaryQueue = await current.stack.kernel(reportPath, {}, 'outsider');
    const anonymousQueue = await current.stack.kernel(reportPath);
    expect(ordinaryQueue.status).not.toBe(200);
    expect(anonymousQueue.status).not.toBe(200);
    expect(await ordinaryQueue.text()).not.toContain(reportEvidence);
    expect(await anonymousQueue.text()).not.toContain(reportEvidence);
    const unrelatedQueue = await current.stack.kernel(
      `/v1/posts/${current.unrelatedPostId}/reports?limit=20`,
      {},
      'moderator',
    );
    expect(unrelatedQueue.status).not.toBe(200);
    const privateReport = await current.stack.kernel(`/v1/reports/${report.id}`, {}, 'outsider');
    expect(privateReport.status).not.toBe(200);
    expect(await privateReport.text()).not.toContain(reportEvidence);
    const anonymousReport = await current.stack.kernel(`/v1/reports/${report.id}`);
    expect(anonymousReport.status).not.toBe(200);
    expect(await anonymousReport.text()).not.toContain(reportEvidence);

    const unauthorizedDecision = await current.stack.kernel(
      `/v1/posts/${current.postId}:takeDown`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(crypto.randomUUID()) },
        body: JSON.stringify({ reason: decisionStatement }),
      },
      'outsider',
    );
    expect(unauthorizedDecision.status).toBe(403);
    const anonymousDecision = await current.stack.kernel(`/v1/posts/${current.postId}:takeDown`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(crypto.randomUUID()) },
      body: JSON.stringify({ reason: decisionStatement }),
    });
    expect(anonymousDecision.status).not.toBe(200);
    const unrelatedDecision = await current.stack.kernel(
      `/v1/posts/${current.unrelatedPostId}:takeDown`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(crypto.randomUUID()) },
        body: JSON.stringify({ reason: decisionStatement }),
      },
      'moderator',
    );
    expect(unrelatedDecision.status).toBe(403);

    const outsiderJourney = await current.auth.signIn('outsider');
    const outsiderPage = pageFor(outsiderJourney);
    const servedReportsUrl = `${current.stack.web}/en/boards/${current.boardId}/moderation`;
    const servedPostReportsUrl = `${servedReportsUrl}?post=${current.postId}`;
    await visit(outsiderPage, servedPostReportsUrl);
    expect(await outsiderPage.locator('body').innerText()).not.toContain(reportEvidence);
    expect((await outsiderPage.locator('body').innerText()).toLowerCase()).not.toContain('personal information');
    expect(await outsiderPage.getByRole('button', { name: 'Take down', exact: true }).count()).toBe(0);
    const anonymousPage = await (await current.auth.context('anonymous')).newPage();
    await visit(anonymousPage, servedPostReportsUrl);
    expect(await anonymousPage.locator('body').innerText()).not.toContain(reportEvidence);

    const moderator = await current.auth.signIn('moderator');
    const moderatorPage = pageFor(moderator);
    const appealModerator = await current.auth.signIn('appeal-moderator');
    const appealModeratorPage = pageFor(appealModerator);
    await visit(moderatorPage, servedPostReportsUrl);
    await visit(appealModeratorPage, servedPostReportsUrl);
    await expect(moderatorPage.locator('body')).toContainText(reportEvidence);
    await expect(appealModeratorPage.locator('body')).toContainText(reportEvidence);

    const nativeStart = current.stack.kernelRequests().length;
    await moderatorPage.getByLabel('Reason', { exact: true }).fill(decisionReason);
    await moderatorPage.getByLabel('Statement to the author', { exact: true }).fill(decisionStatement);
    const takeDown = moderatorPage.getByRole('button', { name: 'Take down', exact: true });
    const decisionSubmission = moderatorPage.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && new URL(response.url()).origin === new URL(current.stack.web).origin,
    );
    await takeDown.focus();
    await takeDown.press('Enter');
    const decisionReceipt = await decisionSubmission;
    const decisionReceiptBody = await decisionReceipt.text().catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      return `response body unavailable after served page reload: ${detail}`;
    });
    const withheldPostAfterDecision = await current.stack.kernel(`/v1/posts/${current.postId}`, {}, 'moderation-alice');
    const decisionRequests = current.stack
      .kernelRequests()
      .slice(nativeStart)
      .filter((request) => request.method === 'POST');
    console.info(
      'served moderation decision response',
      JSON.stringify({
        url: decisionReceipt.url(),
        status: decisionReceipt.status(),
        body: decisionReceiptBody,
        withheldPostStatus: withheldPostAfterDecision.status,
        nativeRequests: decisionRequests.map(({ method, url, failure }) => ({
          method,
          url,
          ...(failure ? { failure } : {}),
        })),
      }),
    );
    expect(decisionReceipt.status()).toBe(200);
    expect(withheldPostAfterDecision.status).not.toBe(200);
    await waitForReportOutcome(current.postId, report.id, 'actioned');
    await reload(moderatorPage);
    await expect(moderatorPage.locator('body')).toContainText('Actioned');

    const decisionId = await waitForDecisionId();
    const author = await current.auth.signIn('moderation-author');
    const authorPage = pageFor(author);
    const decisionUrl = `${current.stack.web}/en/moderation/decisions/${decisionId}`;
    const authorTarget = await current.stack.kernel(`/v1/posts/${current.postId}`, {}, 'moderation-author');
    console.info('native moderation author target read', JSON.stringify({ status: authorTarget.status }));
    const decisionPageStart = current.stack.kernelRequests().length;
    const decisionPageResponse = await visit(authorPage, decisionUrl);
    const decisionPageRequests = current.stack.kernelRequests().slice(decisionPageStart);
    console.info(
      'served moderation decision page receipt',
      JSON.stringify({
        status: decisionPageResponse?.status(),
        nativeRequests: decisionPageRequests.map(({ method, url, failure }) => ({
          method,
          url,
          ...(failure ? { failure } : {}),
        })),
        body: await authorPage.locator('body').innerText(),
      }),
    );
    expect(decisionPageResponse?.status()).toBe(200);
    await expect(authorPage.locator('body')).toContainText(decisionReason);
    await expect(authorPage.locator('body')).toContainText(decisionStatement);
    await expect(authorPage.locator('body')).toContainText('This content is withheld.');
    await expect(authorPage.locator('body')).not.toContainText('A visible reply that Alice can report.');

    const decisionRead = await current.stack.kernel(`/v1/moderation-decisions/${decisionId}`, {}, 'moderation-author');
    expect(decisionRead.status).toBe(200);
    const withheldDecision = await decisionRead.json();
    console.info('native moderation decision receipt', JSON.stringify(withheldDecision));
    expect(withheldDecision).toMatchObject({ id: decisionId, targetKind: 'post', targetId: current.postId });
    const withheldPost = await current.stack.kernel(`/v1/posts/${current.postId}`, {}, 'moderation-alice');
    console.info(
      'native moderation withheld target recording',
      JSON.stringify({ postId: current.postId, status: withheldPost.status }),
    );
    expect(withheldPost.status).not.toBe(200);
    await reload(alicePage);
    expect(await alicePage.locator('body').innerText()).not.toContain('A visible reply that Alice can report.');

    const staleAuthorPage = await (await current.auth.context('moderation-author')).newPage();
    await visit(staleAuthorPage, decisionUrl);
    await authorPage.getByLabel('Explain why you are appealing', { exact: true }).fill(appealStatement);
    const appealSubmission = authorPage.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && new URL(response.url()).origin === new URL(current.stack.web).origin,
    );
    await authorPage.getByRole('button', { name: 'Submit appeal', exact: true }).click();
    expect((await appealSubmission).status()).toBe(200);
    await expect(authorPage.locator('body')).toContainText('Your appeal is pending');
    await staleAuthorPage
      .getByLabel('Explain why you are appealing', { exact: true })
      .fill('A duplicate appeal attempt.');
    await staleAuthorPage.getByRole('button', { name: 'Submit appeal', exact: true }).click();
    await expect(staleAuthorPage.locator('body')).toContainText('Your appeal is pending');
    expect(await staleAuthorPage.getByRole('alert').count()).toBe(0);
    const pendingDecisionResponse = await current.stack.kernel(
      `/v1/moderation-decisions/${decisionId}`,
      {},
      'moderation-author',
    );
    const pendingDecision = await nativeJson<{
      appeal: { id: string; outcome: null; statement: null; resolvedAt: null } | null;
    }>(pendingDecisionResponse, `/v1/moderation-decisions/${decisionId}`);
    expect(pendingDecision.appeal).toMatchObject({ outcome: null });
    const appealId = pendingDecision.appeal!.id;
    const duplicateAppealFailures = current.stack
      .kernelRequests()
      .filter(
        (request) =>
          request.method === 'POST' &&
          request.url === `/v1/moderation-decisions/${decisionId}:appeal` &&
          request.failure?.status === 409,
      );
    expect(duplicateAppealFailures.length).toBeGreaterThan(0);

    const appealQueuePath = `/v1/boards/${current.boardId}/appeals?limit=20`;
    const appealQueueResponse = await current.stack.kernel(appealQueuePath, {}, 'appeal-moderator');
    const appealQueueText = await appealQueueResponse.text();
    const appealQueue = appealQueueText ? JSON.parse(appealQueueText) : {};
    const pendingQueueItem = (appealQueue.appeals as Record<string, unknown>[] | undefined)?.find(
      (item) => item.id === appealId,
    );
    console.info('native moderation pending appeal recording', JSON.stringify(pendingQueueItem));
    const pendingQueueDecision = pendingQueueItem?.decision as
      | { statement?: string; target?: { kind?: string; id?: string } }
      | undefined;
    if (
      appealQueueResponse.status !== 200 ||
      typeof pendingQueueDecision?.statement !== 'string' ||
      pendingQueueDecision.target?.kind !== 'post' ||
      pendingQueueDecision.target.id !== current.postId
    )
      throw new Error(
        `GET ${appealQueuePath} returned ${appealQueueResponse.status} ${appealQueueText}; expected one native appeal with same-page decision statement and post target`,
      );
    expect(pendingQueueItem?.statement).toBe(appealStatement);
    expect(pendingQueueItem?.canResolve).toBe(true);
    const privateAppealsForOutsider = await current.stack.kernel(appealQueuePath, {}, 'outsider');
    const privateAppealsForAnonymous = await current.stack.kernel(appealQueuePath);
    expect(privateAppealsForOutsider.status).not.toBe(200);
    expect(privateAppealsForAnonymous.status).not.toBe(200);
    for (const response of [privateAppealsForOutsider, privateAppealsForAnonymous]) {
      const body = await response.text();
      expect(body).not.toContain(appealStatement);
      expect(body).not.toContain(decisionStatement);
      expect(body).not.toContain(reportEvidence);
    }
    for (const persona of ['outsider', undefined] as const) {
      const unauthorizedAppealResolution = await current.stack.kernel(
        `/v1/moderation-appeals/${appealId}:resolve`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(crypto.randomUUID()) },
          body: JSON.stringify({ outcome: 'reverse', statement: 'Unauthorized resolution attempt.' }),
        },
        persona,
      );
      expect(unauthorizedAppealResolution.status).not.toBe(200);
      expect(await unauthorizedAppealResolution.text()).not.toContain(appealStatement);
    }
    await visit(outsiderPage, `${servedReportsUrl}?tab=appeals`);
    const outsiderAppealsText = await outsiderPage.locator('body').innerText();
    expect(outsiderAppealsText).not.toContain(appealStatement);
    expect(outsiderAppealsText).not.toContain(decisionStatement);

    const appealsUrl = `${servedReportsUrl}?tab=appeals&post=${current.postId}`;
    await visit(appealModeratorPage, servedPostReportsUrl);
    await Promise.all([
      appealModeratorPage.waitForURL(appealsUrl),
      appealModeratorPage.getByRole('link', { name: 'Appeals', exact: true }).click(),
    ]);
    await appealModeratorPage.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
    await expect(appealModeratorPage.locator('body')).toContainText(appealStatement);
    await expect(appealModeratorPage.locator('body')).toContainText(current.postId);
    await expect(appealModeratorPage.locator('body')).toContainText(decisionStatement);
    const staleAppealPage = await (await current.auth.context('appeal-moderator')).newPage();
    await visit(staleAppealPage, appealsUrl);

    await current.addUnrelatedPosts(0);
    const growth = [] as {
      unrelatedPosts: number;
      appealPageRequests: number;
      targetReads: number;
      decisionReads: number;
    }[];
    for (const [unrelatedPosts, additional] of [
      [1, 0],
      [8, 7],
      [64, 56],
    ] as const) {
      if (additional) await current.addUnrelatedPosts(additional);
      const before = current.stack.kernelRequests().length;
      await reload(appealModeratorPage);
      const requests = current.stack.kernelRequests().slice(before);
      const appealPageRequests = requests.filter(
        (request) => request.method === 'GET' && request.url.startsWith(`/v1/boards/${current.boardId}/appeals?`),
      ).length;
      const targetReads = requests.filter(
        (request) => request.method === 'GET' && request.url === `/v1/posts/${current.postId}`,
      ).length;
      const decisionReads = requests.filter(
        (request) => request.method === 'GET' && request.url.startsWith('/v1/moderation-decisions/'),
      ).length;
      growth.push({ unrelatedPosts, appealPageRequests, targetReads, decisionReads });
    }
    expect(growth).toEqual([
      { unrelatedPosts: 1, appealPageRequests: 1, targetReads: 1, decisionReads: 0 },
      { unrelatedPosts: 8, appealPageRequests: 1, targetReads: 1, decisionReads: 0 },
      { unrelatedPosts: 64, appealPageRequests: 1, targetReads: 1, decisionReads: 0 },
    ]);

    await appealModeratorPage
      .getByLabel('Statement to the author', { exact: true })
      .fill('Independent moderator review reverses the decision.');
    const reverseDecision = appealModeratorPage.getByRole('button', { name: 'Reverse', exact: true });
    await reverseDecision.focus();
    await reverseDecision.press('Enter');
    await expect(appealModeratorPage.locator('body')).toContainText('There are no appeals on this page.');
    await expect(appealModeratorPage.locator('body')).not.toContainText(appealStatement);
    await staleAppealPage
      .getByLabel('Statement to the author', { exact: true })
      .fill('A second stale appeal resolution.');
    await staleAppealPage.getByRole('button', { name: 'Reverse', exact: true }).click();
    await staleAppealPage.getByRole('alert').waitFor();
    await expect(staleAppealPage.getByRole('alert')).toContainText('This appeal was already resolved.');
    expect(await staleAppealPage.getByRole('button', { name: 'Reverse', exact: true }).isDisabled()).toBe(true);
    const resolvedResponse = await current.stack.kernel(
      `/v1/moderation-decisions/${decisionId}`,
      {},
      'moderation-author',
    );
    const resolvedDecision = await nativeJson<{
      appeal: { id: string; outcome: string; statement: string; resolvedAt: string };
    }>(resolvedResponse, `/v1/moderation-decisions/${decisionId}`);
    const resolutionConflicts = current.stack
      .kernelRequests()
      .filter(
        (request) =>
          request.method === 'POST' &&
          request.url === `/v1/moderation-appeals/${appealId}:resolve` &&
          request.failure?.status === 409,
      );
    expect(resolutionConflicts.length).toBeGreaterThan(0);

    expect(resolvedDecision.appeal).toMatchObject({
      id: appealId,
      outcome: 'reversed',
      statement: 'Independent moderator review reverses the decision.',
    });
    await reload(authorPage);
    await expect(authorPage.locator('body')).toContainText('The decision was reversed.');
    await expect(authorPage.locator('body')).toContainText('Independent moderator review reverses the decision.');
    const restoredPost = await current.stack.kernel(`/v1/posts/${current.postId}`, {}, 'moderation-alice');
    expect(restoredPost.status).toBe(200);
    expect(JSON.stringify(await restoredPost.json())).toContain('A visible reply that Alice can report.');
    await reload(alicePage);
    await expect(alicePage.locator(`#post-${current.postId}`)).toContainText('A visible reply that Alice can report.');

    const finalAppealsResponse = await current.stack.kernel(
      `/v1/boards/${current.boardId}/appeals?limit=20`,
      {},
      'appeal-moderator',
    );
    const finalAppealsText = await finalAppealsResponse.text();
    const finalAppeals = finalAppealsText ? JSON.parse(finalAppealsText) : {};
    const finalAppeal = (finalAppeals.appeals as Record<string, unknown>[] | undefined)?.find(
      (item) => item.id === appealId,
    );
    expect(finalAppealsResponse.status).toBe(200);
    expect(finalAppeal).toBeUndefined();
    expect(JSON.stringify(finalAppeals)).not.toContain('PRIVATE_REPORT_SENTINEL');
  },
  lifecycle,
);
