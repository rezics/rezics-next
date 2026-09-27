import type { OnboardingMessages } from '../messages.ts';

export default {
  welcome: 'Willkommen bei REZICS',
  welcomeHelp: 'Wähle einen Benutzernamen für dein Profil. Dein öffentlicher Name wird daneben angezeigt.',
  displayName: 'Anzeigename',
  displayNameHelp: 'Dieser Name stammt aus deinem REZICS-Konto.',
  handle: 'Benutzername',
  handleHelp: 'Verwende 3–30 Buchstaben, Ziffern oder Unterstriche. Bei Benutzernamen wird nicht zwischen Groß- und Kleinschreibung unterschieden.',
  checking: 'Verfügbarkeit wird geprüft…',
  available: 'Dieser Benutzername ist verfügbar.',
  current: 'Das ist dein aktueller Benutzername.',
  taken: 'Dieser Benutzername ist bereits vergeben. Versuche einen anderen.',
  reserved: 'Dieser Benutzername kann nicht verwendet werden. Versuche einen anderen.',
  invalid: 'Verwende 3–30 Buchstaben, Ziffern oder Unterstriche.',
  checkFailed: 'Der Benutzername konnte nicht geprüft werden. Bitte versuche es erneut.',
  continue: 'Weiter zur Startseite',
  pending: 'Dein Profil wird vorbereitet',
  pendingHelp: 'Das dauert normalerweise nur einen Moment. Deine Anmeldung ist gespeichert.',
  retry: 'Erneut versuchen',
  failed: 'Dein Profil konnte nicht eingerichtet werden. Bitte versuche es erneut.',
  changeConflict: 'Der Benutzername wurde geändert oder ist nicht mehr verfügbar. Prüfe ihn erneut.',
  interestsLater: 'Themen und Communities, denen du folgen möchtest, kannst du später auswählen.',
} satisfies Partial<OnboardingMessages>;
