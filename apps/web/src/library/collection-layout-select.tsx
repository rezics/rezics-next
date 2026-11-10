import { LayoutSelect } from '@rezics/ui/layout-select';
import { useRouter } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
import type { CollectionLayout } from './collection-presentation';

export function CollectionLayoutSelect({
  value,
  href,
  onValueChange,
}: {
  value: CollectionLayout;
  href: (layout: CollectionLayout) => string;
  onValueChange?: ((layout: CollectionLayout) => void) | undefined;
}) {
  const router = useRouter({ warn: false });
  const options = [
    { value: 'list', label: m.library_layout_list() },
    { value: 'grid', label: m.library_layout_grid() },
  ] as const;
  return (
    <div className="ms-auto min-w-0">
      <LayoutSelect
        label={m.library_layout()}
        value={value}
        options={options}
        onValueChange={(layout) => {
          if (onValueChange) return onValueChange(layout);
          const target = href(layout);
          if (router) void router.navigate({ href: target });
          else window.location.assign(target);
        }}
      />
      <noscript>
        <nav aria-label={m.library_layout()} data-slot="collection-layout" className="flex gap-3">
          {options.map((option) => (
            <a key={option.value} href={href(option.value)} aria-current={value === option.value ? 'page' : undefined}>
              {option.label}
            </a>
          ))}
        </nav>
      </noscript>
    </div>
  );
}
