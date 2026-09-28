import { plural } from './plural.ts';
import type { EmailCopy } from './types.ts';

const topics: Record<string, { other: string }> = {
  reply: { other: '返信{n}件' },
  mention: { other: '言及{n}件' },
  'post-vote': { other: '投稿への投票{n}件' },
  'followed-chapter': { other: '新しい章{n}件' },
  'review-helpful': { other: 'レビューへの参考票{n}件' },
  review: { other: 'レビュー{n}件' },
  'submission-decision': { other: '投稿の判定{n}件' },
  'moderation-outcome': { other: 'モデレーションの結果{n}件' },
  'realm-role-change': { other: '役割の変更{n}件' },
  'realm-membership-change': { other: 'メンバー変更{n}件' },
  'realm-invitation': { other: 'コミュニティへの招待{n}件' },
  'claim-correction': { other: '主張の訂正{n}件' },
  notification: { other: '通知{n}件' },
};

const copy: EmailCopy = {
  verify: { subject: 'メールアドレスを確認してください', body: 'このメールアドレスを REZICS アカウントに使うことを確認してください。', action: 'メールアドレスを確認' },
  reset: { subject: 'パスワードを再設定', body: 'REZICS アカウントの新しいパスワードを設定してください。このリンクは 30 分で無効になります。', action: 'パスワードを再設定' },
  'change-email': { subject: 'メールアドレスの変更を確認', body: 'REZICS のメールアドレス変更を確認してください。その後、新しいアドレスの確認が必要です。', action: '変更を確認' },
  notice: { subject: 'REZICS アカウントに関するお知らせ', body: 'REZICS チームから、アカウントについて次のメッセージが届いています。', action: 'REZICS アカウントを開く' },
  digest: { subject: 'REZICS の通知ダイジェスト', body: '今日の通知をまとめました。', action: 'REZICS を開く' },
  ignore: '心当たりがない場合は、このメールを無視してください。',
  digestMore: '他の通知は REZICS で確認できます。',
  digestLine: (topic, count) => plural('ja', count, topics[topic] ?? topics.notification!),
};

export default copy;
