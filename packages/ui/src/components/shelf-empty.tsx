import type { ReactNode } from 'react';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '../shadcn/empty.tsx';

/** Shelf-specific empty states use the shadcn empty composition. */
export function ShelfEmpty({
  kind,
  title,
  description,
  actions,
}: {
  kind: 'library' | 'tab' | 'no-match';
  title: string;
  description: string;
  actions: ReactNode;
}) {
  return (
    <Empty data-kind={kind}>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>{actions}</EmptyContent>
    </Empty>
  );
}
