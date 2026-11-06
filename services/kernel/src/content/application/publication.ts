import type { ContentAmbient, ContentApplicationPorts, ContentDeadline } from '../contract/index.ts';

/** Publication use cases consume the supplied clock. Native create/revise stay on the command adapter. */
export function createPublication(ports: Pick<ContentApplicationPorts, 'publication'>, ambient: ContentAmbient) {
  return {
    elapsed(deadline: ContentDeadline): boolean {
      return !Number.isFinite(deadline) || ambient.now() >= deadline;
    },
    async createThread(deadline: ContentDeadline) {
      if (this.elapsed(deadline) || !ports.publication) return null;
      return ports.publication.createThread(deadline);
    },
  };
}
