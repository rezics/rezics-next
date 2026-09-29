import { defineCopy } from '../define.ts';
import type { LinePageCopy } from './page.ts';

export const communities = defineCopy<LinePageCopy>({
  en: {
    meta: {
      title: 'Realms on REZICS: communities that keep what they learn',
      description:
        'Realms gather people around one story, one language or one idea, with rules in every language, a wiki that keeps what the conversation discovers and moderation you can follow.',
    },
    hero: {
      title: 'Conversations that become knowledge.',
      lede: 'A Realm gathers people around one story, one language or one idea. Its discussions sit beside the wiki that keeps what they discover, its rules are stated in every language it speaks, and its moderation is visible to the people it affects.',
    },
    story: {
      title: 'A Realm, from its first post to its hundredth page.',
      lede: 'Communities grow in steps. Each one should leave something behind.',
      steps: {
        found: {
          title: 'Found it with rules people can read.',
          body: 'State the rules once in each language the Realm speaks. Moderators apply the same rules to everyone.',
        },
        gather: {
          title: 'Follow to read along, join to take part.',
          body: 'Readers can follow quietly; members post, reply and review. Nobody wonders which one they signed up for.',
        },
        keep: {
          title: 'Keep what the conversation finds.',
          body: 'A theory confirmed in chapter 30 becomes a sourced fact on the Realm’s wiki, linked back to the thread where it started.',
        },
        protect: {
          title: 'Protect it without silencing it.',
          body: 'Newcomers start with gentle limits that lift as they take part. Reports become cases with a reason and an appeal.',
        },
      },
    },
    showcase: {
      title: 'A community that remembers.',
      lede: 'Chat scrolls away. A Realm keeps its history and its knowledge.',
      tiles: {
        languages: {
          title: 'Many languages, one Realm',
          body: 'Post in the language you think in; others read in theirs.',
        },
        wiki: {
          title: 'A wiki that belongs to the Realm',
          body: 'The Realm decides what its wiki says and whether agents may help.',
        },
        recognition: {
          title: 'Recognition for real help',
          body: 'Levels from accepted contributions, never from streaks.',
        },
        cases: {
          title: 'Moderation you can follow',
          body: 'Every decision with its reason, every case with an appeal.',
        },
      },
    },
    compare: {
      title: 'Community without the churn.',
      lede: 'The best answers in a community should still be findable next year.',
      today: 'Today',
      rezics: 'On REZICS',
      rows: {
        scroll: {
          today: 'Answers that scroll away in chat',
          rezics: 'Discussion that feeds a sourced wiki',
        },
        owner: {
          today: 'Rules in one language, applied unevenly',
          rezics: 'Rules in every language, applied to everyone',
        },
        removals: {
          today: 'Removals without a reason',
          rezics: 'A stated reason and a way to appeal',
        },
        farming: {
          today: 'Points for showing up every day',
          rezics: 'Recognition for contributions others accepted',
        },
      },
    },
    statement: {
      text: 'Every Realm keeps what it learns.',
      body: 'Discussion, wiki and moderation live together, so a community’s knowledge outlasts any single thread.',
    },
    ledger: {
      title: 'Realms on REZICS',
      lede: 'Each capability shows where it stands today.',
    },
    cta: {
      title: 'Found your Realm when we open.',
      body: 'Leave your email and we will write once, when registration opens.',
    },
  },
  'zh-Hant': {
    meta: {
      title: 'REZICS 社群：把共同發現的知識留下來',
      description:
        '因故事、語言或想法相聚，以各種語言說明規則，透過 Wiki 留下討論中的發現，管理過程也看得明白。',
    },
    hero: {
      title: '讓聊天，慢慢成為知識。',
      lede: '一個故事、一種語言、一個想法，都能讓社群聚在一起。討論旁就是留下發現的 Wiki，規則用社群使用的各種語言說明，管理過程則對當事人公開。',
    },
    story: {
      title: '從第一篇貼文，到第一百頁 Wiki。',
      lede: '社群一步步成長，每一步都該留下些什麼。',
      steps: {
        found: {
          title: '從人人讀得懂的規則開始。',
          body: '以社群使用的每種語言，各寫一份規則。管理員對所有人採用相同標準。',
        },
        gather: {
          title: '追蹤看動態，加入來參與。',
          body: '讀者可以安靜追蹤；成員能發文、回覆與審核。選的是哪一種，始終清清楚楚。',
        },
        keep: {
          title: '把討論中的發現留下來。',
          body: '第 30 章證實的推測，成為社群 Wiki 上有出處的資訊，並連回最初提出的討論串。',
        },
        protect: {
          title: '保護社群，也保留聲音。',
          body: '新成員先有適度限制，隨參與逐步解除。檢舉會成為案件，有處理理由，也有申訴管道。',
        },
      },
    },
    showcase: {
      title: '有記憶的社群。',
      lede: '聊天會被洗上去，社群的歷史與知識則留得下來。',
      tiles: {
        languages: {
          title: '多種語言，一個社群',
          body: '用你思考的語言發文，別人用自己的語言閱讀。',
        },
        wiki: {
          title: '屬於社群的 Wiki',
          body: 'Wiki 要寫什麼、是否讓代理程式協助，由社群決定。',
        },
        recognition: {
          title: '肯定真正有幫助的貢獻',
          body: '等級來自被採納的貢獻，不靠連續簽到。',
        },
        cases: {
          title: '看得明白的管理',
          body: '每項決定都有理由，每個案件都能申訴。',
        },
      },
    },
    compare: {
      title: '讓社群的累積留下來。',
      lede: '社群裡的好答案，明年也該找得到。',
      today: '目前的做法',
      rezics: '在 REZICS',
      rows: {
        scroll: {
          today: '好答案淹沒在聊天紀錄裡',
          rezics: '討論成果進入有來源的 Wiki',
        },
        owner: {
          today: '規則只有一種語言，執行標準不一',
          rezics: '各種語言都有規則，所有人一視同仁',
        },
        removals: {
          today: '刪除內容卻不說理由',
          rezics: '說明理由，也能提出申訴',
        },
        farming: {
          today: '每天簽到就能拿積分',
          rezics: '他人採納的貢獻，才獲得肯定',
        },
      },
    },
    statement: {
      text: '每個社群，都留下共同學到的事。',
      body: '討論、Wiki 與管理放在一起，社群的知識不會隨一篇討論串結束而消失。',
    },
    ledger: {
      title: 'REZICS 社群',
      lede: '每項功能都標明目前進度。',
    },
    cta: {
      title: '開放時，建立你的社群。',
      body: '留下電子郵件，我們會在開放註冊時通知你一次。',
    },
  },
  'zh-Hans': {
    meta: {
      title: 'REZICS 社区：把共同发现的知识留下来',
      description:
        '因故事、语言或想法相聚，以各种语言说明规则，通过 Wiki 留下讨论中的发现，管理过程也看得明白。',
    },
    hero: {
      title: '让聊天，慢慢成为知识。',
      lede: '一个故事、一种语言、一个想法，都能让社区聚在一起。讨论旁就是留下发现的 Wiki，规则用社区使用的各种语言说明，管理过程则向当事人公开。',
    },
    story: {
      title: '从第一篇帖子，到第一百页 Wiki。',
      lede: '社区一步步成长，每一步都该留下些什么。',
      steps: {
        found: {
          title: '从人人读得懂的规则开始。',
          body: '用社区使用的每种语言，各写一份规则。管理员对所有人采用相同标准。',
        },
        gather: {
          title: '关注看动态，加入来参与。',
          body: '读者可以安静关注；成员能发帖、回复与审核。选的是哪一种，始终清清楚楚。',
        },
        keep: {
          title: '把讨论中的发现留下来。',
          body: '第 30 章证实的推测，成为社区 Wiki 上有出处的信息，并链接回最初提出的讨论帖。',
        },
        protect: {
          title: '保护社区，也保留声音。',
          body: '新成员先有适度限制，随参与逐步解除。举报会成为案件，有处理理由，也有申诉渠道。',
        },
      },
    },
    showcase: {
      title: '有记忆的社区。',
      lede: '聊天会被刷走，社区的历史与知识则留得下来。',
      tiles: {
        languages: {
          title: '多种语言，一个社区',
          body: '用你思考的语言发帖，别人用自己的语言阅读。',
        },
        wiki: {
          title: '属于社区的 Wiki',
          body: 'Wiki 要写什么、是否让智能体协助，由社区决定。',
        },
        recognition: {
          title: '肯定真正有帮助的贡献',
          body: '等级来自被采纳的贡献，不靠连续签到。',
        },
        cases: {
          title: '看得明白的管理',
          body: '每项决定都有理由，每个案件都能申诉。',
        },
      },
    },
    compare: {
      title: '让社区的积累留下来。',
      lede: '社区里的好答案，明年也该找得到。',
      today: '目前的做法',
      rezics: '在 REZICS',
      rows: {
        scroll: {
          today: '好答案淹没在聊天记录里',
          rezics: '讨论成果进入有来源的 Wiki',
        },
        owner: {
          today: '规则只有一种语言，执行标准不一',
          rezics: '各种语言都有规则，所有人一视同仁',
        },
        removals: {
          today: '删除内容却不说理由',
          rezics: '说明理由，也能提出申诉',
        },
        farming: {
          today: '每天签到就能拿积分',
          rezics: '他人采纳的贡献，才获得肯定',
        },
      },
    },
    statement: {
      text: '每个社区，都留下共同学到的事。',
      body: '讨论、Wiki 与管理放在一起，社区的知识不会随一篇讨论帖结束而消失。',
    },
    ledger: {
      title: 'REZICS 社区',
      lede: '每项功能都标明当前进度。',
    },
    cta: {
      title: '开放时，建立你的社区。',
      body: '留下电子邮箱，我们会在开放注册时通知你一次。',
    },
  },
  ja: {
    meta: {
      title: 'REZICSのコミュニティ：みんなの発見が残る場所',
      description:
        'ひとつの物語、言語、考えを囲んで集まる場。各言語のルール、議論の発見を残すWiki、経緯がわかるモデレーションを備えます。',
    },
    hero: {
      title: '会話が、知識になる。',
      lede: 'ひとつの物語、言語、考えを中心に集まるコミュニティ。議論のそばには発見を残すWikiがあり、ルールは使われる各言語で示され、モデレーションは当事者に見える形で進みます。',
    },
    story: {
      title: '最初の投稿から、100ページ目まで。',
      lede: 'コミュニティは少しずつ育つ。その歩みが残るように。',
      steps: {
        found: {
          title: '読めるルールから始める。',
          body: '使われる言語ごとにルールを記載。モデレーターは全員に同じルールを適用します。',
        },
        gather: {
          title: '読むならフォロー、参加するなら加入。',
          body: '読者は静かにフォローでき、メンバーは投稿・返信・確認に参加できます。どちらを選んだのか、迷うことはありません。',
        },
        keep: {
          title: '議論の発見を、残しておく。',
          body: '第30章で確かめられた考察が、出典つきの情報としてWikiに残り、最初のスレッドにつながります。',
        },
        protect: {
          title: '声を封じず、場を守る。',
          body: '新しいメンバーには軽い制限を設け、参加とともに解除。通報は理由と異議申し立ての手段を持つ案件になります。',
        },
      },
    },
    showcase: {
      title: '覚えているコミュニティ。',
      lede: 'チャットは流れても、コミュニティの歩みと知識は残ります。',
      tiles: {
        languages: {
          title: 'さまざまな言語、ひとつの場',
          body: '考える言語で投稿し、読む人は自分の言語で。',
        },
        wiki: {
          title: 'コミュニティのためのWiki',
          body: 'Wikiの内容も、エージェントの手を借りるかも、コミュニティが決めます。',
        },
        recognition: {
          title: '役に立つ貢献に、評価を',
          body: 'レベルは採用された貢献から。連続ログインでは上がりません。',
        },
        cases: {
          title: '経緯がわかるモデレーション',
          body: 'どの判断にも理由があり、どの案件にも異議を申し立てられます。',
        },
      },
    },
    compare: {
      title: '流れて終わらない、コミュニティを。',
      lede: '今年のすばらしい答えが、来年も見つかるように。',
      today: '今のやり方',
      rezics: 'REZICSなら',
      rows: {
        scroll: {
          today: 'チャットに埋もれる答え',
          rezics: '議論が出典つきWikiにつながる',
        },
        owner: {
          today: 'ルールは1言語だけ、適用もばらばら',
          rezics: '各言語のルールを、全員に同じく適用',
        },
        removals: {
          today: '理由のない削除',
          rezics: '理由を示し、異議も申し立てられる',
        },
        farming: {
          today: '毎日のログインでポイントを獲得',
          rezics: 'ほかの人が採用した貢献に評価',
        },
      },
    },
    statement: {
      text: 'みんなで知ったことを、残していく。',
      body: '議論、Wiki、モデレーションが同じ場所にあるから、知識はひとつのスレッドを越えて残ります。',
    },
    ledger: {
      title: 'REZICSのコミュニティ',
      lede: '各機能に、現在の開発状況を表示しています。',
    },
    cta: {
      title: 'オープンしたら、あなたのコミュニティを。',
      body: 'メールアドレスを残していただければ、登録開始時に一度だけお知らせします。',
    },
  },
  ko: {
    meta: {
      title: 'REZICS 커뮤니티: 함께 알아낸 것을 간직하는 곳',
      description:
        '이야기, 언어, 생각을 중심으로 모이는 커뮤니티. 언어별 규칙, 토론에서 찾은 지식을 남기는 위키, 과정을 알 수 있는 운영을 갖춥니다.',
    },
    hero: {
      title: '대화가 지식이 되는 곳.',
      lede: '하나의 이야기, 언어, 생각을 중심으로 사람들이 모입니다. 토론 곁에는 발견한 것을 남기는 위키가 있고, 사용하는 모든 언어로 규칙을 안내합니다. 운영 과정은 당사자가 확인할 수 있습니다.',
    },
    story: {
      title: '첫 게시물에서 백 번째 페이지까지.',
      lede: '커뮤니티는 한 걸음씩 자랍니다. 매 걸음이 무언가를 남겨야 합니다.',
      steps: {
        found: {
          title: '모두가 읽을 수 있는 규칙부터.',
          body: '커뮤니티에서 쓰는 언어마다 규칙을 작성합니다. 운영자는 모두에게 같은 규칙을 적용합니다.',
        },
        gather: {
          title: '소식은 팔로우로, 참여는 가입으로.',
          body: '독자는 조용히 팔로우하고, 회원은 글을 쓰고 답하고 검토에 참여합니다. 어떤 상태를 선택했는지 언제나 명확합니다.',
        },
        keep: {
          title: '대화에서 찾은 것을 남기세요.',
          body: '30장에서 확인된 추측은 출처 있는 정보로 위키에 남고, 처음 제기된 토론으로 연결됩니다.',
        },
        protect: {
          title: '목소리를 막지 않고 지키세요.',
          body: '새 회원은 가벼운 제한으로 시작하고 참여하면서 제한이 풀립니다. 신고는 이유와 이의 제기 절차가 있는 사건으로 처리합니다.',
        },
      },
    },
    showcase: {
      title: '기억하는 커뮤니티.',
      lede: '채팅은 밀려나도 커뮤니티의 역사와 지식은 남습니다.',
      tiles: {
        languages: {
          title: '여러 언어, 하나의 커뮤니티',
          body: '생각하는 언어로 쓰고, 다른 사람은 자신의 언어로 읽습니다.',
        },
        wiki: {
          title: '커뮤니티의 위키',
          body: '위키에 무엇을 담고 에이전트의 도움을 받을지는 커뮤니티가 정합니다.',
        },
        recognition: {
          title: '실질적인 도움에 주는 인정',
          body: '등급은 채택된 기여로 올립니다. 연속 출석으로는 오르지 않습니다.',
        },
        cases: {
          title: '과정을 알 수 있는 운영',
          body: '모든 결정에 이유가 있고 모든 사건에 이의를 제기할 수 있습니다.',
        },
      },
    },
    compare: {
      title: '쌓아 온 것이 남는 커뮤니티.',
      lede: '커뮤니티의 좋은 답변은 내년에도 찾을 수 있어야 합니다.',
      today: '지금은',
      rezics: 'REZICS에서는',
      rows: {
        scroll: {
          today: '채팅에 묻히는 답변',
          rezics: '토론이 출처 있는 위키로 이어짐',
        },
        owner: {
          today: '한 언어의 규칙, 제각각인 적용',
          rezics: '모든 언어의 규칙을 모두에게 적용',
        },
        removals: {
          today: '이유 없는 삭제',
          rezics: '이유 설명과 이의 제기 절차',
        },
        farming: {
          today: '매일 출석하면 주는 점수',
          rezics: '다른 사람이 채택한 기여에 인정',
        },
      },
    },
    statement: {
      text: '함께 알아낸 것은 커뮤니티에 남습니다.',
      body: '토론, 위키, 운영이 한곳에 있어 커뮤니티의 지식은 개별 토론이 끝나도 남습니다.',
    },
    ledger: {
      title: 'REZICS 커뮤니티',
      lede: '각 기능에 현재 진행 상황을 표시합니다.',
    },
    cta: {
      title: '문을 열면 내 커뮤니티를 만드세요.',
      body: '이메일을 남겨 주시면 가입이 열릴 때 한 번만 알려 드립니다.',
    },
  },
  de: {
    meta: {
      title: 'Communitys auf REZICS: gemeinsam lernen, Wissen bewahren',
      description:
        'Communitys rund um Geschichten, Sprachen oder Ideen: Regeln in jeder Sprache, ein Wiki für gemeinsame Entdeckungen und nachvollziehbare Moderation.',
    },
    hero: {
      title: 'Gespräche, aus denen Wissen wird.',
      lede: 'Eine Community versammelt Menschen um eine Geschichte, Sprache oder Idee. Neben den Diskussionen hält ihr Wiki Entdeckungen fest. Regeln gibt es in allen genutzten Sprachen, Moderation ist für Betroffene nachvollziehbar.',
    },
    story: {
      title: 'Vom ersten Beitrag zur hundertsten Seite.',
      lede: 'Communitys wachsen Schritt für Schritt. Jeder Schritt sollte etwas hinterlassen.',
      steps: {
        found: {
          title: 'Mit verständlichen Regeln gründen.',
          body: 'Formuliere die Regeln in jeder Sprache der Community. Die Moderation wendet dieselben Regeln auf alle an.',
        },
        gather: {
          title: 'Folgen zum Mitlesen, beitreten zum Mitmachen.',
          body: 'Leser können still folgen; Mitglieder schreiben, antworten und prüfen. Alle wissen, wofür sie sich entschieden haben.',
        },
        keep: {
          title: 'Entdeckungen aus Gesprächen bewahren.',
          body: 'Eine in Kapitel 30 bestätigte Theorie wird zum belegten Wiki-Eintrag, verlinkt mit dem ursprünglichen Thread.',
        },
        protect: {
          title: 'Schützen, ohne zum Schweigen zu bringen.',
          body: 'Neue Mitglieder beginnen mit sanften Grenzen, die durch Teilnahme fallen. Meldungen werden zu Fällen mit Begründung und Einspruchsmöglichkeit.',
        },
      },
    },
    showcase: {
      title: 'Eine Community mit Gedächtnis.',
      lede: 'Chats verschwinden im Verlauf. Eine Community bewahrt ihre Geschichte und ihr Wissen.',
      tiles: {
        languages: {
          title: 'Viele Sprachen, eine Community',
          body: 'Schreib in deiner Denksprache, andere lesen in ihrer.',
        },
        wiki: {
          title: 'Das Wiki der Community',
          body: 'Die Community entscheidet über Inhalte und ob Agenten helfen dürfen.',
        },
        recognition: {
          title: 'Anerkennung für echte Hilfe',
          body: 'Level durch angenommene Beiträge, nie durch tägliche Serien.',
        },
        cases: {
          title: 'Nachvollziehbare Moderation',
          body: 'Jede Entscheidung mit Begründung, jeder Fall mit Einspruch.',
        },
      },
    },
    compare: {
      title: 'Gemeinschaft, die Bestand hat.',
      lede: 'Die besten Antworten sollten auch nächstes Jahr noch auffindbar sein.',
      today: 'Heute',
      rezics: 'Auf REZICS',
      rows: {
        scroll: {
          today: 'Antworten verschwinden im Chat',
          rezics: 'Diskussionen speisen ein belegtes Wiki',
        },
        owner: {
          today: 'Einsprachige Regeln, ungleich angewandt',
          rezics: 'Regeln in jeder Sprache, für alle gleich',
        },
        removals: {
          today: 'Löschungen ohne Begründung',
          rezics: 'Begründung und Einspruchsmöglichkeit',
        },
        farming: {
          today: 'Punkte fürs tägliche Auftauchen',
          rezics: 'Anerkennung für angenommene Beiträge',
        },
      },
    },
    statement: {
      text: 'Jede Community bewahrt, was sie lernt.',
      body: 'Diskussion, Wiki und Moderation gehören zusammen. So bleibt Wissen länger als ein einzelner Thread.',
    },
    ledger: {
      title: 'Communitys auf REZICS',
      lede: 'Jede Funktion zeigt ihren aktuellen Stand.',
    },
    cta: {
      title: 'Gründe deine Community zur Eröffnung.',
      body: 'Hinterlasse deine E-Mail-Adresse. Wir schreiben dir einmal, wenn die Registrierung öffnet.',
    },
  },
  fr: {
    meta: {
      title: 'Communautés sur REZICS : garder ce qu’on découvre ensemble',
      description:
        'Des communautés autour d’une histoire, d’une langue ou d’une idée : règles multilingues, wiki qui garde les découvertes et modération compréhensible.',
    },
    hero: {
      title: 'Des conversations qui deviennent du savoir.',
      lede: 'Une communauté réunit autour d’une histoire, d’une langue ou d’une idée. Son wiki garde les découvertes des discussions, ses règles existent dans chaque langue pratiquée et sa modération est visible des personnes concernées.',
    },
    story: {
      title: 'Du premier message à la centième page.',
      lede: 'Une communauté grandit par étapes. Chacune devrait laisser une trace.',
      steps: {
        found: {
          title: 'Commencez par des règles lisibles.',
          body: 'Énoncez les règles dans chaque langue de la communauté. La modération applique les mêmes règles à tous.',
        },
        gather: {
          title: 'Suivre pour lire, rejoindre pour participer.',
          body: 'Les lecteurs peuvent suivre discrètement ; les membres publient, répondent et relisent. Chacun sait quel engagement il a choisi.',
        },
        keep: {
          title: 'Gardez les découvertes des échanges.',
          body: 'Une théorie confirmée au chapitre 30 devient un fait sourcé du wiki, relié au fil qui l’a vue naître.',
        },
        protect: {
          title: 'Protéger sans faire taire.',
          body: 'Les nouveaux ont des limites légères qui s’assouplissent avec la participation. Chaque signalement ouvre un dossier avec motif et recours.',
        },
      },
    },
    showcase: {
      title: 'Une communauté qui se souvient.',
      lede: 'Le fil du chat défile. La communauté garde son histoire et son savoir.',
      tiles: {
        languages: {
          title: 'Plusieurs langues, une communauté',
          body: 'Publiez dans la langue où vous pensez ; les autres lisent dans la leur.',
        },
        wiki: {
          title: 'Le wiki de la communauté',
          body: 'La communauté décide du contenu du wiki et de l’aide éventuelle des agents.',
        },
        recognition: {
          title: 'Reconnaître les contributions utiles',
          body: 'Des niveaux gagnés par les contributions acceptées, jamais par l’assiduité quotidienne.',
        },
        cases: {
          title: 'Une modération compréhensible',
          body: 'Chaque décision a son motif, chaque dossier son recours.',
        },
      },
    },
    compare: {
      title: 'Une communauté qui ne perd pas ses acquis.',
      lede: 'Les meilleures réponses devraient rester trouvables l’année prochaine.',
      today: 'Aujourd’hui',
      rezics: 'Sur REZICS',
      rows: {
        scroll: {
          today: 'Des réponses perdues dans le chat',
          rezics: 'Les échanges nourrissent un wiki sourcé',
        },
        owner: {
          today: 'Des règles monolingues, appliquées inégalement',
          rezics: 'Des règles dans chaque langue, pour tous',
        },
        removals: {
          today: 'Des suppressions sans explication',
          rezics: 'Un motif explicite et un recours',
        },
        farming: {
          today: 'Des points pour la présence quotidienne',
          rezics: 'La reconnaissance des contributions acceptées',
        },
      },
    },
    statement: {
      text: 'Chaque communauté garde ce qu’elle apprend.',
      body: 'Discussions, wiki et modération vivent ensemble : le savoir de la communauté survit à chaque fil.',
    },
    ledger: {
      title: 'Les communautés sur REZICS',
      lede: 'Chaque fonctionnalité indique où elle en est.',
    },
    cta: {
      title: 'Fondez votre communauté à l’ouverture.',
      body: 'Laissez votre adresse e-mail. Nous vous écrirons une seule fois, à l’ouverture des inscriptions.',
    },
  },
  es: {
    meta: {
      title: 'Comunidades en REZICS: conservar lo que aprenden juntas',
      description:
        'Comunidades en torno a una historia, un idioma o una idea, con reglas en cada lengua, un wiki que conserva lo descubierto y moderación que puedes seguir.',
    },
    hero: {
      title: 'Conversaciones que se convierten en conocimiento.',
      lede: 'Una comunidad reúne a personas en torno a una historia, idioma o idea. Junto a los debates, su wiki conserva los hallazgos; las reglas están en cada idioma usado y la moderación es visible para quienes afecta.',
    },
    story: {
      title: 'De la primera publicación a la página cien.',
      lede: 'Las comunidades crecen paso a paso. Cada paso debería dejar algo.',
      steps: {
        found: {
          title: 'Empieza con reglas que se puedan leer.',
          body: 'Redacta las reglas en cada idioma de la comunidad. La moderación aplica las mismas reglas a todos.',
        },
        gather: {
          title: 'Sigue para leer, únete para participar.',
          body: 'Los lectores pueden seguir en silencio; los miembros publican, responden y revisan. Nadie duda de qué opción eligió.',
        },
        keep: {
          title: 'Conserva lo que descubre la conversación.',
          body: 'Una teoría confirmada en el capítulo 30 pasa al wiki con su fuente y un enlace al hilo donde nació.',
        },
        protect: {
          title: 'Protege sin silenciar.',
          body: 'Los nuevos miembros empiezan con límites suaves que se levantan al participar. Los reportes se convierten en casos con motivo y apelación.',
        },
      },
    },
    showcase: {
      title: 'Una comunidad con memoria.',
      lede: 'El chat se pierde al avanzar. La comunidad conserva su historia y conocimiento.',
      tiles: {
        languages: {
          title: 'Muchos idiomas, una comunidad',
          body: 'Publica en el idioma en que piensas; los demás leen en el suyo.',
        },
        wiki: {
          title: 'El wiki de la comunidad',
          body: 'La comunidad decide qué dice su wiki y si los agentes pueden ayudar.',
        },
        recognition: {
          title: 'Reconocimiento por ayudar de verdad',
          body: 'Niveles por aportaciones aceptadas, nunca por rachas de asistencia.',
        },
        cases: {
          title: 'Moderación que puedes seguir',
          body: 'Cada decisión tiene un motivo y cada caso, una apelación.',
        },
      },
    },
    compare: {
      title: 'Una comunidad que conserva lo construido.',
      lede: 'Las mejores respuestas deberían seguir encontrándose el año que viene.',
      today: 'Hoy',
      rezics: 'En REZICS',
      rows: {
        scroll: {
          today: 'Respuestas que se pierden en el chat',
          rezics: 'Debates que alimentan un wiki con fuentes',
        },
        owner: {
          today: 'Reglas en un idioma y aplicación desigual',
          rezics: 'Reglas en cada idioma, aplicadas a todos',
        },
        removals: {
          today: 'Eliminaciones sin explicación',
          rezics: 'Un motivo claro y una vía de apelación',
        },
        farming: {
          today: 'Puntos por entrar cada día',
          rezics: 'Reconocimiento por aportaciones aceptadas',
        },
      },
    },
    statement: {
      text: 'Cada comunidad conserva lo que aprende.',
      body: 'Debates, wiki y moderación conviven para que el conocimiento dure más que cualquier hilo.',
    },
    ledger: {
      title: 'Comunidades en REZICS',
      lede: 'Cada función indica su estado actual.',
    },
    cta: {
      title: 'Funda tu comunidad cuando abramos.',
      body: 'Deja tu correo y te escribiremos una sola vez, cuando se abra el registro.',
    },
  },
});
