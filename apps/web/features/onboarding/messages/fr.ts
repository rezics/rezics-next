import type { OnboardingMessages } from '../messages.ts';

export default {
  welcome: 'Bienvenue sur REZICS',
  welcomeHelp: 'Choisissez un nom d’utilisateur pour votre profil. Votre nom public apparaîtra à côté.',
  displayName: 'Nom public',
  displayNameHelp: 'Ce nom vient de votre compte REZICS.',
  handle: 'Votre nom d’utilisateur',
  handleHelp: 'Utilisez entre 3 et 30 lettres, chiffres ou tirets bas. La casse ne compte pas.',
  checking: 'Vérification de la disponibilité…',
  available: 'Ce nom d’utilisateur est disponible.',
  current: 'C’est votre nom d’utilisateur actuel.',
  taken: 'Ce nom d’utilisateur est déjà utilisé. Essayez-en un autre.',
  reserved: 'Ce nom d’utilisateur ne peut pas être utilisé. Essayez-en un autre.',
  invalid: 'Utilisez entre 3 et 30 lettres, chiffres ou tirets bas.',
  checkFailed: 'Impossible de vérifier ce nom d’utilisateur. Réessayez.',
  continue: 'Continuer vers l’accueil',
  pending: 'Votre profil est en cours de préparation',
  pendingHelp: 'Cela ne prend généralement qu’un instant. Votre connexion est enregistrée.',
  retry: 'Réessayer',
  failed: 'Impossible de terminer la configuration de votre profil. Réessayez.',
  changeConflict: 'Ce nom d’utilisateur a changé ou n’est plus disponible. Vérifiez-le à nouveau.',
} satisfies Partial<OnboardingMessages>;
