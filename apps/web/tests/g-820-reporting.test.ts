import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { uiLocales } from '../i18n/define.ts';
import { isPublicPagePath, isReportPath, localizedPath } from '../i18n/locale.ts';
import { uploadCommunityImage, ImageRefused } from '../features/communities/images.ts';
import { saveAgentProfile, profileSaveInput, type AvatarReport } from '../features/settings/profile-api.ts';
import { listReports, readCase, retryAfterSeconds, submitReport, writeCase } from '../features/safety/report-api.ts';
import { casePath, categoriesFor, credentialFromHash, declarationOf, discussionTarget, fill, keyed, needsEmail,
  plausibleTarget, reportHref, textFor, waitText } from '../features/safety/report.ts';
import { CASE_CREDENTIAL_HEADER, relays, withCredential } from '../features/safety/relay.ts';
import { safetyText } from '../features/safety/messages.ts';
import { clearanceOf, nextCheckSeconds, uploadErrorText } from '../features/safety/upload-state.ts';
import { removeCover, uploadCover } from '../features/studio/cover-api.ts';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const CASE = '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const CREDENTIAL = 'A'.repeat(43);
const AGENT = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000aa';

// The class guard: every surface that shows people's contributions, in one table. A surface that lacks the
// shared Report action (or, for a row of posts, the ID it reports) fails here. G-850 (Work hub), the Zone and
// wiki areas add their rows when they place it.
const surfaces = [
  { surface: 'profile', file: '../features/profile/profile-page.tsx', places: /<ReportAction[^>]*kind="profile"/ },
  { surface: 'every post row', file: '../features/feed/post-row.tsx', places: /<ReportAction[^>]*kind="post"/ },
  { surface: 'feed posts', file: '../features/feed/card.tsx', places: /<PostRow[^>]*report=\{/ },
  { surface: 'discussions and replies as posts', file: '../features/feed/discussion-card.tsx', places: /<PostRow[^>]*report=\{/ },
  { surface: 'reply thread', file: '../features/feed/reply-tree.tsx', places: /<ReportAction[^>]*kind="reply"/ },
] as const;

test('G-820 every reportable surface places the shared ReportAction', () => {
  for (const { surface, file, places } of surfaces) {
    expect(source(file), `${surface} must place the ReportAction (${file})`).toMatch(places);
  }
  for (const file of ['../features/profile/profile-page.tsx', '../features/feed/post-row.tsx',
    '../features/feed/reply-tree.tsx']) {
    expect(source(file)).toContain("from '../safety/report-action.tsx'");
  }
});

test('G-820 a report needs no account: the page is public and its target comes from the link', () => {
  expect(isPublicPagePath('/report')).toBe(true);
  expect(isPublicPagePath('/ja/report/0198a1b2')).toBe(true);
  expect(localizedPath(reportHref(AGENT, 'https://rezics.com/id/x'), 'ja')).toStartWith('/ja/report?target=');
  expect(reportHref(AGENT)).toBe(`/report?target=${encodeURIComponent(AGENT)}`);
  const action = source('../features/safety/report-action.tsx');
  expect(action).not.toContain('useSession');
  expect(source('../app/[locale]/report/page.tsx')).not.toContain('redirect(');
  expect(source('../app/[locale]/report/page.tsx')).not.toContain('signInPath');
});

test('G-820 Main resolves IDs, so a post names the ID of what it is about', () => {
  expect(discussionTarget('/en/r/01a0e914-1857-74d8-8763-6628387b7f39/discussions/ee9b727b-300f-406f-aa16-dbd535efde0d'))
    .toBe('https://rezics.com/id/ee9b727b-300f-406f-aa16-dbd535efde0d');
  expect(discussionTarget('/en/r/rain/discussions/ee9b727b-300f-406f-aa16-dbd535efde0d#reply'))
    .toBe('https://rezics.com/id/ee9b727b-300f-406f-aa16-dbd535efde0d');
  expect(discussionTarget('/en/w/01a0e909-2857-70fc-b300-8091dc9a973f')).toBeNull();
  expect(plausibleTarget(AGENT)).toBe(true);
  expect(plausibleTarget('https://rezics.com/works/01a0e909-2857-70fc-b300-8091dc9a973f')).toBe(true);
  expect(plausibleTarget('/en/r/abc')).toBe(false);
  expect(plausibleTarget('javascript:alert(1)')).toBe(false);
  expect(plausibleTarget('   ')).toBe(false);
});

test('G-820 each category has its own form, words in every locale, and Realm rules only where a Realm is reported', () => {
  expect(categoriesFor(null)).not.toContain('realm_rules');
  expect(categoriesFor('https://rezics.com/id/r')).toContain('realm_rules');
  expect(declarationOf('ncii')).toBe('ncii');
  expect(declarationOf('copyright')).toBe('copyright');
  expect(declarationOf('harassment')).toBeNull();
  expect(needsEmail('ncii') && needsEmail('copyright')).toBe(true);
  expect(needsEmail('privacy')).toBe(false);
  for (const category of categoriesFor('realm')) {
    for (const locale of uiLocales) {
      const t = textFor(locale);
      expect(keyed(t, 'cat', category, '')).not.toBe('');
      expect(keyed(t, 'hint', category, '')).not.toBe('');
    }
  }
  // The 48-hour notice, the declarations and the counter-notice's disclosure exist in all eight locales.
  for (const locale of uiLocales) {
    expect(safetyText.nciiNotice[locale]).toContain('48');
    expect(safetyText.counterDisclosure[locale].length).toBeGreaterThan(40);
  }
  expect(safetyText.counterDisclosure.en).toContain('given to the person who sent the original notice');
  expect(safetyText.nciiNoImage.en).toContain('Do not upload or email the image');
});

test('G-820 the case credential lives in the URL fragment only', () => {
  expect(casePath(CASE, CREDENTIAL)).toBe(`/report/${CASE}#${CREDENTIAL}`);
  expect(credentialFromHash(`#${CREDENTIAL}`)).toBe(CREDENTIAL);
  expect(credentialFromHash('#short')).toBeNull();
  expect(credentialFromHash('')).toBeNull();
  // The status page keeps it out of requests and referrers.
  expect(isReportPath('/ja/report/' + CASE)).toBe(true);
  expect(isReportPath('/en/reports')).toBe(false);
  expect(source('../proxy.ts')).toContain("'referrer-policy', 'no-referrer'");
  expect(source('../app/[locale]/report/[caseId]/page.tsx')).toContain("referrer: 'no-referrer'");
  expect(source('../app/[locale]/report/page.tsx')).toContain("referrer: 'no-referrer'");
});

test('G-820 API parity: the browser makes exactly G-564\'s calls and no credential reaches a URL', async () => {
  const calls: Array<{ method: string; url: string; headers: Headers; body: string | null }> = [];
  const send = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url: String(input), headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null });
    const url = String(input);
    if (url.includes('/correspondence')) return Response.json({ stepId: 'step' });
    if (url.endsWith('/public-reports')) return Response.json({ caseId: CASE, credential: CREDENTIAL });
    if (url.includes('/mine')) return Response.json({ reports: [], nextCursor: null });
    return Response.json({ caseId: CASE, steps: [], nextCursor: null });
  }) as typeof fetch;

  await submitReport({ target: AGENT, category: 'harassment', statement: 'Rude', contentLanguage: 'en' }, 'key'.repeat(12), send);
  await listReports(null, send);
  await readCase({ locale: 'ja', caseId: CASE, credential: CREDENTIAL }, send);
  await readCase({ locale: 'ja', caseId: CASE, credential: CREDENTIAL, cursor: CASE }, send);
  await writeCase({ locale: 'ja', caseId: CASE, credential: CREDENTIAL, key: 'k'.repeat(36),
    body: { kind: 'message', statement: 'More', contentLanguage: 'ja' } }, send);

  expect(calls.map(call => `${call.method} ${new URL(call.url, 'http://x').pathname}`)).toEqual([
    'POST /api/main/v1/public-reports',
    'GET /api/main/v1/public-reports/mine',
    `GET /ja/report/relay/v1/public-reports/${CASE}`,
    `GET /ja/report/relay/v1/public-reports/${CASE}`,
    `POST /ja/report/relay/v1/public-reports/${CASE}/correspondence`,
  ]);
  for (const call of calls) {
    expect(call.url).not.toContain(CREDENTIAL);
    expect(call.body ?? '').not.toContain(CREDENTIAL);
  }
  expect(calls[0]!.headers.get('idempotency-key')).toBe('key'.repeat(12));
  expect(JSON.parse(calls[0]!.body!).profile).toBe('public-report-v1');
  for (const call of calls.slice(2)) expect(call.headers.get(CASE_CREDENTIAL_HEADER)).toBe(CREDENTIAL);
  expect(calls[1]!.headers.get(CASE_CREDENTIAL_HEADER)).toBeNull();
  expect(calls[4]!.headers.get('idempotency-key')).toBe('k'.repeat(36));
});

