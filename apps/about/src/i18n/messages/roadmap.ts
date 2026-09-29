import type { Horizon, Milestone } from '../../features.ts';
import { defineCopy } from '../define.ts';

export interface RoadmapCopy {
  meta: { title: string; description: string };
  hero: { title: string; lede: string };
  availableTitle: string;
  availableLede: string;
  /** The three columns, headed by what they mean. */
  horizons: Record<Horizon, { title: string; body: string }>;
  /** GOAL.md's milestones as stages a reader can follow, in order. */
  milestones: Record<Milestone, { name: string; body: string }>;
  /** The pinned story of the five stages, one step each (the step text is `milestones`). */
  story: { title: string; lede: string };
  /** The caption of a stage's picture and how many capabilities it holds beyond those shown. */
  stageOf: string;
  more: string;
  /** The columns that file every capability under the stage that builds it. */
  columns: { title: string; lede: string };
  /** Says what order and missing dates mean. */
  statement: { text: string; body: string };
  cta: { title: string; body: string };
}

export const roadmap = defineCopy<RoadmapCopy>({
  en: {
    meta: {
      title: 'The REZICS roadmap: what is being built now, next and later',
      description:
        'Five stages from foundations to launch. Every capability REZICS describes sits in one of them, so you can see what is being built now and what follows.',
    },
    hero: {
      title: 'Five stages to launch. The first is underway.',
      lede: 'Everything this site describes sits in one of five stages, built in order. Foundations come first because every scenario stands on them; registration opens when the fifth is done.',
    },
    availableTitle: 'Available today',
    availableLede: 'What already works for everyone this site reaches.',
    horizons: {
      now: {
        title: 'In development',
        body: 'The stage being built now.',
      },
      next: {
        title: 'Up next',
        body: 'The stages that follow directly, on the foundations being laid now.',
      },
      later: {
        title: 'Later',
        body: 'The stages after that, which bring knowledge, agents, publishing and launch.',
      },
    },
    milestones: {
      M4: {
        name: 'Foundations',
        body: 'Editions, languages and identities that mean exactly what they say; one account model for people, apps and agents; edits that never lose what you wrote.',
      },
      M5: {
        name: 'Shared capabilities and safety',
        body: 'Complete lists without hidden limits, operations that survive a retry, exports that keep everything, reporting and appeals, and the rules every page is served by.',
      },
      M6: {
        name: 'The four first scenarios',
        body: 'Series tracking led by light novels, the portable library, serial fiction and visual novels by release, with the Light Novels and ACGN Zones over them.',
      },
      M7: {
        name: 'Knowledge, agents and publishing',
        body: 'Reviews and corrections, Realms and their wikis, worldbuilding, the agent protocol with its first agents, developer onboarding and the first books and games for sale.',
      },
      M8: {
        name: 'Launch',
        body: 'Production checks, recovery drills, safety readiness and accessibility on real devices. Then registration opens.',
      },
    },
    story: {
      title: 'Each stage stands on the one before it.',
      lede: 'Foundations come first because every scenario stands on them.',
    },
    stageOf: 'Stage {n} of {total}',
    more: 'and {n} more',
    columns: {
      title: 'Every capability, in its stage.',
      lede: 'The same plan, filed by when each stage is built.',
    },
    statement: {
      text: 'There are no dates on purpose.',
      body: 'A stage is finished when its checks pass, and a capability can move between stages as we learn.',
    },
    cta: {
      title: 'Hear the day registration opens.',
      body: 'Leave your email and we will write once, when registration opens. Nothing else.',
    },
  },
  'zh-Hant': {
    meta: {
      title: 'REZICS 開發規劃：現在、接下來與之後',
      description:
        '從基礎到上線，共五個階段。網站介紹的每項功能都有所屬階段，讓你看清楚現在在做什麼，接下來又是什麼。',
    },
    hero: {
      title: '五個階段走向上線，第一步已開始。',
      lede: '本站介紹的一切分屬五個階段，依序完成。每個使用情境都仰賴共同基礎，所以從基礎開始；第五階段完成後，才會開放註冊。',
    },
    availableTitle: '現在已可使用',
    availableLede: '現在已對所有本站訪客生效的內容。',
    horizons: {
      now: {
        title: '開發中',
        body: '目前正在建置的階段。',
      },
      next: {
        title: '接下來',
        body: '緊接在後的階段，建立在目前建置的基礎上。',
      },
      later: {
        title: '之後',
        body: '再之後的階段，帶來知識、代理程式、出版與正式上線。',
      },
    },
    milestones: {
      M4: {
        name: '共同基礎',
        body: '版本、語言與身分定義清楚；人、App 與代理程式使用同一帳號模型；編輯不會遺失你寫下的內容。',
      },
      M5: {
        name: '共用能力與安全',
        body: '沒有隱藏上限的完整清單、可安全重試的操作、完整匯出、檢舉與申訴，以及每個頁面共同遵循的規則。',
      },
      M6: {
        name: '最初四項使用情境',
        body: '以輕小說為先的系列追蹤、可完整帶走的書庫、小說連載，以及按發行版本找視覺小說，再透過輕小說與 ACGN Zone 呈現。',
      },
      M7: {
        name: '知識、代理程式與出版',
        body: '評論與修正、社群與 Wiki、世界觀建構、代理協定與首批代理程式、開發者入門，以及第一批上架的書籍與遊戲。',
      },
      M8: {
        name: '正式上線',
        body: '正式環境檢查、復原演練、安全準備與真實裝置上的無障礙驗證。完成後，開放註冊。',
      },
    },
    story: {
      title: '每個階段，都建立在前一步之上。',
      lede: '先打好基礎，因為每個使用情境都靠它支撐。',
    },
    stageOf: '第 {n} 階段，共 {total} 階段',
    more: '另有 {n} 項',
    columns: {
      title: '每項能力，都有自己的階段。',
      lede: '同一份計畫，依各階段的開發順序排列。',
    },
    statement: {
      text: '不列日期，是刻意的選擇。',
      body: '通過檢查，階段才算完成；隨著理解加深，功能也可能調整所屬階段。',
    },
    cta: {
      title: '開放註冊那天，收到通知。',
      body: '留下電子郵件，我們只會在開放註冊時通知你一次，不寄其他信件。',
    },
  },
  'zh-Hans': {
    meta: {
      title: 'REZICS 开发计划：现在、接下来与之后',
      description:
        '从基础到上线，共五个阶段。网站介绍的每项功能都有所属阶段，让你看清楚现在在做什么，接下来又是什么。',
    },
    hero: {
      title: '五个阶段走向上线，第一步已开始。',
      lede: '本站介绍的一切分属五个阶段，依次完成。每个使用场景都依赖共同基础，所以从基础开始；第五阶段完成后，才会开放注册。',
    },
    availableTitle: '现在已可使用',
    availableLede: '现在已对所有本站访客生效的内容。',
    horizons: {
      now: {
        title: '开发中',
        body: '目前正在开发的阶段。',
      },
      next: {
        title: '接下来',
        body: '紧接在后的阶段，建立在当前开发的基础上。',
      },
      later: {
        title: '之后',
        body: '再之后的阶段，带来知识、智能体、出版与正式上线。',
      },
    },
    milestones: {
      M4: {
        name: '共同基础',
        body: '版本、语言与身份定义清楚；人、App 与智能体使用同一账号模型；编辑不会丢失你写下的内容。',
      },
      M5: {
        name: '共享能力与安全',
        body: '没有隐藏上限的完整列表、可安全重试的操作、完整导出、举报与申诉，以及每个页面共同遵循的规则。',
      },
      M6: {
        name: '最初四项使用场景',
        body: '以轻小说为先的系列追踪、可完整带走的书库、小说连载，以及按发行版本找视觉小说，再通过轻小说与 ACGN Zone 展示。',
      },
      M7: {
        name: '知识、智能体与出版',
        body: '评论与修正、社区与 Wiki、世界观构建、智能体协议与首批智能体、开发者入门，以及第一批上架的图书与游戏。',
      },
      M8: {
        name: '正式上线',
        body: '生产环境检查、恢复演练、安全准备与真实设备上的无障碍验证。完成后，开放注册。',
      },
    },
    story: {
      title: '每个阶段，都建立在前一步之上。',
      lede: '先打好基础，因为每个使用场景都靠它支撑。',
    },
    stageOf: '第 {n} 阶段，共 {total} 阶段',
    more: '另有 {n} 项',
    columns: {
      title: '每项能力，都有自己的阶段。',
      lede: '同一份计划，按各阶段的开发顺序排列。',
    },
    statement: {
      text: '不列日期，是刻意的选择。',
      body: '通过检查，阶段才算完成；随着理解加深，功能也可能调整所属阶段。',
    },
    cta: {
      title: '开放注册那天，收到通知。',
      body: '留下电子邮箱，我们只会在开放注册时通知你一次，不发其他邮件。',
    },
  },
  ja: {
    meta: {
      title: 'REZICSロードマップ：開発中、次、その先',
      description:
        '基盤から公開までの5段階。紹介するすべての機能がどの段階にあるかを示し、今作っているものとその次がわかります。',
    },
    hero: {
      title: '公開まで5段階。最初の段階を進めています。',
      lede: 'このサイトの内容はすべて5つの段階に分かれ、順番に作ります。どの利用シーンも土台が必要なので、基盤から。第5段階が終わったら登録を開始します。',
    },
    availableTitle: '今使えるもの',
    availableLede: 'このサイトを訪れるすべての人に、すでに提供していること。',
    horizons: {
      now: {
        title: '開発中',
        body: '今、作っている段階です。',
      },
      next: {
        title: '次に取り組むこと',
        body: '今整えている基盤に続く、すぐ次の段階です。',
      },
      later: {
        title: 'その先',
        body: 'その後は、知識、エージェント、出版、そして公開へ進みます。',
      },
    },
    milestones: {
      M4: {
        name: '基盤',
        body: '版・言語・IDを正確に扱い、人・アプリ・エージェントに共通のアカウントモデルを用意。編集で書いた内容を失わせません。',
      },
      M5: {
        name: '共通機能と安全',
        body: '隠れた上限のない一覧、安全に再試行できる操作、丸ごとの書き出し、通報と異議申し立て、すべてのページに適用するルール。',
      },
      M6: {
        name: '最初の4つの利用シーン',
        body: 'ライトノベルから始めるシリーズ管理、持ち出せるライブラリ、小説連載、版から探すビジュアルノベル。それらをライトノベルとACGNのZoneで届けます。',
      },
      M7: {
        name: '知識・エージェント・出版',
        body: 'レビューと訂正、コミュニティとWiki、世界づくり、エージェントのプロトコルと最初のエージェント、開発者の導入支援、最初の本とゲームの販売。',
      },
      M8: {
        name: '公開',
        body: '本番環境の確認、復旧訓練、安全への備え、実機でのアクセシビリティ検証。その後、登録を開始します。',
      },
    },
    story: {
      title: '前の段階が、次を支える。',
      lede: 'どの利用シーンも基盤が必要だから、まずは土台から。',
    },
    stageOf: '全{total}段階のうち第{n}段階',
    more: 'ほか{n}件',
    columns: {
      title: 'すべての機能に、取り組む段階を。',
      lede: '同じ計画を、開発する段階の順に整理しました。',
    },
    statement: {
      text: '日付は、あえて決めていません。',
      body: '検証に通って初めて、その段階は完了です。学んだことに応じて、機能を別の段階に移すこともあります。',
    },
    cta: {
      title: '登録が始まる日に、お知らせ。',
      body: 'メールアドレスを残していただければ、登録開始時に一度だけお知らせします。それ以外のメールは送りません。',
    },
  },
  ko: {
    meta: {
      title: 'REZICS 로드맵: 지금, 다음, 그 이후',
      description:
        '기반 구축부터 출시까지 다섯 단계. 소개하는 모든 기능이 어느 단계에 속하는지 보여 주어 지금 만드는 것과 다음 순서를 확인할 수 있습니다.',
    },
    hero: {
      title: '출시까지 다섯 단계. 첫 단계가 진행 중입니다.',
      lede: '이 사이트의 모든 내용은 다섯 단계에 나뉘며 순서대로 만듭니다. 모든 사용 흐름이 기반 위에 서므로 기반부터 시작합니다. 다섯 번째 단계가 끝나면 가입을 엽니다.',
    },
    availableTitle: '지금 이용 가능',
    availableLede: '이 사이트를 방문하는 누구에게나 이미 적용되는 것들.',
    horizons: {
      now: {
        title: '개발 중',
        body: '지금 만들고 있는 단계입니다.',
      },
      next: {
        title: '다음 단계',
        body: '지금 다지는 기반 위에 바로 이어지는 단계들입니다.',
      },
      later: {
        title: '이후',
        body: '그 뒤에는 지식, 에이전트, 출판과 출시 단계가 이어집니다.',
      },
    },
    milestones: {
      M4: {
        name: '기반',
        body: '판본, 언어, 신원을 정확히 구분하고 사람·앱·에이전트에 같은 계정 모델을 적용합니다. 편집해도 쓴 내용을 잃지 않습니다.',
      },
      M5: {
        name: '공통 기능과 안전',
        body: '숨은 제한 없는 전체 목록, 재시도에도 안전한 작업, 빠짐없는 내보내기, 신고와 이의 제기, 모든 페이지에 적용되는 규칙.',
      },
      M6: {
        name: '첫 네 가지 사용 흐름',
        body: '라이트 노벨 중심의 시리즈 추적, 옮길 수 있는 서재, 웹소설, 출시 버전별 비주얼 노벨 탐색을 라이트 노벨과 ACGN Zone에서 선보입니다.',
      },
      M7: {
        name: '지식, 에이전트, 출판',
        body: '리뷰와 정정, 커뮤니티와 위키, 세계관 구축, 에이전트 프로토콜과 첫 에이전트, 개발자 시작 안내, 첫 책과 게임 판매.',
      },
      M8: {
        name: '출시',
        body: '운영 환경 점검, 복구 훈련, 안전 준비, 실제 기기에서의 접근성 검증을 마친 뒤 가입을 엽니다.',
      },
    },
    story: {
      title: '앞 단계가 다음 단계를 받칩니다.',
      lede: '모든 사용 흐름이 기반 위에 서므로 기반부터 다집니다.',
    },
    stageOf: '총 {total}단계 중 {n}단계',
    more: '외 {n}개',
    columns: {
      title: '모든 기능에 해당 단계를.',
      lede: '같은 계획을 단계별 개발 순서로 정리했습니다.',
    },
    statement: {
      text: '날짜를 적지 않은 데는 이유가 있습니다.',
      body: '검증을 통과해야 단계가 끝납니다. 새로 알게 된 것에 따라 기능이 다른 단계로 옮겨질 수 있습니다.',
    },
    cta: {
      title: '가입을 여는 날 알려 드립니다.',
      body: '이메일을 남겨 주시면 가입이 열릴 때 한 번만 알려 드립니다. 다른 메일은 보내지 않습니다.',
    },
  },
  de: {
    meta: {
      title: 'Die REZICS-Roadmap: jetzt, als Nächstes und später',
      description:
        'Fünf Etappen vom Fundament bis zum Start. Jede beschriebene Funktion gehört zu einer davon. So siehst du, woran wir jetzt arbeiten und was folgt.',
    },
    hero: {
      title: 'Fünf Etappen bis zum Start. Die erste läuft.',
      lede: 'Alles auf dieser Website gehört zu fünf Etappen, die wir nacheinander bauen. Zuerst das Fundament, auf dem alle Abläufe stehen. Nach der fünften Etappe öffnet die Registrierung.',
    },
    availableTitle: 'Heute verfügbar',
    availableLede: 'Was für alle Besucher dieser Website bereits funktioniert.',
    horizons: {
      now: {
        title: 'In Entwicklung',
        body: 'Die Etappe, an der wir gerade arbeiten.',
      },
      next: {
        title: 'Als Nächstes',
        body: 'Die direkt folgenden Etappen auf dem Fundament, das jetzt entsteht.',
      },
      later: {
        title: 'Später',
        body: 'Die Etappen danach bringen Wissen, Agenten, Vertrieb und den Start.',
      },
    },
    milestones: {
      M4: {
        name: 'Grundlagen',
        body: 'Präzise Ausgaben, Sprachen und Identitäten; ein Kontomodell für Menschen, Apps und Agenten; Bearbeitungen, bei denen nichts Geschriebenes verloren geht.',
      },
      M5: {
        name: 'Gemeinsame Funktionen und Sicherheit',
        body: 'Vollständige Listen ohne versteckte Grenzen, sichere Wiederholungen, lückenlose Exporte, Meldungen und Einsprüche sowie die Regeln für jede Seite.',
      },
      M6: {
        name: 'Die ersten vier Szenarien',
        body: 'Reihen verfolgen, beginnend mit Light Novels, die portable Bibliothek, Fortsetzungsromane und Visual Novels nach Fassung, erschlossen über Light-Novels- und ACGN-Zones.',
      },
      M7: {
        name: 'Wissen, Agenten und Vertrieb',
        body: 'Rezensionen und Korrekturen, Communitys und Wikis, Weltenbau, Agentenprotokoll samt ersten Agenten, Entwicklereinstieg und erste Bücher und Spiele im Verkauf.',
      },
      M8: {
        name: 'Start',
        body: 'Produktionsprüfungen, Wiederherstellungsübungen, Sicherheitsbereitschaft und Barrierefreiheit auf echten Geräten. Dann öffnet die Registrierung.',
      },
    },
    story: {
      title: 'Jede Etappe baut auf der vorherigen auf.',
      lede: 'Zuerst die Grundlagen, denn jeder Ablauf steht auf ihnen.',
    },
    stageOf: 'Etappe {n} von {total}',
    more: 'und {n} weitere',
    columns: {
      title: 'Jede Funktion in ihrer Etappe.',
      lede: 'Derselbe Plan, nach Reihenfolge der Etappen geordnet.',
    },
    statement: {
      text: 'Keine Termine, ganz bewusst.',
      body: 'Eine Etappe ist fertig, wenn ihre Prüfungen bestehen. Neue Erkenntnisse können Funktionen in andere Etappen verschieben.',
    },
    cta: {
      title: 'Am Tag der Öffnung Bescheid wissen.',
      body: 'Hinterlasse deine E-Mail-Adresse. Wir schreiben dir genau einmal, wenn die Registrierung öffnet. Sonst nichts.',
    },
  },
  fr: {
    meta: {
      title: 'La feuille de route REZICS : maintenant, ensuite, plus tard',
      description:
        'Cinq étapes, des fondations au lancement. Chaque fonction présentée appartient à l’une d’elles : vous voyez ce qui se construit et ce qui suivra.',
    },
    hero: {
      title: 'Cinq étapes avant le lancement. La première est en cours.',
      lede: 'Tout ce site se répartit en cinq étapes réalisées dans l’ordre. Les fondations viennent d’abord, car chaque parcours en dépend. Les inscriptions ouvriront à la fin de la cinquième étape.',
    },
    availableTitle: 'Disponible aujourd’hui',
    availableLede: 'Ce qui fonctionne déjà pour tous les visiteurs de ce site.',
    horizons: {
      now: {
        title: 'En développement',
        body: 'L’étape en cours de construction.',
      },
      next: {
        title: 'Ensuite',
        body: 'Les étapes qui suivent directement, sur les bases posées maintenant.',
      },
      later: {
        title: 'Plus tard',
        body: 'Les étapes suivantes apportent connaissances, agents, édition et lancement.',
      },
    },
    milestones: {
      M4: {
        name: 'Fondations',
        body: 'Éditions, langues et identités précises ; un modèle de compte commun aux humains, applications et agents ; des modifications qui ne perdent pas vos écrits.',
      },
      M5: {
        name: 'Fonctions communes et sécurité',
        body: 'Listes complètes sans limites cachées, opérations sûres à reprendre, exports intégraux, signalements et recours, et règles appliquées à chaque page.',
      },
      M6: {
        name: 'Les quatre premiers parcours',
        body: 'Suivi de séries avec les light novels, bibliothèque portable, feuilletons et visual novels par version, présentés dans les Zones Light novels et ACGN.',
      },
      M7: {
        name: 'Connaissances, agents et édition',
        body: 'Critiques et corrections, communautés et wikis, création d’univers, protocole et premiers agents, accueil des développeurs, premiers livres et jeux en vente.',
      },
      M8: {
        name: 'Lancement',
        body: 'Vérifications en production, exercices de reprise, préparation à la sécurité et accessibilité sur appareils réels. Puis les inscriptions ouvrent.',
      },
    },
    story: {
      title: 'Chaque étape repose sur la précédente.',
      lede: 'Les fondations d’abord : chaque parcours en dépend.',
    },
    stageOf: 'Étape {n} sur {total}',
    more: 'et {n} autres',
    columns: {
      title: 'Chaque fonction à son étape.',
      lede: 'Le même plan, classé par ordre de réalisation.',
    },
    statement: {
      text: 'Pas de dates, par choix.',
      body: 'Une étape est achevée quand ses vérifications passent. Ce que nous apprenons peut déplacer une fonction entre étapes.',
    },
    cta: {
      title: 'Soyez prévenu le jour de l’ouverture.',
      body: 'Laissez votre adresse e-mail. Nous vous écrirons une seule fois, à l’ouverture des inscriptions. Rien d’autre.',
    },
  },
  es: {
    meta: {
      title: 'La hoja de ruta de REZICS: ahora, después y más adelante',
      description:
        'Cinco etapas, de las bases al lanzamiento. Cada función pertenece a una de ellas para que veas qué se construye ahora y qué viene después.',
    },
    hero: {
      title: 'Cinco etapas hasta el lanzamiento. La primera está en marcha.',
      lede: 'Todo lo que describe este sitio pertenece a cinco etapas construidas en orden. Primero las bases, porque todos los recorridos dependen de ellas. El registro abre al terminar la quinta.',
    },
    availableTitle: 'Disponible hoy',
    availableLede: 'Lo que ya funciona para todos los visitantes de este sitio.',
    horizons: {
      now: {
        title: 'En desarrollo',
        body: 'La etapa que se está construyendo.',
      },
      next: {
        title: 'A continuación',
        body: 'Las etapas que siguen de inmediato, sobre las bases que se están creando.',
      },
      later: {
        title: 'Más adelante',
        body: 'Las etapas posteriores traen conocimiento, agentes, publicación y lanzamiento.',
      },
    },
    milestones: {
      M4: {
        name: 'Bases',
        body: 'Ediciones, idiomas e identidades precisas; un modelo de cuenta para personas, apps y agentes; ediciones que no pierden lo que escribiste.',
      },
      M5: {
        name: 'Funciones comunes y seguridad',
        body: 'Listas completas sin límites ocultos, operaciones que soportan reintentos, exportaciones íntegras, reportes y apelaciones, y reglas para cada página.',
      },
      M6: {
        name: 'Los cuatro primeros recorridos',
        body: 'Seguimiento de series empezando por novelas ligeras, biblioteca portable, ficción por entregas y novelas visuales por versión, con las Zones de novelas ligeras y ACGN.',
      },
      M7: {
        name: 'Conocimiento, agentes y publicación',
        body: 'Reseñas y correcciones, comunidades y wikis, creación de mundos, protocolo y primeros agentes, incorporación de desarrolladores y primeros libros y juegos a la venta.',
      },
      M8: {
        name: 'Lanzamiento',
        body: 'Comprobaciones de producción, simulacros de recuperación, preparación de seguridad y accesibilidad en dispositivos reales. Después abre el registro.',
      },
    },
    story: {
      title: 'Cada etapa se apoya en la anterior.',
      lede: 'Primero las bases, porque cada recorrido depende de ellas.',
    },
    stageOf: 'Etapa {n} de {total}',
    more: 'y {n} más',
    columns: {
      title: 'Cada función en su etapa.',
      lede: 'El mismo plan, ordenado por su etapa de desarrollo.',
    },
    statement: {
      text: 'No hay fechas, a propósito.',
      body: 'Una etapa termina cuando supera sus comprobaciones. Lo que aprendamos puede mover funciones entre etapas.',
    },
    cta: {
      title: 'Entérate el día que abra el registro.',
      body: 'Deja tu correo y te escribiremos una sola vez, cuando se abra el registro. Nada más.',
    },
  },
});
