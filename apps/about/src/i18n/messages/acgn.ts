import { defineCopy } from '../define.ts';
import type { LinePageCopy } from './page.ts';

export const acgn = defineCopy<LinePageCopy>({
  en: {
    meta: {
      title: 'Visual novels, anime and manga on REZICS: the release you can use',
      description:
        'Choose visual novels by language, platform and translation, track anime by the episode and manga by the chapter, and talk about them without spoilers past where you are.',
    },
    hero: {
      title: 'The release you can play. The episode you are on.',
      lede: 'Find a visual novel by the language, platform and translation you need, and see who translated it before you start. Track anime by the episode and manga by the chapter on one list, and never meet a spoiler from past where you are.',
    },
    story: {
      title: 'Choosing a visual novel, honestly.',
      lede: 'The same title can be three different experiences. REZICS shows which one you are getting.',
      steps: {
        releases: {
          title: 'Every release, side by side.',
          body: 'The original, the official translation and the fan patch each have their own row: language, platform, edition and date.',
        },
        provenance: {
          title: 'Who translated it, and from what.',
          body: 'A fan translation credits its group, says which version it was made from and how much of the game it covers.',
        },
        track: {
          title: 'Track it your way.',
          body: 'Routes for visual novels, episodes for anime, chapters for manga and volumes for novels, all on one list.',
        },
        discuss: {
          title: 'Talk without spoiling.',
          body: 'Discussion, tags and wiki pages hold back anything past the route, episode or chapter you have reached.',
        },
      },
    },
    showcase: {
      title: 'For people who watch, read and play.',
      lede: 'Anime, comics, games and novels share one catalogue, so an adaptation is always a link away from its source.',
      tiles: {
        season: {
          title: 'This season',
          body: 'Next unwatched episodes and new releases across everything you follow.',
        },
        adaptations: {
          title: 'Adaptations, connected',
          body: 'The novel, the manga and the anime of one story, linked, without the anime spoiling the books.',
        },
        credits: {
          title: 'Credits that mean something',
          body: 'Every credit names the person, the role, the release and, for voice work, the character.',
        },
        zone: {
          title: 'The ACGN Zone',
          body: 'Seasons, releases and discussion over the same catalogue as every other Zone.',
        },
      },
    },
    compare: {
      title: 'Less detective work, more playing.',
      lede: 'Finding a usable release should not mean reading four forum threads.',
      today: 'Today',
      rezics: 'On REZICS',
      rows: {
        threads: {
          today: 'Forum threads to learn whether a patch is complete',
          rezics: 'Coverage and translator on the release itself',
        },
        lists: {
          today: 'One site for anime, another for novels',
          rezics: 'One list, each medium in its own units',
        },
        spoilers: {
          today: 'Tags that spoil the last route',
          rezics: 'Tags and pages that stop where you are',
        },
        titles: {
          today: 'Titles forced into one language',
          rezics: 'Every title in its own language, with aliases',
        },
      },
    },
    statement: {
      text: 'Choose by language, platform and translation, not by title alone.',
      body: 'Visual-novel discovery by usable release is one of the four first scenarios, and anime and manga tracking share its foundations.',
    },
    ledger: {
      title: 'Visual novels, anime and manga on REZICS',
    },
    cta: {
      title: 'Start your list on day one.',
      body: 'Leave your email and we will write once, when registration opens.',
    },
  },
  'zh-Hant': {
    meta: {
      title: 'REZICS 視覺小說、動畫與漫畫：找到能玩的版本',
      description:
        '依語言、平台與翻譯挑選視覺小說，動畫逐集追、漫畫逐話記，同一處討論，也不怕超過進度的暴雷。',
    },
    hero: {
      title: '找到能玩的版本，記住追到哪一集。',
      lede: '按需要的語言、平台與翻譯找視覺小說，開玩前就知道譯者是誰。動畫按集、漫畫按話，記在同一份清單，不會看到超過目前進度的暴雷。',
    },
    story: {
      title: '選視覺小說，資訊要看得明白。',
      lede: '同一個名稱，可能是三種不同體驗。REZICS 讓你看清楚選的是哪一種。',
      steps: {
        releases: {
          title: '所有發行版本，並排比較。',
          body: '原版、官方譯版與同好翻譯補丁各有一列，列出語言、平台、版本與日期。',
        },
        provenance: {
          title: '誰翻譯的，依據哪個版本。',
          body: '同好翻譯會署名團隊，說明依據的版本，以及涵蓋多少遊戲內容。',
        },
        track: {
          title: '照自己的方式記進度。',
          body: '視覺小說按路線、動畫按集、漫畫按話、小說按冊，都在同一份清單。',
        },
        discuss: {
          title: '放心聊，不暴雷。',
          body: '討論、標籤與 Wiki 頁面都會隱藏超過你目前路線、集數或章節的內容。',
        },
      },
    },
    showcase: {
      title: '給追番、看書、玩遊戲的你。',
      lede: '動畫、漫畫、遊戲與小說共用同一份目錄，改編作與原作之間，只隔著一個連結。',
      tiles: {
        season: {
          title: '本季新番',
          body: '追蹤作品的下一集待看內容與最新發行，集中掌握。',
        },
        adaptations: {
          title: '改編作品，彼此相連',
          body: '同一個故事的小說、漫畫與動畫相互連結，動畫內容也不會暴雷你還沒讀到的書。',
        },
        credits: {
          title: '創作人員，記得清楚',
          body: '每筆署名都列出人物、職務與發行版本，配音還會註明角色。',
        },
        zone: {
          title: 'ACGN Zone',
          body: '季度、發行資訊與討論，和其他 Zone 共用同一份目錄。',
        },
      },
    },
    compare: {
      title: '少花時間查資料，多留時間玩。',
      lede: '找一個能玩的版本，不該先爬完四篇討論串。',
      today: '目前的做法',
      rezics: '在 REZICS',
      rows: {
        threads: {
          today: '爬討論串才知道補丁有沒有翻完',
          rezics: '發行頁面直接標出翻譯範圍與譯者',
        },
        lists: {
          today: '動畫一個網站，小說另一個',
          rezics: '同一份清單，各種媒介各用自己的單位',
        },
        spoilers: {
          today: '標籤直接暴雷最後一條路線',
          rezics: '標籤與頁面只顯示到你的進度',
        },
        titles: {
          today: '作品名稱被迫統一成一種語言',
          rezics: '各語言名稱分別保留，也收錄別名',
        },
      },
    },
    statement: {
      text: '不只看名稱，也看語言、平台與翻譯。',
      body: '尋找能遊玩的視覺小說版本，是最初四項使用情境之一；動畫與漫畫的進度追蹤，也共用這套基礎。',
    },
    ledger: {
      title: 'REZICS 視覺小說、動畫與漫畫',
    },
    cta: {
      title: '開放第一天，就建立你的清單。',
      body: '留下電子郵件，我們會在開放註冊時通知你一次。',
    },
  },
  'zh-Hans': {
    meta: {
      title: 'REZICS 视觉小说、动画与漫画：找到能玩的版本',
      description:
        '按语言、平台与翻译挑选视觉小说，动画逐集追、漫画逐话记，同一处讨论，也不怕超过进度的剧透。',
    },
    hero: {
      title: '找到能玩的版本，记住追到哪一集。',
      lede: '按需要的语言、平台与翻译找视觉小说，开玩前就知道译者是谁。动画按集、漫画按话，记在同一份清单，不会看到超过当前进度的剧透。',
    },
    story: {
      title: '选视觉小说，信息要看得明白。',
      lede: '同一个名称，可能是三种不同体验。REZICS 让你看清楚选的是哪一种。',
      steps: {
        releases: {
          title: '所有发行版本，并排比较。',
          body: '原版、官方译版与同好翻译补丁各有一行，列出语言、平台、版本与日期。',
        },
        provenance: {
          title: '谁翻译的，依据哪个版本。',
          body: '同好翻译会署名团队，说明依据的版本，以及涵盖多少游戏内容。',
        },
        track: {
          title: '照自己的方式记进度。',
          body: '视觉小说按路线、动画按集、漫画按话、小说按卷，都在同一份清单。',
        },
        discuss: {
          title: '放心聊，不剧透。',
          body: '讨论、标签与 Wiki 页面都会隐藏超过你当前路线、集数或章节的内容。',
        },
      },
    },
    showcase: {
      title: '给追番、看书、玩游戏的你。',
      lede: '动画、漫画、游戏与小说共用同一份目录，改编作与原作之间，只隔着一个链接。',
      tiles: {
        season: {
          title: '本季新番',
          body: '追踪作品的下一集待看内容与最新发行，集中掌握。',
        },
        adaptations: {
          title: '改编作品，彼此相连',
          body: '同一个故事的小说、漫画与动画相互连接，动画内容也不会剧透你还没读到的书。',
        },
        credits: {
          title: '创作人员，记得清楚',
          body: '每条署名都列出人物、职务与发行版本，配音还会注明角色。',
        },
        zone: {
          title: 'ACGN Zone',
          body: '季度、发行信息与讨论，和其他 Zone 共用同一份目录。',
        },
      },
    },
    compare: {
      title: '少花时间查资料，多留时间玩。',
      lede: '找一个能玩的版本，不该先爬完四篇讨论帖。',
      today: '目前的做法',
      rezics: '在 REZICS',
      rows: {
        threads: {
          today: '翻讨论帖才知道补丁有没有翻完',
          rezics: '发行页面直接标出翻译范围与译者',
        },
        lists: {
          today: '动画一个网站，小说另一个',
          rezics: '同一份清单，各种媒介各用自己的单位',
        },
        spoilers: {
          today: '标签直接剧透最后一条路线',
          rezics: '标签与页面只显示到你的进度',
        },
        titles: {
          today: '作品名称被迫统一成一种语言',
          rezics: '各语言名称分别保留，也收录别名',
        },
      },
    },
    statement: {
      text: '不只看名称，也看语言、平台与翻译。',
      body: '寻找能游玩的视觉小说版本，是最初四项使用场景之一；动画与漫画的进度追踪，也共用这套基础。',
    },
    ledger: {
      title: 'REZICS 视觉小说、动画与漫画',
    },
    cta: {
      title: '开放第一天，就建立你的清单。',
      body: '留下电子邮箱，我们会在开放注册时通知你一次。',
    },
  },
  ja: {
    meta: {
      title: 'REZICSのビジュアルノベル・アニメ・マンガ：遊べる版を見つける',
      description:
        '言語、対応機種、翻訳でビジュアルノベルを選び、アニメもマンガも話数で記録。まだ見ていない先のネタバレを避けて語れます。',
    },
    hero: {
      title: '遊べる版を探す。観た話数を覚えておく。',
      lede: '言語、対応機種、翻訳でビジュアルノベルを探し、始める前に訳者を確認。アニメは話数、マンガは章ごとに同じリストで記録でき、今の進み具合より先のネタバレには出会いません。',
    },
    story: {
      title: '納得して選ぶ、ビジュアルノベル。',
      lede: '同じタイトルでも、体験は3通りかもしれません。REZICSなら、どれを選ぶのかがわかります。',
      steps: {
        releases: {
          title: '発売された版を、横に並べて。',
          body: '原版、公式翻訳、ファン翻訳パッチを別々の行に。言語、対応機種、版、日付を並べます。',
        },
        provenance: {
          title: '誰が、どの版から訳したか。',
          body: 'ファン翻訳にはグループ名、翻訳元の版、ゲームのどこまで訳したかを明記します。',
        },
        track: {
          title: '進み具合を、自分の単位で。',
          body: 'ビジュアルノベルはルート、アニメは話数、マンガは章、小説は巻。同じリストで記録できます。',
        },
        discuss: {
          title: 'ネタバレせずに、語り合う。',
          body: '議論、タグ、Wikiは、到達したルートや話数、章より先の情報を伏せます。',
        },
      },
    },
    showcase: {
      title: '観る人、読む人、遊ぶ人へ。',
      lede: 'アニメ、マンガ、ゲーム、小説を共通のカタログに。原作とそのアレンジ作品は、リンクひとつで行き来できます。',
      tiles: {
        season: {
          title: '今期の作品',
          body: 'フォロー中の作品の、次に観る話と新たな発売情報をまとめて。',
        },
        adaptations: {
          title: '原作とメディア展開がつながる',
          body: '同じ物語の小説、マンガ、アニメをつなぎます。アニメの情報で、まだ読んでいない本の先を知ってしまうこともありません。',
        },
        credits: {
          title: 'クレジットを、正確に',
          body: '人物、担当、参加した版を明記。声の出演には演じたキャラクターも記録します。',
        },
        zone: {
          title: 'ACGN Zone',
          body: 'シーズン、発売情報、議論を、ほかのZoneと同じカタログから。',
        },
      },
    },
    compare: {
      title: '探す手間を減らして、遊ぶ時間を。',
      lede: '遊べる版を探すだけで、掲示板のスレッドを4本も読み込まなくていいように。',
      today: '今のやり方',
      rezics: 'REZICSなら',
      rows: {
        threads: {
          today: 'パッチが完訳か、掲示板で探す',
          rezics: '版のページで翻訳範囲と訳者を確認',
        },
        lists: {
          today: 'アニメと小説で別のサイト',
          rezics: 'ひとつのリストで、媒体ごとの単位を使える',
        },
        spoilers: {
          today: 'タグで最終ルートのネタバレ',
          rezics: 'タグもページも、進んだところまで',
        },
        titles: {
          today: 'タイトルがひとつの言語に統一される',
          rezics: '各言語のタイトルと別名を保持',
        },
      },
    },
    statement: {
      text: 'タイトルだけでなく、言語・対応機種・翻訳で選ぶ。',
      body: '遊べる版からビジュアルノベルを探すことは、最初の4つの利用シーンのひとつ。アニメとマンガの進捗管理も同じ土台を使います。',
    },
    ledger: {
      title: 'REZICSのビジュアルノベル・アニメ・マンガ',
    },
    cta: {
      title: '初日から、自分のリストを。',
      body: 'メールアドレスを残していただければ、登録開始時に一度だけお知らせします。',
    },
  },
  ko: {
    meta: {
      title: 'REZICS 비주얼 노벨·애니·만화: 즐길 수 있는 버전 찾기',
      description:
        '언어, 플랫폼, 번역으로 비주얼 노벨을 고르고 애니메이션과 만화를 회차별로 기록하세요. 아직 보지 않은 내용의 스포일러 없이 이야기할 수 있습니다.',
    },
    hero: {
      title: '즐길 수 있는 버전, 보고 있는 회차.',
      lede: '필요한 언어, 플랫폼, 번역으로 비주얼 노벨을 찾고 시작 전에 번역자를 확인하세요. 애니메이션과 만화를 회차별로 한 목록에 기록하고, 현재 진도 뒤의 스포일러는 보지 않습니다.',
    },
    story: {
      title: '알고 고르는 비주얼 노벨.',
      lede: '같은 제목도 세 가지 다른 경험일 수 있습니다. REZICS는 무엇을 고르는지 분명히 보여 줍니다.',
      steps: {
        releases: {
          title: '출시 버전을 나란히 비교하세요.',
          body: '원판, 정식 번역판, 팬 번역 패치를 각각 한 행에 놓고 언어, 플랫폼, 판본, 날짜를 표시합니다.',
        },
        provenance: {
          title: '누가, 어떤 버전을 번역했는지.',
          body: '팬 번역에는 팀 이름, 번역의 바탕이 된 버전, 게임의 어느 부분까지 번역했는지를 밝힙니다.',
        },
        track: {
          title: '내 방식으로 진도를 기록하세요.',
          body: '비주얼 노벨은 루트, 애니메이션은 에피소드, 만화는 화, 소설은 권 단위로 한 목록에 기록합니다.',
        },
        discuss: {
          title: '스포일러 없이 이야기하세요.',
          body: '토론, 태그, 위키는 도달한 루트나 회차, 장 이후의 내용을 숨깁니다.',
        },
      },
    },
    showcase: {
      title: '보고, 읽고, 플레이하는 모두에게.',
      lede: '애니메이션, 만화, 게임, 소설이 같은 작품 목록을 씁니다. 각색 작품과 원작을 링크 하나로 오갈 수 있습니다.',
      tiles: {
        season: {
          title: '이번 시즌',
          body: '팔로우하는 작품의 다음 미시청 에피소드와 새 출시 소식을 한곳에서 봅니다.',
        },
        adaptations: {
          title: '각색 작품을 연결해요',
          body: '같은 이야기의 소설, 만화, 애니메이션이 이어집니다. 애니메이션 정보가 아직 읽지 않은 책의 내용을 스포일러하지 않습니다.',
        },
        credits: {
          title: '참여자를 정확하게',
          body: '모든 크레딧에 사람, 담당 역할, 출시 버전을 명시하고, 성우는 배역까지 표시합니다.',
        },
        zone: {
          title: 'ACGN Zone',
          body: '시즌, 출시 정보, 토론을 다른 Zone과 같은 작품 목록에서 모읍니다.',
        },
      },
    },
    compare: {
      title: '찾아보는 시간은 줄이고, 즐기는 시간은 늘리고.',
      lede: '플레이할 수 있는 버전 하나 찾으려고 게시글 네 개를 정독할 필요는 없어야죠.',
      today: '지금은',
      rezics: 'REZICS에서는',
      rows: {
        threads: {
          today: '패치 완역 여부를 게시판에서 찾음',
          rezics: '출시 정보에 번역 범위와 번역자 표시',
        },
        lists: {
          today: '애니와 소설을 다른 사이트에서 관리',
          rezics: '한 목록에서 매체별 단위로 기록',
        },
        spoilers: {
          today: '마지막 루트를 스포일러하는 태그',
          rezics: '태그와 페이지도 내 진도까지만',
        },
        titles: {
          today: '제목을 한 언어로만 표시',
          rezics: '각 언어의 제목과 별칭을 보존',
        },
      },
    },
    statement: {
      text: '제목뿐 아니라 언어, 플랫폼, 번역으로 고르세요.',
      body: '플레이할 수 있는 버전으로 비주얼 노벨을 찾는 일은 첫 네 가지 사용 흐름 중 하나입니다. 애니메이션과 만화 진도 기록도 같은 기반을 씁니다.',
    },
    ledger: {
      title: 'REZICS 비주얼 노벨·애니·만화',
    },
    cta: {
      title: '첫날부터 내 목록을 만들어 보세요.',
      body: '이메일을 남겨 주시면 가입이 열릴 때 한 번만 알려 드립니다.',
    },
  },
  de: {
    meta: {
      title: 'Visual Novels, Anime und Manga auf REZICS: die passende Fassung',
      description:
        'Visual Novels nach Sprache, Plattform und Übersetzung wählen, Anime nach Folgen und Manga nach Kapiteln verfolgen und ohne Spoiler über den eigenen Stand hinaus diskutieren.',
    },
    hero: {
      title: 'Die spielbare Fassung. Die aktuelle Folge.',
      lede: 'Finde Visual Novels nach Sprache, Plattform und Übersetzung und erfahre vorab, wer übersetzt hat. Halte Anime-Folgen und Manga-Kapitel auf einer Liste fest, ohne Spoiler über deinen Stand hinaus.',
    },
    story: {
      title: 'Visual Novels mit offenen Karten wählen.',
      lede: 'Ein Titel kann drei unterschiedliche Erlebnisse bedeuten. REZICS zeigt dir, welches du bekommst.',
      steps: {
        releases: {
          title: 'Alle Veröffentlichungen nebeneinander.',
          body: 'Original, offizielle Übersetzung und Fanpatch haben je eine Zeile mit Sprache, Plattform, Ausgabe und Datum.',
        },
        provenance: {
          title: 'Wer übersetzt hat und auf welcher Grundlage.',
          body: 'Eine Fanübersetzung nennt die Gruppe, ihre Ausgangsversion und wie viel vom Spiel übersetzt ist.',
        },
        track: {
          title: 'Fortschritt so festhalten, wie du ihn erlebst.',
          body: 'Routen für Visual Novels, Folgen für Anime, Kapitel für Manga und Bände für Romane, alles auf einer Liste.',
        },
        discuss: {
          title: 'Reden ohne Spoiler.',
          body: 'Diskussionen, Tags und Wikiseiten halten alles zurück, was nach deiner Route, Folge oder deinem Kapitel liegt.',
        },
      },
    },
    showcase: {
      title: 'Für alle, die schauen, lesen und spielen.',
      lede: 'Anime, Comics, Spiele und Romane teilen einen Katalog. Eine Adaption ist immer nur einen Link von ihrer Vorlage entfernt.',
      tiles: {
        season: {
          title: 'Diese Saison',
          body: 'Die nächsten ungesehenen Folgen und Neuerscheinungen von allem, dem du folgst.',
        },
        adaptations: {
          title: 'Adaptionen, miteinander verbunden',
          body: 'Roman, Manga und Anime derselben Geschichte sind verknüpft, ohne dass der Anime die Bücher spoilert.',
        },
        credits: {
          title: 'Mitwirkende mit klarem Beitrag',
          body: 'Jeder Credit nennt Person, Aufgabe und Veröffentlichung, bei Stimmen auch die Figur.',
        },
        zone: {
          title: 'Die ACGN-Zone',
          body: 'Saisons, Veröffentlichungen und Diskussionen aus demselben Katalog wie alle anderen Zones.',
        },
      },
    },
    compare: {
      title: 'Weniger Detektivarbeit, mehr Spielen.',
      lede: 'Eine spielbare Fassung zu finden sollte keine vier Forenthreads erfordern.',
      today: 'Heute',
      rezics: 'Auf REZICS',
      rows: {
        threads: {
          today: 'In Foren nachsehen, ob der Patch vollständig ist',
          rezics: 'Umfang und Übersetzer direkt an der Veröffentlichung',
        },
        lists: {
          today: 'Eine Seite für Anime, eine andere für Romane',
          rezics: 'Eine Liste, jedes Medium in seinen Einheiten',
        },
        spoilers: {
          today: 'Tags verraten die letzte Route',
          rezics: 'Tags und Seiten bis zu deinem Stand',
        },
        titles: {
          today: 'Titel in eine Sprache gezwängt',
          rezics: 'Jeder Titel in seiner Sprache, mit Alternativnamen',
        },
      },
    },
    statement: {
      text: 'Nach Sprache, Plattform und Übersetzung wählen, nicht nur nach Titel.',
      body: 'Visual Novels über spielbare Fassungen zu finden gehört zu den ersten vier Szenarien. Anime- und Manga-Fortschritt nutzen dieselben Grundlagen.',
    },
    ledger: {
      title: 'Visual Novels, Anime und Manga auf REZICS',
    },
    cta: {
      title: 'Starte deine Liste gleich am ersten Tag.',
      body: 'Hinterlasse deine E-Mail-Adresse. Wir schreiben dir einmal, wenn die Registrierung öffnet.',
    },
  },
  fr: {
    meta: {
      title: 'Visual novels, anime et manga sur REZICS : la bonne version',
      description:
        'Choisissez un visual novel par langue, plateforme et traduction. Suivez anime et manga par épisode ou chapitre et discutez sans révélation au-delà de votre progression.',
    },
    hero: {
      title: 'La version jouable. L’épisode où vous en êtes.',
      lede: 'Trouvez un visual novel selon la langue, la plateforme et la traduction voulues, et connaissez le traducteur avant de commencer. Suivez anime par épisode et manga par chapitre sur une liste, sans spoiler au-delà de votre progression.',
    },
    story: {
      title: 'Choisir un visual novel en connaissance de cause.',
      lede: 'Un même titre peut offrir trois expériences différentes. REZICS vous montre laquelle vous choisissez.',
      steps: {
        releases: {
          title: 'Toutes les versions, côte à côte.',
          body: 'Original, traduction officielle et patch de fans ont chacun leur ligne : langue, plateforme, édition et date.',
        },
        provenance: {
          title: 'Qui a traduit, et à partir de quelle version.',
          body: 'Une traduction de fans crédite son équipe, précise sa version source et la portion du jeu traduite.',
        },
        track: {
          title: 'Suivez votre progression à votre façon.',
          body: 'Routes des visual novels, épisodes des anime, chapitres des manga et tomes des romans : une même liste.',
        },
        discuss: {
          title: 'Discuter sans divulgâcher.',
          body: 'Discussions, tags et pages wiki masquent ce qui dépasse la route, l’épisode ou le chapitre atteint.',
        },
      },
    },
    showcase: {
      title: 'Pour ceux qui regardent, lisent et jouent.',
      lede: 'Anime, BD, jeux et romans partagent un catalogue. Une adaptation n’est qu’à un lien de son œuvre d’origine.',
      tiles: {
        season: {
          title: 'Cette saison',
          body: 'Les prochains épisodes à voir et les nouvelles sorties de tout ce que vous suivez.',
        },
        adaptations: {
          title: 'Des adaptations reliées',
          body: 'Roman, manga et anime d’une même histoire sont reliés, sans que l’anime révèle la suite des livres.',
        },
        credits: {
          title: 'Des crédits précis',
          body: 'Chaque crédit nomme la personne, son rôle, la version et, pour les voix, le personnage.',
        },
        zone: {
          title: 'La Zone ACGN',
          body: 'Saisons, sorties et discussions sur le même catalogue que les autres Zones.',
        },
      },
    },
    compare: {
      title: 'Moins d’enquête, plus de jeu.',
      lede: 'Trouver une version jouable ne devrait pas demander de lire quatre fils de forum.',
      today: 'Aujourd’hui',
      rezics: 'Sur REZICS',
      rows: {
        threads: {
          today: 'Chercher sur les forums si le patch est complet',
          rezics: 'Couverture et traducteur sur la fiche de version',
        },
        lists: {
          today: 'Un site pour les anime, un autre pour les romans',
          rezics: 'Une liste, les unités propres à chaque média',
        },
        spoilers: {
          today: 'Des tags qui révèlent la dernière route',
          rezics: 'Des tags et pages à votre progression',
        },
        titles: {
          today: 'Des titres forcés dans une seule langue',
          rezics: 'Chaque titre dans sa langue, avec ses variantes',
        },
      },
    },
    statement: {
      text: 'Choisir par langue, plateforme et traduction, au-delà du titre.',
      body: 'Trouver un visual novel par version jouable fait partie des quatre premiers parcours. Le suivi des anime et manga repose sur les mêmes bases.',
    },
    ledger: {
      title: 'Visual novels, anime et manga sur REZICS',
    },
    cta: {
      title: 'Créez votre liste dès l’ouverture.',
      body: 'Laissez votre adresse e-mail. Nous vous écrirons une seule fois, à l’ouverture des inscriptions.',
    },
  },
  es: {
    meta: {
      title: 'Novelas visuales, anime y manga en REZICS: la versión que puedes disfrutar',
      description:
        'Elige novelas visuales por idioma, plataforma y traducción. Sigue anime por episodios y manga por capítulos, y coméntalos sin spoilers más allá de donde vas.',
    },
    hero: {
      title: 'La versión que puedes jugar. El episodio por el que vas.',
      lede: 'Busca novelas visuales por idioma, plataforma y traducción, y conoce al traductor antes de empezar. Registra anime por episodios y manga por capítulos en una lista, sin spoilers de lo que aún no has visto.',
    },
    story: {
      title: 'Elegir una novela visual con toda la información.',
      lede: 'Un mismo título puede ofrecer tres experiencias distintas. REZICS te muestra cuál estás eligiendo.',
      steps: {
        releases: {
          title: 'Todos los lanzamientos, lado a lado.',
          body: 'Original, traducción oficial y parche de fans tienen su propia fila: idioma, plataforma, edición y fecha.',
        },
        provenance: {
          title: 'Quién tradujo y a partir de qué versión.',
          body: 'Una traducción de fans acredita al grupo, indica su versión de origen y cuánto del juego abarca.',
        },
        track: {
          title: 'Registra el progreso a tu manera.',
          body: 'Rutas de novelas visuales, episodios de anime, capítulos de manga y volúmenes de novelas, todo en una lista.',
        },
        discuss: {
          title: 'Habla sin spoilers.',
          body: 'Debates, etiquetas y páginas wiki ocultan lo que ocurre después de tu ruta, episodio o capítulo.',
        },
      },
    },
    showcase: {
      title: 'Para quienes ven, leen y juegan.',
      lede: 'Anime, cómics, juegos y novelas comparten catálogo: cada adaptación está a un enlace de su obra original.',
      tiles: {
        season: {
          title: 'Esta temporada',
          body: 'Los próximos episodios sin ver y los nuevos lanzamientos de todo lo que sigues.',
        },
        adaptations: {
          title: 'Adaptaciones conectadas',
          body: 'La novela, el manga y el anime de una historia se conectan sin que el anime destripe los libros.',
        },
        credits: {
          title: 'Créditos que dicen quién hizo qué',
          body: 'Cada crédito indica persona, función y lanzamiento, y en el doblaje, también el personaje.',
        },
        zone: {
          title: 'La Zone ACGN',
          body: 'Temporadas, lanzamientos y debates sobre el mismo catálogo que las demás Zones.',
        },
      },
    },
    compare: {
      title: 'Menos investigar, más jugar.',
      lede: 'Encontrar una versión que puedas jugar no debería exigir leer cuatro hilos de foro.',
      today: 'Hoy',
      rezics: 'En REZICS',
      rows: {
        threads: {
          today: 'Buscar en foros si el parche está completo',
          rezics: 'Cobertura y traductor en la propia ficha',
        },
        lists: {
          today: 'Un sitio para anime, otro para novelas',
          rezics: 'Una lista con las unidades de cada medio',
        },
        spoilers: {
          today: 'Etiquetas que destripan la última ruta',
          rezics: 'Etiquetas y páginas hasta donde vas',
        },
        titles: {
          today: 'Títulos forzados a un solo idioma',
          rezics: 'Cada título en su idioma, con sus alias',
        },
      },
    },
    statement: {
      text: 'Elige por idioma, plataforma y traducción, no solo por el título.',
      body: 'Encontrar novelas visuales por versiones jugables es uno de los cuatro primeros recorridos. El seguimiento de anime y manga comparte sus bases.',
    },
    ledger: {
      title: 'Novelas visuales, anime y manga en REZICS',
    },
    cta: {
      title: 'Empieza tu lista desde el primer día.',
      body: 'Deja tu correo y te escribiremos una sola vez, cuando se abra el registro.',
    },
  },
});