test('G-820 failures say what to do: a spent budget names when, an unknown case is not told apart from a wrong one', async () => {
  const answer = (status: number, headers: Record<string, string> = {}) =>
    (async () => new Response(null, { status, headers })) as unknown as typeof fetch;
  expect(await submitReport({ target: AGENT, category: 'privacy', statement: 's', contentLanguage: 'en' }, 'k'.repeat(36),
    answer(429, { 'retry-after': '90' }))).toEqual({ ok: false, reason: 'limited', retryAfter: 90 });
  expect(retryAfterSeconds({ headers: new Headers() })).toBe(60);
  expect(await readCase({ locale: 'en', caseId: CASE, credential: CREDENTIAL }, answer(404))).toEqual({ ok: false, reason: 'denied' });
  expect(await readCase({ locale: 'en', caseId: CASE, credential: CREDENTIAL }, answer(403))).toEqual({ ok: false, reason: 'denied' });
  expect(await readCase({ locale: 'en', caseId: CASE, credential: CREDENTIAL }, answer(503))).toEqual({ ok: false, reason: 'unavailable' });
  expect(await readCase({ locale: 'en', caseId: CASE, credential: CREDENTIAL },
    (async () => { throw new Error('offline'); }) as unknown as typeof fetch)).toEqual({ ok: false, reason: 'unavailable' });
  expect(waitText(90, 'en')).toBe('2 minutes');
  expect(waitText(30, 'en')).toBe('30 seconds');
  expect(waitText(7200, 'ja')).toBe('2 時間');
  expect(fill(safetyText.retryIn.en, { time: '2 minutes' })).toBe(
    'Too many requests from here for now. You can try again in 2 minutes.');
});

