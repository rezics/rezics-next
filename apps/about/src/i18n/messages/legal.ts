import type { PolicySlug } from '../../legal/policies.ts';
import { defineCopy } from '../define.ts';

/**
 * Chrome around the policies. The policies themselves stay in English (no
 * translated legal text); every locale says so and that English governs.
 */
export interface LegalCopy {
  /** The footer list's heading. */
  heading: string;
  /** Names of the policies, in the footer and as each page's title. */
  names: Record<PolicySlug, string>;
  /** Description of a policy page for search and sharing. */
  summary: string;
  governs: { title: string; body: string };
  draft: { title: string; body: string };
  source: string;
}

const en: LegalCopy = {
  heading: 'Policies',
  names: {
    terms: 'Terms of Service',
    privacy: 'Privacy Policy',
    'acceptable-use': 'Acceptable Use Policy',
    'content-ratings-and-age': 'Content Ratings and Age Policy',
    ai: 'AI Policy',
    'copyright-and-dmca': 'Copyright and DMCA Policy',
    ncii: 'NCII Takedown Policy',
    'child-safety': 'Child Safety Policy',
    'api-and-agent': 'API and Agent Terms',
  },
  summary: 'A REZICS policy, published in English.',
  governs: {
    title: 'This policy is published in English',
    body: 'We do not translate legal texts. If a translation or summary differs from the English text, the English text governs.',
  },
  draft: {
    title: 'Draft, not in force',
    body: 'This is a development build. Text marked in yellow still waits for a fact only REZICS can supply, and nothing on this page binds anyone yet.',
  },
  source: 'Source text',
};

