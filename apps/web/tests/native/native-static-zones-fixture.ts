import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { slug } from '@rezics/definitions/slug';
import { UI_LOCALES, type CompositionDocument, type ZoneStarter } from '@rezics/composition';
import { bundledDigest } from '@rezics/definitions/bundled';
import bookStarter from '../../../../packages/definitions/presentation/book/zone.json';
import { GLOBAL_CONTEXT } from '../../../../services/kernel/src/semantic/definitions.ts';
import type { NativeWebStack } from './stack.ts';

const nativeRead = 'A public page from the native Zone configuration.';
const privateRead = 'PRIVATE-ZONE-STATIC-CONTENT';
const protectedRead = 'TAKEN-DOWN-ZONE-STATIC-CONTENT';
const repositoryRoot = resolve(import.meta.dir, '../../../../');

const labels = (english: string, translations: readonly string[]) =>
  Object.fromEntries(
    UI_LOCALES.map((locale, index) => [locale, locale === 'en' ? english : translations[index - 1]!]),
  ) as Record<(typeof UI_LOCALES)[number], string>;

function document(content: CompositionDocument['content']): CompositionDocument {
  return { root: { props: { appearance: { density: 'comfortable', radius: 'md', surface: 'cards' } } }, content };
}

async function json<T>(response: Response, operation: string): Promise<T> {
  const body = await response.text();
  if (!response.ok) throw new Error(`${operation}: ${response.status} ${body}`);
  return JSON.parse(body) as T;
}

function commandHeaders(): HeadersInit {
  return { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(crypto.randomUUID()) };
}

async function grant(stack: NativeWebStack, accountId: string, actions: string[]) {
  await json(
    await stack.kernel(
      '/v1/grants',
      {
        method: 'POST',
        headers: commandHeaders(),
        body: JSON.stringify({
          resource: { route: 0, id: GLOBAL_CONTEXT },
          subject: { kind: 'account', id: accountId },
          actions,
          valid: '(,)',
        }),
      },
      'governor',
    ),
    `grant ${actions.join(',')}`,
  );
}

async function createZone(stack: NativeWebStack, configuration: ZoneStarter, visibility: 'private' | 'public') {
  return json<{ zone: { id: string; revision: string } }>(
    await stack.kernel(
      '/v1/zones',
      {
        method: 'POST',
        headers: commandHeaders(),
        body: JSON.stringify({ configuration, mounts: [], visibility }),
      },
      'alice',
    ),
    `create ${visibility} Zone`,
  );
}

async function configureZone(stack: NativeWebStack, id: string, revision: string, configuration: ZoneStarter) {
  return json<{ zone: { revision: string } }>(
    await stack.kernel(
      `/v1/zones/${id}/configuration`,
      {
        method: 'PUT',
        headers: { ...commandHeaders(), 'if-match': `"${revision}"` },
        body: JSON.stringify({ configuration, mounts: [] }),
      },
      'alice',
    ),
    'configure static Zone pages',
  );
}

export type NativeStaticZonesFixture = {
  publicZoneId: string;
  privateZoneId: string;
  subjectId: string;
  publicLabel: string;
  publicHref: string;
  privateSentinel: string;
  protectedSentinel: string;
  definitionDigest: string;
};