test('G-820 the relay serves only the two case routes and adds the credential to no other call', async () => {
  expect(relays(['v1', 'public-reports', CASE], 'GET')).toBe(true);
  expect(relays(['v1', 'public-reports', CASE, 'correspondence'], 'POST')).toBe(true);
  expect(relays(['v1', 'public-reports', CASE], 'POST')).toBe(false);
  expect(relays(['v1', 'public-reports', 'mine'], 'GET')).toBe(false);
  expect(relays(['v1', 'works'], 'GET')).toBe(false);
  expect(relays(['v1', 'public-reports', CASE, 'correspondence'], 'GET')).toBe(false);
  expect(relays(['v1', 'public-reports', `${CASE}x`], 'GET')).toBe(false);

  const seen: Array<{ url: string; credential: string | null }> = [];
  const wrapped = withCredential(CREDENTIAL, (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), credential: new Headers(init?.headers).get(CASE_CREDENTIAL_HEADER) });
    return new Response('{}');
  }) as typeof fetch);
  await wrapped(`http://main.test/v1/me/session-agent`, { headers: { authorization: 'Bearer t' } });
  await wrapped(new URL(`http://main.test/v1/public-reports/${CASE}`), { headers: new Headers({ accept: '*/*' }) });
  expect(seen).toEqual([{ url: 'http://main.test/v1/me/session-agent', credential: null },
    { url: `http://main.test/v1/public-reports/${CASE}`, credential: CREDENTIAL }]);
  const route = source('../app/[locale]/report/relay/[...path]/route.ts');
  expect(route).toContain('accessToken: undefined');
});