export const legal = defineCopy<LegalCopy>({
  en,
  'zh-Hant': {
    heading: '政策',
    names: {
      terms: '服務條款',
      privacy: '隱私權政策',
      'acceptable-use': '可接受使用政策',
      'content-ratings-and-age': '內容分級與年齡政策',
      ai: 'AI 政策',
      'copyright-and-dmca': '著作權與 DMCA 政策',
      ncii: 'NCII 下架政策',
      'child-safety': '兒童安全政策',
      'api-and-agent': 'API 與代理條款',
    },
    summary: 'REZICS 的政策，以英文發布。',
    governs: {
      title: '本政策以英文發布',
      body: '我們不翻譯法律文本。若譯文或摘要與英文文本有出入，以英文文本為準。',
    },
    draft: {
      title: '草稿，尚未生效',
      body: '這是開發版本。以黃色標示的文字仍待 REZICS 提供事實，此頁內容目前對任何人都沒有拘束力。',
    },
    source: '原始文本',
  },
  'zh-Hans': {
    heading: '政策',
    names: {
      terms: '服务条款',
      privacy: '隐私政策',
      'acceptable-use': '可接受使用政策',
      'content-ratings-and-age': '内容分级与年龄政策',
      ai: 'AI 政策',
      'copyright-and-dmca': '版权与 DMCA 政策',
      ncii: 'NCII 删除政策',
      'child-safety': '儿童安全政策',
      'api-and-agent': 'API 与代理条款',
    },
    summary: 'REZICS 的政策，以英文发布。',
    governs: {
      title: '本政策以英文发布',
      body: '我们不翻译法律文本。若译文或摘要与英文文本不一致，以英文文本为准。',
    },
    draft: {
      title: '草稿，尚未生效',
      body: '这是开发版本。以黄色标出的文字仍待 REZICS 提供事实，本页内容目前对任何人都没有约束力。',
    },
    source: '原始文本',
  },
  ja: {
    heading: 'ポリシー',
    names: {
      terms: '利用規約',
      privacy: 'プライバシーポリシー',
      'acceptable-use': '許容される利用に関するポリシー',
      'content-ratings-and-age': 'コンテンツ区分と年齢に関するポリシー',
      ai: 'AI ポリシー',
      'copyright-and-dmca': '著作権と DMCA に関するポリシー',
      ncii: 'NCII 削除ポリシー',
      'child-safety': '児童の安全に関するポリシー',
      'api-and-agent': 'API とエージェントの規約',
    },
    summary: 'REZICS のポリシーです。英語で公開しています。',
    governs: {
      title: 'このポリシーは英語で公開しています',
      body: '法的文書は翻訳しません。翻訳や要約が英語の文面と異なる場合は、英語の文面が優先されます。',
    },
    draft: {
      title: '草案であり、効力はありません',
      body: 'これは開発用のビルドです。黄色で示した箇所は REZICS だけが用意できる事実を待っており、このページの内容はまだ誰も拘束しません。',
    },
    source: '原文',
  },
  ko: {
    heading: '정책',
    names: {
      terms: '서비스 약관',
      privacy: '개인정보 처리방침',
      'acceptable-use': '허용 가능한 사용 정책',
      'content-ratings-and-age': '콘텐츠 등급 및 연령 정책',
      ai: 'AI 정책',
      'copyright-and-dmca': '저작권 및 DMCA 정책',
      ncii: 'NCII 삭제 정책',
      'child-safety': '아동 안전 정책',
      'api-and-agent': 'API 및 에이전트 약관',
    },
    summary: '영어로 게시된 REZICS 정책입니다.',
    governs: {
      title: '이 정책은 영어로 게시됩니다',
      body: '법률 문서는 번역하지 않습니다. 번역이나 요약이 영어 본문과 다를 경우 영어 본문이 우선합니다.',
    },
    draft: {
      title: '초안이며 효력이 없습니다',
      body: '개발용 빌드입니다. 노란색으로 표시된 부분은 REZICS만 제공할 수 있는 사실을 기다리고 있으며, 이 페이지의 내용은 아직 누구도 구속하지 않습니다.',
    },
    source: '원문',
  },
  de: {
    heading: 'Richtlinien',
    names: {
      terms: 'Nutzungsbedingungen',
      privacy: 'Datenschutzerklärung',
      'acceptable-use': 'Richtlinie zur zulässigen Nutzung',
      'content-ratings-and-age': 'Richtlinie zu Inhaltseinstufung und Alter',
      ai: 'KI-Richtlinie',
      'copyright-and-dmca': 'Richtlinie zu Urheberrecht und DMCA',
      ncii: 'NCII-Entfernungsrichtlinie',
      'child-safety': 'Richtlinie zum Kinderschutz',
      'api-and-agent': 'Bedingungen für API und Agenten',
    },
    summary: 'Eine REZICS-Richtlinie, veröffentlicht auf Englisch.',
    governs: {
      title: 'Diese Richtlinie erscheint auf Englisch',
      body: 'Wir übersetzen keine Rechtstexte. Weicht eine Übersetzung oder Zusammenfassung vom englischen Text ab, gilt der englische Text.',
    },
    draft: {
      title: 'Entwurf, nicht in Kraft',
      body: 'Dies ist ein Entwicklungs-Build. Gelb markierter Text wartet noch auf eine Angabe, die nur REZICS machen kann; nichts auf dieser Seite bindet bisher jemanden.',
    },
    source: 'Quelltext',
  },
  fr: {
    heading: 'Politiques',
    names: {
      terms: 'Conditions d’utilisation',
      privacy: 'Politique de confidentialité',
      'acceptable-use': 'Politique d’utilisation acceptable',
      'content-ratings-and-age': 'Politique de classification des contenus et d’âge',
      ai: 'Politique sur l’IA',
      'copyright-and-dmca': 'Politique sur le droit d’auteur et le DMCA',
      ncii: 'Politique de retrait des images intimes non consenties',
      'child-safety': 'Politique de protection de l’enfance',
      'api-and-agent': 'Conditions de l’API et des agents',
    },
    summary: 'Une politique de REZICS, publiée en anglais.',
    governs: {
      title: 'Cette politique est publiée en anglais',
      body: 'Nous ne traduisons pas les textes juridiques. Si une traduction ou un résumé diffère du texte anglais, c’est le texte anglais qui fait foi.',
    },
    draft: {
      title: 'Brouillon, non en vigueur',
      body: 'Ceci est une version de développement. Le texte surligné en jaune attend encore un fait que seul REZICS peut fournir ; rien sur cette page n’engage encore personne.',
    },
    source: 'Texte source',
  },
  es: {
    heading: 'Políticas',
    names: {
      terms: 'Términos del servicio',
      privacy: 'Política de privacidad',
      'acceptable-use': 'Política de uso aceptable',
      'content-ratings-and-age': 'Política de clasificación de contenido y edad',
      ai: 'Política de IA',
      'copyright-and-dmca': 'Política de derechos de autor y DMCA',
      ncii: 'Política de retirada de imágenes íntimas sin consentimiento',
      'child-safety': 'Política de seguridad infantil',
      'api-and-agent': 'Términos de la API y los agentes',
    },
    summary: 'Una política de REZICS, publicada en inglés.',
    governs: {
      title: 'Esta política se publica en inglés',
      body: 'No traducimos los textos legales. Si una traducción o un resumen difiere del texto en inglés, prevalece el texto en inglés.',
    },
    draft: {
      title: 'Borrador, no vigente',
      body: 'Esta es una compilación de desarrollo. El texto marcado en amarillo aún espera un dato que solo REZICS puede aportar; nada de esta página obliga todavía a nadie.',
    },
    source: 'Texto fuente',
  },
});
