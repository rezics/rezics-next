import { treaty } from '@elysia/eden';
import type { MainApp } from '@rezics/main/app';

type Assert<Condition extends true> = Condition;
type Routes = MainApp['~Routes']['v1'];
type _Works = Assert<'post' extends keyof Routes['works'] ? true : false>;
type _ContributionDraft = Assert<'get' extends keyof Routes['contributions'][':contribution']['drafts'][':revision'] ? true : false>;
type _MainSelection = Assert<'get' extends keyof Routes['main-versions'][':mainVersion']['selection'] ? true : false>;
type _Classification = Assert<'post' extends keyof Routes['classification-decisions'] ? true : false>;
type _Rating = Assert<'post' extends keyof Routes['rating-aggregates'] ? true : false>;
type _Space = Assert<'post' extends keyof Routes['spaces'] ? true : false>;
type _Query = Assert<'post' extends keyof Routes['queries'] ? true : false>;
type _NpmLock = Assert<'post' extends keyof Routes['package-resolutions']['npm'] ? true : false>;
type _NpmReceipt = Assert<'get' extends keyof Routes['package-resolutions']['npm'][':resolution'] ? true : false>;
type AllOperations = [
  Routes['rating-aggregates']['post'],
  Routes['rating-observations']['post'],
  Routes['rating-observations'][':observation']['revisions'][':revision']['get'],
  Routes['rating-contexts']['post'],
  Routes['rating-contexts'][':id']['get'],
  Routes['classification-resolutions']['post'],
  Routes['classification-decisions']['post'],
  Routes['classification-propositions']['post'],
  Routes['classification-propositions'][':sense']['get'],
  Routes['classification-contexts']['post'],
  Routes['realms'][':realm']['classification-context']['get'],
  Routes['spaces']['post'],
  Routes['spaces'][':space']['get'],
  Routes['queries']['post'],
  Routes['publication-selections']['post'],
  Routes['publication-rejections']['post'],
  Routes['realms'][':realm']['main-versions'][':mainVersion']['selection']['get'],
  Routes['main-versions'][':mainVersion']['selection']['get'],
  Routes['contribution-publications']['post'],
  Routes['contribution-edits']['post'],
  Routes['contributions']['post'],
  Routes['contributions'][':contribution']['drafts'][':revision']['get'],
  Routes['works']['post'],
  Routes['content-edits']['post'],
  Routes['revisions'][':revision']['get'],
];
type _AllInstalled = Assert<AllOperations['length'] extends 25 ? true : false>;

const client = treaty<MainApp>('http://127.0.0.1:1');
type CreateWork = Parameters<typeof client.v1.works.post>[0];
type PublicQuery = Parameters<typeof client.v1.queries.post>[0];
const work: CreateWork = {
  profile: 'metadata-only-v1', title: 'A Work',
  actingSubject: 'https://rezics.com/id/11111111-1111-4111-8111-111111111111',
};
const query: PublicQuery = { profile: 'public-main-phrase-v1',
  phrase: 'example', language: null };
void client.v1.works.post(work);
void client.v1.queries.post(query);
void client.v1.spaces.post;
void client.v1.contributions.post;
void client.v1['rating-aggregates'].post;
void client.v1['classification-resolutions'].post;
void client.v1['package-resolutions'].npm.post({ profile: 'npm-lock-v3-topology-v1',
  npmVersion: '11.19.1', policy: 'literal-sources-required-peers-v1',
  manifest: { bytesBase64: 'e30=', sha256: '0'.repeat(64) },
  lock: { bytesBase64: 'e30=', sha256: '0'.repeat(64) } });
void client.v1['package-resolutions'].npm.post({ profile: 'npm-lock-v3-topology-v2',
  npmVersion: '11.19.1', policy: 'literal-sources-optional-platform-v2', target: { os: 'win32', cpu: 'x64' },
  manifest: { bytesBase64: 'e30=', sha256: '0'.repeat(64) },
  lock: { bytesBase64: 'e30=', sha256: '0'.repeat(64) } });
void client.v1['package-resolutions'].npm.post({ profile: 'npm-lock-v3-topology-v3',
  npmVersion: '11.19.1', policy: 'literal-sources-alias-workspace-v3', workspaces: [],
  manifest: { bytesBase64: 'e30=', sha256: '0'.repeat(64) },
  lock: { bytesBase64: 'e30=', sha256: '0'.repeat(64) } });
void client.v1['package-resolutions'].npm.post({ profile: 'npm-lock-v3-topology-v4',
  npmVersion: '11.19.1', policy: 'literal-sources-composed-v4', workspaces: [], target: { os: 'linux', cpu: 'arm64' },
  manifest: { bytesBase64: 'e30=', sha256: '0'.repeat(64) },
  lock: { bytesBase64: 'e30=', sha256: '0'.repeat(64) } });
