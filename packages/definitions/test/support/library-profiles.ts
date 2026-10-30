import { verticalManifests, verticalProfile } from '../../../../services/kernel/test/support/manifests.ts';
import { bundledSources } from '../../src/bundled.ts';
import type { Release } from '../../src/index.ts';
import countForms from '../fixtures/library-count-forms.json';

export const LIBRARY_LOCALES = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'] as const;
export type ProfileData = Record<string, any>;
const stateIds = ['planned', 'in_progress', 'completed', 'paused', 'dropped'];
const stateWords = {
  de: ['Geplant', 'In Arbeit', 'Abgeschlossen', 'Pausiert', 'Abgebrochen'],
  en: ['Planned', 'In progress', 'Completed', 'Paused', 'Dropped'],
  es: ['Planeado', 'En curso', 'Completado', 'En pausa', 'Abandonado'],
  fr: ['Prévu', 'En cours', 'Terminé', 'En pause', 'Abandonné'],
  ja: ['予定', '進行中', '完了', '中断', '断念'],
  ko: ['예정', '진행 중', '완료', '일시 중지', '중단'],
  'zh-Hans': ['计划', '进行中', '已完成', '暂停', '放弃'],
  'zh-Hant': ['計劃', '進行中', '已完成', '暫停', '放棄'],
};
const unitWords: Record<string, readonly string[]> = {
  page: ['Seite', 'page', 'página', 'page', 'ページ', '쪽', '页', '頁'],
  chapter: ['Kapitel', 'chapter', 'capítulo', 'chapitre', '章', '장', '章', '章'],
  episode: ['Folge', 'episode', 'episodio', 'épisode', 'エピソード', '에피소드', '集', '集'],
  minute: ['Minute', 'minute', 'minuto', 'minute', '分', '분', '分钟', '分鐘'],
  volume: ['Band', 'volume', 'tomo', 'volume', '巻', '권', '卷', '卷'],
  percent: ['Prozent', 'percent', 'porcentaje', 'pourcentage', 'パーセント', '퍼센트', '百分比', '百分比'],
};
const copyKindWords: Record<string, readonly string[]> = {
  physical: ['Physisch', 'Physical', 'Físico', 'Physique', '物理', '실물', '实体', '實體'],
  digital: ['Digital', 'Digital', 'Digital', 'Numérique', 'デジタル', '디지털', '数字', '數位'],
  'legacy-unspecified': [
    'Nicht näher bestimmt',
    'Unspecified',
    'Sin especificar',
    'Non précisé',
    '未指定',
    '미지정',
    '未指定',
    '未指定',
  ],
};
const copyStatusWords: Record<string, readonly string[]> = {
  ordered: ['Bestellt', 'Ordered', 'Pedido', 'Commandé', '注文済み', '주문함', '已订购', '已訂購'],
  owned: ['Im Besitz', 'Owned', 'En propiedad', 'Possédé', '所持', '소장', '拥有', '擁有'],
  lent: ['Verliehen', 'Lent', 'Prestado', 'Prêté', '貸出中', '대여 중', '已借出', '已借出'],
  disposed: ['Abgegeben', 'Disposed', 'Desprendido', 'Cédé', '手放した', '처분함', '已处置', '已處置'],
};

