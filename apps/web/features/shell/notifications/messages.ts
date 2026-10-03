import { insert } from 'native-i18n';
import { defineMessages } from '../../../i18n/define.ts';

export const messages = defineMessages({
  en: {
    newWork: insert('New Work: {{title}}', { title: String }),
    newWorkIn: insert('New in {{topic}}: {{title}}', { topic: String, title: String }),
  },
  'zh-Hans': {
    newWork: insert('新作品：{{title}}', { title: String }),
    newWorkIn: insert('{{topic}}的新作品：{{title}}', { topic: String, title: String }),
  },
  'zh-Hant': {
    newWork: insert('新作品：{{title}}', { title: String }),
    newWorkIn: insert('{{topic}}的新作品：{{title}}', { topic: String, title: String }),
  },
  ja: {
    newWork: insert('新しい作品：{{title}}', { title: String }),
    newWorkIn: insert('{{topic}}の新しい作品：{{title}}', { topic: String, title: String }),
  },
  ko: {
    newWork: insert('새 작품: {{title}}', { title: String }),
    newWorkIn: insert('{{topic}}의 새 작품: {{title}}', { topic: String, title: String }),
  },
  de: {
    newWork: insert('Neues Werk: {{title}}', { title: String }),
    newWorkIn: insert('Neu in {{topic}}: {{title}}', { topic: String, title: String }),
  },
  fr: {
    newWork: insert('Nouvelle œuvre : {{title}}', { title: String }),
    newWorkIn: insert('Nouveau dans {{topic}} : {{title}}', { topic: String, title: String }),
  },
  es: {
    newWork: insert('Nueva obra: {{title}}', { title: String }),
    newWorkIn: insert('Nuevo en {{topic}}: {{title}}', { topic: String, title: String }),
  },
});