test('G-820 an upload is never assumed visible: an answer without a state reads Checking', () => {
  expect(clearanceOf(undefined)).toBe('screening');
  expect(clearanceOf('visible')).toBe('screening');
  expect(clearanceOf('cleared')).toBe('cleared');
  expect(clearanceOf('held')).toBe('held');
  expect(clearanceOf('rejected')).toBe('rejected');
  expect(nextCheckSeconds('cleared', 0)).toBeNull();
  expect(nextCheckSeconds('rejected', 0)).toBeNull();
  expect(nextCheckSeconds('screening', 0)).toBe(2);
  expect(nextCheckSeconds('screening', 99)).toBeNull();
  expect(nextCheckSeconds('held', 0)).toBe(30);
  expect(nextCheckSeconds('held', 99)).toBeNull();
  for (const locale of uiLocales) {
    const t = textFor(locale);
    for (const key of ['uploadChecking', 'uploadVisible', 'uploadHeld', 'uploadRejected'] as const) {
      expect(t[key].length).toBeGreaterThan(0);
    }
  }
  expect(safetyText.uploadChecking.en).toBe('Checking');
  expect(safetyText.uploadVisible.en).toBe('Visible');
  expect(safetyText.uploadHeld.en).toBe('Under review');
  expect(safetyText.uploadRejected.en).toBe('Not accepted');
  expect(uploadErrorText('avatar-limited', '120', 'en')).toBe(
    'You have reached the upload limit for now. You can try again in 2 minutes.');
  expect(uploadErrorText('avatar-limited', null, 'en')).toBe('Upload limit reached');
  expect(uploadErrorText('avatar-rejected', null, 'en')).toContain('Not accepted');
  expect(uploadErrorText('conflict', null, 'en')).toBeNull();
});

const png = () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
function media(options: { clearance?: string; limitedAt?: 'reserve' | 'bytes' } = {}) {
  const calls: string[] = [];
  const send = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const limited = () => Response.json({ status: 429, code: 'rate_limited' }, { status: 429, headers: { 'retry-after': '3600' } });
    if (url.endsWith('/media/uploads')) return options.limitedAt === 'reserve' ? limited() : Response.json({ asset: 'a', upload: 'u' });
    if (url.endsWith('/bytes')) {
      return options.limitedAt === 'bytes' ? limited()
        : Response.json({ status: 'activated', ...(options.clearance ? { clearance: options.clearance } : {}) });
    }
    if (url.endsWith('/avatar')) return Response.json({ selection: 'sel' });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return { send, calls };
}
const cover = (send: typeof fetch) => uploadCover({ actingSubject: AGENT, work: AGENT, image: png(), expected: null,
  key: 'k' }, send);

test('G-820 a saved cover reports its check; done no longer means visible', async () => {
  expect(await cover(media({ clearance: 'cleared' }).send)).toEqual({ outcome: 'done', selection: 'sel', upload: 'u', clearance: 'cleared' });
  expect(await cover(media({ clearance: 'held' }).send)).toEqual({ outcome: 'done', selection: 'sel', upload: 'u', clearance: 'held' });
  // An answer that names no state is Checking, never Visible.
  expect(await cover(media().send)).toMatchObject({ outcome: 'done', clearance: 'screening' });
  const rejected = media({ clearance: 'rejected' });
  expect(await cover(rejected.send)).toEqual({ outcome: 'rejected' });
  expect(rejected.calls.some(call => call.endsWith('/avatar'))).toBe(false);
  expect(await cover(media({ limitedAt: 'reserve' }).send)).toEqual({ outcome: 'limited', retryAfter: 3600 });
  expect(await cover(media({ limitedAt: 'bytes' }).send)).toEqual({ outcome: 'limited', retryAfter: 3600 });
  expect(await removeCover({ actingSubject: AGENT, work: AGENT, expected: 'sel', key: 'k' }, media().send))
    .toEqual({ outcome: 'done', selection: 'sel', upload: null, clearance: null });
});

