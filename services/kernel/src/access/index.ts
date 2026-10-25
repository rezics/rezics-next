import { anonymousAccess, type Access, type AccessConfig } from '../request/access.ts';

export const access = anonymousAccess;

/** Creates the anonymous stand-in, refusing actions not open to anonymous requests. */
export function createAccess({ actions }: AccessConfig): Access {
  return {
    ...anonymousAccess,
    async authorize(client, actor, action, resource, evidence) {
      if (actions.get(action)?.anonymous !== true) return false;
      return anonymousAccess.authorize(client, actor, action, resource, evidence);
    },
  };
}
