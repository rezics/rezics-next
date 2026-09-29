import { defineCopy } from '../define.ts';
import type { LinePageCopy } from './page.ts';

export const wikis = defineCopy<LinePageCopy>({
  en: {
    meta: {
      title: 'Wikis and worldbuilding on REZICS: a wiki as deep as the story',
      description:
        'A wiki for every Work, where each fact cites its chapter and readers see only what they have read. Agents draft from sources, people review, and authors keep a world bible.',
    },
    hero: {
      title: 'A wiki as deep as the story.',
      lede: 'Every Work gets a wiki that grows with it: characters, places and relations, each fact citing the chapter it comes from, shown only as far as you have read. Agents draft from the sources. People decide what is published.',
    },
    story: {
      title: 'Watch a wiki grow, chapter by chapter.',
      lede: 'Each chapter adds what the story has revealed, and nothing more.',
      steps: {
        arrival: {
          title: 'Chapter 1: someone arrives.',
          body: 'A character steps into the story. Her page starts with one fact and the line it comes from.',
        },
        place: {
          title: 'Chapter 4: a place, a connection.',
          body: 'The archive enters the story. The wiki adds the place and links it to the people who keep it.',
        },
        relations: {
          title: 'Chapter 9: relations take shape.',
          body: 'Teacher, rival, sister: relations appear when the text states them, never guessed because two names share a page.',
        },
        reveal: {
          title: 'Chapter 12: a secret, held back.',
          body: 'The reveal is recorded with its chapter. Anyone who has not reached chapter 12 will not meet it on the page, in search or in the infobox.',
        },
      },
    },
    showcase: {
      title: 'For the fans who keep the record, and the authors who build the world.',
      lede: 'The same pages serve a Realm’s public wiki and an author’s private world bible.',
      tiles: {
        bible: {
          title: 'A world bible beside the draft',
          body: 'Characters, places, factions, items and lore, kept privately next to the manuscript.',
        },
        publish: {
          title: 'Publish the pages you choose',
          body: 'Turn selected pages into the Work’s wiki without exposing drafts or their history.',
        },
        maps: {
          title: 'Maps on your own art',
          body: 'Pin places on a map you drew. Every pin is in a list as well.',
        },
        timelines: {
          title: 'Timelines on invented calendars',
          body: 'Set events in your world’s own calendar, with uncertain dates allowed.',
        },
        relations: {
          title: 'Relationship maps',
          body: 'Families, alliances and rivalries as a graph, and as a list anyone can read.',
        },
        history: {
          title: 'History, review and export',
          body: 'Diffs and restore on every page, and the whole wiki exports in one piece.',
        },
      },
    },
    compare: {
      title: 'What a fan wiki becomes.',
      lede: 'The people who keep a story’s record deserve tools that keep it honest.',
      today: 'Today',
      rezics: 'On REZICS',
      rows: {
        spoilers: {
          today: 'Next season’s twist in this season’s infobox',
          rezics: 'Every page stops at the chapter you reached',
        },
        sources: {
          today: 'Facts nobody can trace',
          rezics: 'Each fact cites its chapter and edition',
        },
        generated: {
          today: 'Generated articles with invented citations',
          rezics: 'Agents propose sourced facts; people publish',
        },
        scattered: {
          today: 'Lore split across three writing apps',
          rezics: 'One world bible beside the manuscript',
        },
        leaving: {
          today: 'An export that leaves half the wiki behind',
          rezics: 'The whole wiki, exported and importable',
        },
      },
    },
    statement: {
      text: 'Agents propose. People decide. Every fact shows its source.',
      body: 'Fan wikis are right to reject generated articles. REZICS agents propose sourced facts and structure, and nothing reaches readers until a person has reviewed it. Each Realm decides whether agents may draft for it at all.',
    },
    ledger: {
      title: 'Wikis and worldbuilding on REZICS',
      lede: 'Each capability shows where it stands today.',
    },
    cta: {
      title: 'Start your world’s wiki when we open.',
      body: 'Leave your email and we will write once, when registration opens.',
    },
  },
  'zh-Hant': {
    meta: {
      title: 'REZICS Wiki 與世界觀：和故事一樣深的百科',
      description:
        '每部作品都有 Wiki，每條資訊引用章節，只顯示你已讀到的內容。代理程式依來源擬稿、人員審核，作者也能保存世界觀設定集。',
    },
    hero: {
      title: '和故事一樣深的 Wiki。',
      lede: '每部作品的 Wiki 都隨故事成長：人物、地點與關係，每條資訊引用出處章節，只顯示到你的閱讀進度。代理程式依據來源擬稿，是否發布由人決定。',
    },
    story: {
      title: '看 Wiki 隨章節一點點長大。',
      lede: '每一章，只加入故事已揭露的內容。',
      steps: {
        arrival: {
          title: '第 1 章：一個人的登場。',
          body: '角色走進故事，她的頁面從一條資訊與對應原文開始。',
        },
        place: {
          title: '第 4 章：一個地方，一份連結。',
          body: '書庫在故事中出現，Wiki 加入這個地點，並連結到守護它的人。',
        },
        relations: {
          title: '第 9 章：關係逐漸成形。',
          body: '老師、對手、姊妹：原文明說，才建立關係；不會只因兩個名字在同一頁，就自行推測。',
        },
        reveal: {
          title: '第 12 章：秘密揭曉，先不暴雷。',
          body: '揭曉的內容會連同章節記錄。還沒讀到第 12 章的人，不會在頁面、搜尋結果或資訊框裡撞見它。',
        },
      },
    },
    showcase: {
      title: '給整理故事的同好，也給創造世界的作者。',
      lede: '同一套頁面，既能做社群的公開 Wiki，也能做作者的私人世界觀設定集。',
      tiles: {
        bible: {
          title: '草稿旁的世界觀設定集',
          body: '人物、地點、陣營、物品與背景設定，私密保存在稿件旁。',
        },
        publish: {
          title: '只公開你選定的頁面',
          body: '把選定頁面轉為作品 Wiki，不會連帶公開草稿或修訂歷史。',
        },
        maps: {
          title: '用自己的圖，畫自己的地圖',
          body: '在自己畫的地圖上標記地點，每個標記也會列在清單中。',
        },
        timelines: {
          title: '以架空曆法編排時間線',
          body: '用故事世界的曆法安排事件，日期不確定也能記錄。',
        },
        relations: {
          title: '人物關係圖',
          body: '家族、同盟與敵對關係，能看成圖，也有人人能讀的清單。',
        },
        history: {
          title: '歷史、審核與匯出',
          body: '每頁都有差異比對與還原，整個 Wiki 也能完整匯出。',
        },
      },
    },
    compare: {
      title: '同好 Wiki，可以走得更遠。',
      lede: '為故事留下紀錄的人，值得擁有能確保資訊可信的工具。',
      today: '目前的做法',
      rezics: '在 REZICS',
      rows: {
        spoilers: {
          today: '本季資訊框，卻寫著下季大逆轉',
          rezics: '每頁只顯示到你讀過的章節',
        },
        sources: {
          today: '查不到出處的資訊',
          rezics: '每條資訊都引用章節與版本',
        },
        generated: {
          today: '自動生成文章，連引用都是編的',
          rezics: '代理程式提有來源的資訊，由人發布',
        },
        scattered: {
          today: '世界觀設定散在三個寫作 App',
          rezics: '一份世界觀設定集，就在稿件旁',
        },
        leaving: {
          today: '匯出了，卻漏掉半個 Wiki',
          rezics: '完整 Wiki 匯出，也能重新匯入',
        },
      },
    },
    statement: {
      text: '代理程式提案，由人決定。每條資訊都有出處。',
      body: '同好 Wiki 拒絕生成文章，有其道理。REZICS 的代理程式只提出有來源的資訊與結構，經人審核後才會呈現給讀者。是否允許代理程式擬稿，也由各社群自行決定。',
    },
    ledger: {
      title: 'REZICS Wiki 與世界觀',
      lede: '每項功能都標明目前進度。',
    },
    cta: {
      title: '開放時，為你的世界建立 Wiki。',
      body: '留下電子郵件，我們會在開放註冊時通知你一次。',
    },
  },
  'zh-Hans': {
    meta: {
      title: 'REZICS Wiki 与世界观：和故事一样深的百科',
      description:
        '每部作品都有 Wiki，每条信息引用章节，只显示你已读到的内容。智能体依据来源起草、由人审核，作者也能保存世界观设定集。',
    },
    hero: {
      title: '和故事一样深的 Wiki。',
      lede: '每部作品的 Wiki 都随故事成长：人物、地点与关系，每条信息引用出处章节，只显示到你的阅读进度。智能体依据来源起草，是否发布由人决定。',
    },
    story: {
      title: '看 Wiki 随章节一点点长大。',
      lede: '每一章，只加入故事已揭露的内容。',
      steps: {
        arrival: {
          title: '第 1 章：一个人的登场。',
          body: '角色走进故事，她的页面从一条信息与对应原文开始。',
        },
        place: {
          title: '第 4 章：一个地方，一份联系。',
          body: '书库在故事中出现，Wiki 加入这个地点，并链接到守护它的人。',
        },
        relations: {
          title: '第 9 章：关系逐渐成形。',
          body: '老师、对手、姐妹：原文明说，才建立关系；不会只因两个名字在同一页，就自行推测。',
        },
        reveal: {
          title: '第 12 章：秘密揭晓，先不剧透。',
          body: '揭晓的内容会连同章节记录。还没读到第 12 章的人，不会在页面、搜索结果或信息框里撞见它。',
        },
      },
    },
    showcase: {
      title: '给整理故事的同好，也给创造世界的作者。',
      lede: '同一套页面，既能做社区的公开 Wiki，也能做作者的私人世界观设定集。',
      tiles: {
        bible: {
          title: '草稿旁的世界观设定集',
          body: '人物、地点、阵营、物品与背景设定，私密保存在稿件旁。',
        },
        publish: {
          title: '只公开你选定的页面',
          body: '把选定页面转为作品 Wiki，不会连带公开草稿或修订历史。',
        },
        maps: {
          title: '用自己的图，画自己的地图',
          body: '在自己画的地图上标记地点，每个标记也会列在清单中。',
        },
        timelines: {
          title: '以架空历法编排时间线',
          body: '用故事世界的历法安排事件，日期不确定也能记录。',
        },
        relations: {
          title: '人物关系图',
          body: '家族、同盟与敌对关系，能看成图，也有人人能读的清单。',
        },
        history: {
          title: '历史、审核与导出',
          body: '每页都有差异对比与恢复，整个 Wiki 也能完整导出。',
        },
      },
    },
    compare: {
      title: '同好 Wiki，可以走得更远。',
      lede: '为故事留下记录的人，值得拥有能确保信息可信的工具。',
      today: '目前的做法',
      rezics: '在 REZICS',
      rows: {
        spoilers: {
          today: '本季信息框，却写着下季大反转',
          rezics: '每页只显示到你读过的章节',
        },
        sources: {
          today: '查不到出处的信息',
          rezics: '每条信息都引用章节与版本',
        },
        generated: {
          today: '自动生成文章，连引用都是编的',
          rezics: '智能体提有来源的信息，由人发布',
        },
        scattered: {
          today: '世界观设定散在三个写作 App',
          rezics: '一份世界观设定集，就在稿件旁',
        },
        leaving: {
          today: '导出了，却漏掉半个 Wiki',
          rezics: '完整 Wiki 导出，也能重新导入',
        },
      },
    },
    statement: {
      text: '智能体提案，由人决定。每条信息都有出处。',
      body: '同好 Wiki 拒绝生成文章，有其道理。REZICS 的智能体只提出有来源的信息与结构，经人审核后才会呈现给读者。是否允许智能体起草，也由各社区自行决定。',
    },
    ledger: {
      title: 'REZICS Wiki 与世界观',
      lede: '每项功能都标明当前进度。',
    },
    cta: {
      title: '开放时，为你的世界建立 Wiki。',
      body: '留下电子邮箱，我们会在开放注册时通知你一次。',
    },
  },
  ja: {
    meta: {
      title: 'REZICSのWikiと世界づくり：物語の奥行きまで残すWiki',
      description:
        '作品ごとにWikiを用意し、情報には出典の章を明記。読んだ範囲だけを表示します。エージェントが資料から提案し、人が確認。作者には世界設定集も。',
    },
    hero: {
      title: '物語の奥行きまで残すWiki。',
      lede: '人物、場所、関係。作品とともに育つWikiには、どの情報にも出典の章があり、読んだところまでしか表示しません。エージェントが資料から下書きを作り、公開する内容は人が決めます。',
    },
    story: {
      title: '一章ごとに、Wikiが育つ。',
      lede: 'その章で明かされたことだけを、少しずつ。',
      steps: {
        arrival: {
          title: '第1章：ひとりの登場。',
          body: 'ひとりの人物が物語に登場。彼女のページは、ひとつの事実とその出典の一文から始まります。',
        },
        place: {
          title: '第4章：場所と、つながり。',
          body: '書庫が物語に登場。Wikiにその場所が加わり、そこを守る人々へつながります。',
        },
        relations: {
          title: '第9章：関係が見えてくる。',
          body: '師、ライバル、姉妹。関係は本文に書かれて初めて表示されます。同じページに名前があるだけでは推測しません。',
        },
        reveal: {
          title: '第12章：秘密は、まだ伏せておく。',
          body: '秘密が明かされた章も記録。第12章に到達していなければ、ページにも検索結果にも情報欄にも、その秘密は現れません。',
        },
      },
    },
    showcase: {
      title: '物語を記録するファンにも、世界を作る書き手にも。',
      lede: '同じページの仕組みが、コミュニティの公開Wikiにも、作者の非公開の世界設定集にも使えます。',
      tiles: {
        bible: {
          title: '原稿の隣に、世界設定集',
          body: '人物、場所、勢力、道具、伝承を、原稿の隣に非公開で保管。',
        },
        publish: {
          title: '選んだページだけを公開',
          body: '選んだページを作品のWikiへ。草稿やその履歴は公開されません。',
        },
        maps: {
          title: '自分の絵を地図に',
          body: '自作の地図に場所をピン留め。すべてのピンは一覧でも読めます。',
        },
        timelines: {
          title: '架空の暦で作る年表',
          body: 'その世界の暦に出来事を配置。はっきりしない日付も扱えます。',
        },
        relations: {
          title: '関係図',
          body: '家族、同盟、対立を図で表示。誰もが読める一覧も添えます。',
        },
        history: {
          title: '履歴・確認・書き出し',
          body: 'どのページも差分を比較して復元でき、Wiki全体を一括で書き出せます。',
        },
      },
    },
    compare: {
      title: 'ファンWikiの、その先へ。',
      lede: '物語を記録する人には、その確かさを支える道具が必要です。',
      today: '今のやり方',
      rezics: 'REZICSなら',
      rows: {
        spoilers: {
          today: '今期の情報欄に、来期のどんでん返し',
          rezics: 'どのページも、読んだ章まで',
        },
        sources: {
          today: '出典をたどれない情報',
          rezics: 'どの情報にも章と版の出典',
        },
        generated: {
          today: '架空の出典つきの生成記事',
          rezics: 'エージェントが出典つきで提案し、人が公開',
        },
        scattered: {
          today: '設定が3つの執筆アプリに分散',
          rezics: '原稿の隣に、ひとつの世界設定集',
        },
        leaving: {
          today: '書き出しても、Wikiの半分が欠ける',
          rezics: 'Wiki全体を出力し、再取り込みも可能',
        },
      },
    },
    statement: {
      text: 'エージェントが提案し、人が決める。情報には必ず出典を。',
      body: 'ファンWikiが生成記事を断るのには理由があります。REZICSのエージェントは出典のある情報と構成を提案し、人の確認が済むまで読者には届きません。下書きを任せるかどうかも、各コミュニティが決めます。',
    },
    ledger: {
      title: 'REZICSのWikiと世界づくり',
      lede: '各機能に、現在の開発状況を表示しています。',
    },
    cta: {
      title: 'オープンしたら、あなたの世界にWikiを。',
      body: 'メールアドレスを残していただければ、登録開始時に一度だけお知らせします。',
    },
  },
  ko: {
    meta: {
      title: 'REZICS 위키와 세계관: 이야기만큼 깊이 있는 위키',
      description:
        '작품마다 위키를 두고, 모든 정보에 출처 장을 달아 읽은 범위까지만 보여 줍니다. 에이전트가 자료를 바탕으로 초안을 내고 사람이 검토하며, 작가는 세계관 설정집을 보관합니다.',
    },
    hero: {
      title: '이야기만큼 깊이 있는 위키.',
      lede: '인물, 장소, 관계까지 작품과 함께 자라는 위키. 모든 정보에 출처 장을 달고 읽은 지점까지만 보여 줍니다. 에이전트가 자료를 바탕으로 초안을 만들고, 공개할 내용은 사람이 결정합니다.',
    },
    story: {
      title: '한 장씩 자라나는 위키.',
      lede: '각 장에서 밝혀진 만큼만 더합니다.',
      steps: {
        arrival: {
          title: '1장: 누군가 등장하다.',
          body: '한 인물이 이야기에 들어옵니다. 그녀의 페이지는 정보 하나와 그 근거가 되는 문장으로 시작합니다.',
        },
        place: {
          title: '4장: 장소와 연결.',
          body: '서고가 등장하면 위키에 장소를 추가하고, 그곳을 지키는 인물과 연결합니다.',
        },
        relations: {
          title: '9장: 관계가 드러나다.',
          body: '스승, 라이벌, 자매. 본문이 밝힐 때만 관계를 표시합니다. 두 이름이 같은 페이지에 있다고 추측하지 않습니다.',
        },
        reveal: {
          title: '12장: 비밀은 아직 숨겨 두기.',
          body: '비밀이 밝혀진 장을 함께 기록합니다. 12장에 도달하지 않은 독자에게는 페이지, 검색 결과, 정보 상자 어디에도 나타나지 않습니다.',
        },
      },
    },
    showcase: {
      title: '기록하는 팬과 세계를 만드는 작가에게.',
      lede: '같은 페이지 구조를 커뮤니티의 공개 위키와 작가의 비공개 세계관 설정집에 씁니다.',
      tiles: {
        bible: {
          title: '초고 곁의 세계관 설정집',
          body: '인물, 장소, 세력, 아이템, 설정을 원고 곁에 비공개로 보관합니다.',
        },
        publish: {
          title: '고른 페이지만 공개',
          body: '선택한 페이지를 작품 위키로 공개하되, 초고와 수정 이력은 노출하지 않습니다.',
        },
        maps: {
          title: '직접 그린 지도 위에',
          body: '직접 그린 지도에 장소를 표시하세요. 모든 표시는 목록에서도 볼 수 있습니다.',
        },
        timelines: {
          title: '가상의 달력으로 만드는 연표',
          body: '내 세계의 달력에 사건을 배치합니다. 불확실한 날짜도 기록할 수 있습니다.',
        },
        relations: {
          title: '관계도',
          body: '가족, 동맹, 대립 관계를 그래프로 그리고 누구나 읽을 수 있는 목록으로도 제공합니다.',
        },
        history: {
          title: '이력, 검토, 내보내기',
          body: '모든 페이지에서 변경점 비교와 복원이 가능하고, 위키 전체를 한 번에 내보낼 수 있습니다.',
        },
      },
    },
    compare: {
      title: '팬 위키의 다음 모습.',
      lede: '이야기를 기록하는 사람에게는 기록의 정확성을 지켜 주는 도구가 필요합니다.',
      today: '지금은',
      rezics: 'REZICS에서는',
      rows: {
        spoilers: {
          today: '이번 시즌 정보 상자에 다음 시즌 반전',
          rezics: '모든 페이지를 읽은 장까지만 표시',
        },
        sources: {
          today: '출처를 확인할 수 없는 정보',
          rezics: '모든 정보에 출처 장과 판본 표시',
        },
        generated: {
          today: '출처까지 지어낸 생성 문서',
          rezics: '에이전트가 출처와 함께 제안하고 사람이 공개',
        },
        scattered: {
          today: '앱 세 개에 흩어진 세계관 설정',
          rezics: '원고 곁에 하나로 모은 세계관 설정집',
        },
        leaving: {
          today: '위키 절반이 빠진 내보내기',
          rezics: '위키 전체를 내보내고 다시 가져오기',
        },
      },
    },
    statement: {
      text: '에이전트는 제안하고, 사람은 결정합니다. 모든 정보에는 출처가 있습니다.',
      body: '팬 위키가 생성형 문서를 거부하는 데는 이유가 있습니다. REZICS 에이전트는 출처 있는 정보와 구조를 제안하며, 사람이 검토하기 전에는 독자에게 공개하지 않습니다. 초안 작성을 허용할지도 각 커뮤니티가 결정합니다.',
    },
    ledger: {
      title: 'REZICS 위키와 세계관',
      lede: '각 기능에 현재 진행 상황을 표시합니다.',
    },
    cta: {
      title: '문을 열면 내 세계의 위키를 시작하세요.',
      body: '이메일을 남겨 주시면 가입이 열릴 때 한 번만 알려 드립니다.',
    },
  },
  de: {
    meta: {
      title: 'Wikis und Weltenbau auf REZICS: so viel Tiefe wie die Geschichte',
      description:
        'Jedes Werk bekommt ein Wiki mit Kapitelbelegen und ohne Spoiler über deinen Lesestand hinaus. Agenten entwerfen, Menschen prüfen, Autoren pflegen ihre Welt.',
    },
    hero: {
      title: 'Ein Wiki so tief wie die Geschichte.',
      lede: 'Jedes Werk bekommt ein mitwachsendes Wiki: Figuren, Orte und Beziehungen mit Kapitelbelegen, sichtbar nur bis zu deinem Lesestand. Agenten entwerfen anhand der Quellen. Menschen entscheiden über die Veröffentlichung.',
    },
    story: {
      title: 'Wie ein Wiki Kapitel für Kapitel wächst.',
      lede: 'Jedes Kapitel ergänzt nur, was die Geschichte bis dahin verrät.',
      steps: {
        arrival: {
          title: 'Kapitel 1: Jemand kommt an.',
          body: 'Eine Figur betritt die Geschichte. Ihre Seite beginnt mit einer Angabe und der Textzeile, die sie belegt.',
        },
        place: {
          title: 'Kapitel 4: Ein Ort, eine Verbindung.',
          body: 'Das Archiv taucht auf. Das Wiki ergänzt den Ort und verknüpft ihn mit seinen Hütern.',
        },
        relations: {
          title: 'Kapitel 9: Beziehungen nehmen Gestalt an.',
          body: 'Lehrer, Rivalin, Schwester: Beziehungen erscheinen, wenn der Text sie nennt. Zwei Namen auf derselben Seite sind kein Beleg.',
        },
        reveal: {
          title: 'Kapitel 12: Ein Geheimnis bleibt verborgen.',
          body: 'Die Enthüllung wird mit ihrem Kapitel erfasst. Wer Kapitel 12 noch nicht erreicht hat, sieht sie weder auf der Seite noch in Suche oder Infobox.',
        },
      },
    },
    showcase: {
      title: 'Für Fans, die festhalten, und Autoren, die Welten schaffen.',
      lede: 'Dieselben Seiten dienen als öffentliches Community-Wiki und private Weltensammlung eines Autors.',
      tiles: {
        bible: {
          title: 'Die Weltensammlung neben dem Entwurf',
          body: 'Figuren, Orte, Fraktionen, Gegenstände und Hintergründe privat neben dem Manuskript.',
        },
        publish: {
          title: 'Nur ausgewählte Seiten veröffentlichen',
          body: 'Mache ausgewählte Seiten zum Werk-Wiki, ohne Entwürfe oder ihre Historie offenzulegen.',
        },
        maps: {
          title: 'Karten auf deinem eigenen Bild',
          body: 'Markiere Orte auf deiner selbst gezeichneten Karte. Jeder Marker steht auch in einer Liste.',
        },
        timelines: {
          title: 'Zeitlinien mit erfundenen Kalendern',
          body: 'Trage Ereignisse in den Kalender deiner Welt ein, auch mit unsicherem Datum.',
        },
        relations: {
          title: 'Beziehungsübersichten',
          body: 'Familien, Bündnisse und Rivalitäten als Graph und als lesbare Liste.',
        },
        history: {
          title: 'Historie, Prüfung und Export',
          body: 'Änderungsvergleich und Wiederherstellung auf jeder Seite, das ganze Wiki in einem Export.',
        },
      },
    },
    compare: {
      title: 'Was aus einem Fan-Wiki werden kann.',
      lede: 'Wer eine Geschichte dokumentiert, verdient Werkzeuge, die den Eintrag verlässlich halten.',
      today: 'Heute',
      rezics: 'Auf REZICS',
      rows: {
        spoilers: {
          today: 'Die Wendung der nächsten Staffel in der heutigen Infobox',
          rezics: 'Jede Seite endet bei deinem Kapitel',
        },
        sources: {
          today: 'Angaben ohne nachvollziehbare Quelle',
          rezics: 'Jede Angabe belegt mit Kapitel und Ausgabe',
        },
        generated: {
          today: 'Generierte Artikel mit erfundenen Belegen',
          rezics: 'Agenten schlagen belegte Fakten vor, Menschen veröffentlichen',
        },
        scattered: {
          today: 'Hintergründe über drei Schreib-Apps verteilt',
          rezics: 'Eine Weltensammlung neben dem Manuskript',
        },
        leaving: {
          today: 'Beim Export bleibt das halbe Wiki zurück',
          rezics: 'Das ganze Wiki exportieren und wieder importieren',
        },
      },
    },
    statement: {
      text: 'Agenten schlagen vor. Menschen entscheiden. Fakten zeigen ihre Quellen.',
      body: 'Fan-Wikis lehnen generierte Artikel zu Recht ab. REZICS-Agenten schlagen belegte Fakten und Strukturen vor; erst nach menschlicher Prüfung sehen Leser sie. Jede Community entscheidet selbst, ob Agenten überhaupt Entwürfe liefern dürfen.',
    },
    ledger: {
      title: 'Wikis und Weltenbau auf REZICS',
      lede: 'Jede Funktion zeigt ihren aktuellen Stand.',
    },
    cta: {
      title: 'Starte das Wiki deiner Welt zur Eröffnung.',
      body: 'Hinterlasse deine E-Mail-Adresse. Wir schreiben dir einmal, wenn die Registrierung öffnet.',
    },
  },
  fr: {
    meta: {
      title: 'Wikis et création d’univers sur REZICS : toute la profondeur du récit',
      description:
        'Un wiki par œuvre, des faits sourcés par chapitre, visibles selon votre lecture. Les agents proposent, les humains relisent et les auteurs gardent leur bible d’univers.',
    },
    hero: {
      title: 'Un wiki aussi riche que l’histoire.',
      lede: 'Chaque œuvre a un wiki qui grandit avec elle : personnages, lieux et relations, chaque fait renvoyant à son chapitre, visible jusqu’à votre progression. Les agents rédigent à partir des sources. Les humains décident de la publication.',
    },
    story: {
      title: 'Un wiki qui grandit, chapitre après chapitre.',
      lede: 'Chaque chapitre ajoute ce que le récit révèle, rien de plus.',
      steps: {
        arrival: {
          title: 'Chapitre 1 : une arrivée.',
          body: 'Un personnage entre en scène. Sa page commence par un fait et la phrase dont il provient.',
        },
        place: {
          title: 'Chapitre 4 : un lieu, un lien.',
          body: 'Les archives entrent dans le récit. Le wiki ajoute ce lieu et le relie aux personnes qui le gardent.',
        },
        relations: {
          title: 'Chapitre 9 : les relations se dessinent.',
          body: 'Mentor, rival, sœur : les relations apparaissent quand le texte les établit, jamais parce que deux noms partagent une page.',
        },
        reveal: {
          title: 'Chapitre 12 : un secret préservé.',
          body: 'La révélation est enregistrée avec son chapitre. Avant le chapitre 12, elle n’apparaît ni sur la page, ni dans la recherche, ni dans l’infobox.',
        },
      },
    },
    showcase: {
      title: 'Pour les fans qui documentent et les auteurs qui créent.',
      lede: 'Les mêmes pages servent au wiki public d’une communauté et à la bible d’univers privée d’un auteur.',
      tiles: {
        bible: {
          title: 'Une bible d’univers près du brouillon',
          body: 'Personnages, lieux, factions, objets et histoire du monde gardés en privé près du manuscrit.',
        },
        publish: {
          title: 'Publiez les pages choisies',
          body: 'Transformez certaines pages en wiki de l’œuvre sans exposer les brouillons ni leur historique.',
        },
        maps: {
          title: 'Vos cartes, vos dessins',
          body: 'Placez les lieux sur votre propre carte. Chaque repère figure aussi dans une liste.',
        },
        timelines: {
          title: 'Des chronologies en calendriers inventés',
          body: 'Placez les événements dans le calendrier de votre monde, même avec des dates incertaines.',
        },
        relations: {
          title: 'Cartes de relations',
          body: 'Familles, alliances et rivalités en graphe et en liste lisible par tous.',
        },
        history: {
          title: 'Historique, révision et export',
          body: 'Comparaison et restauration sur chaque page, export du wiki entier en une fois.',
        },
      },
    },
    compare: {
      title: 'Ce que peut devenir un wiki de fans.',
      lede: 'Ceux qui documentent une histoire méritent des outils qui en préservent la justesse.',
      today: 'Aujourd’hui',
      rezics: 'Sur REZICS',
      rows: {
        spoilers: {
          today: 'Le rebondissement de la saison suivante dans l’infobox actuelle',
          rezics: 'Chaque page s’arrête au chapitre atteint',
        },
        sources: {
          today: 'Des faits sans source retrouvable',
          rezics: 'Chaque fait cite son chapitre et son édition',
        },
        generated: {
          today: 'Des articles générés avec de fausses citations',
          rezics: 'Les agents proposent des faits sourcés, les humains publient',
        },
        scattered: {
          today: 'L’univers éparpillé entre trois logiciels d’écriture',
          rezics: 'Une bible d’univers près du manuscrit',
        },
        leaving: {
          today: 'Un export qui oublie la moitié du wiki',
          rezics: 'Tout le wiki, exporté et réimportable',
        },
      },
    },
    statement: {
      text: 'Les agents proposent. Les humains décident. Chaque fait cite sa source.',
      body: 'Les wikis de fans ont raison de refuser les articles générés. Les agents REZICS proposent des faits sourcés et une structure ; rien n’atteint les lecteurs avant une relecture humaine. Chaque communauté décide si elle accepte même ces brouillons.',
    },
    ledger: {
      title: 'Wikis et création d’univers sur REZICS',
      lede: 'Chaque fonctionnalité indique où elle en est.',
    },
    cta: {
      title: 'Créez le wiki de votre univers à l’ouverture.',
      body: 'Laissez votre adresse e-mail. Nous vous écrirons une seule fois, à l’ouverture des inscriptions.',
    },
  },
  es: {
    meta: {
      title: 'Wikis y creación de mundos en REZICS: tan profundos como la historia',
      description:
        'Un wiki por obra, con fuentes por capítulo y contenido hasta donde has leído. Los agentes proponen, las personas revisan y los autores conservan su biblia del mundo.',
    },
    hero: {
      title: 'Un wiki tan profundo como la historia.',
      lede: 'Cada obra tiene un wiki que crece con ella: personajes, lugares y relaciones con su capítulo de origen, visibles solo hasta donde has leído. Los agentes preparan borradores con fuentes. Las personas deciden qué publicar.',
    },
    story: {
      title: 'Mira crecer un wiki capítulo a capítulo.',
      lede: 'Cada capítulo añade lo que la historia ha revelado, nada más.',
      steps: {
        arrival: {
          title: 'Capítulo 1: alguien llega.',
          body: 'Un personaje entra en la historia. Su página empieza con un dato y la frase que lo respalda.',
        },
        place: {
          title: 'Capítulo 4: un lugar, un vínculo.',
          body: 'El archivo aparece en la historia. El wiki añade el lugar y lo conecta con quienes lo custodian.',
        },
        relations: {
          title: 'Capítulo 9: las relaciones toman forma.',
          body: 'Maestro, rival, hermana: las relaciones aparecen cuando el texto las afirma, nunca por coincidir dos nombres en una página.',
        },
        reveal: {
          title: 'Capítulo 12: un secreto que espera.',
          body: 'La revelación se guarda con su capítulo. Quien no haya llegado al 12 no la verá en la página, en búsquedas ni en la ficha informativa.',
        },
      },
    },
    showcase: {
      title: 'Para fans que documentan y autores que crean mundos.',
      lede: 'Las mismas páginas sirven para el wiki público de una comunidad y la biblia del mundo privada de un autor.',
      tiles: {
        bible: {
          title: 'La biblia del mundo junto al borrador',
          body: 'Personajes, lugares, facciones, objetos y trasfondo, en privado junto al manuscrito.',
        },
        publish: {
          title: 'Publica las páginas que elijas',
          body: 'Convierte las páginas elegidas en el wiki de la obra sin exponer borradores ni su historial.',
        },
        maps: {
          title: 'Mapas sobre tus ilustraciones',
          body: 'Marca lugares en el mapa que dibujaste. Cada marcador aparece también en una lista.',
        },
        timelines: {
          title: 'Cronologías con calendarios inventados',
          body: 'Sitúa eventos en el calendario de tu mundo, incluso con fechas inciertas.',
        },
        relations: {
          title: 'Mapas de relaciones',
          body: 'Familias, alianzas y rivalidades en un gráfico y en una lista que cualquiera puede leer.',
        },
        history: {
          title: 'Historial, revisión y exportación',
          body: 'Diferencias y restauración en cada página, y todo el wiki en una sola exportación.',
        },
      },
    },
    compare: {
      title: 'Lo que puede llegar a ser un wiki de fans.',
      lede: 'Quienes documentan una historia merecen herramientas que mantengan fiables sus registros.',
      today: 'Hoy',
      rezics: 'En REZICS',
      rows: {
        spoilers: {
          today: 'El giro de la próxima temporada en la ficha de esta',
          rezics: 'Cada página llega hasta el capítulo que has leído',
        },
        sources: {
          today: 'Datos que nadie puede rastrear',
          rezics: 'Cada dato cita capítulo y edición',
        },
        generated: {
          today: 'Artículos generados con citas inventadas',
          rezics: 'Los agentes proponen datos con fuentes; las personas publican',
        },
        scattered: {
          today: 'El trasfondo repartido entre tres apps de escritura',
          rezics: 'Una biblia del mundo junto al manuscrito',
        },
        leaving: {
          today: 'Una exportación que deja atrás medio wiki',
          rezics: 'Todo el wiki, exportable y reimportable',
        },
      },
    },
    statement: {
      text: 'Los agentes proponen. Las personas deciden. Cada dato muestra su fuente.',
      body: 'Los wikis de fans tienen razón al rechazar artículos generados. Los agentes de REZICS proponen datos con fuentes y estructura; nada llega al lector sin revisión humana. Cada comunidad decide si permite siquiera esos borradores.',
    },
    ledger: {
      title: 'Wikis y creación de mundos en REZICS',
      lede: 'Cada función indica su estado actual.',
    },
    cta: {
      title: 'Crea el wiki de tu mundo cuando abramos.',
      body: 'Deja tu correo y te escribiremos una sola vez, cuando se abra el registro.',
    },
  },
});
