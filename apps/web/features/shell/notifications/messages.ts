import { insert } from 'native-i18n';
import { defineMessages } from '../../../i18n/define.ts';

export const messages = defineMessages({
  en: {
    newWork: insert('New Work: {{title}}', { title: String }),
    newWorkIn: insert('New in {{topic}}: {{title}}', { topic: String, title: String }),
    thisRealm: 'this Realm',
    bannedUntil: insert('You are banned from {{realm}} until {{end}}. Reason: {{reason}}. Open the Realm to appeal.',
      { realm: String, end: String, reason: String }),
    bannedPermanent: insert('You are banned from {{realm}}, and the ban does not end. Reason: {{reason}}. Open the Realm to appeal.',
      { realm: String, reason: String }),
    unbanned: insert('Your ban in {{realm}} has ended. Reason: {{reason}}.', { realm: String, reason: String }),
  },
  'zh-Hans': {
    newWork: insert('新作品：{{title}}', { title: String }),
    newWorkIn: insert('{{topic}}的新作品：{{title}}', { topic: String, title: String }),
    // Machine-drafted; needs native review.
    thisRealm: '这个社区',
    bannedUntil: insert('你被禁止参与{{realm}}，直到{{end}}。原因：{{reason}}。打开这个社区即可申诉。',
      { realm: String, end: String, reason: String }),
    bannedPermanent: insert('你被禁止参与{{realm}}，且没有结束时间。原因：{{reason}}。打开这个社区即可申诉。',
      { realm: String, reason: String }),
    unbanned: insert('你在{{realm}}的封禁已经结束。原因：{{reason}}。', { realm: String, reason: String }),
  },
  'zh-Hant': {
    newWork: insert('新作品：{{title}}', { title: String }),
    newWorkIn: insert('{{topic}}的新作品：{{title}}', { topic: String, title: String }),
    // Machine-drafted; needs native review.
    thisRealm: '這個社群',
    bannedUntil: insert('你被禁止參與{{realm}}，直到{{end}}。原因：{{reason}}。打開這個社群即可申訴。',
      { realm: String, end: String, reason: String }),
    bannedPermanent: insert('你被禁止參與{{realm}}，且沒有結束時間。原因：{{reason}}。打開這個社群即可申訴。',
      { realm: String, reason: String }),
    unbanned: insert('你在{{realm}}的封禁已經結束。原因：{{reason}}。', { realm: String, reason: String }),
  },
  ja: {
    newWork: insert('新しい作品：{{title}}', { title: String }),
    newWorkIn: insert('{{topic}}の新しい作品：{{title}}', { topic: String, title: String }),
    // Machine-drafted; needs native review.
    thisRealm: 'このコミュニティ',
    bannedUntil: insert('{{realm}}への参加を{{end}}まで停止しました。理由：{{reason}}。コミュニティを開いて異議を申し立てできます。',
      { realm: String, end: String, reason: String }),
    bannedPermanent: insert('{{realm}}への参加を停止しました。この停止に終了日はありません。理由：{{reason}}。コミュニティを開いて異議を申し立てできます。',
      { realm: String, reason: String }),
    unbanned: insert('{{realm}}での参加停止は終了しました。理由：{{reason}}。', { realm: String, reason: String }),
  },
  ko: {
    newWork: insert('새 작품: {{title}}', { title: String }),
    newWorkIn: insert('{{topic}}의 새 작품: {{title}}', { topic: String, title: String }),
    // Machine-drafted; needs native review.
    thisRealm: '이 커뮤니티',
    bannedUntil: insert('{{end}}까지 {{realm}} 참여가 제한되었습니다. 사유: {{reason}}. 커뮤니티를 열면 이의를 제기할 수 있습니다.',
      { realm: String, end: String, reason: String }),
    bannedPermanent: insert('{{realm}} 참여가 제한되었으며, 종료일이 없습니다. 사유: {{reason}}. 커뮤니티를 열면 이의를 제기할 수 있습니다.',
      { realm: String, reason: String }),
    unbanned: insert('{{realm}}의 참여 제한이 끝났습니다. 사유: {{reason}}.', { realm: String, reason: String }),
  },
  de: {
    newWork: insert('Neues Werk: {{title}}', { title: String }),
    newWorkIn: insert('Neu in {{topic}}: {{title}}', { topic: String, title: String }),
    // Machine-drafted; needs native review.
    thisRealm: 'dieser Community',
    bannedUntil: insert('Du bist bis {{end}} aus {{realm}} ausgeschlossen. Grund: {{reason}}. Öffne die Community, um Widerspruch einzulegen.',
      { realm: String, end: String, reason: String }),
    bannedPermanent: insert('Du bist aus {{realm}} ausgeschlossen, und der Ausschluss endet nicht. Grund: {{reason}}. Öffne die Community, um Widerspruch einzulegen.',
      { realm: String, reason: String }),
    unbanned: insert('Dein Ausschluss aus {{realm}} ist beendet. Grund: {{reason}}.', { realm: String, reason: String }),
  },
  fr: {
    newWork: insert('Nouvelle œuvre : {{title}}', { title: String }),
    newWorkIn: insert('Nouveau dans {{topic}} : {{title}}', { topic: String, title: String }),
    // Machine-drafted; needs native review.
    thisRealm: 'cette communauté',
    bannedUntil: insert('Vous êtes exclu·e de {{realm}} jusqu’au {{end}}. Motif : {{reason}}. Ouvrez la communauté pour faire appel.',
      { realm: String, end: String, reason: String }),
    bannedPermanent: insert('Vous êtes exclu·e de {{realm}}, sans date de fin. Motif : {{reason}}. Ouvrez la communauté pour faire appel.',
      { realm: String, reason: String }),
    unbanned: insert('Votre exclusion de {{realm}} est terminée. Motif : {{reason}}.', { realm: String, reason: String }),
  },
  es: {
    newWork: insert('Nueva obra: {{title}}', { title: String }),
    newWorkIn: insert('Nuevo en {{topic}}: {{title}}', { topic: String, title: String }),
    // Machine-drafted; needs native review.
    thisRealm: 'esta comunidad',
    bannedUntil: insert('Tienes un veto en {{realm}} hasta el {{end}}. Motivo: {{reason}}. Abre la comunidad para apelar.',
      { realm: String, end: String, reason: String }),
    bannedPermanent: insert('Tienes un veto en {{realm}} y no tiene fecha de fin. Motivo: {{reason}}. Abre la comunidad para apelar.',
      { realm: String, reason: String }),
    unbanned: insert('Tu veto en {{realm}} ha terminado. Motivo: {{reason}}.', { realm: String, reason: String }),
  },
});
