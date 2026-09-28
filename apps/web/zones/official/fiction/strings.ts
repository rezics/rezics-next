// The Fiction Zone's own words. Packages bring their strings; the platform
// passes the interface locale in `zone.locale`, and any other locale reads English.

const en = {
  tagline: 'Web serials, light novels and originals, picked in public by the Fiction editors.',
  official: 'Official REZICS Zone',
  podium: 'Top of the chart',
  more: 'Full chart',
  footerTitle: 'Fiction on REZICS',
  footerNote: 'Every pick in this Zone is a public decision. Follow the stamp on any work to see why it is here.',
  decisions: 'Decision log',
  about: 'About and rules',
  works: 'Every work',
};

type Strings = typeof en;

const translations: Record<string, Strings> = {
  en,
  'zh-Hans': {
    tagline: '网络连载、轻小说与原创作品，由小说编辑部公开甄选。',
    official: 'REZICS 官方专区',
    podium: '榜单前三',
    more: '完整榜单',
    footerTitle: 'REZICS 小说',
    footerNote: '本专区的每一部推荐都来自一项公开决定。点开作品旁的印章，就能看到它为什么在这里。',
    decisions: '决定记录',
    about: '关于与规则',
    works: '全部作品',
  },
  'zh-Hant': {
    tagline: '網路連載、輕小說與原創作品，由小說編輯部公開甄選。',
    official: 'REZICS 官方 Zone',
    podium: '榜單前三',
    more: '完整榜單',
    footerTitle: 'REZICS 小說',
    footerNote: '這個 Zone 的每項精選都是公開決策的結果。點開作品旁的印章，就能了解它為何入選。',
    decisions: '決策紀錄',
    about: '關於與規則',
    works: '全部作品',
  },
  ko: {
    tagline: '웹 연재물, 라이트 노벨, 오리지널 작품을 소설 편집진이 공개적으로 선정합니다.',
    official: 'REZICS 공식 Zone',
    podium: '순위 상위 작품',
    more: '전체 순위',
    footerTitle: 'REZICS 소설',
    footerNote: '이 Zone의 모든 추천 작품은 공개된 결정에 따라 선정되었습니다. 작품 옆의 도장을 누르면 선정 이유를 볼 수 있어요.',
    decisions: '결정 내역',
    about: '소개와 규칙',
    works: '모든 작품',
  },
  de: {
    tagline: 'Die Redaktion für Geschichten wählt Webserien, Light Novels und Originalwerke öffentlich aus.',
    official: 'Offizielle REZICS Zone',
    podium: 'Die Spitzenplätze der Rangliste',
    more: 'Gesamte Rangliste',
    footerTitle: 'Geschichten auf REZICS',
    footerNote: 'Jede Empfehlung in dieser Zone beruht auf einer öffentlichen Entscheidung. Öffne den Stempel an einem Werk, um zu erfahren, warum es hier ist.',
    decisions: 'Entscheidungsprotokoll',
    about: 'Über die Zone und ihre Regeln',
    works: 'Alle Werke',
  },
  ja: {
    tagline: 'ウェブ連載やライトノベル、オリジナル作品を、小説編集チームが公開の場で選び抜きます。',
    official: 'REZICS 公式 Zone',
    podium: 'ランキング上位',
    more: 'ランキングをすべて見る',
    footerTitle: 'REZICSの小説',
    footerNote: 'この Zone のおすすめはすべて公開の決定によって選ばれています。作品の横のスタンプをたどると、選ばれた理由がわかります。',
    decisions: '決定ログ',
    about: '概要とルール',
    works: 'すべての作品',
  },
};

export function strings(locale: string): Strings {
  return translations[locale] ?? en;
}
