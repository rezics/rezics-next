import { asValue, insert, number, plural } from 'native-i18n';
import type { HomeMessages } from '../messages.ts';

export default {
  title: 'Accueil',

  // Continue
  continueTitle: 'Reprendre la lecture',
  newChapters: plural({ one: insert('{{count}} nouveau'), other: insert('{{count}} nouveaux') }, { count: asValue(number()) }),
  newChaptersAtLeast: plural({ one: insert('{{count}}+ nouveau'), other: insert('{{count}}+ nouveaux') },
    { count: asValue(number()) }),
  nextChapter: insert('Suivant : {{chapter}}', { chapter: String }), nextUp: 'Reprendre là où vous en étiez',
  continueWork: insert('Continuer « {{title}} »', { title: String }),
  hideFromContinue: insert('Masquer « {{title}} » dans la liste de lecture', { title: String }),
  hiddenFromContinue: insert('« {{title}} » n’apparaît plus dans la liste de lecture.', { title: String }),
  hideFailed: 'Impossible de masquer l’œuvre. Réessayez.', undo: 'Annuler',
  scrollBack: 'Faire défiler vers le haut', scrollForward: 'Faire défiler vers le bas',

  // Signed out
  welcomeTitle: 'Suivez des communautés pour personnaliser votre accueil',
  welcomeBody: 'Rejoignez les communautés des œuvres que vous aimez. Leurs nouveaux chapitres, sélections et discussions apparaîtront ici.',
  signUp: 'Rejoindre REZICS', signIn: 'Se connecter', dismiss: 'Ignorer',
  officialZones: 'Zones officielles', officialZonesIntro: 'Sélectionnées par les communautés REZICS',

  // Suggestions
  reasonPopular: 'Populaire sur REZICS',
  members: plural({ one: insert('{{count}} membre'), other: insert('{{count}} membres') }, { count: asValue(number()) }),
  membersAbout: plural({ one: insert('Environ {{count}} membre'), other: insert('Environ {{count}} membres') },
    { count: asValue(number()) }),

  // The rail
  sidebar: 'À découvrir sur REZICS',
  trendingFollowed: 'Tendances dans vos communautés', trendingGlobal: 'Tendances de la semaine',
  trendingEmpty: 'Rien ne fait encore tendance cette semaine.',
  realmsToFollow: 'Communautés à suivre', popularRealms: 'Communautés populaires',
  follow: 'Suivre', followed: 'Suivi', followRealm: insert('Suivre {{realm}}', { realm: String }),
  followOneFailed: 'Impossible de suivre cette communauté. Réessayez.',
  queueTitle: 'Votre file de modération',
  queueWaiting: insert('{{count}} en attente', { count: String }), queueClear: 'Aucun élément en attente',
  openManage: 'Ouvrir la gestion',
  howHomeWorks: 'Comment fonctionne l’accueil',
  howBest: insert('Le classement Pertinence s’appuie sur les votes des lecteurs, qui diminuent pendant environ {{hours}} heures. Chaque publication est comparée aux autres de sa communauté.',
    { hours: String }),
  howCap: insert('Une communauté ne peut pas occuper plus de {{cap}} places consécutives sur {{window}} publications.', { cap: String, window: String }),
  howNew: 'Nouveautés affiche les publications des plus récentes aux plus anciennes. Top compte les votes sur la période choisie.',
  howFollowing: 'Suivi affiche les communautés, les Zones et les œuvres que vous suivez. Les suggestions n’apparaissent que si le fil est calme, et sont signalées comme telles.',
} satisfies Partial<HomeMessages>;
