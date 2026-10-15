import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { uiLocales } from '../i18n/define.ts';
import { textFor } from '../features/safety/report.ts';
import { messages as rightsCopy } from '../features/rights-mark/messages.ts';
import { resourceHref } from '../features/address/path.ts';
import { localizedPath } from '../i18n/locale.ts';
import { platformAdministratorSession } from '../../../tests/qa/fixtures/platform-grant.ts';
import type { ImportedCatalogueFixture } from '../../../tests/qa/fixtures/imported-catalogue.ts';
import type { DecisionInput, DecisionResult } from '../../../services/main/src/modules/governance/store.ts';

test('visitor to rights holder: source licences in every UI language, public complaint, audited removal and a fresh read', async ({ page }, info) => {
  test.setTimeout(240_000);
  const fixture = JSON.parse(readFileSync(resolve('.temp/imported-content-rights-browser',
    process.env.REZICS_QA_RUN_ID!, 'seed.json'), 'utf8')) as ImportedCatalogueFixture & {
      rule: { ref: string; revision: string; digest: string }; publicConfigPath: string; privateConfigPath: string };
  const instruments = { bangumi: 'https://creativecommons.org/licenses/by-sa/3.0/',
    vndb: 'https://opendatacommons.org/licenses/odbl/1-0/',
    'open-library': 'https://creativecommons.org/publicdomain/zero/1.0/',
    'project-gutenberg': 'https://www.gutenberg.org/policy/license.html' };
  for (const locale of uiLocales) for (const work of fixture.works) {
    if (locale !== 'en' && work.provider !== 'bangumi') continue;
    await page.goto(localizedPath(resourceHref('/w/', work.work), locale));
    const mark = page.locator('[data-rights-mark]').filter({ has: page.locator(`a[href="${work.url}"]`) }).first();
    await expect(mark).toBeVisible();
    await expect(mark.locator(`a[href="${instruments[work.provider]}"]`)).toBeVisible();
    await expect(mark).toContainText(rightsCopy[locale].source.trim());
    if (work.provider === 'project-gutenberg') await expect(mark).toContainText('Fannie Merritt Farmer');
    if (locale === 'ja' && work.provider === 'bangumi')
      await page.screenshot({ path: info.outputPath('bangumi-attribution-ja.png'), fullPage: true });
  }
  const work = fixture.works.find(item => item.provider === 'bangumi')!;
  const copy = textFor('en');
  await page.goto(localizedPath(resourceHref('/w/', work.work), 'en'));
  await page.getByRole('link', { name: copy.reportText, exact: true }).click();
  await page.locator('label[data-scope="radio-group"]').filter({
    has: page.locator('input[value="copyright"]'),
  }).click({ timeout: 15_000 });
  await expect(page.getByRole('radio', { name: /^Copyright/ })).toBeChecked();
  await page.getByLabel(copy.statementLabel).fill('I hold the rights to the imported synopsis and request removal.');
  await page.getByLabel(copy.emailLabel, { exact: true }).fill('rights-holder@example.test');
  for (const [label, value] of [[copy.claimantName, 'Rights holder'], [copy.claimantAddress, '1 Example Street'],
    [copy.claimantPhone, '+1 555 555 0100'], [copy.claimedWork, 'The original synopsis'],
    [copy.materialLocation, work.work], [copy.copyrightSignature, 'Rights holder']])
    await page.getByLabel(label!).fill(value!);
  await page.getByText(copy.copyrightGoodFaith, { exact: true }).click();
  await page.getByText(copy.copyrightPerjury, { exact: true }).click();
  await page.getByRole('button', { name: copy.submit, exact: true }).click();
  await expect(page).toHaveURL(/\/en\/report\/[0-9a-f-]{36}#[\w-]{43}$/, { timeout: 60_000 });
  const caseId = new URL(page.url()).pathname.split('/').at(-1)!;
  await expect(page.getByRole('heading', { name: copy.statusTitle, exact: true })).toBeVisible();
  const operator = await platformAdministratorSession({ ...process.env,
    REZICS_WEB_AUTH_PUBLIC_PATH: fixture.publicConfigPath, REZICS_WEB_AUTH_PRIVATE_PATH: fixture.privateConfigPath },
  'openid governance:decide rights:decide');
  const api = async (method: string, path: string, body?: object, key?: string) => {
    const response = await fetch(new URL(path, operator.mainOrigin), { method,
      headers: { authorization: `Bearer ${await operator.session.current()}`,
        ...(body ? { 'content-type': 'application/json' } : {}), ...(key ? { 'idempotency-key': key } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    expect(response.ok, text).toBe(true);
    return JSON.parse(text);
  };
  const claimKey = crypto.randomUUID();
  await api('POST', `/v1/safety-cases/${caseId}/claim`, { actingSubject: operator.actingSubject, idempotencyKey: claimKey }, claimKey);
  const reviewed = await api('GET', `/v1/safety-cases/${caseId}?actingSubject=${encodeURIComponent(operator.actingSubject)}`) as {
    generation: string; reports: Array<{ evidenceDigest: string }> };
  const key = crypto.randomUUID();
  const decision: DecisionInput = { caseId, expectedGeneration: reviewed.generation, actingSubject: operator.actingSubject,
    outcome: 'final_restrict', targets: [{ owner: 'graph', resource: work.work, component: 'synopsis', locator: null,
      scopeKind: 'component', revision: null, expectedHead: work.revision, effect: 'disclosure' }],
    rule: fixture.rule, evidenceDigest: reviewed.reports[0]!.evidenceDigest, reversesDecisionId: null,
    answersStepId: null, rationale: 'Reviewed the retained source and the rights holder notice.', disclosure: 'parties',
    reasons: { facts: 'The imported synopsis was reviewed after a copyright complaint.', scope: 'The Work synopsis',
      duration: 'Until an attributable restoration decision.', automation: false,
      appealRoute: '/v1/public-reports/{caseId}/correspondence', contentLanguage: 'en' },
    idempotencyKey: key };
  let result: DecisionResult | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    result = await api('POST', `/v1/safety-cases/${caseId}/decisions`, decision, key) as DecisionResult;
    if (result.operation.status === 'completed') break;
  }
  expect(result?.operation.status).toBe('completed');
  await page.goto(localizedPath(resourceHref('/w/', work.work), 'en'));
  await expect(page.getByRole('heading', { name: work.title, exact: true }).first()).toBeVisible();
  await expect(page.getByText(fixture.summary, { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText(fixture.summary, { exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('synopsis-after-takedown.png'), fullPage: true });
});
