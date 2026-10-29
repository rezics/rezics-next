import { createFileRoute, notFound } from '@tanstack/react-router';

export const Route = createFileRoute('/zones/$id_/subjects/$subjectId')({
  loader: () => {
    throw notFound();
  },
});
