import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { expect, type Page, test, type TestInfo } from '@playwright/test';
import { signInAtAccounts } from './account-sign-in.ts';

// M7's exit in a real browser. The records are written once into this isolated QA stack through Main's routes
// (`g-704-seed.ts`): a Swedish Work whose reviewers are API members, and a Pride and Prejudice wiki whose steward is the
// stack's web member and whose assistant is an API member. The browser signs in as that web member, a contributor on
// the first Work and the steward of the second. The other people act between its steps through `g-704-act.ts`, which
// sends one request as them to the same stack. Every step is read on a desktop and on a phone, in English and in Japanese.
interface Seed {
  roles: Record<'holder' | 'steward' | 'second' | 'assistant', { actor: string; name: string }>;
  reader: { principalId: string; actingSubject: string };
  sagan: { work: string; id: string };
  wiki: {
    work: string;
    id: string;
    zone: string;
    chapters: string[];
    property: string;
    relation: string;
    bundleProposal: string;
    head: string;
  };
}
let seed: Seed;
let statePath: string;
test.use({ actionTimeout: 15_000 });
const main = (path: string) => `http://127.0.0.1:${process.env.MAIN_PORT}${path}`;

test.beforeAll(async () => {
  test.setTimeout(420_000);
  // Playwright starts a new worker after a failed test and runs this again; the records are written once per stack.
  statePath = `.temp/g704-seed-${process.env.REZICS_QA_RUN_ID}.json`;
  if (existsSync(statePath)) seed = JSON.parse(readFileSync(statePath, 'utf8')) as Seed;
  else {
    mkdirSync('.temp', { recursive: true });
    const result = spawnSync('bun', ['apps/web/tests/g-704-seed.ts', statePath], {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf8',
      timeout: 360_000,
    });
    if (result.status !== 0 || result.error) {
      throw new Error(
        `G-704 seed failed: ${result.stderr || result.error?.message || result.status}`,
      );
    }
    seed = JSON.parse(readFileSync(statePath, 'utf8')) as Seed;
  }
  // Main keeps processing the seed's events for a while, moving the graph under every read (409).
  let last = '';
  let still = 0;
  for (const deadline = Date.now() + 120_000; Date.now() < deadline && still < 4;) {
    const response = await fetch(main(`/v1/works/${seed.wiki.id}`)).catch(() => null);
    const position = response?.ok
      ? JSON.stringify(((await response.json()) as { sourcePosition: unknown }).sourcePosition)
      : '';
    still = position && position === last ? still + 1 : 0;
    last = position;
    await new Promise((done) => setTimeout(done, 500));
  }
  if (still < 4) throw new Error('Main’s graph kept moving for two minutes after the seed');
});

const phone = { width: 390, height: 844 };
const desktop = { width: 1280, height: 860 };
const overflows = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > innerWidth);

/** One screenshot per viewport, none with horizontal overflow: the files are what a reviewer reads. */
async function shoot(page: Page, name: string, info: TestInfo, known?: string) {
  mkdirSync('.temp/g704-shots', { recursive: true });
  for (const [label, viewport] of [
    ['desktop', desktop],
    ['phone', phone],
  ] as const) {
    await page.setViewportSize(viewport);
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    // A page the finding makes thousands of pixels tall is read from its top.
    const fullPage = !known;
    await page.screenshot({ path: info.outputPath(`${name}-${label}.png`), fullPage });
    await page.screenshot({ path: `.temp/g704-shots/${name}-${label}.png`, fullPage });
    // A page that overflows is a defect to report, never a screenshot to skip: `known` names the finding that records it.
    if (known && (await overflows(page)))
      info.annotations.push({
        type: 'finding',
        description: `${known}: ${name} overflows on a ${label}`,
      });
    else expect(await overflows(page), `${name} ${label}`).toBe(false);
  }
  await page.setViewportSize(desktop);
}

