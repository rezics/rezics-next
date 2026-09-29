import type { FeatureId } from '../../features.ts';
import { defineCopy } from '../define.ts';

/** One statement per feature in `features.ts`; its status renders beside it. Draft copy for G-481. */
export type FeatureCopy = Record<FeatureId, { title: string; body: string }>;

const en: FeatureCopy = {
  'native-multilingual': {
    title: 'Natively multilingual',
    body: 'Titles, editions, translations and discussion each keep their own language. Nothing is quietly replaced by English.',
  },
  'portable-data': {
    title: 'Your data is portable',
    body: 'Bring your reading history in and take all of it out again, without losing what it meant.',
  },
  'open-source': {
    title: 'Open source',
    body: 'The code is meant to be read, run and improved in the open.',
  },
  'api-agent-first': {
    title: 'API- and agent-first',
    body: 'Everything a person can do in the browser has an API, so your own tools and assistants can do it too.',
  },
  'portable-library': {
    title: 'A library that travels',
    body: 'Shelves, progress and ratings stay yours, wherever you read.',
  },
  'reading-sessions': {
    title: 'Reading sessions',
    body: 'Record reads, pauses, rereads and books you gave up on, per edition and format.',
  },
  'library-exchange': {
    title: 'Import and export',
    body: 'Move a library in from another service and back out again, with a preview of anything that will not carry over.',
  },
  'series-tracking': {
    title: 'Series tracking',
    body: 'See what is out, what you own, what you read and what comes next, for every volume.',
  },
  'edition-coverage': {
    title: 'Editions that stay distinct',
    body: 'Volumes, omnibuses, regions and platforms are separate things, never guessed from a matching title.',
  },
  'translation-availability': {
    title: 'Translation availability',
    body: 'Follow a series in the language you read and hear when the next volume appears.',
  },
  'serial-writing': {
    title: 'Drafting you can trust',
    body: 'Drafts save continuously, survive a lost connection and can be restored to any earlier revision.',
  },
  'serial-scheduling': {
    title: 'Scheduled chapters',
    body: 'Plan releases in your own time zone and let readers follow along.',
  },
  'serial-reading': {
    title: 'Calm reading',
    body: 'Pick up at the exact place you stopped, on any device, with spoilers held back.',
  },
  'vn-releases': {
    title: 'Visual novels by release',
    body: 'Choose by language, platform and edition, not just by title.',
  },
  'release-provenance': {
    title: 'Translator provenance',
    body: 'See who translated a release, from which source and how complete it is.',
  },
  'anime-episodes': {
    title: 'Anime by episode',
    body: 'Track seasons and episodes, and talk about an episode without spoiling the next.',
  },
  'realm-wikis': {
    title: 'Realm wikis',
    body: 'Each Realm keeps a wiki with citations, links, backlinks and discussion.',
  },
  'wiki-history': {
    title: 'History you can review',
    body: 'Every edit is reviewed, compared and reversible, and the whole wiki exports.',
  },
  'agent-wikis': {
    title: 'Agent-built wikis',
    body: 'Assistants can draft pages from sources you approve; people review before anything is published.',
  },
  realms: {
    title: 'Realms',
    body: 'Communities that gather around a story, a language or an idea, with their own rules.',
  },
  'community-rules': {
    title: 'Rules in every language',
    body: 'A Realm states its rules once per language, and moderation follows them.',
  },
  'newcomer-trust': {
    title: 'Room for newcomers',
    body: 'New members start with sensible limits that grow as they take part.',
  },
  'publish-books': {
    title: 'Publish a book',
    body: 'Bring a finished book or game to readers with its rights and translations stated.',
  },
  'sell-books-games': {
    title: 'Sell what you make',
    body: 'Offer paid editions and let buyers keep and export what they bought.',
  },
  'rights-declarations': {
    title: 'Rights, stated plainly',
    body: 'Say who made a work, who translated it and what you may do with it.',
  },
  'open-api': {
    title: 'An open API',
    body: 'A documented interface for the whole product, with errors your code can act on.',
  },
  'scoped-credentials': {
    title: 'Scoped credentials',
    body: 'Give a tool only the access it needs, and revoke it in one place.',
  },
  'typescript-sdk': {
    title: 'A TypeScript SDK',
    body: 'Typed clients generated from the same definitions as the API.',
  },
  'mcp-agents': {
    title: 'Bring your own agent',
    body: 'Connect an assistant of your choice through MCP, with approvals and a receipt for every action.',
  },
  'suitability-gates': {
    title: 'Suitability you control',
    body: 'General, teen, sexual and graphic material are separate choices, and nothing unrated is shown as general.',
  },
  'ai-disclosure': {
    title: 'AI disclosure',
    body: 'Prose, art and translations say whether AI was used and whether a person reviewed it.',
  },
  'no-trackers': {
    title: 'No trackers',
    body: 'No advertising trackers and no third-party analytics on this site.',
  },
  'reporting-appeals': {
    title: 'Reporting and appeals',
    body: 'Anyone can report a problem, and every decision can be appealed.',
  },
};

