import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkFirstPartyBundle } from '../../../services/main/src/modules/theme/first-party-bundle.ts';
import { parseZonePath } from '../../../services/main/src/modules/zone/route-path.ts';
import type { ZonePackage } from '@rezics/zone-sdk';
import { uiLocales } from '../i18n/define.ts';
import { zoneNavigationHref } from '../features/realm/route.ts';
import { messages } from '../features/zones/messages.ts';
import de from '../features/zones/messages/de.ts';
import es from '../features/zones/messages/es.ts';
import fr from '../features/zones/messages/fr.ts';
import ja from '../features/zones/messages/ja.ts';
import ko from '../features/zones/messages/ko.ts';
import zhHans from '../features/zones/messages/zh-Hans.ts';
import zhHant from '../features/zones/messages/zh-Hant.ts';
import { realmRefFromPageUrl } from '../features/zones/page-missing.tsx';
import franchiseWiki from '../zones/official/franchise-wiki/index.tsx';
import lightNovels from '../zones/official/light-novels/index.tsx';

const root = join(import.meta.dir, '../../..');
const communityMissing = {
  en: 'This community isn’t here', 'zh-Hant': '找不到此社群', 'zh-Hans': '找不到这个社区',
  ja: 'このコミュニティは見つかりません', ko: '커뮤니티를 찾을 수 없어요', de: 'Diese Community gibt es nicht',
  fr: 'Cette communauté est introuvable', es: 'Esta comunidad no está disponible',
} as const;
const pageMissing = { en: messages, 'zh-Hant': zhHant, 'zh-Hans': zhHans, ja, ko, de, fr, es };

interface Manifest {
  routeSegment: string;
  navigation: { label: string; href: string }[];
  mountSegment?: string;
  mounts?: { name: string; routeSegment: string }[];
}

function manifest(file: string): Manifest {
  return JSON.parse(readFileSync(join(root, 'config/zones', file), 'utf8')) as Manifest;
}

function mountsOf(spec: Manifest): Set<string> {
  return new Set(spec.mounts?.map(mount => mount.routeSegment) ?? (spec.mountSegment ? [spec.mountSegment] : []));
}

/** Slot names a package fills, in the form a first-party bundle declares them. */
function packageSlots(pkg: ZonePackage): string[] {
  const { modules, ...rest } = pkg.slots;
  return [...Object.keys(rest), ...Object.keys(modules ?? {}).map(type => `module:${type}`)];
}

const bundle = {
  profile: 'first-party-bundle-v1' as const,
  hostZone: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001',
  entry: 'assets/main.js',
  files: [{ path: 'assets/main.js', digest: 'a'.repeat(64), gzipBytes: 1000 }],
  connectOrigins: [] as string[], imageOrigins: [] as string[], fontOrigins: [] as string[],
};

describe('zone manifests', () => {
  test('every navigation entry resolves to one of the zone’s mounts', () => {
    for (const file of ['light-novels.json', 'visual-novels.json', 'franchise-wiki.json']) {
      const spec = manifest(file);
      const mounts = mountsOf(spec);
      expect(spec.navigation.length, file).toBeGreaterThan(0);
      if (spec.mounts) expect(spec.navigation.map(item => item.href).sort())
        .toEqual(spec.mounts.map(mount => `/${mount.routeSegment}`).sort());
      for (const item of spec.navigation) {
        const parsed = parseZonePath(item.href);
        expect(parsed, `${file} ${item.href}`).toEqual({ kind: 'mount', segment: item.href.slice(1),
          resource: null, tab: null });
        expect(mounts.has(parsed && parsed.kind === 'mount' ? parsed.segment : '')).toBe(true);
        expect(zoneNavigationHref(item.href, spec.routeSegment)).toBe(`/r/${spec.routeSegment}${item.href}`);
      }
    }
  });
});

describe('first-party slots', () => {
  test('home, entity, index and memberIndex are declarable, and the approvals name the ones each package uses', () => {
    const slots = ['home', 'entity', 'index', 'memberIndex'];
    expect(checkFirstPartyBundle({ ...bundle, slots }).bundle.slots).toEqual(['entity', 'home', 'index', 'memberIndex']);
    const wiki = readFileSync(join(root, 'apps/web/tests/g-849-records.ts'), 'utf8');
    const novels = readFileSync(join(root, 'apps/web/tests/g-853-records.ts'), 'utf8');
    const declared = {
      'franchise-wiki': wiki.match(/slots: \[([^\]]+)\]/)?.[1] ?? '',
      'light-novels': novels.split('\n').find(line => line.includes("'light-novels', light,")) ?? '',
    };
    for (const [slug, pkg] of [['franchise-wiki', franchiseWiki], ['light-novels', lightNovels]] as const) {
      for (const slot of packageSlots(pkg)) {
        if (!slots.includes(slot)) continue;
        expect(declared[slug], `${slug} approval`).toContain(`'${slot}'`);
      }
    }
  });
});

describe('a missing page inside a community', () => {
  test('reads the community from the page address', () => {
    expect(realmRefFromPageUrl('https://rezics.test/en/r/light-novels/no-such-page')).toBe('light-novels');
    expect(realmRefFromPageUrl('https://rezics.test/ja/r/franchise-wiki/characters/00000000-0000-4000-8000-000000000001'))
      .toBe('franchise-wiki');
    expect(realmRefFromPageUrl('https://rezics.test/en/discover')).toBeNull();
    expect(realmRefFromPageUrl(null)).toBeNull();
  });

  test('says the page isn’t there, in every locale', () => {
    for (const locale of uiLocales) {
      const copy = { ...messages, ...pageMissing[locale] };
      expect(copy.pageMissingTitle.length).toBeGreaterThan(0);
      expect(copy.pageMissingBody.length).toBeGreaterThan(0);
      expect(copy.pageMissingBack.length).toBeGreaterThan(0);
      expect(copy.pageMissingTitle).not.toBe(communityMissing[locale]);
      expect(copy.pageMissingBody).not.toContain(communityMissing[locale]);
    }
  });
});
