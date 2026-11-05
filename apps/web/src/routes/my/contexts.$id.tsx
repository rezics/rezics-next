import { createFileRoute, notFound } from '@tanstack/react-router';
import { ContextSession } from '../../features/contexts/session';
import { contextId } from '../../features/contexts/model';

export const Route = createFileRoute('/my/contexts/$id')({
  beforeLoad: ({ params }) => {
    if (!contextId.test(params.id)) throw notFound();
  },
  component: ContextDetailRoute,
});
function ContextDetailRoute() {
  return <ContextSession mode="detail" id={Route.useParams().id} />;
}
