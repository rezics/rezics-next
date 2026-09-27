import type { OnboardingMessages } from '../messages.ts';

export default {
  welcome: 'Te damos la bienvenida a REZICS',
  welcomeHelp: 'Elige un nombre de usuario para tu perfil. Tu nombre público aparecerá junto a él.',
  displayName: 'Nombre visible',
  displayNameHelp: 'Este nombre procede de tu cuenta de REZICS.',
  handle: 'Tu nombre de usuario',
  handleHelp: 'Usa entre 3 y 30 letras, números o guiones bajos. No distingue entre mayúsculas y minúsculas.',
  checking: 'Comprobando si está disponible…',
  available: 'Este nombre de usuario está disponible.',
  current: 'Este es tu nombre de usuario actual.',
  taken: 'Este nombre de usuario ya está en uso. Prueba con otro.',
  reserved: 'No se puede usar este nombre de usuario. Prueba con otro.',
  invalid: 'Usa entre 3 y 30 letras, números o guiones bajos.',
  checkFailed: 'No se pudo comprobar este nombre de usuario. Inténtalo de nuevo.',
  continue: 'Ir al inicio',
  pending: 'Se está preparando tu perfil',
  pendingHelp: 'Suele tardar solo un momento. Tu inicio de sesión está guardado.',
  retry: 'Reintentar',
  failed: 'No se pudo terminar de configurar tu perfil. Inténtalo de nuevo.',
  changeConflict: 'Ese nombre de usuario cambió o ya no está disponible. Compruébalo de nuevo.',
  interestsLater: 'Más adelante podrás elegir los temas y las comunidades que quieres seguir.',
} satisfies Partial<OnboardingMessages>;
