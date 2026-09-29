import { defineCopy } from '../define.ts';

/** A home section's heading and lede. */
interface Section {
  title: string;
  lede: string;
}

export interface HomeCopy {
  meta: { title: string; description: string };
  hero: { title: string; lede: string; primary: string; secondary: string };
  /** What the hero's deck shows, for people who cannot see it. */
  heroPicture: string;
  /** Message one: a work's details in the language you read. */
  language: Section;
  /** Message two: the whole community around a story. */
  community: Section;
  /** Message three: fans of one story from every platform, together. */
  together: Section;
  /** Every kind of story, from the same parts. */
  kinds: Section;
  lines: Section;
  why: Section;
  glance: Section & { link: string };
  cta: { title: string; body: string };
}

export const home = defineCopy<HomeCopy>({
  en: {
    meta: {
      title: 'REZICS: every story, every language, one home',
      description:
        'Web novels, light novels, books, visual novels, anime, manga, games and more, each with a complete page in the language you read, a whole community around it, and fans from every platform in one place.',
    },
    hero: {
      title: 'Every story. Every language. One home.',
      lede: 'Web novels and light novels, books and visual novels, anime, manga and games, even AI prompts and recipes. REZICS gives each one a complete home, shows it in the language you read, and brings together everyone who loves it, wherever they found it.',
      primary: 'Get notified',
      secondary: 'See the roadmap',
    },
    heroPicture:
      'A deck of stories of every kind: a light novel, a visual novel, a web serial, an anime, a manga, a game, an AI prompt and a recipe, each named in the several languages it is read in.',
    language: {
      title: 'Don’t read Japanese? It doesn’t matter.',
      lede: 'REZICS keeps a work’s details in the language they were written in, from titles and synopsis to credits, tags, editions and releases, and presents them in English or in any language you read. Choose a language and watch the record change in place.',
    },
    community: {
      title: 'Want more from a story’s community? It’s all here.',
      lede: 'Discussion that knows where you are in the story, reviews, lists, wikis, moderation that explains itself, and one identity that goes with you everywhere. Move your place in the story and see what waits for you.',
    },
    together: {
      title: 'Bring fans together, beyond any one platform.',
      lede: 'One story is read as a web serial, bought as a light novel, watched as an anime and played as a game, in a dozen languages. On REZICS every version meets on one page, and everyone who loves it meets in one Realm.',
    },
    kinds: {
      title: 'One home for every kind of story.',
      lede: 'Every kind gets a complete page from the same parts, so a recipe is as well kept as a light novel, and each shows the facts that matter for it.',
    },
    lines: {
      title: 'Reading is one room. Here is the whole house.',
      lede: 'A library for readers, a studio for writers, wikis, Realms, agents and publishing share the same records, so a story, its translations, its wiki and its people are never more than a link apart.',
    },
    why: {
      title: 'Why REZICS',
      lede: 'Five commitments hold every part of it together.',
    },
    glance: {
      title: 'Where it is going',
      lede: 'Registration opens once the first scenarios work end to end: following a series across languages, a library you can take with you, serial fiction, and finding the visual-novel release you can play. This is the order the work happens in.',
      link: 'Read the roadmap',
    },
    cta: {
      title: 'Be there when the doors open.',
      body: 'Leave your email and we will write once, when registration opens. Nothing else.',
    },
  },
  'zh-Hant': {
    meta: {
      title: 'REZICS：所有故事、所有語言，共同的家',
      description:
        '網路小說、輕小說、書籍、視覺小說、動畫、漫畫、遊戲……每部作品都有完整的介紹，以你閱讀的語言呈現，還有完整的社群，讓來自各個平台的同好相聚。',
    },
    hero: {
      title: '所有故事。所有語言。共同的家。',
      lede: '網路小說與輕小說、書籍與視覺小說、動畫、漫畫、遊戲，甚至 AI 提示詞與食譜。REZICS 為每一種創作準備完整的家，以你閱讀的語言呈現；不論在哪裡遇見作品，喜愛它的人都能在此相聚。',
      primary: '開放時通知我',
      secondary: '查看開發規劃',
    },
    heroPicture:
      '一疊呈現各種故事的卡片：輕小說、視覺小說、網路連載、動畫、漫畫、遊戲、AI 提示詞與食譜，每張都列出讀者所用的多種語言名稱。',
    language: {
      title: '不懂日文？一樣看得懂作品資訊。',
      lede: 'REZICS 保留作品資訊的原文，從書名、簡介到創作人員、標籤、版本與發行資料，再以英文或你閱讀的語言呈現。選個語言，看看同一份資料如何切換。',
    },
    community: {
      title: '想和同好多聊一點？這裡都準備好了。',
      lede: '配合閱讀進度的討論、評論、清單、Wiki、有理有據的管理，以及走到哪裡都能使用的同一個身分。試著調整閱讀進度，看看哪些內容會出現。',
    },
    together: {
      title: '同好相聚，不受平台侷限。',
      lede: '同一個故事，有人追網路連載，有人買輕小說，有人看動畫、玩遊戲，使用的語言也各不相同。在 REZICS，各個版本匯聚在同一個頁面，喜愛它的人則在同一個社群相遇。',
    },
    kinds: {
      title: '每一種故事，都有自己的家。',
      lede: '各種作品都用同一套元素建立完整頁面：食譜和輕小說一樣受到用心整理，也各自呈現最重要的資訊。',
    },
    lines: {
      title: '閱讀只是起點，還有更多空間。',
      lede: '讀者的書庫、作者的工作室、Wiki、社群、代理程式與出版共用同一份資料。作品、譯本、百科與同好之間，永遠只隔著一個連結。',
    },
    why: {
      title: '為什麼選擇 REZICS',
      lede: '五項承諾，貫穿 REZICS 的每個角落。',
    },
    glance: {
      title: '接下來的路',
      lede: '跨語言追系列、能完整帶走的書庫、小說連載，以及尋找可遊玩的視覺小說版本：這幾項最初的使用情境完整打通後，才會開放註冊。以下是開發順序。',
      link: '閱讀開發規劃',
    },
    cta: {
      title: '開放那天，一起加入。',
      body: '留下電子郵件，我們只會在開放註冊時通知你一次，不寄其他信件。',
    },
  },
  'zh-Hans': {
    meta: {
      title: 'REZICS：所有故事、所有语言，共同的家',
      description:
        '网络小说、轻小说、图书、视觉小说、动画、漫画、游戏……每部作品都有完整的介绍，以你阅读的语言呈现，还有完整的社区，让来自各个平台的同好相聚。',
    },
    hero: {
      title: '所有故事。所有语言。共同的家。',
      lede: '网络小说与轻小说、图书与视觉小说、动画、漫画、游戏，甚至 AI 提示词与食谱。REZICS 为每一种创作准备完整的家，以你阅读的语言呈现；无论在哪里遇见作品，喜欢它的人都能在此相聚。',
      primary: '开放时通知我',
      secondary: '查看开发计划',
    },
    heroPicture:
      '一叠展示各种故事的卡片：轻小说、视觉小说、网络连载、动画、漫画、游戏、AI 提示词与食谱，每张都列出读者所用的多种语言名称。',
    language: {
      title: '不懂日语？一样看得懂作品信息。',
      lede: 'REZICS 保留作品信息的原文，从书名、简介到创作人员、标签、版本与发行资料，再以英语或你阅读的语言呈现。选个语言，看看同一份资料如何切换。',
    },
    community: {
      title: '想和同好多聊一点？这里都准备好了。',
      lede: '配合阅读进度的讨论、评论、清单、Wiki、有理有据的管理，以及走到哪里都能使用的同一个身份。试着调整阅读进度，看看哪些内容会出现。',
    },
    together: {
      title: '同好相聚，不受平台局限。',
      lede: '同一个故事，有人追网络连载，有人买轻小说，有人看动画、玩游戏，使用的语言也各不相同。在 REZICS，各个版本汇聚在同一个页面，喜欢它的人则在同一个社区相遇。',
    },
    kinds: {
      title: '每一种故事，都有自己的家。',
      lede: '各种作品都用同一套元素建立完整页面：食谱和轻小说一样受到用心整理，也各自展示最重要的信息。',
    },
    lines: {
      title: '阅读只是起点，还有更多空间。',
      lede: '读者的书库、作者的工作室、Wiki、社区、智能体与出版共用同一份资料。作品、译本、百科与同好之间，永远只隔着一个链接。',
    },
    why: {
      title: '为什么选择 REZICS',
      lede: '五项承诺，贯穿 REZICS 的每个角落。',
    },
    glance: {
      title: '接下来的路',
      lede: '跨语言追系列、能完整带走的书库、小说连载，以及寻找可游玩的视觉小说版本：这几项最初的使用场景完整打通后，才会开放注册。以下是开发顺序。',
      link: '阅读开发计划',
    },
    cta: {
      title: '开放那天，一起加入。',
      body: '留下电子邮箱，我们只会在开放注册时通知你一次，不发其他邮件。',
    },
  },
  ja: {
    meta: {
      title: 'REZICS：あらゆる物語を、あらゆる言語で。集まる場所はひとつ。',
      description:
        'Web小説、ライトノベル、本、ビジュアルノベル、アニメ、マンガ、ゲームまで。読める言語で作品の情報を知り、充実したコミュニティで、プラットフォームを越えてファンと出会えます。',
    },
    hero: {
      title: 'すべての物語。すべての言語。ひとつの居場所。',
      lede: 'Web小説やライトノベル、本やビジュアルノベル、アニメ、マンガ、ゲーム、さらにはAIプロンプトやレシピまで。REZICSはどの作品にも充実した居場所を用意し、あなたが読める言語で紹介します。出会った場所は違っても、好きな作品を通じてつながれます。',
      primary: '登録開始のお知らせを受け取る',
      secondary: 'ロードマップを見る',
    },
    heroPicture:
      'ライトノベル、ビジュアルノベル、Web連載、アニメ、マンガ、ゲーム、AIプロンプト、レシピのカード。それぞれ、読まれている複数の言語で名前が表示されています。',
    language: {
      title: '日本語が読めなくても、作品に出会える。',
      lede: 'タイトルやあらすじ、クレジット、タグ、版、発売情報。REZICSは作品の情報を元の言語のまま保管し、英語をはじめ、あなたが読める言語で表示します。言語を選ぶと、同じ作品の情報がその場で切り替わります。',
    },
    community: {
      title: '作品のコミュニティに、もっと欲しかったものを。',
      lede: '読んだところまで安心して話せる議論、レビュー、リスト、Wiki、理由がわかるモデレーション。そして、どこでも使えるひとつのプロフィール。読書の進み具合を動かして、見える内容の変化を確かめてください。',
    },
    together: {
      title: '好きでつながる。プラットフォームを越えて。',
      lede: 'Web連載で読み、ライトノベルを買い、アニメを観て、ゲームで遊ぶ。言語もさまざまです。REZICSでは同じ物語の各版がひとつのページにつながり、その作品を好きな人がひとつのコミュニティに集まります。',
    },
    kinds: {
      title: 'どんな物語にも、居場所がある。',
      lede: '共通の仕組みで、どの種類にも充実したページを。レシピもライトノベルと同じように丁寧に整理され、それぞれに必要な情報が並びます。',
    },
    lines: {
      title: '読書の先にも、広がる場所がある。',
      lede: '読者のライブラリ、書き手のスタジオ、Wiki、コミュニティ、エージェント、出版が同じ情報を共有します。作品も翻訳もWikiも人も、リンクひとつでつながっています。',
    },
    why: {
      title: 'REZICSが大切にすること',
      lede: 'すべてを支える、5つの約束。',
    },
    glance: {
      title: 'これからの道のり',
      lede: '言語をまたいだシリーズの追跡、持ち出せるライブラリ、小説の連載、遊べるビジュアルノベルの版探し。最初の利用シーンが最初から最後まで使えるようになってから、登録を開始します。開発はこの順に進めます。',
      link: 'ロードマップを読む',
    },
    cta: {
      title: '扉が開く日に、お会いしましょう。',
      body: 'メールアドレスを残していただければ、登録開始時に一度だけお知らせします。それ以外のメールは送りません。',
    },
  },
  ko: {
    meta: {
      title: 'REZICS: 모든 이야기, 모든 언어가 모이는 곳',
      description:
        '웹소설, 라이트 노벨, 책, 비주얼 노벨, 애니메이션, 만화, 게임까지. 읽을 수 있는 언어로 작품 정보를 살펴보고, 풍성한 커뮤니티에서 플랫폼을 넘어 팬들과 만납니다.',
    },
    hero: {
      title: '모든 이야기, 모든 언어가 모이는 곳.',
      lede: '웹소설과 라이트 노벨, 책과 비주얼 노벨, 애니메이션, 만화, 게임은 물론 AI 프롬프트와 레시피까지. REZICS는 모든 작품을 읽을 수 있는 언어로 소개하고, 작품에 필요한 모든 것을 한곳에 모읍니다. 어디서 처음 접했든 그 작품을 좋아하는 사람이라면 함께할 수 있습니다.',
      primary: '가입 시작 알림 받기',
      secondary: '로드맵 보기',
    },
    heroPicture:
      '라이트 노벨, 비주얼 노벨, 웹 연재, 애니메이션, 만화, 게임, AI 프롬프트, 레시피를 담은 카드 묶음. 각 카드에 독자들이 사용하는 여러 언어로 이름이 적혀 있습니다.',
    language: {
      title: '일본어를 몰라도 작품을 알아갈 수 있어요.',
      lede: 'REZICS는 제목과 줄거리부터 참여자, 태그, 판본, 출시 정보까지 원래 쓰인 언어로 보관하고, 영어를 비롯해 독자가 읽을 수 있는 언어로 보여 줍니다. 언어를 골라 같은 작품의 정보가 바뀌는 모습을 확인해 보세요.',
    },
    community: {
      title: '작품 커뮤니티에 바라던 것, 여기 다 있어요.',
      lede: '읽은 지점을 아는 토론, 리뷰, 목록, 위키, 이유를 설명하는 운영, 어디서나 이어지는 하나의 프로필까지. 읽은 지점을 바꾸며 어떤 내용이 나타나는지 살펴보세요.',
    },
    together: {
      title: '플랫폼을 넘어, 같은 작품을 좋아하는 사람들과.',
      lede: '누군가는 웹 연재로 읽고, 누군가는 라이트 노벨을 사고, 또 누군가는 애니메이션으로 보거나 게임으로 즐깁니다. 언어도 제각각이죠. REZICS에서는 한 이야기의 모든 버전이 한 페이지에서 만나고, 그 이야기를 좋아하는 사람들이 한 커뮤니티에 모입니다.',
    },
    kinds: {
      title: '어떤 이야기든 머물 곳이 있어요.',
      lede: '모든 유형의 작품은 같은 구성 요소로 완전한 페이지를 갖춥니다. 레시피도 라이트 노벨처럼 세심하게 정리되고, 각 유형에 필요한 정보를 보여 줍니다.',
    },
    lines: {
      title: '독서에서 시작해, 더 넓은 세상으로.',
      lede: '독자의 서재, 작가의 작업실, 위키, 커뮤니티, 에이전트, 출판이 같은 기록으로 연결됩니다. 이야기와 번역, 위키와 사람 사이를 링크 하나로 오갈 수 있습니다.',
    },
    why: {
      title: 'REZICS를 선택하는 이유',
      lede: '다섯 가지 약속이 REZICS의 모든 부분을 이어 줍니다.',
    },
    glance: {
      title: '앞으로의 계획',
      lede: '여러 언어로 시리즈를 따라가고, 서재를 통째로 옮기고, 소설을 연재하고, 플레이할 수 있는 비주얼 노벨 버전을 찾는 일. 이 첫 사용 흐름들이 처음부터 끝까지 작동하면 가입을 엽니다. 개발은 다음 순서로 진행합니다.',
      link: '로드맵 살펴보기',
    },
    cta: {
      title: '문을 여는 날, 함께해요.',
      body: '이메일을 남겨 주시면 가입이 열릴 때 한 번만 알려 드립니다. 다른 메일은 보내지 않습니다.',
    },
  },
  de: {
    meta: {
      title: 'REZICS: Jede Geschichte. Jede Sprache. Ein Zuhause.',
      description:
        'Webromane, Light Novels, Bücher, Visual Novels, Anime, Manga und Spiele: mit vollständigen Seiten in deiner Sprache und einer Community, die Fans über Plattformen hinweg verbindet.',
    },
    hero: {
      title: 'Jede Geschichte. Jede Sprache. Ein Zuhause.',
      lede: 'Webromane und Light Novels, Bücher und Visual Novels, Anime, Manga und Spiele, sogar KI-Prompts und Rezepte. REZICS gibt jedem davon ein vollständiges Zuhause in deiner Sprache und bringt alle zusammen, die es lieben – ganz gleich, wo sie es entdeckt haben.',
      primary: 'Zum Start benachrichtigen',
      secondary: 'Zur Roadmap',
    },
    heroPicture:
      'Ein Stapel mit Geschichten aller Art: Light Novel, Visual Novel, Webroman, Anime, Manga, Spiel, KI-Prompt und Rezept. Jede Karte zeigt den Namen in mehreren Sprachen ihrer Leserschaft.',
    language: {
      title: 'Kein Japanisch? Kein Hindernis.',
      lede: 'REZICS bewahrt Werkdaten in ihrer ursprünglichen Sprache auf: Titel, Inhaltsangabe, Mitwirkende, Tags, Ausgaben und Veröffentlichungen. Angezeigt werden sie auf Englisch oder in einer Sprache, die du liest. Wähle eine Sprache und sieh, wie sich der Eintrag direkt umstellt.',
    },
    community: {
      title: 'Mehr Raum für deine Fan-Community.',
      lede: 'Diskussionen passend zu deinem Lesestand, Rezensionen, Listen, Wikis, nachvollziehbare Moderation und ein Profil, das überall mitkommt. Verändere deinen Lesestand und entdecke, was auf dich wartet.',
    },
    together: {
      title: 'Fans zusammenbringen, über Plattformen hinweg.',
      lede: 'Eine Geschichte wird als Webroman gelesen, als Light Novel gekauft, als Anime geschaut und als Spiel erlebt – in vielen Sprachen. Auf REZICS treffen ihre Fassungen auf einer Seite zusammen und ihre Fans in einer Community.',
    },
    kinds: {
      title: 'Ein Zuhause für jede Art von Geschichte.',
      lede: 'Jede Art bekommt eine vollständige Seite aus denselben Bausteinen. So wird ein Rezept genauso sorgfältig gepflegt wie eine Light Novel, mit den jeweils wichtigen Angaben.',
    },
    lines: {
      title: 'Lesen ist ein Zimmer. Entdecke das ganze Haus.',
      lede: 'Bibliothek, Schreibstudio, Wikis, Communitys, Agenten und Veröffentlichung nutzen dieselben Einträge. Eine Geschichte, ihre Übersetzungen, ihr Wiki und ihre Menschen sind immer nur einen Link voneinander entfernt.',
    },
    why: {
      title: 'Warum REZICS',
      lede: 'Fünf Zusagen verbinden alle Teile von REZICS.',
    },
    glance: {
      title: 'Wohin es geht',
      lede: 'Die Registrierung öffnet, wenn die ersten Abläufe vollständig funktionieren: Reihen über Sprachen hinweg verfolgen, die Bibliothek mitnehmen, Fortsetzungsromane lesen und schreiben und eine spielbare Visual-Novel-Fassung finden. In dieser Reihenfolge bauen wir daran.',
      link: 'Roadmap lesen',
    },
    cta: {
      title: 'Sei dabei, wenn es losgeht.',
      body: 'Hinterlasse deine E-Mail-Adresse. Wir schreiben dir genau einmal, wenn die Registrierung öffnet. Sonst nichts.',
    },
  },
  fr: {
    meta: {
      title: 'REZICS : toutes les histoires, toutes les langues, un même lieu',
      description:
        'Romans web, light novels, livres, visual novels, anime, manga, jeux… Chaque œuvre a sa page dans votre langue et sa communauté, où se retrouvent les fans de toutes les plateformes.',
    },
    hero: {
      title: 'Toutes les histoires. Toutes les langues. Un même lieu.',
      lede: 'Romans web et light novels, livres et visual novels, anime, manga et jeux, mais aussi prompts d’IA et recettes. REZICS donne à chacun une place à part entière, dans votre langue, et réunit ceux qui l’aiment, quel que soit l’endroit où ils l’ont découvert.',
      primary: 'Être prévenu à l’ouverture',
      secondary: 'Voir la feuille de route',
    },
    heroPicture:
      'Un jeu de cartes : light novel, visual novel, roman web, anime, manga, jeu, prompt d’IA et recette. Chaque carte porte les noms de l’œuvre dans plusieurs langues de son public.',
    language: {
      title: 'Pas besoin de lire le japonais.',
      lede: 'REZICS conserve les informations d’une œuvre dans leur langue d’origine : titres, résumé, crédits, tags, éditions et sorties. Vous les consultez en anglais ou dans une langue que vous lisez. Choisissez une langue et regardez la fiche changer sur place.',
    },
    community: {
      title: 'Tout ce que vous attendez d’une communauté de fans.',
      lede: 'Des discussions qui respectent votre progression, des critiques, des listes, des wikis, une modération qui explique ses décisions et un même profil partout. Faites avancer votre lecture pour découvrir ce qui vous attend.',
    },
    together: {
      title: 'Réunir les fans, au-delà des plateformes.',
      lede: 'Une même histoire se lit en feuilleton, s’achète en light novel, se regarde en anime et se joue, dans une multitude de langues. Sur REZICS, toutes ses versions se rejoignent sur une page et tous ses fans dans une communauté.',
    },
    kinds: {
      title: 'Une place pour chaque forme d’histoire.',
      lede: 'Les mêmes éléments composent une page complète pour chaque type d’œuvre. Une recette reçoit autant de soin qu’un light novel, avec les informations qui lui sont propres.',
    },
    lines: {
      title: 'La lecture ouvre la porte. Découvrez toute la maison.',
      lede: 'Bibliothèque, atelier d’écriture, wikis, communautés, agents et édition partagent les mêmes fiches. Une histoire, ses traductions, son wiki et ses lecteurs ne sont jamais qu’à un lien les uns des autres.',
    },
    why: {
      title: 'Pourquoi REZICS',
      lede: 'Cinq engagements portent l’ensemble du projet.',
    },
    glance: {
      title: 'La suite du projet',
      lede: 'Les inscriptions ouvriront quand les premiers parcours fonctionneront de bout en bout : suivre une série entre langues, emporter sa bibliothèque, écrire et lire en feuilleton, trouver une version jouable d’un visual novel. Voici l’ordre des travaux.',
      link: 'Lire la feuille de route',
    },
    cta: {
      title: 'Soyez là dès l’ouverture.',
      body: 'Laissez votre adresse e-mail. Nous vous écrirons une seule fois, à l’ouverture des inscriptions. Rien d’autre.',
    },
  },
  es: {
    meta: {
      title: 'REZICS: todas las historias, todos los idiomas, un mismo hogar',
      description:
        'Novelas web, novelas ligeras, libros, novelas visuales, anime, manga y juegos: cada obra con su página completa en tu idioma y una comunidad que reúne a fans de todas las plataformas.',
    },
    hero: {
      title: 'Todas las historias. Todos los idiomas. Un mismo hogar.',
      lede: 'Novelas web y ligeras, libros y novelas visuales, anime, manga y juegos, e incluso prompts de IA y recetas. REZICS les da un hogar completo en el idioma que lees y reúne a quienes los disfrutan, dondequiera que los hayan descubierto.',
      primary: 'Avísame cuando abra',
      secondary: 'Ver la hoja de ruta',
    },
    heroPicture:
      'Una baraja de historias: novela ligera, novela visual, serial web, anime, manga, juego, prompt de IA y receta, cada una con su nombre en varios idiomas de su público.',
    language: {
      title: 'No necesitas saber japonés.',
      lede: 'REZICS conserva los datos de cada obra en su idioma original: títulos, sinopsis, créditos, etiquetas, ediciones y lanzamientos. Te los muestra en inglés o en un idioma que leas. Elige uno y mira cómo cambia la ficha sin salir de ella.',
    },
    community: {
      title: 'Más para la comunidad de tu historia.',
      lede: 'Debates que respetan por dónde vas, reseñas, listas, wikis, moderación que explica sus decisiones y un perfil que te acompaña a todas partes. Cambia tu punto de lectura y descubre lo que te espera.',
    },
    together: {
      title: 'Reúne a los fans más allá de cada plataforma.',
      lede: 'Una historia se lee por entregas, se compra como novela ligera, se ve como anime y se juega, en una docena de idiomas. En REZICS, todas sus versiones se reúnen en una página y sus fans en una comunidad.',
    },
    kinds: {
      title: 'Un hogar para cada tipo de historia.',
      lede: 'Cada tipo tiene una página completa hecha con los mismos elementos. Una receta se cuida tanto como una novela ligera, y cada una muestra los datos que le corresponden.',
    },
    lines: {
      title: 'La lectura es una habitación. Descubre toda la casa.',
      lede: 'La biblioteca, el estudio de escritura, los wikis, las comunidades, los agentes y la publicación comparten las mismas fichas. Una historia, sus traducciones, su wiki y su gente siempre están a un enlace de distancia.',
    },
    why: {
      title: 'Por qué REZICS',
      lede: 'Cinco compromisos sostienen todo el proyecto.',
    },
    glance: {
      title: 'Lo que viene',
      lede: 'El registro se abrirá cuando funcionen de principio a fin los primeros recorridos: seguir series entre idiomas, llevarte tu biblioteca, escribir y leer por entregas y encontrar una versión jugable de una novela visual. Este es el orden de desarrollo.',
      link: 'Consultar la hoja de ruta',
    },
    cta: {
      title: 'Nos vemos el día de la apertura.',
      body: 'Deja tu correo y te escribiremos una sola vez, cuando se abra el registro. Nada más.',
    },
  },
});
