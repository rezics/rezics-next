import { insert, materializeData } from 'native-i18n';
import { defineMessages, type UiLocale } from '../../i18n/define.ts';
import type { ReadFailure } from './types.ts';
import type { WorkPageMessages } from './messages.ts';
import { Region, RegionFailure } from './region.tsx';
import { ReleaseCard, type EditionMessages, type ShownRelease } from './release.tsx';

const en = {
  editions: 'Editions and releases',
  editionsUnavailable: 'Editions and releases could not be loaded.',
  kindFormal: 'Print edition', kindWeb: 'Web publication', kindFixed: 'Fixed release', kindVirtual: 'Virtual release',
  statusOfficial: 'Official', statusUnofficial: 'Unofficial', statusVirtual: 'Virtual',
  statusWithdrawn: 'Withdrawn', statusCancelled: 'Cancelled',
  languages: 'Languages', languagesUnrecorded: 'Language not recorded', noLinguisticContent: 'No linguistic content',
  translation: 'Translation',
  translatedFrom: insert('Translated from {{language}}', { language: String }),
  titleLanguage: 'Title language', tracklistLanguage: 'Track list language',
  originalUrl: 'Original URL', coverage: 'Coverage',
  virtualNotice: 'A virtual release is not a record that this was published.',
  unofficialNotice: 'An unofficial release stays separate from the official one.',
  snapshots: 'Snapshots',
  snapshotFetched: insert('Fetched {{date}}', { date: String }),
  coverageComplete: 'Complete capture', coveragePartial: 'Partial capture',
};