export const MODES = ['scalar_amount', 'cursor_position', 'completed_units'] as const;
export const LEGACY_UNITS = ['page', 'chapter', 'episode', 'volume', 'minute', 'percent'] as const;
export function unitData(id: string, mode: string = 'scalar_amount'): ProfileData {
  return {
    id,
    minimum: '0',
    totalPolicy: mode === 'scalar_amount' ? 'optional' : 'forbidden',
    identity: { kind: mode === 'completed_units' ? 'session_local' : 'none' },
    structure: { kind: 'none' },
    ...(id === 'percent' ? { dimension: 'percent' } : {}),
    ...(id === 'percent' && mode === 'scalar_amount' ? { maximum: '100' } : {}),
  };
}
/** Source contains no labels; precision absence preserves the existing decimal parser. */
export function libraryProfile(id = 'fixture.reading', unit = 'page'): ProfileData {
  return {
    id,
    entryStateSet: {
      id: 'legacy-five',
      states: stateIds.map((id, i) => ({ id, role: ['planned', 'active', 'completed', 'paused', 'dropped'][i] })),
    },
    progress: { allowed: [{ mode: 'scalar_amount', units: [unitData(unit)] }] },
    copies: {
      kinds: [
        { id: 'physical', statuses: [{ id: 'owned' }, { id: 'disposed' }] },
        { id: 'digital', statuses: [{ id: 'owned' }] },
      ],
    },
    importSources: [],
  };
}
export function legacyProfile(): ProfileData {
  const p = libraryProfile('legacy-fixed-v1');
  p.progress.allowed = MODES.map((mode) => ({ mode, units: LEGACY_UNITS.map((id) => unitData(id, mode)) }));
  p.copies.kinds = [
    { id: 'legacy-unspecified', statuses: ['ordered', 'owned', 'lent', 'disposed'].map((id) => ({ id })) },
  ];
  return p;
}
/** Mode then unit disambiguates the same unit's presentation in different modes. */
export function libraryLabels(profile: ProfileData, locale: (typeof LIBRARY_LOCALES)[number]): ProfileData {
  const n = LIBRARY_LOCALES.indexOf(locale);
  return {
    ...(profile.entryStateSet
      ? {
          states: Object.fromEntries(
            profile.entryStateSet.states.map((s: ProfileData) => [
              s.id,
              stateWords[locale][stateIds.indexOf(s.id)] ?? s.id,
            ]),
          ),
        }
      : {}),
    ...(profile.progress
      ? {
          units: Object.fromEntries(
            profile.progress.allowed.map((m: ProfileData) => [
              m.mode,
              Object.fromEntries(
                m.units.map((u: ProfileData) => {
                  const label = unitWords[u.id]?.[n] ?? u.id;
                  const forms = (countForms[locale] as Record<string, unknown>)[u.id];
                  return [u.id, forms ? { label, countForms: forms } : label];
                }),
              ),
            ]),
          ),
        }
      : {}),
    ...(profile.copies
      ? {
          copyKinds: Object.fromEntries(
            profile.copies.kinds.map((k: ProfileData) => [k.id, copyKindWords[k.id]?.[n] ?? k.id]),
          ),
          copyStatuses: Object.fromEntries(
            profile.copies.kinds.map((k: ProfileData) => [
              k.id,
              Object.fromEntries(k.statuses.map((s: ProfileData) => [s.id, copyStatusWords[s.id]?.[n] ?? s.id])),
            ]),
          ),
        }
      : {}),
  };
}
export function compiledProfile(profile: ProfileData): ProfileData {
  const result = structuredClone(profile);
  const labels = (select: (p: ProfileData) => string) =>
    Object.fromEntries(LIBRARY_LOCALES.map((l) => [l, select(libraryLabels(profile, l))]));
  for (const s of result.entryStateSet?.states ?? []) s.labels = labels((p) => p.states[s.id]);
  for (const m of result.progress?.allowed ?? [])
    for (const u of m.units) {
      u.labels = labels((p) => {
        const leaf = p.units[m.mode][u.id];
        return typeof leaf === 'string' ? leaf : leaf.label;
      });
      const forms = Object.fromEntries(
        LIBRARY_LOCALES.flatMap((locale) => {
          const leaf = libraryLabels(profile, locale).units[m.mode][u.id];
          return typeof leaf === 'string' ? [] : [[locale, structuredClone(leaf.countForms)]];
        }),
      );
      if (Object.keys(forms).length) u.countForms = forms;
    }
  for (const k of result.copies?.kinds ?? []) {
    k.labels = labels((p) => p.copyKinds[k.id]);
    for (const s of k.statuses) s.labels = labels((p) => p.copyStatuses[k.id][s.id]);
  }
  return result;
}
export function registryOf(release: Release): Record<string, ProfileData> | undefined {
  return (release as unknown as { libraryProfiles?: Record<string, ProfileData> }).libraryProfiles;
}
export function referenceOf(release: Release, type: string): ProfileData | undefined {
  return (release.types[type] as unknown as { library?: ProfileData } | undefined)?.library;
}
export function profileOf(release: Release, type: string): ProfileData | undefined {
  const ref = referenceOf(release, type);
  return ref && registryOf(release)?.[ref.profileId];
}
export function fixture(profile: unknown = libraryProfile(), child?: unknown) {
  const classes: Record<string, ProfileData> = {
    Root: { abstract: true, annotations: { library: libraryProfile('fixture.root', 'percent') } },
    Parent: { class_uri: 'ex:Parent', is_a: 'Root', annotations: { library: profile } },
    Bridge: { abstract: true, is_a: 'Parent' },
    Child: {
      class_uri: 'ex:Child',
      is_a: 'Bridge',
      ...(child === undefined ? {} : { annotations: { library: child } }),
    },
    Sibling: { class_uri: 'ex:Sibling', is_a: 'Parent' },
    Person: { class_uri: 'ex:Person' },
    LegacyData: { abstract: true, annotations: { library: legacyProfile() } },
  };
  const profiles = [classes.Root!.annotations.library, profile, child, legacyProfile()].filter(
    (p): p is ProfileData => !!p && typeof p === 'object',
  );
  return {
    root: 'fixture.yaml',
    schemas: {
      'fixture.yaml': JSON.stringify({
        id: 'https://example.org/fixture',
        name: 'fixture',
        version: '1',
        prefixes: { linkml: 'https://w3id.org/linkml/', ex: 'https://example.org/' },
        imports: ['linkml:types'],
        classes,
      }),
    },
    presentation: Object.fromEntries(
      LIBRARY_LOCALES.map((locale) => [
        `fixture/${locale}`,
        JSON.stringify({
          types: { 'ex:Parent': 'parent', 'ex:Child': 'child', 'ex:Sibling': 'sibling', 'ex:Person': 'person' },
          libraryProfiles: Object.fromEntries(profiles.map((p) => [p.id, libraryLabels(p, locale)])),
        }),
      ]),
    ),
  };
}
export function releaseWith(profile: unknown = compiledProfile(libraryProfile())): Release {
  return {
    format: 'https://rezics.com/definitions/release/1',
    catalogue: { id: 'https://example.org/fixture', version: '1' },
    generator: { name: 'fixture', version: '1' },
    prefixes: { ex: 'https://example.org/' },
    libraryProfiles: { 'fixture.reading': profile },
    types: {
      'ex:Child': {
        iri: 'https://example.org/Child',
        labels: { en: 'child' },
        mappings: [],
        bases: [],
        properties: [],
        facets: [],
        library: { profileId: 'fixture.reading' },
      },
    },
    properties: {},
  } as unknown as Release;
}
export const launchProfiles = [
  ['book', 'Work', 'schema:Book', 'book.reading', 'page'],
  ['book', 'Edition', 'bf:Instance', 'book.edition', 'page'],
  ['anime', 'TVSeries', 'schema:TVSeries', 'anime.series', 'episode'],
  ['anime', 'TVSeason', 'schema:TVSeason', 'anime.season', 'episode'],
  ['anime', 'Episode', 'schema:Episode', 'anime.episode', 'minute'],
  ['anime', 'Movie', 'schema:Movie', 'anime.film', 'minute'],
  ['game', 'VideoGame', 'schema:VideoGame', 'game.playing', 'minute'],
  ['game', 'VideoGameRelease', 'wd:Q20631656', 'game.release', 'minute'],
  ['game', 'GameAddOn', 'wd:Q209163', 'game.addon', 'minute'],
  ['visual-novel', 'VisualNovel', 'wd:Q689445', 'visual-novel.reading', 'percent'],
  ['recipe', 'Recipe', 'schema:Recipe', 'recipe.cooking', 'minute'],
] as const;