test('G-820 an avatar upload reports its check, a rejected image and a spent budget', async () => {
  const profile = { revision: 'r1', displayName: 'Ada', bio: null, avatarSelection: null } as never;
  const file = new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' });
  const withMedia = (options: Parameters<typeof media>[0], extra: (url: string) => Response | null = () => null) => {
    const base = media(options);
    return ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      return Promise.resolve(extra(url)) .then(response => response ?? base.send(input, init));
    }) as typeof fetch;
  };
  const save = (send: typeof fetch, report: AvatarReport) => saveAgentProfile(profileSaveInput(profile,
    { token: 't', agent: AGENT, displayName: 'Ada', bioText: '', bioLanguage: '', avatar: file, removeAvatar: false,
      key: '00000000-0000-4000-8000-000000000001', report }), send);
  const saved: AvatarReport = {};
  const profileOk = (url: string) => url.includes('/profile') ? new Response(null, { status: 200 }) : null;
  expect(await save(withMedia({ clearance: 'held' }, profileOk), saved)).toBe('saved');
  expect(saved).toEqual({ clearance: 'held' });
  const rejected: AvatarReport = {};
  expect(await save(withMedia({ clearance: 'rejected' }, profileOk), rejected)).toBe('avatar-rejected');
  expect(rejected).toEqual({ clearance: 'rejected' });
  const limited: AvatarReport = {};
  expect(await save(withMedia({ limitedAt: 'reserve' }), limited)).toBe('avatar-limited');
  expect(limited).toEqual({ retryAfter: 3600 });
  expect(source('../app/[locale]/settings/profile/route.ts')).toContain("saved.searchParams.set('avatar'");
});

test('G-820 a community image reports its check and refuses what Main rejected or limited', async () => {
  const image = new File([new Uint8Array([1, 2, 3])], 'i.png', { type: 'image/png' });
  const seen: string[] = [];
  const done = await uploadCommunityImage({ image, realm: AGENT, actingSubject: AGENT, kind: 'icon', key: 'k',
    onClearance: clearance => seen.push(clearance) }, media({ clearance: 'held' }).send);
  expect(done).toBe('sel');
  expect(seen).toEqual(['held']);
  const rejected = uploadCommunityImage({ image, realm: AGENT, actingSubject: AGENT, kind: 'banner', key: 'k',
    onClearance: clearance => seen.push(clearance) }, media({ clearance: 'rejected' }).send);
  await expect(rejected).rejects.toMatchObject({ reason: 'rejected' });
  expect(seen).toEqual(['held', 'rejected']);
  const limited = uploadCommunityImage({ image, realm: AGENT, actingSubject: AGENT, kind: 'icon', key: 'k' },
    media({ limitedAt: 'reserve' }).send);
  await expect(limited).rejects.toBeInstanceOf(ImageRefused);
  await expect(uploadCommunityImage({ image, realm: AGENT, actingSubject: AGENT, kind: 'icon', key: 'k' },
    media({ limitedAt: 'reserve' }).send)).rejects.toMatchObject({ reason: 'limited', retryAfter: 3600 });
});

test('G-820 the old "done means visible" assumption is gone from every upload path', () => {
  for (const file of ['../features/studio/cover-api.ts', '../features/settings/profile-api.ts',
    '../features/communities/images.ts']) {
    expect(source(file), file).toContain('clearanceOf');
  }
});
