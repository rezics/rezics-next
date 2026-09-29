import { defineCopy } from '../define.ts';
import type { PageCopy } from './page.ts';

export const developers = defineCopy<PageCopy>({
  en: {
    meta: {
      title: 'Developers: API, MCP and SDK',
      description:
        'Build on REZICS with a documented API, scoped credentials, a TypeScript SDK and the agent of your choice.',
    },
    hero: {
      title: 'Everything in the browser has an API.',
      lede: 'REZICS is built API-first. Use your own tools or bring an agent: every action is scoped, approved and recorded.',
    },
    scene: {
      title: 'Ask the API',
      body: 'A request, a typed response and an error your code can act on. This sketches the intended shape; it is not a released API.',
    },
    featuresTitle: 'What developers will get',
  },
  'zh-Hant': {
    meta: {
      title: '開發者：API、MCP 與 SDK',
      description:
        '以文件化的 API、限定範圍的憑證、TypeScript SDK 與你選擇的代理，在 REZICS 上開發。',
    },
    hero: {
      title: '瀏覽器裡的一切都有 API。',
      lede: 'REZICS 以 API 優先打造。使用你自己的工具，或帶來一個代理：每個動作都有範圍、需核准並留下紀錄。',
    },
    scene: {
      title: '向 API 提問',
      body: '一個請求、一個型別化的回應，以及程式能處理的錯誤。這是預期形態的草圖，並非已發布的 API。',
    },
    featuresTitle: '開發者將獲得的功能',
  },
  'zh-Hans': {
    meta: {
      title: '开发者：API、MCP 与 SDK',
      description:
        '以文档化的 API、限定范围的凭证、TypeScript SDK 和你选择的智能体，在 REZICS 上开发。',
    },
    hero: {
      title: '浏览器里的一切都有 API。',
      lede: 'REZICS 以 API 优先打造。使用你自己的工具，或带来一个智能体：每个动作都有范围、需批准并留下记录。',
    },
    scene: {
      title: '向 API 提问',
      body: '一个请求、一个类型化的响应，以及程序能处理的错误。这是预期形态的草图，并非已发布的 API。',
    },
    featuresTitle: '开发者将获得的功能',
  },
  ja: {
    meta: {
      title: '開発者：API、MCP、SDK',
      description:
        '文書化された API、範囲を絞った認証情報、TypeScript SDK、お好みのエージェントで REZICS 上に構築できます。',
    },
    hero: {
      title: 'ブラウザでできることは、すべて API から。',
      lede: 'REZICS は API ファーストで作られています。自分のツールを使うか、エージェントを持ち込んでください。すべての操作は範囲が限られ、承認され、記録されます。',
    },
    scene: {
      title: 'API に尋ねる',
      body: 'リクエスト、型付きのレスポンス、コードで扱えるエラー。目指す形のスケッチであり、公開済みの API ではありません。',
    },
    featuresTitle: '開発者が得られるもの',
  },
  ko: {
    meta: {
      title: '개발자: API, MCP, SDK',
      description:
        '문서화된 API, 범위가 정해진 자격 증명, TypeScript SDK, 원하는 에이전트로 REZICS 위에 만들 수 있습니다.',
    },
    hero: {
      title: '브라우저에서 하는 모든 일에 API가 있습니다.',
      lede: 'REZICS는 API를 먼저 만듭니다. 내 도구를 쓰거나 에이전트를 가져오세요. 모든 작업은 범위가 정해지고, 승인되고, 기록됩니다.',
    },
    scene: {
      title: 'API에 물어보기',
      body: '요청 하나, 타입이 있는 응답, 코드가 처리할 수 있는 오류. 목표로 하는 형태의 스케치이며 공개된 API가 아닙니다.',
    },
    featuresTitle: '개발자가 얻을 것',
  },
  de: {
    meta: {
      title: 'Entwickler: API, MCP und SDK',
      description:
        'Baue auf REZICS mit einer dokumentierten API, begrenzten Zugangsdaten, einem TypeScript-SDK und dem Agenten deiner Wahl.',
    },
    hero: {
      title: 'Alles im Browser hat eine API.',
      lede: 'REZICS ist API-zuerst gebaut. Nutze deine eigenen Werkzeuge oder bring einen Agenten mit: Jede Aktion ist begrenzt, freigegeben und protokolliert.',
    },
    scene: {
      title: 'Die API fragen',
      body: 'Eine Anfrage, eine typisierte Antwort und ein Fehler, auf den dein Code reagieren kann. Das skizziert die geplante Form; es ist keine veröffentlichte API.',
    },
    featuresTitle: 'Was Entwickler bekommen werden',
  },
  fr: {
    meta: {
      title: 'Développeurs : API, MCP et SDK',
      description:
        'Construisez sur REZICS avec une API documentée, des identifiants à portée limitée, un SDK TypeScript et l’agent de votre choix.',
    },
    hero: {
      title: 'Tout ce qui se fait dans le navigateur a une API.',
      lede: 'REZICS est conçu API d’abord. Utilisez vos propres outils ou apportez un agent : chaque action est bornée, approuvée et enregistrée.',
    },
    scene: {
      title: 'Interroger l’API',
      body: 'Une requête, une réponse typée et une erreur que votre code peut exploiter. Ceci esquisse la forme visée ; ce n’est pas une API publiée.',
    },
    featuresTitle: 'Ce que les développeurs obtiendront',
  },
  es: {
    meta: {
      title: 'Desarrolladores: API, MCP y SDK',
      description:
        'Construye sobre REZICS con una API documentada, credenciales acotadas, un SDK de TypeScript y el agente que prefieras.',
    },
    hero: {
      title: 'Todo lo del navegador tiene una API.',
      lede: 'REZICS se construye con la API primero. Usa tus propias herramientas o trae un agente: cada acción está acotada, aprobada y registrada.',
    },
    scene: {
      title: 'Preguntar a la API',
      body: 'Una solicitud, una respuesta tipada y un error que tu código puede tratar. Esboza la forma prevista; no es una API publicada.',
    },
    featuresTitle: 'Lo que obtendrán los desarrolladores',
  },
});