// Reuse the existing launch-grain generator: 3 types, 12 properties and 8 presentation files per manifest.
export function sourcesFor(count: number, profiles: boolean) {
  const bundled = bundledSources();
  const extra = verticalManifests(count);
  if (profiles) {
    for (let i = 0; i < count; i++) {
      const vertical = verticalProfile(i);
      const schema = Bun.YAML.parse(extra.schemas[vertical.schema]!) as {
        classes: Record<string, { annotations?: Record<string, unknown> }>;
      };
      const p = expansionProfile(i);
      // An abstract structural node with no CURIE exercises compile-time inheritance.
      schema.classes[`V${i}LibraryBase`] = { annotations: { library: p } };
      Object.assign(schema.classes[`V${i}LibraryBase`]!, { abstract: true, is_a: 'CreativeWork' });
      for (const suffix of ['Work', 'Edition'])
        Object.assign(schema.classes[`V${i}${suffix}`]!, { is_a: `V${i}LibraryBase` });
      (extra.schemas as Record<string, string>)[vertical.schema] = JSON.stringify(schema);
      for (const locale of LIBRARY_LOCALES) {
        const key = `${vertical.name}/${locale}`;
        const labels = Bun.YAML.parse(extra.presentation[key]!) as Record<string, unknown>;
        labels.libraryProfiles = { [p.id]: libraryLabels(p, locale) };
        (extra.presentation as Record<string, string>)[key] = JSON.stringify(labels);
      }
    }
  }
  return {
    ...bundled,
    schemas: {
      ...bundled.schemas,
      ...extra.schemas,
      'rezics.yaml': `${bundled.schemas['rezics.yaml']!.trimEnd()}\n${Array.from({ length: count }, (_, i) => `  - v${i}`).join('\n')}\n`,
    },
    presentation: { ...bundled.presentation, ...extra.presentation },
  };
}

// Even manifests reuse the same canonical object; odd manifests add a genuinely new fixture vocabulary.
export function expansionProfile(index: number) {
  return index % 2 === 0 ? libraryProfile('fixture.shared') : libraryProfile(`v${index}.gardening`, 'seed-tray.v2');
}
