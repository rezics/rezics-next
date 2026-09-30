import { defineCopy } from '../define.ts';
import type { LinePageCopy } from './page.ts';

export const agents = defineCopy<LinePageCopy>({
  en: {
    meta: {
      title: 'Agents on REZICS: automation that shows its work',
      description:
        'Official agents and the ones you bring use one open protocol: they propose exact changes with evidence, people review, and every applied change has a receipt and can be undone.',
    },
    hero: {
      title: 'Agents that do the tedious work, and show it.',
      lede: 'Spam review, tagging, keeping relations current, tidying posts, moving libraries, building wikis. Official agents and the ones you bring yourself use one open protocol: they propose exact changes with the evidence behind them, a person reviews, and every applied change carries a receipt.',
    },
    story: {
      title: 'How a contribution travels.',
      lede: 'Every agent, ours or yours, follows the same four steps.',
      steps: {
        propose: {
          title: 'An agent proposes.',
          body: 'A tagging agent reads a new post and proposes three tags. The proposal names the exact revision it read, quotes the passage behind each tag and states its confidence as a claim it must stand behind.',
        },
        review: {
          title: 'A person reviews.',
          body: 'The reviewer sees the quoted evidence highlighted in the post and accepts, edits or rejects each tag. If the post changes first, the proposal goes back for review.',
        },
        apply: {
          title: 'It applies, with a receipt.',
          body: 'Accepted tags apply with a receipt naming the agent, the person who runs it and the reviewer. Readers can see that automation was involved.',
        },
        undo: {
          title: 'And it can be undone.',
          body: 'Reversing an agent’s change applies a correction that keeps every human edit made since. Nothing an agent does is beyond reach.',
        },
      },
    },
    showcase: {
      title: 'The first agents.',
      lede: 'Each one does a job people already do by hand, and hands the decision back to them.',
      tiles: {
        'spam-review': {
          title: 'Spam and advertising review',
          body: 'Built on TypeSafe’s Jev. It tells an author announcing their own book apart from an unsolicited ad, quotes the passages that decided it, and a moderator has the final word.',
        },
        'auto-tagging': {
          title: 'Auto-tagging',
          body: 'Suggests tags for posts and books from the shared vocabulary, with the reason and the spoiler level of each.',
        },
        'relation-maintenance': {
          title: 'Relation maintenance',
          body: 'A new character, person or place is proposed into every Work and entity it belongs to.',
        },
        normalisation: {
          title: 'Normalisation',
          body: 'Turns a free-form post, such as a recipe told as a story, into structured content its author can accept.',
        },
        'migration-assistant': {
          title: 'Library migration',
          body: 'Moves a library in from another site, resolves editions with you and lists every row it could not match.',
        },
        'wiki-builder': {
          title: 'The wiki builder',
          body: 'Reads a Work chapter by chapter and proposes sourced facts for reviewers to publish, where the Realm allows it.',
        },
        byo: {
          title: 'Your own agent',
          body: 'Connect it through the API or MCP. It runs on your compute, with the credentials and budget you grant.',
        },
      },
    },
    compare: {
      title: 'Automation you can see.',
      lede: 'Agents earn a place in a community by being accountable, not invisible.',
      today: 'Today',
      rezics: 'On REZICS',
      rows: {
        bots: {
          today: 'Bots that post as if they were people',
          rezics: 'Every automated action labelled',
        },
        filters: {
          today: 'Filters that remove posts without a reason',
          rezics: 'Quoted evidence and a human decision',
        },
        training: {
          today: 'Assistants that learn from your drafts',
          rezics: 'Private drafts and reading stay out of training',
        },
        scraping: {
          today: 'Integrations that scrape pages',
          rezics: 'One documented protocol and scoped credentials',
        },
        bills: {
          today: 'AI costs you cannot predict',
          rezics: 'Your compute, your budget, your cap',
        },
      },
    },
    statement: {
      text: 'Every automated action says so, and a person can always overrule it.',
      body: 'Agents disclose who runs them, act only with the access they were granted and never pose as members, reviewers or voters. Your private drafts and reading records never train them unless you opt in.',
    },
    ledger: {
      title: 'Agents on REZICS',
    },
    cta: {
      title: 'Bring your agent when we open.',
      body: 'Leave your email and we will write once, when registration opens.',
    },
  },
  'zh-Hant': {
    meta: {
      title: 'REZICS 代理程式：自動化，也交代依據',
      description:
        '官方與自備代理程式共用開放協定：提出附證據的明確變更，由人審核；每次套用都有回執，也能撤銷。',
    },
    hero: {
      title: '繁瑣工作交給代理程式，怎麼做都看得見。',
      lede: '審查垃圾訊息、建議標籤、更新關係、整理貼文、搬移書庫、建立 Wiki。官方與自備代理程式使用同一開放協定：提出具體變更與證據，由人審核，每次套用都有回執。',
    },
    story: {
      title: '一份貢獻，如何完成。',
      lede: '不論我們的或你的代理程式，都遵循相同四個步驟。',
      steps: {
        propose: {
          title: '代理程式提出建議。',
          body: '標籤代理程式讀取新貼文，建議三個標籤。提案記明讀取的確切修訂版、引用每個標籤的依據段落，並提出可供檢驗的信心程度。',
        },
        review: {
          title: '由人審核。',
          body: '審核者看到貼文中標出的證據，逐一接受、修改或拒絕標籤。若貼文先有變動，提案就送回重新審核。',
        },
        apply: {
          title: '套用變更，留下回執。',
          body: '通過的標籤套用後，回執會記錄代理程式、執行者與審核者。讀者看得見自動化曾參與其中。',
        },
        undo: {
          title: '也能撤銷。',
          body: '撤銷代理程式的變更時，會以更正方式處理，保留之後所有人工編輯。代理程式的任何操作都能追究與修正。',
        },
      },
    },
    showcase: {
      title: '第一批代理程式。',
      lede: '接手人們原本手動做的工作，把決定權交回人手中。',
      tiles: {
        'spam-review': {
          title: '垃圾訊息與廣告審查',
          body: '以 TypeSafe 的 Jev 為基礎，區分作者介紹自己的書與未經邀請的廣告，引用判斷依據段落，最後由管理員決定。',
        },
        'auto-tagging': {
          title: '自動標籤建議',
          body: '從共用詞彙表為貼文與書籍建議標籤，附上各標籤的理由與暴雷程度。',
        },
        'relation-maintenance': {
          title: '關係維護',
          body: '新角色、人物或地點出現時，提議連到所屬的作品與實體。',
        },
        normalisation: {
          title: '內容結構化',
          body: '把自由格式的貼文，例如用故事寫成的食譜，整理成結構化內容，交由作者接受。',
        },
        'migration-assistant': {
          title: '書庫搬家',
          body: '從其他網站搬入書庫，和你一起確認版本，列出每筆無法比對的資料。',
        },
        'wiki-builder': {
          title: 'Wiki 建構助手',
          body: '在社群允許的前提下，逐章閱讀作品，提出有來源的資訊，由審核者發布。',
        },
        byo: {
          title: '你自己的代理程式',
          body: '透過 API 或 MCP 連接，使用你的運算資源，以及你授予的憑證與預算。',
        },
      },
    },
    compare: {
      title: '看得見的自動化。',
      lede: '代理程式要靠負責任贏得社群信任，而非躲在幕後。',
      today: '目前的做法',
      rezics: '在 REZICS',
      rows: {
        bots: {
          today: '機器人假扮真人發文',
          rezics: '每次自動操作都明確標示',
        },
        filters: {
          today: '不說理由就刪文的過濾器',
          rezics: '引用證據，由人判斷',
        },
        training: {
          today: '拿你的草稿訓練的助手',
          rezics: '私人草稿與閱讀紀錄不拿來訓練',
        },
        scraping: {
          today: '只能爬網頁串接',
          rezics: '有文件的統一協定，權限受限的憑證',
        },
        bills: {
          today: '難以預測的 AI 費用',
          rezics: '自己的運算資源、預算與上限',
        },
      },
    },
    statement: {
      text: '自動操作一定標明，人隨時能推翻決定。',
      body: '代理程式公開執行者身分，只在獲准權限內行動，絕不假扮會員、評論者或投票者。除非你主動同意，私人草稿與閱讀紀錄絕不用於訓練。',
    },
    ledger: {
      title: 'REZICS 代理程式',
    },
    cta: {
      title: '開放時，帶上你的代理程式。',
      body: '留下電子郵件，我們會在開放註冊時通知你一次。',
    },
  },
  'zh-Hans': {
    meta: {
      title: 'REZICS 智能体：自动化，也交代依据',
      description:
        '官方与自带智能体共用开放协议：提出附证据的明确变更，由人审核；每次应用都有回执，也能撤销。',
    },
    hero: {
      title: '繁琐工作交给智能体，怎么做都看得见。',
      lede: '审核垃圾信息、建议标签、更新关系、整理帖子、迁移书库、建立 Wiki。官方与自带智能体使用同一开放协议：提出具体变更与证据，由人审核，每次应用都有回执。',
    },
    story: {
      title: '一份贡献，如何完成。',
      lede: '无论我们的还是你的智能体，都遵循相同四个步骤。',
      steps: {
        propose: {
          title: '智能体提出建议。',
          body: '标签智能体读取新帖子，建议三个标签。提案记明读取的准确修订版、引用每个标签的依据段落，并提出可供检验的置信度。',
        },
        review: {
          title: '由人审核。',
          body: '审核者看到帖子中标出的证据，逐一接受、修改或拒绝标签。如果帖子先有变动，提案就退回重新审核。',
        },
        apply: {
          title: '应用变更，留下回执。',
          body: '通过的标签应用后，回执会记录智能体、运行者与审核者。读者看得见自动化曾参与其中。',
        },
        undo: {
          title: '也能撤销。',
          body: '撤销智能体的变更时，会以更正方式处理，保留之后所有人工编辑。智能体的任何操作都能追究与修正。',
        },
      },
    },
    showcase: {
      title: '第一批智能体。',
      lede: '接手人们原本手动做的工作，把决定权交回人手中。',
      tiles: {
        'spam-review': {
          title: '垃圾信息与广告审核',
          body: '基于 TypeSafe 的 Jev，区分作者介绍自己的书与未经邀请的广告，引用判断依据段落，最后由管理员决定。',
        },
        'auto-tagging': {
          title: '自动标签建议',
          body: '从共享词表为帖子与书籍建议标签，附上各标签的理由与剧透程度。',
        },
        'relation-maintenance': {
          title: '关系维护',
          body: '新角色、人物或地点出现时，提议连到所属的作品与实体。',
        },
        normalisation: {
          title: '内容结构化',
          body: '把自由格式的帖子，例如用故事写成的食谱，整理成结构化内容，交由作者接受。',
        },
        'migration-assistant': {
          title: '书库迁移',
          body: '从其他网站迁入书库，和你一起确认版本，列出每条无法匹配的数据。',
        },
        'wiki-builder': {
          title: 'Wiki 构建助手',
          body: '在社区允许的前提下，逐章阅读作品，提出有来源的信息，由审核者发布。',
        },
        byo: {
          title: '你自己的智能体',
          body: '通过 API 或 MCP 连接，使用你的计算资源，以及你授予的凭证与预算。',
        },
      },
    },
    compare: {
      title: '看得见的自动化。',
      lede: '智能体要靠负责任赢得社区信任，而非躲在幕后。',
      today: '目前的做法',
      rezics: '在 REZICS',
      rows: {
        bots: {
          today: '机器人假扮真人发帖',
          rezics: '每次自动操作都明确标注',
        },
        filters: {
          today: '不说理由就删帖的过滤器',
          rezics: '引用证据，由人判断',
        },
        training: {
          today: '拿你的草稿训练的助手',
          rezics: '私人草稿与阅读记录不拿来训练',
        },
        scraping: {
          today: '只能爬网页集成',
          rezics: '有文档的统一协议，权限受限的凭证',
        },
        bills: {
          today: '难以预测的 AI 费用',
          rezics: '自己的计算资源、预算与上限',
        },
      },
    },
    statement: {
      text: '自动操作一定标明，人随时能推翻决定。',
      body: '智能体公开运行者身份，只在获准权限内行动，绝不假扮会员、评论者或投票者。除非你主动同意，私人草稿与阅读记录绝不用于训练。',
    },
    ledger: {
      title: 'REZICS 智能体',
    },
    cta: {
      title: '开放时，带上你的智能体。',
      body: '留下电子邮箱，我们会在开放注册时通知你一次。',
    },
  },
  ja: {
    meta: {
      title: 'REZICSのエージェント：仕事の根拠が見える自動化',
      description:
        '公式も持ち込みも、同じ公開プロトコルを利用。根拠つきの具体的な変更を提案し、人が確認します。反映した変更には記録が残り、取り消せます。',
    },
    hero: {
      title: '手間のかかる仕事を、根拠が見えるエージェントに。',
      lede: 'スパム確認、タグ付け、関係の更新、投稿の整理、ライブラリ移行、Wiki作成。公式も持ち込みも同じ公開プロトコルで、根拠とともに具体的な変更を提案します。人が確認し、反映のたびに処理記録が残ります。',
    },
    story: {
      title: '提案が反映されるまで。',
      lede: '私たちのエージェントも、あなたのものも、同じ4つの手順をたどります。',
      steps: {
        propose: {
          title: 'エージェントが提案。',
          body: 'タグ付けエージェントが新しい投稿を読み、3つのタグを提案。読んだ版を正確に示し、各タグの根拠となる一節を引用し、検証の対象となる確信度を申告します。',
        },
        review: {
          title: '人が確認。',
          body: '確認者は投稿内で強調された根拠を見て、タグごとに承認・修正・却下を選びます。先に投稿が変われば、提案は再確認に戻ります。',
        },
        apply: {
          title: '反映して、記録を残す。',
          body: '承認されたタグを反映すると、エージェント、運用者、確認者を記した処理記録が残ります。読者にも自動化が関わったことがわかります。',
        },
        undo: {
          title: 'あとから取り消せる。',
          body: '変更の取り消しは訂正として反映され、その後の人の編集はすべて保持されます。エージェントの操作に、手の届かないものはありません。',
        },
      },
    },
    showcase: {
      title: '最初のエージェントたち。',
      lede: '人が手作業でしてきた仕事を担い、判断は人に返します。',
      tiles: {
        'spam-review': {
          title: 'スパム・広告の確認',
          body: 'TypeSafeのJevが基盤。作者による自作の告知と一方的な広告を区別し、判断の根拠となった箇所を引用。最終判断はモデレーターが下します。',
        },
        'auto-tagging': {
          title: '自動タグ提案',
          body: '投稿や本に共通語彙からタグを提案し、それぞれの理由とネタバレ範囲を示します。',
        },
        'relation-maintenance': {
          title: '関係のメンテナンス',
          body: '新たなキャラクター、人物、場所を、関わるすべての作品や項目につなぐ提案をします。',
        },
        normalisation: {
          title: '内容の整理',
          body: '物語風のレシピなど、自由形式の投稿を構造化した内容に整え、作者に承認を求めます。',
        },
        'migration-assistant': {
          title: 'ライブラリの引っ越し',
          body: '別のサイトからライブラリを移し、版の確認を手伝い、照合できなかった行をすべて示します。',
        },
        'wiki-builder': {
          title: 'Wiki作成エージェント',
          body: 'コミュニティが許可した場合に作品を一章ずつ読み、出典つきの情報を提案。確認者が公開します。',
        },
        byo: {
          title: 'あなたのエージェント',
          body: 'APIまたはMCPで接続。あなたの計算資源で、与えた認証情報と予算の範囲内で動きます。',
        },
      },
    },
    compare: {
      title: '見える自動化。',
      lede: 'エージェントが居場所を得るには、姿を隠すのではなく、責任を示すことが必要です。',
      today: '今のやり方',
      rezics: 'REZICSなら',
      rows: {
        bots: {
          today: '人のふりをして投稿するボット',
          rezics: '自動操作はすべて明記',
        },
        filters: {
          today: '理由を示さず投稿を消すフィルター',
          rezics: '引用した根拠をもとに人が判断',
        },
        training: {
          today: '草稿を学習に使うアシスタント',
          rezics: '非公開の草稿と読書は学習の対象外',
        },
        scraping: {
          today: 'ページを収集してつなぐ連携',
          rezics: '文書化された共通プロトコルと権限を絞った認証情報',
        },
        bills: {
          today: '予測できないAI費用',
          rezics: '自分の計算資源、予算、上限',
        },
      },
    },
    statement: {
      text: '自動操作は明らかにし、人がいつでも覆せる。',
      body: 'エージェントは運用者を明かし、許可された権限だけで動き、会員・レビュアー・投票者を装いません。明示的に同意しない限り、非公開の草稿や読書履歴を学習に使いません。',
    },
    ledger: {
      title: 'REZICSのエージェント',
    },
    cta: {
      title: 'オープンしたら、あなたのエージェントと一緒に。',
      body: 'メールアドレスを残していただければ、登録開始時に一度だけお知らせします。',
    },
  },
  ko: {
    meta: {
      title: 'REZICS 에이전트: 근거를 보여 주는 자동화',
      description:
        '공식 에이전트도 직접 연결한 에이전트도 같은 개방형 프로토콜을 씁니다. 근거와 함께 변경을 제안하고 사람이 검토합니다. 적용한 변경은 처리 기록이 남고 되돌릴 수 있습니다.',
    },
    hero: {
      title: '번거로운 일을 맡기고, 그 과정을 확인하세요.',
      lede: '스팸 검토, 태그 제안, 관계 갱신, 게시물 정리, 서재 이전, 위키 작성까지. 공식 에이전트와 직접 연결한 에이전트가 같은 개방형 프로토콜로 구체적인 변경과 근거를 제안합니다. 사람이 검토하고, 적용할 때마다 처리 기록을 남깁니다.',
    },
    story: {
      title: '기여가 반영되기까지.',
      lede: '우리 에이전트든 직접 연결한 에이전트든 같은 네 단계를 따릅니다.',
      steps: {
        propose: {
          title: '에이전트가 제안합니다.',
          body: '태그 에이전트가 새 게시물을 읽고 태그 세 개를 제안합니다. 읽은 수정본을 정확히 밝히고 각 태그의 근거 구절을 인용하며, 검증받을 신뢰도를 함께 제시합니다.',
        },
        review: {
          title: '사람이 검토합니다.',
          body: '검토자는 게시물에 강조된 근거를 보고 각 태그를 수락, 수정, 거절합니다. 게시물이 먼저 바뀌면 제안은 다시 검토를 받습니다.',
        },
        apply: {
          title: '적용하고 처리 기록을 남깁니다.',
          body: '수락된 태그를 적용하며 에이전트, 운영자, 검토자를 적은 처리 기록을 남깁니다. 독자는 자동화가 관여했음을 알 수 있습니다.',
        },
        undo: {
          title: '되돌릴 수도 있습니다.',
          body: '에이전트의 변경을 되돌릴 때는 이후 사람이 수정한 내용을 모두 보존하는 정정을 적용합니다. 에이전트의 어떤 작업도 손댈 수 없는 상태로 남지 않습니다.',
        },
      },
    },
    showcase: {
      title: '첫 에이전트들.',
      lede: '사람이 손으로 하던 일을 맡되, 결정은 사람에게 돌려줍니다.',
      tiles: {
        'spam-review': {
          title: '스팸·광고 검토',
          body: 'TypeSafe의 Jev를 기반으로, 작가의 신간 소개와 원치 않는 광고를 구분하고 판단 근거를 인용합니다. 최종 결정은 운영자가 합니다.',
        },
        'auto-tagging': {
          title: '자동 태그 제안',
          body: '게시물과 책에 공통 어휘의 태그를 제안하고, 각 태그의 이유와 스포일러 수준을 표시합니다.',
        },
        'relation-maintenance': {
          title: '관계 갱신',
          body: '새 캐릭터, 인물, 장소를 관련된 모든 작품과 항목에 연결하도록 제안합니다.',
        },
        normalisation: {
          title: '내용 구조화',
          body: '이야기처럼 풀어 쓴 레시피 등의 자유 형식 게시물을 구조화해 원작자가 수락할 수 있게 제안합니다.',
        },
        'migration-assistant': {
          title: '서재 이전',
          body: '다른 사이트의 서재를 옮기고, 함께 판본을 확인하며 일치 항목을 찾지 못한 모든 행을 나열합니다.',
        },
        'wiki-builder': {
          title: '위키 작성 도우미',
          body: '커뮤니티가 허용하면 작품을 한 장씩 읽고 출처 있는 정보를 제안합니다. 공개는 검토자가 합니다.',
        },
        byo: {
          title: '직접 연결하는 에이전트',
          body: 'API나 MCP로 연결하세요. 내 컴퓨팅 자원에서 부여한 인증 정보와 예산으로 실행합니다.',
        },
      },
    },
    compare: {
      title: '눈에 보이는 자동화.',
      lede: '에이전트는 보이지 않게 숨어서가 아니라 책임을 지면서 커뮤니티의 자리를 얻습니다.',
      today: '지금은',
      rezics: 'REZICS에서는',
      rows: {
        bots: {
          today: '사람인 척 글 쓰는 봇',
          rezics: '모든 자동 작업에 표시',
        },
        filters: {
          today: '이유 없이 게시물을 지우는 필터',
          rezics: '근거 인용과 사람의 결정',
        },
        training: {
          today: '내 초고로 학습하는 도우미',
          rezics: '비공개 초고와 독서는 학습에서 제외',
        },
        scraping: {
          today: '페이지를 긁어오는 연동',
          rezics: '문서화된 공통 프로토콜과 범위를 제한한 인증 정보',
        },
        bills: {
          today: '예측하기 어려운 AI 비용',
          rezics: '내 컴퓨팅 자원, 예산, 한도',
        },
      },
    },
    statement: {
      text: '자동 작업은 반드시 밝히고, 사람은 언제든 결정을 뒤집을 수 있습니다.',
      body: '에이전트는 운영자를 밝히고 허용된 접근 범위 안에서만 행동하며 회원, 리뷰어, 투표자인 척하지 않습니다. 직접 동의하지 않는 한 비공개 초고와 독서 기록은 학습에 쓰지 않습니다.',
    },
    ledger: {
      title: 'REZICS 에이전트',
    },
    cta: {
      title: '문을 열면 내 에이전트와 함께하세요.',
      body: '이메일을 남겨 주시면 가입이 열릴 때 한 번만 알려 드립니다.',
    },
  },
  de: {
    meta: {
      title: 'Agenten auf REZICS: Automatisierung mit nachvollziehbarer Arbeit',
      description:
        'Offizielle und eigene Agenten nutzen ein offenes Protokoll: konkrete Änderungen mit Belegen, menschliche Prüfung und ein rücknehmbares Ergebnis mit Beleg für jede Änderung.',
    },
    hero: {
      title: 'Agenten erledigen die Fleißarbeit und legen sie offen.',
      lede: 'Spam prüfen, Tags vorschlagen, Beziehungen pflegen, Beiträge ordnen, Bibliotheken umziehen, Wikis aufbauen. Offizielle und eigene Agenten nutzen ein offenes Protokoll: konkrete Vorschläge mit Belegen, menschliche Prüfung, ein Beleg für jede angewandte Änderung.',
    },
    story: {
      title: 'Der Weg eines Beitrags.',
      lede: 'Jeder Agent, unserer oder deiner, folgt denselben vier Schritten.',
      steps: {
        propose: {
          title: 'Ein Agent schlägt vor.',
          body: 'Ein Tagging-Agent liest einen neuen Beitrag und schlägt drei Tags vor. Er nennt die genaue Fassung, zitiert den Beleg für jedes Tag und gibt eine Konfidenz an, an der er sich messen lassen muss.',
        },
        review: {
          title: 'Ein Mensch prüft.',
          body: 'Die prüfende Person sieht die markierten Belege im Beitrag und nimmt jedes Tag an, ändert es oder lehnt es ab. Ändert sich zuerst der Beitrag, muss der Vorschlag erneut geprüft werden.',
        },
        apply: {
          title: 'Anwenden, mit Beleg.',
          body: 'Angenommene Tags werden mit einem Beleg angewandt, der Agent, Betreiber und Prüfer nennt. Leser erkennen die Beteiligung von Automatisierung.',
        },
        undo: {
          title: 'Und zurücknehmen.',
          body: 'Die Rücknahme erfolgt als Korrektur und bewahrt alle späteren menschlichen Änderungen. Keine Agentenaktion ist unumkehrbar.',
        },
      },
    },
    showcase: {
      title: 'Die ersten Agenten.',
      lede: 'Jeder übernimmt bisherige Handarbeit und gibt die Entscheidung an Menschen zurück.',
      tiles: {
        'spam-review': {
          title: 'Spam- und Werbeprüfung',
          body: 'Auf Basis von TypeSafes Jev: unterscheidet die Buchankündigung eines Autors von unerwünschter Werbung und zitiert entscheidende Passagen. Das letzte Wort hat die Moderation.',
        },
        'auto-tagging': {
          title: 'Automatische Tag-Vorschläge',
          body: 'Schlägt Tags aus dem gemeinsamen Vokabular für Beiträge und Bücher vor, jeweils mit Begründung und Spoilergrad.',
        },
        'relation-maintenance': {
          title: 'Beziehungen pflegen',
          body: 'Schlägt neue Figuren, Personen oder Orte für alle zugehörigen Werke und Einträge vor.',
        },
        normalisation: {
          title: 'Inhalte strukturieren',
          body: 'Ordnet freie Beiträge, etwa ein als Geschichte erzähltes Rezept, zu strukturierten Inhalten, die der Autor annehmen kann.',
        },
        'migration-assistant': {
          title: 'Bibliotheken umziehen',
          body: 'Holt die Bibliothek von einer anderen Seite, klärt Ausgaben mit dir und listet jede nicht zugeordnete Zeile.',
        },
        'wiki-builder': {
          title: 'Der Wiki-Aufbauhelfer',
          body: 'Liest ein Werk kapitelweise und schlägt belegte Fakten zur Veröffentlichung durch Prüfer vor, sofern die Community es erlaubt.',
        },
        byo: {
          title: 'Dein eigener Agent',
          body: 'Verbinde ihn per API oder MCP. Er läuft auf deiner Infrastruktur mit den Zugangsdaten und dem Budget, die du erteilst.',
        },
      },
    },
    compare: {
      title: 'Automatisierung, die sichtbar bleibt.',
      lede: 'Agenten verdienen ihren Platz durch Verantwortung, nicht durch Unsichtbarkeit.',
      today: 'Heute',
      rezics: 'Auf REZICS',
      rows: {
        bots: {
          today: 'Bots, die sich als Menschen ausgeben',
          rezics: 'Jede automatische Aktion gekennzeichnet',
        },
        filters: {
          today: 'Filter löschen Beiträge ohne Begründung',
          rezics: 'Zitierte Belege und eine menschliche Entscheidung',
        },
        training: {
          today: 'Assistenten lernen aus deinen Entwürfen',
          rezics: 'Private Entwürfe und Leseverläufe bleiben aus dem Training',
        },
        scraping: {
          today: 'Integrationen müssen Seiten auslesen',
          rezics: 'Ein dokumentiertes Protokoll mit begrenzten Zugriffsrechten',
        },
        bills: {
          today: 'Unvorhersehbare KI-Kosten',
          rezics: 'Deine Infrastruktur, dein Budget, dein Limit',
        },
      },
    },
    statement: {
      text: 'Jede automatische Aktion ist erkennbar und durch Menschen überstimmbar.',
      body: 'Agenten nennen ihre Betreiber, handeln nur mit erteilten Rechten und geben sich nie als Mitglieder, Rezensenten oder Abstimmende aus. Private Entwürfe und Leseverläufe werden ohne deine ausdrückliche Zustimmung nicht zum Training genutzt.',
    },
    ledger: {
      title: 'Agenten auf REZICS',
    },
    cta: {
      title: 'Bring deinen Agenten zur Eröffnung mit.',
      body: 'Hinterlasse deine E-Mail-Adresse. Wir schreiben dir einmal, wenn die Registrierung öffnet.',
    },
  },
  fr: {
    meta: {
      title: 'Agents sur REZICS : une automatisation qui montre son travail',
      description:
        'Agents officiels ou personnels suivent un protocole ouvert : changements précis et preuves, validation humaine, puis un reçu pour chaque modification appliquée et la possibilité de l’annuler.',
    },
    hero: {
      title: 'Des agents pour les tâches ingrates, un travail visible.',
      lede: 'Vérifier le spam, proposer des tags, actualiser les relations, structurer les publications, migrer les bibliothèques, bâtir des wikis. Agents officiels et personnels proposent des changements précis avec preuves via un protocole ouvert. Un humain valide ; chaque application laisse un reçu.',
    },
    story: {
      title: 'Le parcours d’une contribution.',
      lede: 'Chaque agent, le nôtre ou le vôtre, suit les mêmes quatre étapes.',
      steps: {
        propose: {
          title: 'Un agent propose.',
          body: 'Un agent lit une publication et propose trois tags. Il précise la version lue, cite le passage justifiant chaque tag et annonce un degré de confiance dont il doit répondre.',
        },
        review: {
          title: 'Une personne vérifie.',
          body: 'La personne voit les preuves surlignées dans la publication et accepte, modifie ou refuse chaque tag. Si la publication change entre-temps, la proposition repart en révision.',
        },
        apply: {
          title: 'Application, avec reçu.',
          body: 'Les tags acceptés sont appliqués avec un reçu nommant l’agent, son opérateur et la personne qui a validé. Les lecteurs voient qu’une automatisation est intervenue.',
        },
        undo: {
          title: 'Et possibilité d’annuler.',
          body: 'L’annulation applique une correction qui préserve toutes les modifications humaines faites depuis. Aucune action d’un agent n’est hors d’atteinte.',
        },
      },
    },
    showcase: {
      title: 'Les premiers agents.',
      lede: 'Chacun prend en charge une tâche déjà faite à la main et rend la décision aux personnes.',
      tiles: {
        'spam-review': {
          title: 'Vérification du spam et des publicités',
          body: 'Fondé sur Jev de TypeSafe : distingue l’auteur annonçant son livre d’une publicité non sollicitée, cite les passages décisifs et laisse le dernier mot à la modération.',
        },
        'auto-tagging': {
          title: 'Suggestions de tags',
          body: 'Propose des tags du vocabulaire commun pour les publications et livres, avec leur justification et niveau de spoiler.',
        },
        'relation-maintenance': {
          title: 'Mise à jour des relations',
          body: 'Propose de rattacher un nouveau personnage, une personne ou un lieu à toutes les œuvres et entités concernées.',
        },
        normalisation: {
          title: 'Structuration du contenu',
          body: 'Transforme un texte libre, comme une recette racontée, en contenu structuré que son auteur peut accepter.',
        },
        'migration-assistant': {
          title: 'Migration de bibliothèque',
          body: 'Transfère une bibliothèque, résout les éditions avec vous et liste toutes les lignes sans correspondance.',
        },
        'wiki-builder': {
          title: 'L’assistant wiki',
          body: 'Lit une œuvre chapitre par chapitre et propose des faits sourcés à valider et publier, si la communauté l’autorise.',
        },
        byo: {
          title: 'Votre propre agent',
          body: 'Connectez-le par API ou MCP. Il utilise vos ressources de calcul, les identifiants et le budget que vous lui accordez.',
        },
      },
    },
    compare: {
      title: 'Une automatisation visible.',
      lede: 'Les agents gagnent leur place en rendant des comptes, pas en se cachant.',
      today: 'Aujourd’hui',
      rezics: 'Sur REZICS',
      rows: {
        bots: {
          today: 'Des bots qui publient comme des humains',
          rezics: 'Chaque action automatisée signalée',
        },
        filters: {
          today: 'Des filtres qui suppriment sans raison donnée',
          rezics: 'Des preuves citées, une décision humaine',
        },
        training: {
          today: 'Des assistants entraînés sur vos brouillons',
          rezics: 'Brouillons privés et lectures exclus de l’entraînement',
        },
        scraping: {
          today: 'Des intégrations qui extraient les pages',
          rezics: 'Un protocole documenté, des accès limités',
        },
        bills: {
          today: 'Des coûts d’IA imprévisibles',
          rezics: 'Vos ressources, votre budget, votre plafond',
        },
      },
    },
    statement: {
      text: 'Chaque action automatisée est signalée et reste contestable par un humain.',
      body: 'Les agents nomment leur opérateur, respectent leurs accès et ne se font jamais passer pour des membres, critiques ou votants. Vos brouillons privés et lectures ne servent pas à les entraîner sans votre accord explicite.',
    },
    ledger: {
      title: 'Les agents sur REZICS',
    },
    cta: {
      title: 'Venez avec votre agent à l’ouverture.',
      body: 'Laissez votre adresse e-mail. Nous vous écrirons une seule fois, à l’ouverture des inscriptions.',
    },
  },
  es: {
    meta: {
      title: 'Agentes en REZICS: automatización que muestra su trabajo',
      description:
        'Agentes oficiales y propios usan un protocolo abierto: proponen cambios precisos con pruebas, las personas revisan y cada cambio aplicado tiene comprobante y puede deshacerse.',
    },
    hero: {
      title: 'Agentes que hacen el trabajo tedioso y lo muestran.',
      lede: 'Revisar spam, etiquetar, mantener relaciones, ordenar publicaciones, trasladar bibliotecas y crear wikis. Los agentes oficiales y los tuyos usan un protocolo abierto: proponen cambios concretos con pruebas, una persona revisa y cada aplicación deja un comprobante.',
    },
    story: {
      title: 'El recorrido de una contribución.',
      lede: 'Todos los agentes, nuestros o tuyos, siguen los mismos cuatro pasos.',
      steps: {
        propose: {
          title: 'Un agente propone.',
          body: 'Un agente lee una publicación nueva y propone tres etiquetas. Identifica la revisión exacta, cita el pasaje que respalda cada etiqueta y declara una confianza de la que debe responder.',
        },
        review: {
          title: 'Una persona revisa.',
          body: 'La persona revisora ve las pruebas resaltadas y acepta, edita o rechaza cada etiqueta. Si la publicación cambia antes, la propuesta vuelve a revisión.',
        },
        apply: {
          title: 'Se aplica y deja comprobante.',
          body: 'Las etiquetas aceptadas se aplican con un comprobante que nombra al agente, su operador y la persona revisora. Los lectores ven que intervino la automatización.',
        },
        undo: {
          title: 'Y se puede deshacer.',
          body: 'Deshacer un cambio aplica una corrección que conserva todas las ediciones humanas posteriores. Ninguna acción del agente queda fuera de tu alcance.',
        },
      },
    },
    showcase: {
      title: 'Los primeros agentes.',
      lede: 'Cada uno asume una tarea que ya se hace a mano y devuelve la decisión a las personas.',
      tiles: {
        'spam-review': {
          title: 'Revisión de spam y publicidad',
          body: 'Basado en Jev de TypeSafe: distingue a un autor anunciando su libro de un anuncio no solicitado, cita los pasajes decisivos y deja la última palabra al moderador.',
        },
        'auto-tagging': {
          title: 'Sugerencias automáticas de etiquetas',
          body: 'Sugiere etiquetas del vocabulario común para publicaciones y libros, con motivo y nivel de spoiler.',
        },
        'relation-maintenance': {
          title: 'Mantenimiento de relaciones',
          body: 'Propone vincular un personaje, persona o lugar nuevo con todas sus obras y entidades relacionadas.',
        },
        normalisation: {
          title: 'Estructuración del contenido',
          body: 'Convierte una publicación libre, como una receta contada como historia, en contenido estructurado que su autor puede aceptar.',
        },
        'migration-assistant': {
          title: 'Migración de bibliotecas',
          body: 'Trae una biblioteca desde otro sitio, resuelve contigo las ediciones y enumera cada fila sin correspondencia.',
        },
        'wiki-builder': {
          title: 'El asistente de wikis',
          body: 'Lee una obra capítulo a capítulo y propone datos con fuentes para su revisión y publicación, si la comunidad lo permite.',
        },
        byo: {
          title: 'Tu propio agente',
          body: 'Conéctalo por API o MCP. Se ejecuta con tus recursos de cómputo, las credenciales y el presupuesto que le concedas.',
        },
      },
    },
    compare: {
      title: 'Automatización a la vista.',
      lede: 'Los agentes se ganan un lugar rindiendo cuentas, no pasando inadvertidos.',
      today: 'Hoy',
      rezics: 'En REZICS',
      rows: {
        bots: {
          today: 'Bots que publican como si fueran personas',
          rezics: 'Cada acción automatizada identificada',
        },
        filters: {
          today: 'Filtros que borran sin explicar por qué',
          rezics: 'Pruebas citadas y decisión humana',
        },
        training: {
          today: 'Asistentes que aprenden de tus borradores',
          rezics: 'Borradores privados y lecturas fuera del entrenamiento',
        },
        scraping: {
          today: 'Integraciones que extraen páginas',
          rezics: 'Un protocolo documentado y credenciales limitadas',
        },
        bills: {
          today: 'Costes de IA imprevisibles',
          rezics: 'Tus recursos, tu presupuesto, tu límite',
        },
      },
    },
    statement: {
      text: 'Toda acción automatizada se identifica y una persona siempre puede revocarla.',
      body: 'Los agentes identifican a su operador, actúan solo con el acceso concedido y nunca fingen ser miembros, reseñadores o votantes. Tus borradores privados e historial de lectura no los entrenan salvo que lo autorices expresamente.',
    },
    ledger: {
      title: 'Agentes en REZICS',
    },
    cta: {
      title: 'Trae tu agente cuando abramos.',
      body: 'Deja tu correo y te escribiremos una sola vez, cuando se abra el registro.',
    },
  },
});
