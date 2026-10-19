import { expect, test } from 'bun:test';
import { browserMainApi } from '../api/browser.ts';
import { withdrawChapterQualification, type QualificationWithdrawalIntent } from './content-api.ts';
import { authorFixture as f } from '../feed/author-fixtures.ts';

const intent: QualificationWithdrawalIntent = {
  key: 'qualification-once', target: { actingSubject: f.actor, chapter: f.reply,
    variant: f.variant, language: 'en', direction: 'ltr' },
  current: { publication: f.placement, eligibility: f.nextPlacement },
};

test('qualification withdrawal replays exact publication and qualification heads without touching the draft or Structure', async () => {
  const calls: { body: unknown; key: string | null; path: string }[] = [];
  let lost = true;
  const fetcher = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ body: JSON.parse(String(init?.body)), key: new Headers(init?.headers).get('idempotency-key'),
      path: new URL(String(input)).pathname });
    if (lost) { lost = false; return Response.json({ code: 'unavailable' }, { status: 503 }); }
    return Response.json({ profile: 'content-search-eligibility-withdrawal-v1', outcome: 'succeeded',
      resourceId: f.reply, variantId: f.variant, publicationDecision: f.placement,
      withdrawnEligibilityHead: f.nextPlacement, decision: f.withdrawal, receipt: 'urn:rezics:receipt:withdrawal',
      graphDataEpoch: 'fixture', graphSequence: '4', replayed: true });
  }, { preconnect: fetch.preconnect });
  const main = browserMainApi('https://author.invalid', { fetcher });
  expect(await withdrawChapterQualification(intent, main)).toEqual({ kind: 'failed' });
  expect(await withdrawChapterQualification(JSON.parse(JSON.stringify(intent)), main)).toEqual({ kind: 'done', value: {
    decision: f.withdrawal, receipt: 'urn:rezics:receipt:withdrawal', publication: f.placement,
    withdrawnEligibilityHead: f.nextPlacement,
  } });
  expect(calls[1]).toEqual(calls[0]);
  expect(calls[0]!.path).toBe('/api/main/v1/content-search-eligibility');
  expect(calls[0]!.body).toEqual({ profile: 'content-search-eligibility-withdrawal-v1', resourceId: f.reply,
    variantId: f.variant, publicationDecision: f.placement, expectedEligibilityHead: f.nextPlacement, actingSubject: f.actor });
});

test('another qualification receipt and a pending transport result never become success', async () => {
  for (const answer of [
    { profile: 'content-search-eligibility-withdrawal-v1', outcome: 'succeeded', resourceId: f.other,
      variantId: f.variant, publicationDecision: f.placement, withdrawnEligibilityHead: f.nextPlacement,
      decision: f.withdrawal, receipt: 'other-receipt' },
    { operationId: f.revision, retry: { afterMs: 1000 } },
  ]) {
    const fetcher = Object.assign(async () => Response.json(answer), { preconnect: fetch.preconnect });
    expect(await withdrawChapterQualification(intent, browserMainApi('https://author.invalid', { fetcher })))
      .toEqual({ kind: 'failed' });
  }
});
