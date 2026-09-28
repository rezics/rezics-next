import { plural } from './plural.ts';
import type { EmailCopy } from './types.ts';

const topics: Record<string, { one?: string; other: string }> = {
  reply: { one: '{n} réponse', other: '{n} réponses' },
  mention: { one: '{n} mention', other: '{n} mentions' },
  'post-vote': { one: '{n} vote sur vos publications', other: '{n} votes sur vos publications' },
  'followed-chapter': { one: '{n} nouveau chapitre', other: '{n} nouveaux chapitres' },
  'review-helpful': { one: '{n} vote utile sur vos critiques', other: '{n} votes utiles sur vos critiques' },
  review: { one: '{n} critique', other: '{n} critiques' },
  'submission-decision': { one: '{n} décision sur une soumission', other: '{n} décisions sur des soumissions' },
  'moderation-outcome': { one: '{n} résultat de modération', other: '{n} résultats de modération' },
  'realm-role-change': { one: '{n} changement de rôle', other: '{n} changements de rôle' },
  'realm-membership-change': { one: '{n} changement d’adhésion', other: '{n} changements d’adhésion' },
  'realm-invitation': { one: '{n} invitation à une communauté', other: '{n} invitations à une communauté' },
  'claim-correction': { one: '{n} correction de revendication', other: '{n} corrections de revendications' },
  notification: { one: '{n} notification', other: '{n} notifications' },
};

const copy: EmailCopy = {
  verify: { subject: 'Confirmez votre adresse e-mail', body: 'Confirmez cette adresse e-mail pour votre compte REZICS.', action: 'Confirmer l’adresse' },
  reset: { subject: 'Réinitialisez votre mot de passe', body: 'Choisissez un nouveau mot de passe pour votre compte REZICS. Ce lien expire dans 30 minutes.', action: 'Réinitialiser le mot de passe' },
  'change-email': { subject: 'Confirmez le changement d’adresse e-mail', body: 'Confirmez la demande de changement d’adresse e-mail REZICS. Vous devrez ensuite confirmer la nouvelle adresse.', action: 'Confirmer le changement' },
  notice: { subject: 'Un message au sujet de votre compte REZICS', body: 'L’équipe REZICS vous envoie ce message au sujet de votre compte :', action: 'Ouvrir votre compte REZICS' },
  digest: { subject: 'Votre récapitulatif de notifications REZICS', body: 'Voici ce qui s’est passé aujourd’hui.', action: 'Ouvrir REZICS' },
  ignore: 'Si vous n’êtes pas à l’origine de cette demande, ignorez ce message.',
  digestMore: 'D’autres notifications vous attendent dans REZICS.',
  digestLine: (topic, count) => plural('fr', count, topics[topic] ?? topics.notification!),
};

export default copy;