export const editionMessages = defineMessages({
  en,
  'zh-Hans': {
    editions: '版本与发行', editionsUnavailable: '版本与发行暂时无法加载。',
    kindFormal: '纸质版本', kindWeb: '网络出版', kindFixed: '固定发行', kindVirtual: '虚拟发行',
    statusOfficial: '正式', statusUnofficial: '非官方', statusVirtual: '虚拟',
    statusWithdrawn: '已撤回', statusCancelled: '已取消',
    languages: '语言', languagesUnrecorded: '未记录语言', noLinguisticContent: '无语言内容',
    translation: '译本', translatedFrom: insert('译自{{language}}', { language: String }),
    titleLanguage: '题名语言', tracklistLanguage: '曲目文字语言',
    originalUrl: '原始网址', coverage: '覆盖范围',
    virtualNotice: '虚拟发行并不表示这部作品曾经这样出版。',
    unofficialNotice: '非官方发行单独记录，不会并入正式发行。',
    snapshots: '快照', snapshotFetched: insert('抓取于 {{date}}', { date: String }),
    coverageComplete: '完整抓取', coveragePartial: '部分抓取',
  },
  'zh-Hant': {
    editions: '版本與發行', editionsUnavailable: '版本與發行暫時無法載入。',
    kindFormal: '紙本版本', kindWeb: '網路出版', kindFixed: '固定發行', kindVirtual: '虛擬發行',
    statusOfficial: '正式', statusUnofficial: '非官方', statusVirtual: '虛擬',
    statusWithdrawn: '已撤回', statusCancelled: '已取消',
    languages: '語言', languagesUnrecorded: '未記錄語言', noLinguisticContent: '無語言內容',
    translation: '譯本', translatedFrom: insert('譯自{{language}}', { language: String }),
    titleLanguage: '題名語言', tracklistLanguage: '曲目文字語言',
    originalUrl: '原始網址', coverage: '涵蓋範圍',
    virtualNotice: '虛擬發行並不表示這部作品曾經這樣出版。',
    unofficialNotice: '非官方發行單獨記錄，不會併入正式發行。',
    snapshots: '快照', snapshotFetched: insert('擷取於 {{date}}', { date: String }),
    coverageComplete: '完整擷取', coveragePartial: '部分擷取',
  },
  ja: {
    editions: '版とリリース', editionsUnavailable: '版とリリースを読み込めませんでした。',
    kindFormal: '印刷版', kindWeb: 'ウェブ公開', kindFixed: '固定リリース', kindVirtual: '仮想リリース',
    statusOfficial: '公式', statusUnofficial: '非公式', statusVirtual: '仮想',
    statusWithdrawn: '撤回', statusCancelled: '中止',
    languages: '言語', languagesUnrecorded: '言語は記録されていません', noLinguisticContent: '言語内容なし',
    translation: '翻訳', translatedFrom: insert('{{language}}からの翻訳', { language: String }),
    titleLanguage: '題名の言語', tracklistLanguage: 'トラックリストの言語',
    originalUrl: '元の URL', coverage: '範囲',
    virtualNotice: '仮想リリースは、その内容が出版された記録ではありません。',
    unofficialNotice: '非公式リリースは公式リリースとは別の記録です。',
    snapshots: 'スナップショット', snapshotFetched: insert('{{date}} に取得', { date: String }),
    coverageComplete: '全体を取得', coveragePartial: '一部を取得',
  },
  ko: {
    editions: '판과 릴리스', editionsUnavailable: '판과 릴리스를 불러오지 못했습니다.',
    kindFormal: '인쇄본', kindWeb: '웹 출판', kindFixed: '고정 릴리스', kindVirtual: '가상 릴리스',
    statusOfficial: '공식', statusUnofficial: '비공식', statusVirtual: '가상',
    statusWithdrawn: '철회', statusCancelled: '취소',
    languages: '언어', languagesUnrecorded: '언어가 기록되지 않았습니다', noLinguisticContent: '언어 내용 없음',
    translation: '번역', translatedFrom: insert('{{language}}에서 번역', { language: String }),
    titleLanguage: '제목 언어', tracklistLanguage: '트랙 목록 언어',
    originalUrl: '원본 URL', coverage: '범위',
    virtualNotice: '가상 릴리스는 이 내용이 출판되었다는 기록이 아닙니다.',
    unofficialNotice: '비공식 릴리스는 공식 릴리스와 따로 둡니다.',
    snapshots: '스냅샷', snapshotFetched: insert('{{date}}에 수집', { date: String }),
    coverageComplete: '전체 수집', coveragePartial: '일부 수집',
  },
  de: {
    editions: 'Ausgaben und Veröffentlichungen',
    editionsUnavailable: 'Ausgaben und Veröffentlichungen konnten nicht geladen werden.',
    kindFormal: 'Druckausgabe', kindWeb: 'Webveröffentlichung', kindFixed: 'Feste Veröffentlichung',
    kindVirtual: 'Virtuelle Veröffentlichung',
    statusOfficial: 'Offiziell', statusUnofficial: 'Inoffiziell', statusVirtual: 'Virtuell',
    statusWithdrawn: 'Zurückgezogen', statusCancelled: 'Abgebrochen',
    languages: 'Sprachen', languagesUnrecorded: 'Sprache nicht erfasst', noLinguisticContent: 'Kein sprachlicher Inhalt',
    translation: 'Übersetzung', translatedFrom: insert('Übersetzt aus {{language}}', { language: String }),
    titleLanguage: 'Sprache des Titels', tracklistLanguage: 'Sprache der Titelliste',
    originalUrl: 'Ursprüngliche URL', coverage: 'Umfang',
    virtualNotice: 'Eine virtuelle Veröffentlichung belegt nicht, dass dieser Inhalt so erschienen ist.',
    unofficialNotice: 'Eine inoffizielle Veröffentlichung bleibt von der offiziellen getrennt.',
    snapshots: 'Snapshots', snapshotFetched: insert('Abgerufen am {{date}}', { date: String }),
    coverageComplete: 'Vollständig erfasst', coveragePartial: 'Teilweise erfasst',
  },
  fr: {
    editions: 'Éditions et parutions',
    editionsUnavailable: 'Les éditions et parutions n’ont pas pu être chargées.',
    kindFormal: 'Édition imprimée', kindWeb: 'Publication web', kindFixed: 'Parution figée',
    kindVirtual: 'Parution virtuelle',
    statusOfficial: 'Officielle', statusUnofficial: 'Non officielle', statusVirtual: 'Virtuelle',
    statusWithdrawn: 'Retirée', statusCancelled: 'Annulée',
    languages: 'Langues', languagesUnrecorded: 'Langue non enregistrée', noLinguisticContent: 'Pas de contenu linguistique',
    translation: 'Traduction', translatedFrom: insert('Traduit de : {{language}}', { language: String }),
    titleLanguage: 'Langue du titre', tracklistLanguage: 'Langue de la liste des pistes',
    originalUrl: 'URL d’origine', coverage: 'Couverture',
    virtualNotice: 'Une parution virtuelle n’atteste pas que ce contenu a été publié ainsi.',
    unofficialNotice: 'Une parution non officielle reste distincte de la parution officielle.',
    snapshots: 'Instantanés', snapshotFetched: insert('Récupéré le {{date}}', { date: String }),
    coverageComplete: 'Capture complète', coveragePartial: 'Capture partielle',
  },
  es: {
    editions: 'Ediciones y publicaciones',
    editionsUnavailable: 'No se pudieron cargar las ediciones y publicaciones.',
    kindFormal: 'Edición impresa', kindWeb: 'Publicación web', kindFixed: 'Publicación fija',
    kindVirtual: 'Publicación virtual',
    statusOfficial: 'Oficial', statusUnofficial: 'No oficial', statusVirtual: 'Virtual',
    statusWithdrawn: 'Retirada', statusCancelled: 'Cancelada',
    languages: 'Idiomas', languagesUnrecorded: 'Idioma no registrado', noLinguisticContent: 'Sin contenido lingüístico',
    translation: 'Traducción', translatedFrom: insert('Traducido del {{language}}', { language: String }),
    titleLanguage: 'Idioma del título', tracklistLanguage: 'Idioma de la lista de pistas',
    originalUrl: 'URL original', coverage: 'Cobertura',
    virtualNotice: 'Una publicación virtual no acredita que este contenido se haya publicado así.',
    unofficialNotice: 'Una publicación no oficial permanece separada de la oficial.',
    snapshots: 'Instantáneas', snapshotFetched: insert('Obtenida el {{date}}', { date: String }),
    coverageComplete: 'Captura completa', coveragePartial: 'Captura parcial',
  },
});

export type { EditionMessages };

export function EditionsSection({ items, failure, locale, messages }: {
  items: ShownRelease[] | null; failure: ReadFailure | null; locale: UiLocale; messages: WorkPageMessages;
}) {
  const t = materializeData(editionMessages[locale], { locale });
  if (failure) return <RegionFailure title={t.editions} failure={failure} messages={messages} />;
  if (!items?.length) return null;
  return <Region id="work-editions" title={t.editions}>
    <div className="grid gap-5">{items.map(release => <ReleaseCard key={release.id} release={release} locale={locale}
      messages={t} />)}</div>
  </Region>;
}
