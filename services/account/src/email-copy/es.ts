import { plural } from './plural.ts';
import type { EmailCopy } from './types.ts';

const topics: Record<string, { one?: string; other: string }> = {
  reply: { one: '{n} respuesta', other: '{n} respuestas' },
  mention: { one: '{n} mención', other: '{n} menciones' },
  'post-vote': { one: '{n} voto en tus publicaciones', other: '{n} votos en tus publicaciones' },
  'followed-chapter': { one: '{n} capítulo nuevo', other: '{n} capítulos nuevos' },
  'review-helpful': { one: '{n} voto útil en tus reseñas', other: '{n} votos útiles en tus reseñas' },
  review: { one: '{n} reseña', other: '{n} reseñas' },
  'submission-decision': { one: '{n} decisión sobre un envío', other: '{n} decisiones sobre envíos' },
  'moderation-outcome': { one: '{n} resultado de moderación', other: '{n} resultados de moderación' },
  'realm-role-change': { one: '{n} cambio de rol', other: '{n} cambios de rol' },
  'realm-membership-change': { one: '{n} cambio de membresía', other: '{n} cambios de membresía' },
  'realm-invitation': { one: '{n} invitación a una comunidad', other: '{n} invitaciones a una comunidad' },
  'claim-correction': { one: '{n} corrección de una alegación', other: '{n} correcciones de alegaciones' },
  notification: { one: '{n} notificación', other: '{n} notificaciones' },
};

const copy: EmailCopy = {
  verify: { subject: 'Confirma tu dirección de correo', body: 'Confirma esta dirección para tu cuenta de REZICS.', action: 'Confirmar correo' },
  reset: { subject: 'Restablece tu contraseña', body: 'Elige una contraseña nueva para tu cuenta de REZICS. Este enlace caduca en 30 minutos.', action: 'Restablecer contraseña' },
  'change-email': { subject: 'Confirma el cambio de correo', body: 'Confirma la solicitud para cambiar tu correo de REZICS. Después tendrás que verificar la dirección nueva.', action: 'Confirmar el cambio' },
  notice: { subject: 'Un mensaje sobre tu cuenta de REZICS', body: 'El equipo de REZICS te envía este mensaje sobre tu cuenta:', action: 'Abrir tu cuenta de REZICS' },
  digest: { subject: 'Tu resumen de notificaciones de REZICS', body: 'Esto es lo que ha pasado hoy.', action: 'Abrir REZICS' },
  ignore: 'Si no has solicitado esto, puedes ignorar este mensaje.',
  digestMore: 'Hay más notificaciones en REZICS.',
  digestLine: (topic, count) => plural('es', count, topics[topic] ?? topics.notification!),
};

export default copy;