export const featureCopy = defineCopy<FeatureCopy>({
  en,
  'zh-Hant': {
    'native-multilingual': {
      title: '原生多語言',
      body: '書名、版本、翻譯與討論都保有各自的語言，不會被悄悄換成英文。',
    },
    'portable-data': {
      title: '資料帶得走',
      body: '匯入你的閱讀紀錄，也能完整匯出，不遺失原本的意義。',
    },
    'open-source': { title: '開放原始碼', body: '程式碼公開，讓人閱讀、執行與改進。' },
    'api-agent-first': {
      title: 'API 與代理優先',
      body: '在瀏覽器裡能做的事都有 API，你自己的工具與助理也能做到。',
    },
    'portable-library': { title: '隨身書庫', body: '書架、進度與評分永遠屬於你，不論在哪裡閱讀。' },
    'reading-sessions': { title: '閱讀紀錄', body: '依版本與格式記錄讀過、暫停、重讀與放棄的書。' },
    'library-exchange': {
      title: '匯入與匯出',
      body: '從其他服務匯入書庫，也能匯出，並預覽無法轉移的內容。',
    },
    'series-tracking': {
      title: '系列追蹤',
      body: '每一冊都看得到：出版了什麼、擁有什麼、讀了什麼、下一步是什麼。',
    },
    'edition-coverage': {
      title: '版本各自獨立',
      body: '單行本、合訂本、地區與平台是不同的東西，不會只靠書名相同就猜測。',
    },
    'translation-availability': {
      title: '翻譯上市通知',
      body: '以你閱讀的語言追蹤系列，下一冊出現時通知你。',
    },
    'serial-writing': {
      title: '值得信賴的草稿',
      body: '草稿持續儲存、斷線也不遺失，並可還原到任一舊版本。',
    },
    'serial-scheduling': { title: '排程發布章節', body: '以你的時區安排發布，讓讀者持續追讀。' },
    'serial-reading': { title: '安靜的閱讀', body: '在任何裝置上從停下的位置繼續，並避開劇透。' },
    'vn-releases': {
      title: '依發行版本找視覺小說',
      body: '依語言、平台與版本選擇，而不只看書名。',
    },
    'release-provenance': {
      title: '翻譯來源',
      body: '看到誰翻譯了這個版本、依據哪個來源，以及完成度。',
    },
    'anime-episodes': { title: '依集數追蹤動畫', body: '追蹤季與集，討論單集而不劇透下一集。' },
    'realm-wikis': {
      title: '社群 Wiki',
      body: '每個社群都有 Wiki，含引用、連結、反向連結與討論。',
    },
    'wiki-history': {
      title: '可審閱的歷史',
      body: '每次編輯都經審閱、可比較、可還原，整個 Wiki 也能匯出。',
    },
    'agent-wikis': {
      title: '代理協作的 Wiki',
      body: '助理可依你核准的來源起草頁面；發布前由人審閱。',
    },
    realms: { title: '社群', body: '圍繞一部作品、一種語言或一個想法而聚集，並有自己的規則。' },
    'community-rules': {
      title: '各語言的規則',
      body: '社群以每種語言各訂一次規則，管理依規則進行。',
    },
    'newcomer-trust': { title: '給新成員的空間', body: '新成員從合理的限制開始，隨參與逐步放寬。' },
    'publish-books': {
      title: '出版一本書',
      body: '把完成的書或遊戲交到讀者手上，並清楚註明權利與翻譯。',
    },
    'sell-books-games': {
      title: '販售你的作品',
      body: '提供付費版本，讓買家保有並匯出所購買的內容。',
    },
    'rights-declarations': {
      title: '清楚說明權利',
      body: '註明誰創作、誰翻譯，以及你能怎麼使用。',
    },
    'open-api': { title: '開放的 API', body: '涵蓋整個產品的文件化介面，錯誤訊息可供程式處理。' },
    'scoped-credentials': {
      title: '限定範圍的憑證',
      body: '只給工具它需要的權限，並在同一處撤銷。',
    },
    'typescript-sdk': { title: 'TypeScript SDK', body: '由 API 同一份定義產生的型別化用戶端。' },
    'mcp-agents': {
      title: '自帶代理',
      body: '透過 MCP 連接你選擇的助理，每個動作都需核准並留下收據。',
    },
    'suitability-gates': {
      title: '由你掌控的分級',
      body: '一般、青少年、性與血腥內容各自獨立設定，未分級的內容不會當成一般內容顯示。',
    },
    'ai-disclosure': {
      title: 'AI 揭露',
      body: '文字、美術與翻譯會標明是否使用 AI，以及是否經人審閱。',
    },
    'no-trackers': { title: '沒有追蹤器', body: '本站沒有廣告追蹤器，也沒有第三方分析。' },
    'reporting-appeals': { title: '檢舉與申訴', body: '任何人都能檢舉問題，每項決定都能申訴。' },
  },
  'zh-Hans': {
    'native-multilingual': {
      title: '原生多语言',
      body: '书名、版本、翻译与讨论都保有各自的语言，不会被悄悄换成英文。',
    },
    'portable-data': {
      title: '数据带得走',
      body: '导入你的阅读记录，也能完整导出，不丢失原本的含义。',
    },
    'open-source': { title: '开源', body: '代码公开，供人阅读、运行和改进。' },
    'api-agent-first': {
      title: 'API 与智能体优先',
      body: '在浏览器里能做的事都有 API，你自己的工具和助手也能做到。',
    },
    'portable-library': { title: '随身书库', body: '书架、进度和评分永远属于你，无论在哪里阅读。' },
    'reading-sessions': { title: '阅读记录', body: '按版本和格式记录读过、暂停、重读和放弃的书。' },
    'library-exchange': {
      title: '导入与导出',
      body: '从其他服务导入书库，也能导出，并预览无法迁移的内容。',
    },
    'series-tracking': {
      title: '系列追踪',
      body: '每一册都看得到：出版了什么、拥有什么、读了什么、下一步是什么。',
    },
    'edition-coverage': {
      title: '版本各自独立',
      body: '单行本、合订本、地区和平台是不同的东西，不会只凭书名相同就猜测。',
    },
    'translation-availability': {
      title: '翻译上架通知',
      body: '以你阅读的语言追踪系列，下一册出现时通知你。',
    },
    'serial-writing': {
      title: '值得信赖的草稿',
      body: '草稿持续保存、断网也不丢失，并可恢复到任一旧版本。',
    },
    'serial-scheduling': { title: '定时发布章节', body: '按你的时区安排发布，让读者持续追更。' },
    'serial-reading': { title: '安静的阅读', body: '在任何设备上从停下的位置继续，并避开剧透。' },
    'vn-releases': {
      title: '按发行版本找视觉小说',
      body: '按语言、平台和版本选择，而不只看书名。',
    },
    'release-provenance': {
      title: '翻译来源',
      body: '看到谁翻译了这个版本、依据哪个来源，以及完成度。',
    },
    'anime-episodes': { title: '按集数追踪动画', body: '追踪季与集，讨论单集而不剧透下一集。' },
    'realm-wikis': {
      title: '社区 Wiki',
      body: '每个社区都有 Wiki，含引用、链接、反向链接和讨论。',
    },
    'wiki-history': {
      title: '可审阅的历史',
      body: '每次编辑都经审阅、可比较、可恢复，整个 Wiki 也能导出。',
    },
    'agent-wikis': {
      title: '智能体协作的 Wiki',
      body: '助手可依你批准的来源起草页面；发布前由人审阅。',
    },
    realms: { title: '社区', body: '围绕一部作品、一种语言或一个想法而聚集，并有自己的规则。' },
    'community-rules': {
      title: '各语言的规则',
      body: '社区以每种语言各订一次规则，管理依规则进行。',
    },
    'newcomer-trust': { title: '给新成员的空间', body: '新成员从合理的限制开始，随参与逐步放宽。' },
    'publish-books': {
      title: '出版一本书',
      body: '把完成的书或游戏交到读者手上，并清楚注明权利和翻译。',
    },
    'sell-books-games': {
      title: '销售你的作品',
      body: '提供付费版本，让买家保有并导出所购买的内容。',
    },
    'rights-declarations': {
      title: '清楚说明权利',
      body: '注明谁创作、谁翻译，以及你能怎么使用。',
    },
    'open-api': { title: '开放的 API', body: '覆盖整个产品的文档化接口，错误信息可供程序处理。' },
    'scoped-credentials': {
      title: '限定范围的凭证',
      body: '只给工具它需要的权限，并在同一处撤销。',
    },
    'typescript-sdk': { title: 'TypeScript SDK', body: '由 API 同一份定义生成的类型化客户端。' },
    'mcp-agents': {
      title: '自带智能体',
      body: '通过 MCP 连接你选择的助手，每个动作都需批准并留下回执。',
    },
    'suitability-gates': {
      title: '由你掌控的分级',
      body: '一般、青少年、性与血腥内容各自独立设置，未分级的内容不会当作一般内容显示。',
    },
    'ai-disclosure': {
      title: 'AI 披露',
      body: '文字、美术和翻译会注明是否使用 AI，以及是否经人审阅。',
    },
    'no-trackers': { title: '没有追踪器', body: '本站没有广告追踪器，也没有第三方分析。' },
    'reporting-appeals': { title: '举报与申诉', body: '任何人都能举报问题，每项决定都能申诉。' },
  },
  ja: {
    'native-multilingual': {
      title: '多言語が前提',
      body: 'タイトル、版、翻訳、議論は、それぞれの言語のまま。黙って英語に置き換えることはありません。',
    },
    'portable-data': {
      title: 'データは持ち出せる',
      body: '読書履歴を取り込み、意味を失わずにすべて書き出せます。',
    },
    'open-source': {
      title: 'オープンソース',
      body: 'コードは、読まれ、動かされ、改良されることを前提に公開します。',
    },
    'api-agent-first': {
      title: 'API とエージェントが先',
      body: 'ブラウザでできることはすべて API からもでき、あなたのツールやアシスタントにも使えます。',
    },
    'portable-library': {
      title: '持ち歩けるライブラリ',
      body: '本棚、進捗、評価は、どこで読んでもあなたのものです。',
    },
    'reading-sessions': {
      title: '読書セッション',
      body: '読了、中断、再読、断念を、版と形式ごとに記録します。',
    },
    'library-exchange': {
      title: 'インポートとエクスポート',
      body: '他のサービスからライブラリを移し、また書き出せます。移せないものは事前に確認できます。',
    },
    'series-tracking': {
      title: 'シリーズの追跡',
      body: '巻ごとに、発売済み、所有、読了、次の巻がわかります。',
    },
    'edition-coverage': {
      title: '版を区別する',
      body: '単行本、合本、地域、プラットフォームは別のもの。タイトルが同じというだけで推測しません。',
    },
    'translation-availability': {
      title: '翻訳の入手状況',
      body: '読みたい言語でシリーズを追い、次の巻が出たら知らせを受け取れます。',
    },
    'serial-writing': {
      title: '信頼できる下書き',
      body: '下書きは常時保存され、接続が切れても失われず、過去の版に戻せます。',
    },
    'serial-scheduling': {
      title: '章の予約公開',
      body: 'あなたのタイムゾーンで公開を計画し、読者に追ってもらえます。',
    },
    'serial-reading': {
      title: '落ち着いた読書',
      body: 'どの端末でも止めた場所から再開でき、ネタバレは伏せられます。',
    },
    'vn-releases': {
      title: 'リリースで選ぶビジュアルノベル',
      body: 'タイトルだけでなく、言語、プラットフォーム、版で選べます。',
    },
    'release-provenance': {
      title: '翻訳者の出自',
      body: '誰がどの原典から翻訳したか、どこまで完成しているかがわかります。',
    },
    'anime-episodes': {
      title: '話数で追うアニメ',
      body: 'シーズンと話数を記録し、次の話のネタバレなしで一話について語れます。',
    },
    'realm-wikis': {
      title: 'コミュニティのウィキ',
      body: 'コミュニティごとに、出典、リンク、被リンク、議論を備えたウィキを持てます。',
    },
    'wiki-history': {
      title: '確認できる履歴',
      body: 'すべての編集は確認・比較・取り消しができ、ウィキ全体を書き出せます。',
    },
    'agent-wikis': {
      title: 'エージェントが作るウィキ',
      body: 'アシスタントが承認済みの出典からページを下書きし、公開前に人が確認します。',
    },
    realms: {
      title: 'コミュニティ',
      body: 'ひとつの物語、言語、関心のもとに集まり、独自のルールを持ちます。',
    },
    'community-rules': {
      title: '言語ごとのルール',
      body: 'ルールは言語ごとに一度定め、モデレーションはそれに従います。',
    },
    'newcomer-trust': {
      title: '新しい人の居場所',
      body: '新しいメンバーは無理のない制限から始まり、参加とともに広がります。',
    },
    'publish-books': {
      title: '本を公開する',
      body: '完成した本やゲームを、権利と翻訳を明示して読者に届けます。',
    },
    'sell-books-games': {
      title: '作ったものを販売する',
      body: '有料の版を提供し、購入者は買ったものを手元に残して書き出せます。',
    },
    'rights-declarations': {
      title: '権利をはっきりと',
      body: '誰が作り、誰が翻訳し、何をしてよいかを明示します。',
    },
    'open-api': {
      title: 'オープンな API',
      body: 'プロダクト全体を文書化したインターフェース。エラーはコードで扱えます。',
    },
    'scoped-credentials': {
      title: '範囲を絞った認証情報',
      body: 'ツールには必要な権限だけを渡し、一か所で取り消せます。',
    },
    'typescript-sdk': {
      title: 'TypeScript SDK',
      body: 'API と同じ定義から生成される型付きクライアント。',
    },
    'mcp-agents': {
      title: '好きなエージェントを持ち込む',
      body: 'MCP でお好みのアシスタントをつなぎ、操作ごとに承認と記録を残します。',
    },
    'suitability-gates': {
      title: '自分で決める年齢区分',
      body: '一般、15歳以上、性的表現、グロテスク表現は別々に選べ、未評価のものを一般として表示することはありません。',
    },
    'ai-disclosure': {
      title: 'AI の開示',
      body: '文章、画像、翻訳に AI を使ったか、人が確認したかを示します。',
    },
    'no-trackers': {
      title: 'トラッカーなし',
      body: 'このサイトには広告トラッカーも、第三者の解析もありません。',
    },
    'reporting-appeals': {
      title: '通報と異議申し立て',
      body: '誰でも問題を通報でき、すべての判断に異議を申し立てられます。',
    },
  },
  ko: {
    'native-multilingual': {
      title: '처음부터 다국어',
      body: '제목, 판본, 번역, 토론이 각자의 언어를 유지합니다. 조용히 영어로 바뀌는 일은 없습니다.',
    },
    'portable-data': {
      title: '내 데이터는 가져갈 수 있습니다',
      body: '독서 기록을 가져오고, 의미를 잃지 않은 채 전부 내보낼 수 있습니다.',
    },
    'open-source': {
      title: '오픈 소스',
      body: '코드는 공개되어 읽고, 실행하고, 개선할 수 있게 하는 것이 목표입니다.',
    },
    'api-agent-first': {
      title: 'API와 에이전트 우선',
      body: '브라우저에서 할 수 있는 모든 일에 API가 있어 내 도구와 어시스턴트도 할 수 있습니다.',
    },
    'portable-library': {
      title: '들고 다니는 서재',
      body: '서가, 진행 상황, 평점은 어디서 읽든 내 것입니다.',
    },
    'reading-sessions': {
      title: '독서 기록',
      body: '완독, 중단, 재독, 포기한 책을 판본과 형식별로 기록합니다.',
    },
    'library-exchange': {
      title: '가져오기와 내보내기',
      body: '다른 서비스에서 서재를 가져오고 다시 내보낼 수 있으며, 옮겨지지 않는 항목은 미리 확인합니다.',
    },
    'series-tracking': {
      title: '시리즈 추적',
      body: '권마다 출간된 것, 가진 것, 읽은 것, 다음 권을 확인합니다.',
    },
    'edition-coverage': {
      title: '구분되는 판본',
      body: '단행본, 합본, 지역, 플랫폼은 서로 다른 것이며 제목이 같다고 추측하지 않습니다.',
    },
    'translation-availability': {
      title: '번역 출간 알림',
      body: '읽는 언어로 시리즈를 따라가고 다음 권이 나오면 알림을 받습니다.',
    },
    'serial-writing': {
      title: '믿을 수 있는 초고',
      body: '초고는 계속 저장되고, 연결이 끊겨도 남으며, 이전 개정본으로 되돌릴 수 있습니다.',
    },
    'serial-scheduling': {
      title: '예약 연재',
      body: '내 시간대에 맞춰 공개를 계획하고 독자가 따라오게 합니다.',
    },
    'serial-reading': {
      title: '차분한 독서',
      body: '어느 기기에서든 멈춘 곳에서 이어 읽고, 스포일러는 가려집니다.',
    },
    'vn-releases': {
      title: '릴리스로 찾는 비주얼 노벨',
      body: '제목만이 아니라 언어, 플랫폼, 판본으로 고릅니다.',
    },
    'release-provenance': {
      title: '번역자 출처',
      body: '누가 어떤 원본으로 번역했는지, 얼마나 완성되었는지 볼 수 있습니다.',
    },
    'anime-episodes': {
      title: '화 단위 애니메이션',
      body: '시즌과 화를 기록하고, 다음 화를 밝히지 않고 한 화에 대해 이야기합니다.',
    },
    'realm-wikis': {
      title: '커뮤니티 위키',
      body: '커뮤니티마다 출처, 링크, 역링크, 토론을 갖춘 위키를 둡니다.',
    },
    'wiki-history': {
      title: '검토할 수 있는 이력',
      body: '모든 편집은 검토·비교·되돌리기가 가능하고 위키 전체를 내보낼 수 있습니다.',
    },
    'agent-wikis': {
      title: '에이전트가 만드는 위키',
      body: '어시스턴트가 승인한 출처로 문서를 초안하고, 공개 전에 사람이 검토합니다.',
    },
    realms: {
      title: '커뮤니티',
      body: '하나의 이야기, 언어, 아이디어를 중심으로 모이며 저마다 규칙이 있습니다.',
    },
    'community-rules': {
      title: '언어별 규칙',
      body: '커뮤니티는 언어마다 규칙을 한 번씩 정하고, 운영은 그에 따릅니다.',
    },
    'newcomer-trust': {
      title: '새 멤버를 위한 여유',
      body: '새 멤버는 합리적인 제한으로 시작하고, 참여할수록 넓어집니다.',
    },
    'publish-books': {
      title: '책 출판',
      body: '완성한 책이나 게임을 권리와 번역 정보와 함께 독자에게 전합니다.',
    },
    'sell-books-games': {
      title: '만든 것을 판매',
      body: '유료 판본을 제공하고, 구매자는 산 것을 보관하고 내보낼 수 있습니다.',
    },
    'rights-declarations': {
      title: '분명한 권리 표시',
      body: '누가 만들고 누가 번역했는지, 무엇을 할 수 있는지 밝힙니다.',
    },
    'open-api': {
      title: '열린 API',
      body: '제품 전체를 문서화한 인터페이스이며, 오류는 코드가 처리할 수 있습니다.',
    },
    'scoped-credentials': {
      title: '범위가 정해진 자격 증명',
      body: '도구에는 필요한 권한만 주고, 한곳에서 취소합니다.',
    },
    'typescript-sdk': {
      title: 'TypeScript SDK',
      body: 'API와 같은 정의에서 생성된 타입 클라이언트.',
    },
    'mcp-agents': {
      title: '내 에이전트 사용',
      body: 'MCP로 원하는 어시스턴트를 연결하고, 모든 작업에 승인과 영수증을 남깁니다.',
    },
    'suitability-gates': {
      title: '내가 정하는 등급',
      body: '일반, 청소년, 성적, 잔혹 콘텐츠는 각각 따로 선택하며, 평가되지 않은 것은 일반으로 표시되지 않습니다.',
    },
    'ai-disclosure': {
      title: 'AI 공개',
      body: '글, 그림, 번역에 AI를 썼는지, 사람이 검토했는지 표시합니다.',
    },
    'no-trackers': {
      title: '트래커 없음',
      body: '이 사이트에는 광고 트래커도 제3자 분석도 없습니다.',
    },
    'reporting-appeals': {
      title: '신고와 이의 제기',
      body: '누구나 문제를 신고할 수 있고, 모든 결정에 이의를 제기할 수 있습니다.',
    },
  },
  de: {
    'native-multilingual': {
      title: 'Von Grund auf mehrsprachig',
      body: 'Titel, Ausgaben, Übersetzungen und Diskussionen behalten ihre eigene Sprache. Nichts wird stillschweigend durch Englisch ersetzt.',
    },
    'portable-data': {
      title: 'Deine Daten sind portabel',
      body: 'Bring deinen Leseverlauf mit und nimm alles wieder mit, ohne dass seine Bedeutung verloren geht.',
    },
    'open-source': {
      title: 'Open Source',
      body: 'Der Code soll offen gelesen, ausgeführt und verbessert werden können.',
    },
    'api-agent-first': {
      title: 'API- und Agenten-zuerst',
      body: 'Alles, was du im Browser tun kannst, hat eine API, damit auch deine eigenen Werkzeuge und Assistenten es können.',
    },
    'portable-library': {
      title: 'Eine Bibliothek für unterwegs',
      body: 'Regale, Fortschritt und Bewertungen gehören dir, wo auch immer du liest.',
    },
    'reading-sessions': {
      title: 'Lesesitzungen',
      body: 'Halte gelesene, pausierte, wiedergelesene und abgebrochene Bücher fest, je Ausgabe und Format.',
    },
    'library-exchange': {
      title: 'Import und Export',
      body: 'Hole deine Bibliothek aus einem anderen Dienst und nimm sie wieder mit, mit Vorschau auf alles, was nicht übertragbar ist.',
    },
    'series-tracking': {
      title: 'Reihen verfolgen',
      body: 'Sieh für jeden Band, was erschienen ist, was du besitzt, was du gelesen hast und was als Nächstes kommt.',
    },
    'edition-coverage': {
      title: 'Ausgaben bleiben getrennt',
      body: 'Bände, Sammelbände, Regionen und Plattformen sind verschiedene Dinge und werden nie aus gleichen Titeln erraten.',
    },
    'translation-availability': {
      title: 'Verfügbare Übersetzungen',
      body: 'Verfolge eine Reihe in deiner Lesesprache und erfahre, wann der nächste Band erscheint.',
    },
    'serial-writing': {
      title: 'Entwürfe, denen du vertraust',
      body: 'Entwürfe werden laufend gespeichert, überstehen Verbindungsabbrüche und lassen sich auf jede frühere Fassung zurücksetzen.',
    },
    'serial-scheduling': {
      title: 'Geplante Kapitel',
      body: 'Plane Veröffentlichungen in deiner Zeitzone und lass Leser mitverfolgen.',
    },
    'serial-reading': {
      title: 'Ruhiges Lesen',
      body: 'Mach auf jedem Gerät genau dort weiter, wo du aufgehört hast, ohne Spoiler.',
    },
    'vn-releases': {
      title: 'Visual Novels nach Veröffentlichung',
      body: 'Wähle nach Sprache, Plattform und Ausgabe, nicht nur nach Titel.',
    },
    'release-provenance': {
      title: 'Herkunft der Übersetzung',
      body: 'Sieh, wer eine Veröffentlichung übersetzt hat, aus welcher Quelle und wie vollständig sie ist.',
    },
    'anime-episodes': {
      title: 'Anime nach Folgen',
      body: 'Verfolge Staffeln und Folgen und sprich über eine Folge, ohne die nächste zu verraten.',
    },
    'realm-wikis': {
      title: 'Realm-Wikis',
      body: 'Jedes Realm führt ein Wiki mit Quellenangaben, Links, Rückverweisen und Diskussion.',
    },
    'wiki-history': {
      title: 'Nachvollziehbare Versionsgeschichte',
      body: 'Jede Änderung wird geprüft, verglichen und lässt sich rückgängig machen; das ganze Wiki ist exportierbar.',
    },
    'agent-wikis': {
      title: 'Von Agenten aufgebaute Wikis',
      body: 'Assistenten entwerfen Seiten aus Quellen, die du freigibst; Menschen prüfen, bevor etwas erscheint.',
    },
    realms: {
      title: 'Realms',
      body: 'Communitys rund um eine Geschichte, eine Sprache oder eine Idee, mit eigenen Regeln.',
    },
    'community-rules': {
      title: 'Regeln in jeder Sprache',
      body: 'Ein Realm legt seine Regeln einmal je Sprache fest, und die Moderation folgt ihnen.',
    },
    'newcomer-trust': {
      title: 'Raum für Neue',
      body: 'Neue Mitglieder starten mit sinnvollen Grenzen, die mit ihrer Teilnahme wachsen.',
    },
    'publish-books': {
      title: 'Ein Buch veröffentlichen',
      body: 'Bring ein fertiges Buch oder Spiel zu Leserinnen und Lesern, mit ausgewiesenen Rechten und Übersetzungen.',
    },
    'sell-books-games': {
      title: 'Verkaufe, was du machst',
      body: 'Biete kostenpflichtige Ausgaben an; Käufer behalten und exportieren, was sie gekauft haben.',
    },
    'rights-declarations': {
      title: 'Rechte, klar benannt',
      body: 'Gib an, wer ein Werk geschaffen und übersetzt hat und was man damit tun darf.',
    },
    'open-api': {
      title: 'Eine offene API',
      body: 'Eine dokumentierte Schnittstelle für das ganze Produkt, mit Fehlern, auf die dein Code reagieren kann.',
    },
    'scoped-credentials': {
      title: 'Zugangsdaten mit begrenztem Umfang',
      body: 'Gib einem Werkzeug nur den Zugriff, den es braucht, und entziehe ihn an einer Stelle.',
    },
    'typescript-sdk': {
      title: 'Ein TypeScript-SDK',
      body: 'Typisierte Clients, erzeugt aus denselben Definitionen wie die API.',
    },
    'mcp-agents': {
      title: 'Bring deinen eigenen Agenten mit',
      body: 'Verbinde einen Assistenten deiner Wahl über MCP, mit Freigaben und einem Beleg für jede Aktion.',
    },
    'suitability-gates': {
      title: 'Eignung, die du steuerst',
      body: 'Allgemeine, jugendliche, sexuelle und drastische Inhalte sind getrennte Entscheidungen, und nichts Unbewertetes wird als allgemein gezeigt.',
    },
    'ai-disclosure': {
      title: 'KI-Kennzeichnung',
      body: 'Text, Bild und Übersetzung geben an, ob KI genutzt und ob sie von einem Menschen geprüft wurde.',
    },
    'no-trackers': {
      title: 'Keine Tracker',
      body: 'Keine Werbe-Tracker und keine Analysen von Drittanbietern auf dieser Website.',
    },
    'reporting-appeals': {
      title: 'Melden und Widerspruch',
      body: 'Jeder kann ein Problem melden, und jede Entscheidung lässt sich anfechten.',
    },
  },
  fr: {
    'native-multilingual': {
      title: 'Multilingue dès l’origine',
      body: 'Titres, éditions, traductions et discussions gardent chacun leur langue. Rien n’est remplacé en silence par de l’anglais.',
    },
    'portable-data': {
      title: 'Vos données vous suivent',
      body: 'Importez votre historique de lecture et ressortez-le en entier, sans perdre ce qu’il signifiait.',
    },
    'open-source': {
      title: 'Open source',
      body: 'Le code est fait pour être lu, exécuté et amélioré au grand jour.',
    },
    'api-agent-first': {
      title: 'API et agents d’abord',
      body: 'Tout ce qu’une personne fait dans le navigateur a une API : vos outils et vos assistants peuvent le faire aussi.',
    },
    'portable-library': {
      title: 'Une bibliothèque qui voyage',
      body: 'Étagères, progression et notes restent à vous, où que vous lisiez.',
    },
    'reading-sessions': {
      title: 'Sessions de lecture',
      body: 'Notez lectures, pauses, relectures et abandons, par édition et par format.',
    },
    'library-exchange': {
      title: 'Import et export',
      body: 'Rapatriez une bibliothèque depuis un autre service et ressortez-la, avec un aperçu de ce qui ne passera pas.',
    },
    'series-tracking': {
      title: 'Suivi de séries',
      body: 'Voyez, pour chaque tome, ce qui est paru, ce que vous possédez, ce que vous avez lu et la suite.',
    },
    'edition-coverage': {
      title: 'Des éditions bien distinctes',
      body: 'Tomes, intégrales, régions et plateformes sont des choses différentes, jamais devinées à partir d’un titre identique.',
    },
    'translation-availability': {
      title: 'Disponibilité des traductions',
      body: 'Suivez une série dans la langue où vous lisez et sachez quand paraît le prochain tome.',
    },
    'serial-writing': {
      title: 'Des brouillons fiables',
      body: 'Les brouillons s’enregistrent en continu, survivent à une coupure et se restaurent à n’importe quelle révision.',
    },
    'serial-scheduling': {
      title: 'Chapitres programmés',
      body: 'Planifiez vos parutions dans votre fuseau horaire et laissez les lecteurs vous suivre.',
    },
    'serial-reading': {
      title: 'Une lecture sereine',
      body: 'Reprenez exactement où vous vous étiez arrêté, sur n’importe quel appareil, sans divulgâcher.',
    },
    'vn-releases': {
      title: 'Visual novels par sortie',
      body: 'Choisissez par langue, plateforme et édition, pas seulement par titre.',
    },
    'release-provenance': {
      title: 'Provenance de la traduction',
      body: 'Voyez qui a traduit une sortie, depuis quelle source et à quel point elle est complète.',
    },
    'anime-episodes': {
      title: 'Anime par épisode',
      body: 'Suivez saisons et épisodes, et parlez d’un épisode sans dévoiler le suivant.',
    },
    'realm-wikis': {
      title: 'Wikis de Realms',
      body: 'Chaque Realm tient un wiki avec citations, liens, rétroliens et discussion.',
    },
    'wiki-history': {
      title: 'Un historique vérifiable',
      body: 'Chaque modification est relue, comparable et réversible, et tout le wiki s’exporte.',
    },
    'agent-wikis': {
      title: 'Wikis construits par des agents',
      body: 'Des assistants rédigent des pages à partir de sources que vous approuvez ; des personnes relisent avant toute publication.',
    },
    realms: {
      title: 'Realms',
      body: 'Des communautés autour d’une histoire, d’une langue ou d’une idée, avec leurs propres règles.',
    },
    'community-rules': {
      title: 'Des règles dans chaque langue',
      body: 'Un Realm énonce ses règles une fois par langue, et la modération les suit.',
    },
    'newcomer-trust': {
      title: 'De la place pour les nouveaux',
      body: 'Les nouveaux membres commencent avec des limites raisonnables qui s’élargissent avec leur participation.',
    },
    'publish-books': {
      title: 'Publier un livre',
      body: 'Amenez un livre ou un jeu terminé jusqu’aux lecteurs, avec ses droits et ses traductions indiqués.',
    },
    'sell-books-games': {
      title: 'Vendre ce que vous créez',
      body: 'Proposez des éditions payantes ; les acheteurs gardent et exportent ce qu’ils ont acheté.',
    },
    'rights-declarations': {
      title: 'Des droits énoncés clairement',
      body: 'Dites qui a créé une œuvre, qui l’a traduite et ce qu’on peut en faire.',
    },
    'open-api': {
      title: 'Une API ouverte',
      body: 'Une interface documentée pour tout le produit, avec des erreurs que votre code peut exploiter.',
    },
    'scoped-credentials': {
      title: 'Identifiants à portée limitée',
      body: 'Donnez à un outil seulement l’accès dont il a besoin, et révoquez-le au même endroit.',
    },
    'typescript-sdk': {
      title: 'Un SDK TypeScript',
      body: 'Des clients typés générés à partir des mêmes définitions que l’API.',
    },
    'mcp-agents': {
      title: 'Apportez votre propre agent',
      body: 'Connectez l’assistant de votre choix via MCP, avec des approbations et un reçu pour chaque action.',
    },
    'suitability-gates': {
      title: 'Un public que vous choisissez',
      body: 'Contenus tout public, adolescents, sexuels et violents sont des choix séparés, et rien de non évalué n’est présenté comme tout public.',
    },
    'ai-disclosure': {
      title: 'Mention de l’IA',
      body: 'Textes, illustrations et traductions indiquent si une IA a servi et si une personne les a relus.',
    },
    'no-trackers': {
      title: 'Aucun traceur',
      body: 'Aucun traceur publicitaire ni outil d’analyse tiers sur ce site.',
    },
    'reporting-appeals': {
      title: 'Signalement et recours',
      body: 'Chacun peut signaler un problème, et chaque décision peut faire l’objet d’un recours.',
    },
  },
  es: {
    'native-multilingual': {
      title: 'Multilingüe de origen',
      body: 'Títulos, ediciones, traducciones y debates conservan cada uno su idioma. Nada se sustituye en silencio por inglés.',
    },
    'portable-data': {
      title: 'Tus datos son portátiles',
      body: 'Trae tu historial de lectura y llévatelo entero, sin perder lo que significaba.',
    },
    'open-source': {
      title: 'Código abierto',
      body: 'El código está pensado para leerse, ejecutarse y mejorarse en abierto.',
    },
    'api-agent-first': {
      title: 'API y agentes primero',
      body: 'Todo lo que una persona hace en el navegador tiene una API, para que tus herramientas y asistentes también puedan hacerlo.',
    },
    'portable-library': {
      title: 'Una biblioteca que viaja',
      body: 'Estantes, progreso y valoraciones siguen siendo tuyos, leas donde leas.',
    },
    'reading-sessions': {
      title: 'Sesiones de lectura',
      body: 'Registra lecturas, pausas, relecturas y libros abandonados, por edición y formato.',
    },
    'library-exchange': {
      title: 'Importar y exportar',
      body: 'Trae una biblioteca de otro servicio y llévatela de vuelta, con una vista previa de lo que no se transferirá.',
    },
    'series-tracking': {
      title: 'Seguimiento de series',
      body: 'Consulta, para cada volumen, qué ha salido, qué tienes, qué has leído y qué viene después.',
    },
    'edition-coverage': {
      title: 'Ediciones bien distintas',
      body: 'Volúmenes, ediciones integrales, regiones y plataformas son cosas distintas, nunca deducidas de un título coincidente.',
    },
    'translation-availability': {
      title: 'Traducciones disponibles',
      body: 'Sigue una serie en el idioma en que lees y entérate cuando salga el próximo volumen.',
    },
    'serial-writing': {
      title: 'Borradores de confianza',
      body: 'Los borradores se guardan de forma continua, sobreviven a una desconexión y pueden restaurarse a cualquier revisión anterior.',
    },
    'serial-scheduling': {
      title: 'Capítulos programados',
      body: 'Planifica las publicaciones en tu zona horaria y deja que los lectores te sigan.',
    },
    'serial-reading': {
      title: 'Lectura tranquila',
      body: 'Continúa exactamente donde lo dejaste, en cualquier dispositivo, sin spoilers.',
    },
    'vn-releases': {
      title: 'Novelas visuales por edición',
      body: 'Elige por idioma, plataforma y edición, no solo por título.',
    },
    'release-provenance': {
      title: 'Procedencia de la traducción',
      body: 'Consulta quién tradujo una edición, de qué fuente y cuán completa está.',
    },
    'anime-episodes': {
      title: 'Anime por episodios',
      body: 'Sigue temporadas y episodios, y habla de un episodio sin desvelar el siguiente.',
    },
    'realm-wikis': {
      title: 'Wikis de Realms',
      body: 'Cada Realm mantiene una wiki con citas, enlaces, retroenlaces y debate.',
    },
    'wiki-history': {
      title: 'Un historial revisable',
      body: 'Cada edición se revisa, se compara y se puede revertir, y toda la wiki se exporta.',
    },
    'agent-wikis': {
      title: 'Wikis creadas con agentes',
      body: 'Los asistentes redactan páginas a partir de fuentes que apruebas; personas las revisan antes de publicar nada.',
    },
    realms: {
      title: 'Realms',
      body: 'Comunidades en torno a una historia, un idioma o una idea, con sus propias normas.',
    },
    'community-rules': {
      title: 'Normas en cada idioma',
      body: 'Un Realm expone sus normas una vez por idioma, y la moderación las sigue.',
    },
    'newcomer-trust': {
      title: 'Espacio para los recién llegados',
      body: 'Los nuevos miembros empiezan con límites razonables que crecen con su participación.',
    },
    'publish-books': {
      title: 'Publicar un libro',
      body: 'Lleva un libro o juego terminado a los lectores, con sus derechos y traducciones indicados.',
    },
    'sell-books-games': {
      title: 'Vende lo que creas',
      body: 'Ofrece ediciones de pago y deja que los compradores conserven y exporten lo que compraron.',
    },
    'rights-declarations': {
      title: 'Derechos, dichos con claridad',
      body: 'Indica quién creó una obra, quién la tradujo y qué se puede hacer con ella.',
    },
    'open-api': {
      title: 'Una API abierta',
      body: 'Una interfaz documentada para todo el producto, con errores que tu código puede tratar.',
    },
    'scoped-credentials': {
      title: 'Credenciales acotadas',
      body: 'Da a una herramienta solo el acceso que necesita y revócalo en un único lugar.',
    },
    'typescript-sdk': {
      title: 'Un SDK de TypeScript',
      body: 'Clientes tipados generados a partir de las mismas definiciones que la API.',
    },
    'mcp-agents': {
      title: 'Trae tu propio agente',
      body: 'Conecta el asistente que prefieras mediante MCP, con aprobaciones y un recibo por cada acción.',
    },
    'suitability-gates': {
      title: 'Idoneidad bajo tu control',
      body: 'El contenido general, juvenil, sexual y gráfico son decisiones separadas, y nada sin clasificar se muestra como general.',
    },
    'ai-disclosure': {
      title: 'Aviso de IA',
      body: 'Textos, ilustraciones y traducciones indican si se usó IA y si una persona la revisó.',
    },
    'no-trackers': {
      title: 'Sin rastreadores',
      body: 'Sin rastreadores publicitarios ni analítica de terceros en este sitio.',
    },
    'reporting-appeals': {
      title: 'Denuncias y apelaciones',
      body: 'Cualquiera puede denunciar un problema, y toda decisión puede apelarse.',
    },
  },
});
