import type { ContentAmbient, ContentApplicationPorts, ContentAuthoredFieldInput } from '../contract/index.ts';
import { admitAuthoredFieldInput } from '../core/index.ts';

export class AuthoredFieldRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthoredFieldRejectedError';
  }
}

export function createAuthoredFields(
  ports: Pick<ContentApplicationPorts, 'authoredFields'>,
  ambient: ContentAmbient,
) {
  return {
    admit(input: ContentAuthoredFieldInput): void {
      const reason = admitAuthoredFieldInput(input);
      if (reason) throw new AuthoredFieldRejectedError(reason);
    },
    nextId(): string {
      return ambient.id();
    },
    async erase(id: string, deadline: number) {
      if (!Number.isFinite(deadline) || ambient.now() >= deadline) return null;
      return ports.authoredFields.erase(id, deadline);
    },
  };
}
