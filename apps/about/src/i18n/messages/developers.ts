import { defineCopy } from '../define.ts';
import type { LinePageCopy } from './page.ts';

export const developers = defineCopy<LinePageCopy>({
  en: {
    meta: {
      title: 'Developers on REZICS: the whole product as an API',
      description:
        'Every capability of REZICS is an API operation first: scoped credentials, errors your code can act on, safe retries, resumable events, a TypeScript SDK and MCP for agents.',
    },
    hero: {
      title: 'Build on the same REZICS people use.',
      lede: 'Every capability is an API operation first, and the website is one client among many. Your app, your script and your agent get the same operations, with credentials scoped to the job, outcomes they can read and retries that never do anything twice.',
    },
    story: {
      title: 'One task, done properly.',
      lede: 'Importing a library through the API, the way the website does it.',
      steps: {
        credential: {
          title: 'Ask for exactly what you need.',
          body: 'A credential scoped to one library and one task, revocable in one place.',
        },
        prepare: {
          title: 'Prepare, then review.',
          body: 'Upload the export and get a preview: matched editions, rows that need a choice and fields that will not carry over.',
        },
        apply: {
          title: 'Apply safely, even twice.',
          body: 'Send the decision with an idempotency key. A retry after a timeout returns the same receipt instead of a second import.',
        },
        follow: {
          title: 'Follow what happens next.',
          body: 'Read events with a durable cursor and resume exactly where you left off after a disconnect.',
        },
      },
    },
    showcase: {
      title: 'What you build with.',
      lede: 'The pieces that make an integration dependable.',
      tiles: {
        errors: {
          title: 'Errors your code can act on',
          body: 'Problem details that name the cause and the next step.',
        },
        sdk: {
          title: 'A TypeScript SDK',
          body: 'Typed clients from the same definitions as the API.',
        },
        mcp: {
          title: 'MCP for agents',
          body: 'Agents connect with the same scopes and budgets as apps.',
        },
        portal: {
          title: 'Docs that cannot drift',
          body: 'Generated from the registry the API runs on.',
        },
      },
    },
    compare: {
      title: 'An API that is the product, not an afterthought.',
      lede: 'Integrations should not have to reverse-engineer a website.',
      today: 'Today',
      rezics: 'On REZICS',
      rows: {
        scraping: {
          today: 'Scraping pages because there is no API',
          rezics: 'Every capability documented as an operation',
        },
        tokens: {
          today: 'One token that can do everything',
          rezics: 'Credentials scoped to resources and tasks',
        },
        retries: {
          today: 'Retries that create duplicates',
          rezics: 'Idempotent operations with receipts',
        },
        success: {
          today: 'A 200 that quietly dropped your fields',
          rezics: 'Outcomes that say exactly what was kept',
        },
      },
    },
    statement: {
      text: 'If a person can do it on REZICS, your code can too.',
      body: 'The same operations, the same permissions and the same outcomes, whether a click or a call starts them.',
    },
    ledger: {
      title: 'Developers on REZICS',
    },
    cta: {
      title: 'Get your first credential on day one.',
      body: 'Leave your email and we will write once, when registration opens.',
    },
  },
  'zh-Hant': {
    meta: {
      title: 'REZICS 開發者：完整產品，都能透過 API 使用',
      description:
        'REZICS 每項功能都先有 API 操作：範圍受限的憑證、程式能處理的錯誤、安全重試、可接續的事件、TypeScript SDK 與供代理程式使用的 MCP。',
    },
    hero: {
      title: '大家用的 REZICS，也是你開發的基礎。',
      lede: '每項功能都先是 API 操作，網站只是其中一個用戶端。你的 App、腳本與代理程式使用同樣的操作，憑證權限對應工作範圍，結果可由程式判讀，重試也不會重複執行。',
    },
    story: {
      title: '一件事，完整做好。',
      lede: '透過 API 匯入書庫，走的就是網站同一條流程。',
      steps: {
        credential: {
          title: '只要求工作需要的權限。',
          body: '憑證只限一個書庫、一項工作，並能集中撤銷。',
        },
        prepare: {
          title: '先準備，再確認。',
          body: '上傳匯出檔案，取得預覽：已比對的版本、需要選擇的資料，以及無法帶入的欄位。',
        },
        apply: {
          title: '安全套用，再送一次也沒問題。',
          body: '附上冪等鍵送出決定。逾時後重試，只會傳回同一張回執，不會再匯入一次。',
        },
        follow: {
          title: '接著追蹤後續事件。',
          body: '用持久游標讀取事件，斷線後從原處精確接續。',
        },
      },
    },
    showcase: {
      title: '開發需要的工具。',
      lede: '讓整合可靠運作的各個環節。',
      tiles: {
        errors: {
          title: '程式能處理的錯誤',
          body: '錯誤詳情會說明原因與下一步。',
        },
        sdk: {
          title: 'TypeScript SDK',
          body: '用戶端與 API 由同一份定義產生，保留型別資訊。',
        },
        mcp: {
          title: '供代理程式使用的 MCP',
          body: '代理程式與 App 使用相同的權限範圍與預算限制。',
        },
        portal: {
          title: '與實作同步的文件',
          body: '從 API 本身使用的登錄表產生。',
        },
      },
    },
    compare: {
      title: 'API 就是產品的起點。',
      lede: '做整合，不該得先逆向工程整個網站。',
      today: '目前的做法',
      rezics: '在 REZICS',
      rows: {
        scraping: {
          today: '沒有 API，只能爬取網頁',
          rezics: '每項能力都有 API 操作與文件',
        },
        tokens: {
          today: '一把權杖，什麼都能做',
          rezics: '憑證按資源與工作限縮權限',
        },
        retries: {
          today: '一重試，就產生重複資料',
          rezics: '附回執的冪等操作',
        },
        success: {
          today: '回傳 200，卻悄悄漏掉欄位',
          rezics: '結果精確交代哪些資料已保留',
        },
      },
    },
    statement: {
      text: '人在 REZICS 做得到的，你的程式也做得到。',
      body: '不論點擊或呼叫，都是相同操作、相同權限、相同結果。',
    },
    ledger: {
      title: 'REZICS 開發者',
    },
    cta: {
      title: '開放第一天，就取得第一組憑證。',
      body: '留下電子郵件，我們會在開放註冊時通知你一次。',
    },
  },
  'zh-Hans': {
    meta: {
      title: 'REZICS 开发者：完整产品，都能通过 API 使用',
      description:
        'REZICS 每项功能都先有 API 操作：范围受限的凭证、程序能处理的错误、安全重试、可续接的事件、TypeScript SDK 与供智能体使用的 MCP。',
    },
    hero: {
      title: '大家用的 REZICS，也是你开发的基础。',
      lede: '每项功能都先是 API 操作，网站只是其中一个客户端。你的 App、脚本与智能体使用同样的操作，凭证权限对应任务范围，结果可由程序读取，重试也不会重复执行。',
    },
    story: {
      title: '一件事，完整做好。',
      lede: '通过 API 导入书库，走的就是网站同一条流程。',
      steps: {
        credential: {
          title: '只申请任务需要的权限。',
          body: '凭证只限一个书库、一项任务，并能集中撤销。',
        },
        prepare: {
          title: '先准备，再确认。',
          body: '上传导出文件，获取预览：已匹配的版本、需要选择的数据，以及无法带入的字段。',
        },
        apply: {
          title: '安全应用，再发一次也没问题。',
          body: '附上幂等键提交决定。超时后重试，只会返回同一张回执，不会再导入一次。',
        },
        follow: {
          title: '接着追踪后续事件。',
          body: '用持久游标读取事件，断线后从原处准确续接。',
        },
      },
    },
    showcase: {
      title: '开发需要的工具。',
      lede: '让集成可靠运行的各个环节。',
      tiles: {
        errors: {
          title: '程序能处理的错误',
          body: '错误详情会说明原因与下一步。',
        },
        sdk: {
          title: 'TypeScript SDK',
          body: '客户端与 API 由同一份定义生成，保留类型信息。',
        },
        mcp: {
          title: '供智能体使用的 MCP',
          body: '智能体与 App 使用相同的权限范围与预算限制。',
        },
        portal: {
          title: '与实现同步的文档',
          body: '从 API 本身使用的注册表生成。',
        },
      },
    },
    compare: {
      title: 'API 就是产品的起点。',
      lede: '做集成，不该得先逆向工程整个网站。',
      today: '目前的做法',
      rezics: '在 REZICS',
      rows: {
        scraping: {
          today: '没有 API，只能抓取网页',
          rezics: '每项能力都有 API 操作与文档',
        },
        tokens: {
          today: '一个令牌，什么都能做',
          rezics: '凭证按资源与任务限制权限',
        },
        retries: {
          today: '一重试，就产生重复数据',
          rezics: '附回执的幂等操作',
        },
        success: {
          today: '返回 200，却悄悄漏掉字段',
          rezics: '结果准确说明哪些数据已保留',
        },
      },
    },
    statement: {
      text: '人在 REZICS 做得到的，你的代码也做得到。',
      body: '无论点击还是调用，都是相同操作、相同权限、相同结果。',
    },
    ledger: {
      title: 'REZICS 开发者',
    },
    cta: {
      title: '开放第一天，就获取第一组凭证。',
      body: '留下电子邮箱，我们会在开放注册时通知你一次。',
    },
  },
  ja: {
    meta: {
      title: 'REZICSの開発者向け機能：製品全体をAPIで',
      description:
        'すべての機能はまずAPI操作として提供。権限を絞った認証情報、対処できるエラー、安全な再試行、再開できるイベント、TypeScript SDK、エージェント用MCPを備えます。',
    },
    hero: {
      title: 'みんなが使うREZICSを、開発の土台に。',
      lede: 'すべての機能はまずAPI操作として作られ、Webサイトもクライアントのひとつです。アプリ、スクリプト、エージェントも同じ操作を使えます。認証情報は仕事に必要な範囲に絞れ、結果はコードで読み取れ、再試行しても二重実行しません。',
    },
    story: {
      title: 'ひとつの仕事を、確実に。',
      lede: 'Webサイトと同じ手順で、APIからライブラリを取り込みます。',
      steps: {
        credential: {
          title: '必要な権限だけを求める。',
          body: 'ひとつのライブラリと仕事に限定した認証情報を、ひとつの場所で取り消せます。',
        },
        prepare: {
          title: '準備してから、確認する。',
          body: '書き出したファイルをアップロードし、照合済みの版、選択が必要な行、引き継げない項目をプレビューします。',
        },
        apply: {
          title: '二度送っても、安全に反映。',
          body: '冪等キーを付けて決定を送信。タイムアウト後に再試行しても、同じ処理記録が返り、二重に取り込みません。',
        },
        follow: {
          title: 'その後の変化を追う。',
          body: '永続カーソルでイベントを読み、切断後も前回の位置から正確に再開できます。',
        },
      },
    },
    showcase: {
      title: '開発を支える道具。',
      lede: '信頼できる連携のための仕組み。',
      tiles: {
        errors: {
          title: 'コードで対処できるエラー',
          body: 'エラーの詳細が原因と次の手順を示します。',
        },
        sdk: {
          title: 'TypeScript SDK',
          body: 'APIと同じ定義から、型のあるクライアントを生成。',
        },
        mcp: {
          title: 'エージェント向けMCP',
          body: 'エージェントもアプリと同じ権限範囲と予算で接続。',
        },
        portal: {
          title: '実装とずれないドキュメント',
          body: 'API自体が使うレジストリから生成します。',
        },
      },
    },
    compare: {
      title: 'APIそのものが、製品の土台。',
      lede: '連携のためにWebサイトをリバースエンジニアリングする必要はないはずです。',
      today: '今のやり方',
      rezics: 'REZICSなら',
      rows: {
        scraping: {
          today: 'APIがなく、ページをスクレイピング',
          rezics: '各機能を操作として文書化',
        },
        tokens: {
          today: '何でもできるひとつのトークン',
          rezics: '対象と仕事で認証情報の権限を限定',
        },
        retries: {
          today: '再試行で重複が発生',
          rezics: '処理記録つきの冪等な操作',
        },
        success: {
          today: '200が返っても項目が消えている',
          rezics: '何が残ったかを正確に示す結果',
        },
      },
    },
    statement: {
      text: '人がREZICSでできることは、コードでもできる。',
      body: 'クリックでも呼び出しでも、操作・権限・結果は同じです。',
    },
    ledger: {
      title: 'REZICSの開発者向け機能',
    },
    cta: {
      title: '初日から、最初の認証情報を。',
      body: 'メールアドレスを残していただければ、登録開始時に一度だけお知らせします。',
    },
  },
  ko: {
    meta: {
      title: 'REZICS 개발자: 제품 전체를 API로',
      description:
        '모든 기능을 API 작업으로 먼저 제공합니다. 범위를 제한한 인증 정보, 코드로 처리할 수 있는 오류, 안전한 재시도, 재개 가능한 이벤트, TypeScript SDK, 에이전트용 MCP까지.',
    },
    hero: {
      title: '사람들이 쓰는 REZICS 위에서 개발하세요.',
      lede: '모든 기능은 API 작업에서 시작하고 웹사이트도 여러 클라이언트 중 하나입니다. 앱, 스크립트, 에이전트가 같은 작업을 사용합니다. 인증 범위는 작업에 맞추고, 결과는 코드로 읽으며, 재시도해도 중복 실행하지 않습니다.',
    },
    story: {
      title: '작업 하나를 제대로 끝내기.',
      lede: '웹사이트와 같은 방식으로 API를 통해 서재를 가져옵니다.',
      steps: {
        credential: {
          title: '필요한 권한만 요청하세요.',
          body: '서재 하나와 작업 하나로 범위를 제한한 인증 정보를 한곳에서 철회합니다.',
        },
        prepare: {
          title: '준비한 뒤 검토하세요.',
          body: '내보낸 파일을 올리고 미리보기를 받습니다. 일치한 판본, 선택이 필요한 행, 옮겨지지 않는 필드를 확인합니다.',
        },
        apply: {
          title: '두 번 보내도 안전하게 적용하세요.',
          body: '멱등 키와 함께 결정을 보냅니다. 시간 초과 뒤 다시 보내도 같은 처리 기록을 반환하며 두 번 가져오지 않습니다.',
        },
        follow: {
          title: '이후의 변화를 따라가세요.',
          body: '영속 커서로 이벤트를 읽고 연결이 끊겨도 정확히 멈춘 지점에서 재개합니다.',
        },
      },
    },
    showcase: {
      title: '개발에 쓰는 도구들.',
      lede: '믿을 수 있는 연동을 만드는 요소들.',
      tiles: {
        errors: {
          title: '코드로 대응할 수 있는 오류',
          body: '문제 상세 정보가 원인과 다음 단계를 알려 줍니다.',
        },
        sdk: {
          title: 'TypeScript SDK',
          body: 'API와 같은 정의에서 타입이 있는 클라이언트를 생성합니다.',
        },
        mcp: {
          title: '에이전트용 MCP',
          body: '에이전트도 앱과 같은 권한 범위와 예산으로 연결합니다.',
        },
        portal: {
          title: '실제 동작과 어긋나지 않는 문서',
          body: 'API 자체가 사용하는 레지스트리에서 생성합니다.',
        },
      },
    },
    compare: {
      title: 'API 자체가 제품의 출발점.',
      lede: '연동을 위해 웹사이트를 역공학할 필요는 없어야 합니다.',
      today: '지금은',
      rezics: 'REZICS에서는',
      rows: {
        scraping: {
          today: 'API가 없어 페이지를 스크래핑',
          rezics: '모든 기능을 작업으로 문서화',
        },
        tokens: {
          today: '무엇이든 할 수 있는 토큰 하나',
          rezics: '리소스와 작업별로 인증 범위 제한',
        },
        retries: {
          today: '재시도로 생기는 중복',
          rezics: '처리 기록이 있는 멱등 작업',
        },
        success: {
          today: '필드는 빠졌는데 응답은 200',
          rezics: '무엇이 보존됐는지 정확히 밝히는 결과',
        },
      },
    },
    statement: {
      text: '사람이 REZICS에서 할 수 있다면, 코드로도 할 수 있습니다.',
      body: '클릭으로 시작하든 호출로 시작하든 작업, 권한, 결과는 같습니다.',
    },
    ledger: {
      title: 'REZICS 개발자',
    },
    cta: {
      title: '첫날에 첫 인증 정보를 받아 보세요.',
      body: '이메일을 남겨 주시면 가입이 열릴 때 한 번만 알려 드립니다.',
    },
  },
  de: {
    meta: {
      title: 'Entwickeln auf REZICS: das ganze Produkt als API',
      description:
        'Alle Funktionen zuerst als API: begrenzte Zugriffsrechte, verwertbare Fehler, sichere Wiederholungen, fortsetzbare Ereignisse, TypeScript SDK und MCP für Agenten.',
    },
    hero: {
      title: 'Baue auf demselben REZICS auf, das Menschen nutzen.',
      lede: 'Jede Funktion ist zuerst eine API-Operation; die Website ist einer von vielen Clients. Apps, Skripte und Agenten nutzen dieselben Operationen, mit passenden Zugriffsrechten, maschinenlesbaren Ergebnissen und Wiederholungen ohne doppelte Ausführung.',
    },
    story: {
      title: 'Eine Aufgabe, sauber erledigt.',
      lede: 'Eine Bibliothek per API importieren, genauso wie auf der Website.',
      steps: {
        credential: {
          title: 'Genau den nötigen Zugriff anfordern.',
          body: 'Zugangsdaten für eine Bibliothek und eine Aufgabe, zentral widerrufbar.',
        },
        prepare: {
          title: 'Vorbereiten, dann prüfen.',
          body: 'Export hochladen und Vorschau erhalten: zugeordnete Ausgaben, offene Entscheidungen und nicht übertragbare Felder.',
        },
        apply: {
          title: 'Sicher anwenden, auch zweimal.',
          body: 'Sende die Entscheidung mit Idempotenzschlüssel. Ein erneuter Versuch nach Timeout liefert denselben Beleg statt eines zweiten Imports.',
        },
        follow: {
          title: 'Verfolgen, was danach passiert.',
          body: 'Lies Ereignisse mit dauerhaftem Cursor und setze nach Verbindungsabbruch genau an der letzten Stelle fort.',
        },
      },
    },
    showcase: {
      title: 'Womit du baust.',
      lede: 'Die Bausteine verlässlicher Integrationen.',
      tiles: {
        errors: {
          title: 'Fehler, auf die Code reagieren kann',
          body: 'Problemdetails nennen Ursache und nächsten Schritt.',
        },
        sdk: {
          title: 'Ein SDK für TypeScript',
          body: 'Typisierte Clients aus denselben Definitionen wie die API.',
        },
        mcp: {
          title: 'MCP für Agenten',
          body: 'Agenten nutzen dieselben Berechtigungen und Budgets wie Apps.',
        },
        portal: {
          title: 'Dokumentation, die aktuell bleibt',
          body: 'Aus derselben Registry erzeugt, auf der die API läuft.',
        },
      },
    },
    compare: {
      title: 'Eine API als Produktgrundlage.',
      lede: 'Integrationen sollten keine Website rückentwickeln müssen.',
      today: 'Heute',
      rezics: 'Auf REZICS',
      rows: {
        scraping: {
          today: 'Seiten auslesen, weil die API fehlt',
          rezics: 'Jede Funktion als Operation dokumentiert',
        },
        tokens: {
          today: 'Ein Token für alles',
          rezics: 'Zugangsdaten auf Ressourcen und Aufgaben begrenzt',
        },
        retries: {
          today: 'Wiederholungen erzeugen Duplikate',
          rezics: 'Idempotente Operationen mit Belegen',
        },
        success: {
          today: 'Status 200, aber Felder fehlen stillschweigend',
          rezics: 'Ergebnisse zeigen genau, was übernommen wurde',
        },
      },
    },
    statement: {
      text: 'Was Menschen auf REZICS tun können, kann dein Code auch.',
      body: 'Dieselben Operationen, Rechte und Ergebnisse, ob per Klick oder Aufruf.',
    },
    ledger: {
      title: 'Entwickeln auf REZICS',
    },
    cta: {
      title: 'Hol dir deine ersten Zugangsdaten zum Start.',
      body: 'Hinterlasse deine E-Mail-Adresse. Wir schreiben dir einmal, wenn die Registrierung öffnet.',
    },
  },
  fr: {
    meta: {
      title: 'Développer sur REZICS : tout le produit en API',
      description:
        'Chaque fonction est d’abord une opération API : accès limités, erreurs exploitables, reprises sûres, événements reprenables, SDK TypeScript et MCP pour agents.',
    },
    hero: {
      title: 'Développez sur le REZICS que chacun utilise.',
      lede: 'Chaque fonction est d’abord une opération API ; le site est un client parmi d’autres. Applications, scripts et agents utilisent les mêmes opérations, avec des accès ciblés, des résultats lisibles et des reprises sans double exécution.',
    },
    story: {
      title: 'Une tâche menée à bien.',
      lede: 'Importer une bibliothèque par API, comme le fait le site.',
      steps: {
        credential: {
          title: 'Demandez juste le nécessaire.',
          body: 'Un accès limité à une bibliothèque et une tâche, révocable en un seul endroit.',
        },
        prepare: {
          title: 'Préparez, puis vérifiez.',
          body: 'Envoyez l’export pour obtenir un aperçu : éditions reconnues, lignes à départager et champs non repris.',
        },
        apply: {
          title: 'Appliquez sans risque, même deux fois.',
          body: 'Envoyez la décision avec une clé d’idempotence. Après un délai dépassé, la reprise renvoie le même reçu sans refaire l’import.',
        },
        follow: {
          title: 'Suivez la suite.',
          body: 'Lisez les événements avec un curseur persistant et reprenez au même endroit après une déconnexion.',
        },
      },
    },
    showcase: {
      title: 'Vos outils pour construire.',
      lede: 'Les éléments d’une intégration fiable.',
      tiles: {
        errors: {
          title: 'Des erreurs exploitables par le code',
          body: 'Les détails du problème indiquent la cause et la suite à donner.',
        },
        sdk: {
          title: 'Un SDK TypeScript',
          body: 'Des clients typés issus des mêmes définitions que l’API.',
        },
        mcp: {
          title: 'MCP pour les agents',
          body: 'Les agents se connectent avec les mêmes périmètres et budgets que les applications.',
        },
        portal: {
          title: 'Une documentation qui reste juste',
          body: 'Générée depuis le registre utilisé par l’API elle-même.',
        },
      },
    },
    compare: {
      title: 'Une API au cœur du produit.',
      lede: 'Intégrer ne devrait pas demander de décortiquer un site à rebours.',
      today: 'Aujourd’hui',
      rezics: 'Sur REZICS',
      rows: {
        scraping: {
          today: 'Extraire des pages faute d’API',
          rezics: 'Chaque capacité documentée comme opération',
        },
        tokens: {
          today: 'Un jeton qui peut tout faire',
          rezics: 'Des accès limités aux ressources et aux tâches',
        },
        retries: {
          today: 'Des reprises qui créent des doublons',
          rezics: 'Des opérations idempotentes avec reçus',
        },
        success: {
          today: 'Un code 200 qui masque des champs perdus',
          rezics: 'Des résultats qui précisent ce qui a été conservé',
        },
      },
    },
    statement: {
      text: 'Ce qu’une personne peut faire sur REZICS, votre code le peut aussi.',
      body: 'Mêmes opérations, mêmes permissions, mêmes résultats, par clic ou par appel.',
    },
    ledger: {
      title: 'Développer sur REZICS',
    },
    cta: {
      title: 'Obtenez votre premier accès dès l’ouverture.',
      body: 'Laissez votre adresse e-mail. Nous vous écrirons une seule fois, à l’ouverture des inscriptions.',
    },
  },
  es: {
    meta: {
      title: 'Desarrollar en REZICS: todo el producto como API',
      description:
        'Cada función empieza como una operación API: credenciales limitadas, errores procesables, reintentos seguros, eventos reanudables, SDK de TypeScript y MCP para agentes.',
    },
    hero: {
      title: 'Construye sobre el mismo REZICS que usa la gente.',
      lede: 'Cada función es primero una operación API; la web es un cliente más. Apps, scripts y agentes usan las mismas operaciones, con permisos ajustados a la tarea, resultados procesables y reintentos que nunca duplican acciones.',
    },
    story: {
      title: 'Una tarea bien hecha.',
      lede: 'Importar una biblioteca por API igual que lo hace la web.',
      steps: {
        credential: {
          title: 'Pide exactamente lo que necesitas.',
          body: 'Una credencial limitada a una biblioteca y una tarea, revocable desde un solo lugar.',
        },
        prepare: {
          title: 'Prepara y después revisa.',
          body: 'Sube la exportación y obtén una vista previa: ediciones vinculadas, filas que requieren elegir y campos que no se trasladarán.',
        },
        apply: {
          title: 'Aplica con seguridad, incluso dos veces.',
          body: 'Envía la decisión con una clave de idempotencia. Tras un timeout, el reintento devuelve el mismo comprobante sin importar otra vez.',
        },
        follow: {
          title: 'Sigue lo que pasa después.',
          body: 'Lee eventos con un cursor persistente y retoma en el punto exacto tras una desconexión.',
        },
      },
    },
    showcase: {
      title: 'Con qué vas a construir.',
      lede: 'Las piezas de una integración fiable.',
      tiles: {
        errors: {
          title: 'Errores ante los que tu código puede actuar',
          body: 'Los detalles del problema indican la causa y el siguiente paso.',
        },
        sdk: {
          title: 'Un SDK de TypeScript',
          body: 'Clientes tipados a partir de las mismas definiciones que la API.',
        },
        mcp: {
          title: 'MCP para agentes',
          body: 'Los agentes se conectan con los mismos permisos y presupuestos que las apps.',
        },
        portal: {
          title: 'Documentación que no se desfasa',
          body: 'Generada desde el registro que usa la propia API.',
        },
      },
    },
    compare: {
      title: 'Una API que es la base del producto.',
      lede: 'Integrar no debería exigir hacer ingeniería inversa de una web.',
      today: 'Hoy',
      rezics: 'En REZICS',
      rows: {
        scraping: {
          today: 'Extraer páginas porque no hay API',
          rezics: 'Cada función documentada como operación',
        },
        tokens: {
          today: 'Un token que lo puede hacer todo',
          rezics: 'Credenciales limitadas por recursos y tareas',
        },
        retries: {
          today: 'Reintentos que crean duplicados',
          rezics: 'Operaciones idempotentes con comprobantes',
        },
        success: {
          today: 'Un 200 que ha descartado campos en silencio',
          rezics: 'Resultados que detallan qué se conservó',
        },
      },
    },
    statement: {
      text: 'Si una persona puede hacerlo en REZICS, tu código también.',
      body: 'Mismas operaciones, permisos y resultados, tanto con un clic como con una llamada.',
    },
    ledger: {
      title: 'Desarrollar en REZICS',
    },
    cta: {
      title: 'Obtén tu primera credencial desde el primer día.',
      body: 'Deja tu correo y te escribiremos una sola vez, cuando se abra el registro.',
    },
  },
});
