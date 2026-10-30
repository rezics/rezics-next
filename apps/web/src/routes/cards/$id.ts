import { createFileRoute } from '@tanstack/react-router';

async function respond({ request }: { request: Request }) {
  const { currentShareCardResponse } = await import('../../media/share-card.worker');
  return currentShareCardResponse(request);
}

export const Route = createFileRoute('/cards/$id')({
  staticData: { publicCache: false },
  server: { handlers: { GET: respond, HEAD: respond } },
});