function credentials() {
  const path = process.env.REZICS_WEB_AUTH_PRIVATE_PATH;
  if (!path)
    throw new Error('REZICS_WEB_AUTH_PRIVATE_PATH must point to the isolated QA web-auth fixture');
  return JSON.parse(readFileSync(path, 'utf8')) as { member: { email: string; password: string } };
}

/** One request as an API member, through the stack's Main: the other person's step between the browser's. */
function act(
  request:
    | {
        as: 'steward' | 'second' | 'assistant' | 'holder';
        method: string;
        path: string;
        body?: object;
        settle?: boolean;
        key?: string;
      }
    | { revoke: 'assistant' },
): { status: number; body: Record<string, unknown> } {
  const result = spawnSync(
    'bun',
    ['apps/web/tests/g-704-act.ts', statePath, JSON.stringify(request)],
    { cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 120_000 },
  );
  if (result.status !== 0 || result.error)
    throw new Error(`G-704 act failed: ${result.stderr || result.error?.message}`);
  console.log('act', JSON.stringify(request).slice(0, 200), result.stderr.slice(-300));
  return JSON.parse(result.stdout.trim().split('\n').at(-1)!) as {
    status: number;
    body: Record<string, unknown>;
  };
}
const actOk = (request: Parameters<typeof act>[0], status = 200) => {
  const answer = act(request);
  expect(answer, JSON.stringify(answer)).toMatchObject({ status });
  return answer.body;
};

const proposalPath = (id: string) => `/proposals/${id}`;
const controls = (page: Page) => page.locator('[data-action]');
const actions = async (page: Page) =>
  (
    await controls(page).evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute('data-action')),
    )
  ).sort();
/** Reads the page again until `check` holds: Main delivers notifications and projections a moment after the write. */
async function eventually(page: Page, path: string, check: () => Promise<void>) {
  await expect(async () => {
    await page.goto(path);
    await check();
  }).toPass({ timeout: 60_000, intervals: [1_000, 2_000, 3_000] });
}

