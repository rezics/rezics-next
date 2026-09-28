import { asValue, insert, number, plural } from 'native-i18n';
import type { HomeMessages } from '../messages.ts';

export default {
  title: 'Startseite',

  // Continue
  continueTitle: 'Weiterlesen',
  newChapters: plural({ one: insert('{{count}} neue Kapitel'), other: insert('{{count}} neue Kapitel') }, { count: asValue(number()) }),
  newChaptersAtLeast: plural({ one: insert('{{count}}+ neue Kapitel'), other: insert('{{count}}+ neue Kapitel') },
    { count: asValue(number()) }),
  nextChapter: insert('Weiter: {{chapter}}', { chapter: String }), nextUp: 'Dort weiterlesen, wo du aufgehört hast',
  continueWork: insert('„{{title}}“ weiterlesen', { title: String }),
  hideFromContinue: insert('„{{title}}“ aus „Weiterlesen“ ausblenden', { title: String }),
  hiddenFromContinue: insert('„{{title}}“ wird nicht mehr unter „Weiterlesen“ angezeigt.', { title: String }),
  hideFailed: 'Das ließ sich nicht ausblenden. Versuch es noch einmal.', undo: 'Rückgängig',
  scrollBack: 'Zurückscrollen', scrollForward: 'Weiter scrollen',

  // Signed out
  welcomeTitle: 'Folge Communities, um deine Startseite zu gestalten',
  welcomeBody: 'Tritt den Communities hinter deinen Lieblingswerken bei. Neue Kapitel, Empfehlungen und Diskussionen erscheinen hier.',
  signUp: 'REZICS beitreten', signIn: 'Anmelden', dismiss: 'Schließen',
  officialZones: 'Offizielle Zones', officialZonesIntro: 'Kuratierte Auswahl aus den eigenen Communities von REZICS',

  // A new person
  pickTitle: 'Wofür nutzt du REZICS?',
  pickBody: 'Wähle ein paar Interessen aus. Wir schlagen dir passende Communities vor. Du kannst deine Auswahl jederzeit ändern.',
  step: insert('Schritt {{step}} von {{total}}', { step: String, total: String }),
  languagesTitle: 'In welchen Sprachen liest du?',
  languagesBody: 'Wir schlagen dir Communities vor, die in diesen Sprachen posten.',
  communitiesTitle: 'Folge ein paar Communities',
  communitiesBody: 'Diese Vorschläge passen zu deiner Auswahl. Entferne das Häkchen bei allem, was du nicht möchtest.',
  noSuggestions: 'Noch keine Vorschläge. Entdecke Communities unter „Entdecken“.',
  findingCommunities: 'Communities werden gesucht…',
  back: 'Zurück', next: 'Weiter', skip: 'Vorerst überspringen',
  followAndContinue: plural({ one: insert('{{count}} Community folgen und weiter'), other: insert('{{count}} Communities folgen und weiter') },
    { count: asValue(number()) }),
  continueWithoutFollowing: 'Ohne Folgen weiter',
  following: 'Wird gefolgt…', followFailed: 'Du konntest ihnen nicht folgen. Versuch es noch einmal.',
  pickLaterTitle: 'Gestalte deine Startseite', pickLaterBody: 'Wähle deine Interessen und folge ein paar Communities.',
  pickStart: 'Interessen auswählen',
  reasonPopular: 'Beliebt auf REZICS', reasonOfficial: 'Offizielle Zone',
  reasonKind: insert('Für {{kind}}', { kind: String }),
  members: plural({ one: insert('{{count}} Mitglied'), other: insert('{{count}} Mitglieder') }, { count: asValue(number()) }),
  membersAbout: plural({ one: insert('Etwa {{count}} Mitglied'), other: insert('Etwa {{count}} Mitglieder') },
    { count: asValue(number()) }),

  // The rail
  sidebar: 'Mehr auf REZICS',
  trendingFollowed: 'Beliebt in deinen Communities', trendingGlobal: 'Diese Woche im Trend',
  trendingEmpty: 'Diese Woche ist noch nichts im Trend.',
  realmsToFollow: 'Communities zum Folgen', popularRealms: 'Beliebte Communities',
  follow: 'Folgen', followed: 'Gefolgt', followRealm: insert('{{realm}} folgen', { realm: String }),
  followOneFailed: 'Das Folgen ist fehlgeschlagen. Versuch es noch einmal.',
  queueTitle: 'Deine Moderationswarteschlange',
  queueWaiting: insert('{{count}} warten', { count: String }), queueClear: 'Nichts wartet',
  openManage: 'Verwaltung öffnen',
  howHomeWorks: 'So funktioniert die Startseite',
  howBest: insert('„Beste“ sortiert Beiträge nach den Stimmen der Leserinnen und Leser. Ältere Stimmen zählen mit der Zeit weniger; berücksichtigt werden Beiträge aus derselben Community über etwa {{hours}} Stunden.',
    { hours: String }),
  howCap: insert('Höchstens {{cap}} von jeweils {{window}} aufeinanderfolgenden Beiträgen stammen aus derselben Community.', { cap: String, window: String }),
  howNew: '„Neu“ sortiert strikt nach Aktualität. „Top“ zählt die Stimmen im gewählten Zeitraum.',
  howFollowing: 'Hier erscheinen die Communities, Zones und Werke, denen du folgst. Vorschläge gibt es nur bei wenig Aktivität und sie sind gekennzeichnet.',
} satisfies Partial<HomeMessages>;