/** Creates public subjects and routed Zones through the native production APIs. */
export async function createNativeStaticZonesFixture(stack: NativeWebStack): Promise<NativeStaticZonesFixture> {
  const active = await json<{ digest: string }>(
    await stack.kernel('/v1/definitions/active'),
    'read active definitions',
  );
  if (active.digest !== bundledDigest)
    throw new Error(`Native fixture definitions differ from the bundled release: ${active.digest}`);

  const owner = await stack.authPersona('alice');
  await grant(stack, owner.accountId, ['subject:create', 'zone:create']);
  const subjectLabels = labels('Static link subject', [
    '靜態連結主題',
    '静态链接主题',
    '静的リンク対象',
    '정적 링크 주제',
    'Statisches Linkthema',
    'Sujet du lien statique',
    'Enlace estático',
  ]);
  const subject = await json<{ subject: { id: string } }>(
    await stack.kernel(
      '/v1/subjects',
      {
        method: 'POST',
        headers: commandHeaders(),
        body: JSON.stringify({ type: 'schema:Book', labels: subjectLabels }),
      },
      'alice',
    ),
    'create link destination subject',
  );
  const subjectId = subject.subject.id;
  const publicLabel = subjectLabels.en;
  const publicHref = `/subjects/${subjectId}/${slug(publicLabel)}`;

  const publicConfiguration = structuredClone(bookStarter) as ZoneStarter;
  publicConfiguration.scope = [];
  publicConfiguration.labels = labels('Field Notes', [
    '田野筆記',
    '田野札记',
    'フィールドノート',
    '현장 노트',
    'Feldnotizen',
    'Notes de terrain',
    'Notas de campo',
  ]);
  publicConfiguration.pages = [
    {
      route: '',
      document: document([
        {
          type: 'Heading',
          props: {
            id: 'zone-title',
            level: 1,
            text: labels('Field Notes', [
              '田野筆記',
              '田野札记',
              'フィールドノート',
              '현장 노트',
              'Feldnotizen',
              'Notes de terrain',
              'Notas de campo',
            ]),
          },
        },
        {
          type: 'Text',
          props: {
            id: 'zone-copy',
            text: labels(nativeRead, [
              '原生區域頁面內容。',
              '原生区域页面内容。',
              'ネイティブなゾーンページです。',
              '네이티브 구역 페이지입니다.',
              'Eine native Zone-Seite.',
              'Une page Zone native.',
              'Una página Zone nativa.',
            ]),
          },
        },
        {
          type: 'Text',
          props: {
            id: 'protected-copy',
            text: labels(protectedRead, [
              '受保護的區域文字。',
              '受保护的区域文字。',
              '保護されたゾーンの文章です。',
              '보호된 구역 문구입니다.',
              'Geschützter Zonentext.',
              'Texte Zone protégé.',
              'Texto Zone protegido.',
            ]),
          },
        },
        { type: 'LinkGrid', props: { id: 'subject-links', links: [{ href: publicHref, label: subjectLabels }] } },
      ]),
    },
    {
      route: 'guide',
      document: document([
        {
          type: 'Heading',
          props: {
            id: 'guide-title',
            level: 1,
            text: labels('Guide', ['指南', '指南', 'ガイド', '안내', 'Leitfaden', 'Guide', 'Guía']),
          },
        },
        {
          type: 'Text',
          props: {
            id: 'guide-copy',
            text: labels('A second declared static page.', [
              '另一個已設定的靜態頁面。',
              '另一个已配置的静态页面。',
              '2 つ目の設定済み静的ページです。',
              '두 번째로 구성된 정적 페이지입니다.',
              'Eine zweite konfigurierte statische Seite.',
              'Une deuxième page statique configurée.',
              'Una segunda página estática configurada.',
            ]),
          },
        },
      ]),
    },
  ];
  const createdPublic = await createZone(stack, publicConfiguration, 'private');
  const configuredPublic = await configureZone(
    stack,
    createdPublic.zone.id,
    createdPublic.zone.revision,
    publicConfiguration,
  );
  const publishedPublic = await json<{ zone: { id: string } }>(
    await stack.kernel(
      `/v1/zones/${createdPublic.zone.id}:publish`,
      {
        method: 'POST',
        headers: { ...commandHeaders(), 'if-match': `"${configuredPublic.zone.revision}"` },
        body: JSON.stringify({ visibility: 'public' }),
      },
      'alice',
    ),
    'publish static Zone',
  );

  const privateConfiguration = structuredClone(publicConfiguration) as ZoneStarter;
  privateConfiguration.labels = labels('Private Notes', [
    '私人筆記',
    '私人札记',
    '非公開ノート',
    '비공개 노트',
    'Private Notizen',
    'Notes privées',
    'Notas privadas',
  ]);
  privateConfiguration.pages[0]!.document = document([
    { type: 'Heading', props: { id: 'private-title', level: 1, text: privateConfiguration.labels } },
    {
      type: 'Text',
      props: {
        id: 'private-copy',
        text: labels(privateRead, [
          '私人區域內容。',
          '私人区域内容。',
          '非公開ゾーンの内容です。',
          '비공개 구역 내용입니다.',
          'Privater Zoneninhalt.',
          'Contenu Zone privé.',
          'Contenido Zone privado.',
        ]),
      },
    },
  ]);
  const createdPrivate = await createZone(stack, privateConfiguration, 'private');
  const configuredPrivate = await configureZone(
    stack,
    createdPrivate.zone.id,
    createdPrivate.zone.revision,
    privateConfiguration,
  );

  const recordPage = async (id: string, route: string) =>
    json(
      await stack.kernel(`/v1/zones/${id}:readPage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: { route }, languages: ['en'] }),
      }),
      `record native ${route || 'home'} page`,
    );
  const [home, guide, metadata, subjectMetadata, subjectPage] = await Promise.all([
    recordPage(publishedPublic.zone.id, ''),
    recordPage(publishedPublic.zone.id, 'guide'),
    json(await stack.kernel(`/v1/zones/${publishedPublic.zone.id}`), 'record native Zone metadata'),
    json(await stack.kernel(`/v1/subjects/${subjectId}`), 'record native global subject'),
    json(
      await stack.kernel('/v1/pages:read', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: { subject: subjectId }, languages: ['en'] }),
      }),
      'record native global subject page',
    ),
  ]);
  const recordingDirectory = join(repositoryRoot, '.temp');
  await mkdir(recordingDirectory, { recursive: true });
  await Bun.write(
    join(recordingDirectory, 'native-static-zones-recording.json'),
    `${JSON.stringify({ home, guide, metadata, subjectMetadata, subjectPage }, null, 2)}\n`,
  );

  return {
    publicZoneId: publishedPublic.zone.id,
    privateZoneId: createdPrivate.zone.id,
    subjectId,
    publicLabel,
    publicHref,
    privateSentinel: privateRead,
    protectedSentinel: protectedRead,
    definitionDigest: active.digest,
  };
}

/** Adds unrelated native Zones for the page-read request-count growth check. */
export async function createNativeStaticZoneGrowthResources(stack: NativeWebStack, count: number): Promise<void> {
  const configuration = structuredClone(bookStarter) as ZoneStarter;
  configuration.scope = [];
  for (let index = 0; index < count; index++) await createZone(stack, configuration, 'private');
}

export const zoneDisclosureFieldPaths = ['/labels/en', '/pages/0/document/content/2/props/text'] as const;
export const zoneDisclosureComplaint = 'A native fixture notice used to check current Zone disclosure.';