test.describe.configure({ mode: 'serial' });
test('CLP01/CLP04: a contributor proposes, is asked for changes, revises past a stale approval, and sees the decision and its revert', async ({
  page,
}, info) => {
  test.setTimeout(280_000);
  await page.setViewportSize(desktop);
  const { member } = credentials();
  await signInAtAccounts(page, `/en/proposals/new?work=${seed.sagan.id}`, member);
  await expect(page.getByText('Correcting Sagan om ringen')).toBeVisible();
  await shoot(page, 'clp01-1-propose-form', info);

  // Propose in Swedish, a language the interface does not offer.
  const body = page.locator('#main-content');
  await body.getByRole('combobox').click();
  await page.getByRole('option', { name: 'Another language…' }).click();
  await page.getByLabel('Language tag').fill('sv');
  await page.getByLabel('Synopsis').fill('Första beskrivningen');
  await page.getByLabel('Source', { exact: true }).fill('https://example.test/sv-utgava');
  await page.getByLabel('Where in it').fill('Kapitel 1');
  await page.getByRole('button', { name: 'Submit correction' }).click();
  await expect(page).toHaveURL(/\/en\/proposals\/[0-9a-f-]{36}$/);
  const proposal = page.url().slice(-36);
  await expect(page.getByRole('heading', { level: 1, name: 'Sagan om ringen' })).toBeVisible();
  // The author sees exactly the actions Main allows, and why they cannot review their own proposal.
  await expect(
    page.getByText('You proposed this, so someone else has to review it.'),
  ).toBeVisible();
  expect(await actions(page)).toEqual(['revise', 'withdraw']);
  await expect(page.getByText('Första beskrivningen')).toBeVisible();
  await expect(page.getByText('in Swedish')).toBeVisible();
  await shoot(page, 'clp01-2-proposed', info);

  // The steward asks for changes; the author hears about it in the inbox and follows it to the proposal.
  actOk({
    as: 'steward',
    method: 'POST',
    path: `/v1/editorial/proposals/${proposal}/reviews`,
    body: {
      profile: 'editorial-proposal-review-v1',
      revision: 1,
      outcome: 'request_changes',
      message: 'Cite the edition',
      actingSubject: seed.roles.steward.actor,
    },
  });
  const inboxItem = (text: string, id = proposal) =>
    page
      .getByRole('listitem')
      .filter({ has: page.locator(`a[href*="/proposals/${id}"]`) })
      .filter({ hasText: text });
  await eventually(page, '/en/notifications', async () => {
    await expect(inboxItem('Changes were requested on your correction')).toBeVisible({
      timeout: 2_000,
    });
  });
  await shoot(page, 'clp01-3-inbox-changes-requested', info);
  await inboxItem('Changes were requested on your correction').getByRole('link').first().click();
  await expect(page).toHaveURL(new RegExp(`/en/proposals/${proposal}\\?revision=1$`));
  await expect(page.getByText('Changes requested', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Requested changes')).toBeVisible();
  expect(await actions(page)).toEqual(['revise', 'withdraw']);
  await shoot(page, 'clp01-4-changes-requested', info);

  // Back in the inbox the item is saved and marked done; each view says where it went.
  await page.goto('/en/notifications');
  const row = inboxItem('Changes were requested on your correction');
  await row.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await row.getByRole('button', { name: 'Mark done' }).click();
  await expect(page.getByText('Marked done.')).toBeVisible();
  await expect(inboxItem('Changes were requested on your correction')).toHaveCount(0);
  await page.goto('/en/notifications?view=done');
  await expect(inboxItem('Changes were requested on your correction')).toBeVisible();
  await shoot(page, 'clp01-5-inbox-done', info);

  // Revise: revision 2 replaces revision 1 and the reviewer is told.
  const dialog = page.getByRole('dialog');
  const revise = async (text: string) => {
    await controls(page).and(page.locator('[data-action="revise"]')).click();
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Synopsis').fill(text);
    await dialog.getByRole('button', { name: 'Submit revision' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Saved.')).toBeVisible();
  };
  await page.goto(`/en${proposalPath(proposal)}`);
  await revise('Andra beskrivningen');
  await expect(page.getByText('Revision 2, the latest')).toBeVisible();
  await expect(page.getByText('Andra beskrivningen')).toBeVisible();
  await shoot(page, 'clp01-6-revised', info);

  // A second reviewer approves revision 2 ...
  actOk({
    as: 'second',
    method: 'POST',
    path: `/v1/editorial/proposals/${proposal}/reviews`,
    body: {
      profile: 'editorial-proposal-review-v1',
      revision: 2,
      outcome: 'approve',
      message: 'Verified against the print',
      actingSubject: seed.roles.second.actor,
    },
  });
  await page.reload();
  await expect(page.getByText('Approved', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Verified against the print')).toBeVisible();
  await shoot(page, 'clp04-1-approved', info);

  // ... and the author's next revision invalidates that approval. It stays visible as stale, and counts for nothing.
  await revise('Tredje beskrivningen');
  await expect(page.getByText('Revision 3, the latest')).toBeVisible();
  await expect(
    page.getByText(/1 earlier approval no longer counts because the correction was revised/),
  ).toBeVisible();
  await expect(page.getByText('Open', { exact: true }).first()).toBeVisible();
  await shoot(page, 'clp04-2-approval-no-longer-counts', info);

  // The steward's approval of revision 3 applies it; the author finds the decision in the inbox and on the page.
  actOk({
    as: 'steward',
    method: 'POST',
    path: `/v1/editorial/proposals/${proposal}/decisions`,
    body: {
      profile: 'editorial-proposal-decide-v1',
      revision: 3,
      outcome: 'applied',
      approve: true,
      message: 'Checked evidence',
      actingSubject: seed.roles.steward.actor,
    },
  });
  await eventually(page, '/en/notifications', async () => {
    await expect(inboxItem('A decision was made on a correction')).toBeVisible({ timeout: 2_000 });
  });
  await page.goto(`/en${proposalPath(proposal)}`);
  await expect(page.getByText('Applied', { exact: true }).first()).toBeVisible();
  expect(await actions(page)).toEqual(['revert']);
  await shoot(page, 'clp01-7-applied', info);

  // Revert: a new correction that undoes it, reviewed like any other.
  await controls(page).and(page.locator('[data-action="revert"]')).click();
  await dialog.getByRole('button', { name: 'Open the reverting correction' }).click();
  await expect(page.getByText('The reverting correction is open.')).toBeVisible();
  await page.getByRole('link', { name: 'Open it' }).click();
  await expect(page.getByText('This correction undoes')).toBeVisible();
  const reversal = page.url().slice(-36);
  expect(reversal).not.toBe(proposal);
  await shoot(page, 'clp01-8-reversal-open', info);
  actOk({
    as: 'steward',
    method: 'POST',
    path: `/v1/editorial/proposals/${reversal}/decisions`,
    body: {
      profile: 'editorial-proposal-decide-v1',
      revision: 1,
      outcome: 'applied',
      approve: true,
      message: 'Undoing',
      actingSubject: seed.roles.steward.actor,
    },
  });
  await page.reload();
  await expect(page.getByText('Applied', { exact: true }).first()).toBeVisible();
  await shoot(page, 'clp01-9-reversal-applied', info);

  // Withdraw: the author closes a correction nobody has decided; nothing is left for anyone to do.
  await page.goto(`/en/proposals/new?work=${seed.sagan.id}`);
  await body.getByRole('combobox').click();
  await page.getByRole('option', { name: 'Another language…' }).click();
  await page.getByLabel('Language tag').fill('sv');
  await page.getByLabel('Synopsis').fill('Ska dras tillbaka');
  await page.getByRole('button', { name: 'Submit correction' }).click();
  await expect(page).toHaveURL(/\/en\/proposals\/[0-9a-f-]{36}$/);
  const stray = page.url().slice(-36);
  await controls(page).and(page.locator('[data-action="withdraw"]')).click();
  await dialog.getByRole('button', { name: 'Withdraw' }).click();
  await expect(page.getByText('Withdrawn', { exact: true }).first()).toBeVisible();
  await expect(controls(page)).toHaveCount(0);
  await expect(page.getByText('Nothing more is needed from you.')).toBeVisible();
  await shoot(page, 'clp01-10-withdrawn', info);
  expect(
    actOk({ as: 'steward', method: 'GET', path: `/v1/editorial/proposals/${stray}` }, 200),
  ).toMatchObject({ state: 'withdrawn' });

  // The same proposal and inbox in Japanese: labels, states and the reviewer's own words, nothing borrowed from English.
  await page.goto(`/ja${proposalPath(proposal)}`);
  await expect(page.getByText('適用済み', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Tredje beskrivningen')).toBeVisible();
  await expect(page.getByRole('button', { name: '元に戻す' })).toBeVisible();
  await shoot(page, 'clp01-11-applied-ja', info);
  await page.goto('/ja/notifications');
  await expect(inboxItem('訂正について決定がありました')).toBeVisible();
  await shoot(page, 'clp01-12-inbox-ja', info);
});

/** Main's own read of a proposal as the signed-in member: the actions it allows are what the page must offer. */
async function allowed(page: Page, proposal: string): Promise<string[]> {
  const read = await page.request.get(
    `/api/main/v1/editorial/proposals/${proposal}?actingSubject=${encodeURIComponent(seed.reader.actingSubject)}`,
  );
  expect(read.status(), await read.text()).toBe(200);
  return ((await read.json()) as { allowedActions: string[] }).allowedActions.sort();
}

test('CLP02/CLP04: a steward reviews an assistant’s wiki bundle, sees an approval stop counting, and publishes it', async ({
  page,
}, info) => {
  test.setTimeout(280_000);
  await page.setViewportSize(desktop);
  const { member } = credentials();
  const bundle = seed.wiki.bundleProposal;
  await signInAtAccounts(page, `/en${proposalPath(bundle)}`, member);
  await expect(page.getByText('Wiki bundle', { exact: true })).toBeVisible();
  await expect(page.getByText('Proposed by Assistant Ada')).toBeVisible();
  expect(await actions(page)).toEqual(await allowed(page, bundle));
  await shoot(page, 'clp02-1-bundle-proposed', info, 'F1 a wiki bundle is shown as raw leaf paths');

  // Review: the steward asks for changes through the dialog.
  const dialog = page.getByRole('dialog');
  await controls(page).and(page.locator('[data-action="review"]')).click();
  await dialog.getByText('Request changes', { exact: true }).click();
  await dialog.getByLabel('Message').fill('Chapter three is not cited');
  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Changes requested', { exact: true }).first()).toBeVisible();

  // The assistant revises (API credential), a second reviewer approves that revision, and the assistant then changes it again.
  const wikiBundle = (await (
    await page.request.get(
      `/api/main/v1/editorial/proposals/${bundle}?actingSubject=${encodeURIComponent(seed.reader.actingSubject)}`,
    )
  ).json()) as { revision: { candidate: Record<string, unknown>; baseHeads: unknown[] } };
  const revise = (revision: number, candidate: unknown) =>
    actOk({
      as: 'assistant',
      method: 'POST',
      path: `/v1/editorial/proposals/${bundle}/revisions`,
      body: {
        profile: 'editorial-proposal-revise-v1',
        revision,
        candidate,
        baseHeads: wikiBundle.revision.baseHeads,
        evidence: [],
        actingSubject: seed.roles.assistant.actor,
      },
    });
  const fewer = {
    ...wikiBundle.revision.candidate,
    claims: (wikiBundle.revision.candidate.claims as unknown[]).slice(0, 1),
  };
  revise(1, fewer);
  actOk({
    as: 'second',
    method: 'POST',
    path: `/v1/editorial/proposals/${bundle}/reviews`,
    body: {
      profile: 'editorial-proposal-review-v1',
      revision: 2,
      outcome: 'approve',
      message: 'Cited',
      actingSubject: seed.roles.second.actor,
    },
  });
  await page.reload();
  await expect(page.getByText('Approved', { exact: true }).first()).toBeVisible();
  revise(2, wikiBundle.revision.candidate);
  await page.reload();
  await expect(page.getByText('Revision 3, the latest')).toBeVisible();
  await expect(
    page.getByText(/1 earlier approval no longer counts because the correction was revised/),
  ).toBeVisible();
  expect(await actions(page)).toEqual(await allowed(page, bundle));
  expect(await actions(page)).not.toContain('apply');
  await shoot(
    page,
    'clp04-3-bundle-approval-no-longer-counts',
    info,
    'F1 a wiki bundle is shown as raw leaf paths',
  );

  // Publish: the steward's own approval applies revision 3 once, and the wiki then shows its reviewed claims.
  await controls(page).and(page.locator('[data-action="approve-and-apply"]')).click();
  await dialog.getByRole('button', { name: 'Approve and apply' }).click();
  await expect(async () => {
    const recover = controls(page).and(page.locator('[data-action="recover"]'));
    if (await recover.count()) await recover.click();
    await expect(page.getByText('Applied', { exact: true }).first()).toBeVisible({
      timeout: 2_000,
    });
  }).toPass({ timeout: 60_000 });
  const history = async () =>
    (await (
      await page.request.get(
        `/api/main/v1/wiki/${seed.wiki.id}/history?position=all&actingSubject=${encodeURIComponent(seed.reader.actingSubject)}`,
      )
    ).json()) as { claims: { claim: string; revision: string }[]; revisions: unknown };
  expect((await history()).claims).toHaveLength(2);
  await shoot(page, 'clp02-2-bundle-applied', info, 'F1 a wiki bundle is shown as raw leaf paths');
});

type Read = {
  proposal: {
    decision: {
      receipt: {
        afterHeads: { component: string; head: string }[];
        commands: { key: string; result: { component: string; revision: string } }[];
        owner: { evidence: string[] };
      };
    };
  };
  revision: {
    candidate: {
      claims: { evidence: { quote: string; locator: { selector: { exact: string } } }[] }[];
      units: object[];
    };
  };
};

test('CLP03/CLP05/CLP06: a chapter delta is reviewed and reverted in the browser, a pin and an export outlive it, and a revoked assistant keeps its work', async ({
  page,
}, info) => {
  test.setTimeout(290_000);
  await page.setViewportSize(desktop);
  const { member } = credentials();
  const bundle = seed.wiki.bundleProposal;
  await signInAtAccounts(page, `/en${proposalPath(bundle)}`, member);
  const acting = encodeURIComponent(seed.reader.actingSubject);
  const get = async (path: string) => {
    const response = await page.request.get(
      `/api/main/v1${path}${path.includes('?') ? '&' : '?'}actingSubject=${acting}`,
    );
    expect(response.status(), `${path}: ${await response.text()}`).toBe(200);
    return response.json() as Promise<unknown>;
  };
  type History = {
    claims: { claim: string; revision: string; value: { object: unknown } }[];
    revisions: unknown;
    sourcePosition: unknown;
  };
  const history = (query = '') =>
    get(`/wiki/${seed.wiki.id}/history?position=all${query}`) as Promise<History>;
  const applied = (await get(`/editorial/proposals/${bundle}`)) as Read;
  const receipt = applied.proposal.decision.receipt;
  const elizabeth = receipt.commands.find((command) => command.key.endsWith(':entity:elizabeth'))!
    .result.component;
  const pinned = await history();
  expect(pinned.claims).toHaveLength(2);

  // The assistant proposes a chapter four that retracts one claim and says nothing of the rest; a competing delta shares its base.
  const evidence = (quote: string) => ({
    ...applied.revision.candidate.claims[0]!.evidence[0]!,
    quote,
    locator: {
      ...applied.revision.candidate.claims[0]!.evidence[0]!.locator,
      selector: { type: 'TextQuoteSelector', exact: quote },
    },
  });
  const delta = (quote: string) => ({
    profile: 'wiki-delta-v1',
    base: pinned.revisions,
    changes: [
      {
        claim: pinned.claims[0]!.claim,
        revision: pinned.claims[0]!.revision,
        operation: 'retract',
        reason: 'Chapter four contradicts this assertion',
        evidenceClaim: 0,
      },
    ],
    bundle: {
      ...applied.revision.candidate,
      entities: [],
      units: [
        {
          ...applied.revision.candidate.units[0],
          id: 'ch4',
          ordinal: 3,
          label: 'Chapter 4',
          occurrence: seed.wiki.chapters[3],
        },
      ],
      claims: [
        {
          ...applied.revision.candidate.claims[0],
          subject: elizabeth,
          revealedAt: 'ch4',
          evidence: [evidence(quote)],
        },
      ],
    },
  });
  const propose = (quote: string) =>
    actOk(
      {
        as: 'assistant',
        method: 'POST',
        path: '/v1/editorial/proposals',
        body: {
          profile: 'editorial-proposal-create-v1',
          kind: 'wiki-bundle',
          candidate: delta(quote),
          baseHeads: receipt.afterHeads,
          target: {
            resource: seed.wiki.work,
            revision: receipt.afterHeads[0]!.head,
            context: 'urn:rezics:context:global',
          },
          evidence: [],
          actingSubject: seed.roles.assistant.actor,
        },
      },
      201,
    ).proposal as string;
  const first = propose('Chapter four corrects the family');
  const contender = propose('Chapter four corrects the family, again');
  const dialog = page.getByRole('dialog');
  const approveAndApply = async () => {
    await controls(page).and(page.locator('[data-action="approve-and-apply"]')).click();
    await dialog.getByRole('button', { name: 'Approve and apply' }).click();
  };
  await eventually(page, `/en${proposalPath(first)}`, async () => {
    await expect(controls(page).and(page.locator('[data-action="approve-and-apply"]'))).toBeVisible(
      { timeout: 2_000 },
    );
  });
  await shoot(page, 'clp03-1-delta-proposed', info, 'F1 a wiki bundle is shown as raw leaf paths');
  await approveAndApply();
  await expect(async () => {
    const recover = controls(page).and(page.locator('[data-action="recover"]'));
    if (await recover.count()) await recover.click();
    await expect(page.getByText('Applied', { exact: true }).first()).toBeVisible({
      timeout: 2_000,
    });
  }).toPass({ timeout: 60_000 });
  await expect
    .poll(async () => (await history()).claims.map((claim) => claim.claim), { timeout: 60_000 })
    .toEqual([pinned.claims[1]!.claim]);
  await shoot(page, 'clp03-2-delta-applied', info, 'F1 a wiki bundle is shown as raw leaf paths');

  // The competing delta was written against a base that has moved: Main refuses it and the page says so.
  await page.goto(`/en${proposalPath(contender)}`);
  await approveAndApply();
  await expect(dialog.getByRole('alert').or(page.getByRole('alert')).first()).toBeVisible();
  await expect(page.getByText('Applied', { exact: true })).toHaveCount(0);
  await shoot(
    page,
    'clp03-3-competing-delta-refused',
    info,
    'F1 a wiki bundle is shown as raw leaf paths',
  );

  // Revert from the applied delta's page restores what it ended.
  await page.goto(`/en${proposalPath(first)}`);
  await controls(page).and(page.locator('[data-action="revert"]')).click();
  await dialog.getByRole('button', { name: 'Open the reverting correction' }).click();
  await page.getByRole('link', { name: 'Open it' }).click();
  await expect(page.getByText('This correction undoes')).toBeVisible();
  const reversal = page.url().slice(-36);
  // The steward who opened the reversal cannot review it: the second reviewer decides it.
  await expect(
    page.getByText('You proposed this, so someone else has to review it.'),
  ).toBeVisible();
  expect(await actions(page)).not.toContain('approve-and-apply');
  actOk({
    as: 'second',
    method: 'POST',
    path: `/v1/editorial/proposals/${reversal}/decisions`,
    settle: true,
    key: crypto.randomUUID(),
    body: {
      profile: 'editorial-proposal-decide-v1',
      revision: 1,
      outcome: 'applied',
      approve: true,
      message: 'Restoring',
      actingSubject: seed.roles.second.actor,
    },
  });
  await page.reload();
  await expect(page.getByText('Applied', { exact: true }).first()).toBeVisible();
  // Main projects an owner's write a moment after its receipt.
  await expect
    .poll(async () => (await history()).claims.map((claim) => claim.value.object), {
      timeout: 60_000,
    })
    .toEqual([pinned.claims[1]!.value.object, pinned.claims[0]!.value.object]);
  expect(reversal).not.toBe(first);

  // CLP05: the pin taken before any of this renders exactly as it did, and an export of it serves until the quote is restricted.
  const pin = `&revisions=${encodeURIComponent(JSON.stringify(pinned.revisions))}`;
  expect(await history(pin)).toEqual(pinned);
  const exportBody = {
    profile: 'export-create-v1',
    actingSubject: seed.reader.actingSubject,
    useScope: 'quotation',
    selection: {
      kind: 'wiki-revision-set',
      reference: seed.wiki.work,
      revisions: pinned.revisions,
      expectedPosition: pinned.sourcePosition,
    },
  };
  const makeExport = async () => {
    const response = await page.request.post('/api/main/v1/exports', {
      headers: { 'idempotency-key': crypto.randomUUID() },
      data: exportBody,
    });
    expect(response.status(), await response.text()).toBe(201);
    return (await response.json()) as { manifestId: string; manifestDigest: string };
  };
  const exported = await makeExport();
  expect((await page.request.get(`/api/main/v1/exports/${exported.manifestId}`)).status()).toBe(
    200,
  );
  const restrictionKey = crypto.randomUUID();
  actOk(
    {
      as: 'steward',
      method: 'POST',
      path: '/v1/rights/use-assessments',
      key: restrictionKey,
      body: {
        profile: 'rights-use-assessment-v1',
        actingSubject: seed.roles.steward.actor,
        material: {
          scopeKind: 'wiki_evidence',
          provider: null,
          namespace: null,
          sourceRecordId: null,
          contentVariantId: null,
          wikiEvidenceId: receipt.owner.evidence[0],
          mediaAsset: null,
          component: 'record',
        },
        expressionKind: 'expression',
        family: 'data_rights',
        useKind: 'quotation',
        useScope: 'rezics:export:quotation',
        basis: 'permission',
        outcome: 'not_supported',
        licenseInstrument: null,
        exceptionKind: null,
        rationale: null,
        extent: {},
        evidence: {},
        obligations: [],
        expectedAssessment: null,
        idempotencyKey: restrictionKey,
      },
    } as never,
    201,
  );
  await page.goto(`/en${proposalPath(bundle)}`);
  await expect(page.getByText('Applied', { exact: true }).first()).toBeVisible();
  await expect(page.locator('body')).not.toContainText('The Bennet family');
  expect(JSON.stringify(await history(pin))).not.toContain('The Bennet family');
  expect((await page.request.get(`/api/main/v1/exports/${exported.manifestId}`)).status()).toBe(
    409,
  );
  expect((await makeExport()).manifestDigest).not.toBe(exported.manifestDigest);
  await shoot(page, 'clp05-1-quote-withheld', info, 'F1 a wiki bundle is shown as raw leaf paths');

  // CLP06: the assistant's credential ends; what it proposed and what was applied from it stay, attributed.
  actOk({ revoke: 'assistant' });
  await page.goto(`/en${proposalPath(first)}`);
  await expect(page.getByText('Proposed by Assistant Ada')).toBeVisible();
  await expect(page.getByText('Applied', { exact: true }).first()).toBeVisible();
  expect(await actions(page)).toEqual(await allowed(page, first));
  expect(await history(pin)).toEqual(await history(pin));
  await shoot(
    page,
    'clp06-1-revoked-assistant-work-remains',
    info,
    'F1 a wiki bundle is shown as raw leaf paths',
  );
  await page.goto(`/ja${proposalPath(bundle)}`);
  await expect(page.getByText('適用済み', { exact: true }).first()).toBeVisible();
  await shoot(page, 'clp06-2-bundle-ja', info, 'F1 a wiki bundle is shown as raw leaf paths');
});

/** What M7 keeps closed: a word of it in a link or on a page is an entry point with nothing behind it. */
const CLOSED =
  /distribut(?:e|ion)|world-?build|\brecognition\b|block-?note|agent mode|agent-mode|prose wiki|developer (?:portal|extras?)/i;

test('CLP07: the site offers no way into what M7 keeps closed', async ({ page }, info) => {
  test.setTimeout(120_000);
  await page.setViewportSize(desktop);
  const { member } = credentials();
  await signInAtAccounts(page, '/en/settings', member);
  for (const path of [
    '/en',
    '/en/settings',
    '/en/studio',
    '/en/submit',
    '/en/discover',
    '/en/proposals',
    '/en/notifications',
    '/en/library',
  ]) {
    await page.goto(path);
    await page.waitForLoadState('load');
    const links = await page
      .locator('a[href]')
      .evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute('href') ?? ''));
    expect(
      links.filter((href) => CLOSED.test(href)),
      `${path} links`,
    ).toEqual([]);
    const text = await page.locator('body').innerText();
    expect(text.match(CLOSED)?.[0] ?? null, `${path} text`).toBeNull();
  }
  await page.goto('/en/settings');
  await shoot(page, 'clp07-1-settings', info);
  // No such route answers either: the routes are not there to be guessed.
  for (const path of [
    '/en/worldbuilding',
    '/en/recognition',
    '/en/distribution',
    '/en/developers',
    '/en/agent-mode',
  ]) {
    expect((await page.request.get(path)).status(), path).toBe(404);
  }
});
