import { APPEARANCE, platformRegistry } from '@rezics/composition';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { createContext, isValidElement, useContext, type ReactNode } from 'react';
import { pageText, usePageLocale, usePageMessages } from './data';

/** `{ type, slots }` for every platform component, shared by layout and data renderers. */
export const pageDefinitions = platformRegistry.components.map((component) => ({
  type: component.type,
  slots: [...component.slots],
}));

const rootClass = [
  'flex w-full flex-col gap-8 font-sans text-base text-foreground',
  'data-[density=compact]:gap-4',
  'data-[surface=cards]:[&>*]:rounded-2xl data-[surface=cards]:[&>*]:border data-[surface=cards]:[&>*]:border-border/60',
  'data-[surface=cards]:[&>*]:bg-card data-[surface=cards]:[&>*]:text-card-foreground',
  'data-[surface=cards]:[&>*]:px-6 data-[surface=cards]:[&>*]:py-5 data-[surface=cards]:[&>*]:shadow-(--aura-shadow-card)',
  'data-[density=compact]:data-[surface=cards]:[&>*]:px-4 data-[density=compact]:data-[surface=cards]:[&>*]:py-3',
  'data-[surface=cards]:data-[radius=sm]:[&>*]:rounded-lg',
  'data-[surface=cards]:data-[radius=md]:[&>*]:rounded-2xl',
  'data-[surface=cards]:data-[radius=lg]:[&>*]:rounded-3xl',
].join(' ');

const stackGap = {
  sm: 'flex min-w-0 flex-col gap-3 in-data-[density=compact]:gap-2',
  md: 'flex min-w-0 flex-col gap-6 in-data-[density=compact]:gap-4',
  lg: 'flex min-w-0 flex-col gap-10 in-data-[density=compact]:gap-6',
} as const;

const columnSplit = {
  even: 'md:grid-cols-2',
  start: 'md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]',
  end: 'md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]',
} as const;

const columnClass = 'grid min-w-0 grid-cols-1 items-start gap-6 in-data-[density=compact]:gap-4';
const columnChild = 'flex min-w-0 flex-col gap-4 in-data-[density=compact]:gap-3';
const slotClass = 'flex min-w-0 flex-col gap-3 empty:hidden in-data-[density=compact]:gap-2';
const headerSlotClass = [
  'flex min-w-0 flex-col gap-3 empty:hidden in-data-[density=compact]:gap-2',
  'sm:flex-row sm:items-start sm:justify-between [&>*:first-child]:min-w-0 [&>*:first-child]:flex-1',
  '[&>[data-slot=actions]]:shrink-0',
].join(' ');
const actionsSlotClass = 'flex flex-wrap items-center gap-2';

const PageHostContext = createContext<{ actions: ReactNode; personal: ReactNode; afterHeader: ReactNode }>({
  actions: null,
  personal: null,
  afterHeader: null,
});

const headingClass = {
  1: 'text-4xl in-data-[heading-scale=lg]:text-5xl',
  2: 'text-2xl leading-snug in-data-[heading-scale=lg]:text-3xl',
  3: 'text-xl leading-snug in-data-[heading-scale=lg]:text-2xl',
  4: 'text-lg leading-snug in-data-[heading-scale=lg]:text-xl',
} as const;

const headingTag = { 1: 'h1', 2: 'h2', 3: 'h3', 4: 'h4' } as const;

const textClass = [
  'max-w-prose space-y-4 text-base leading-7 text-foreground',
  'in-data-[density=compact]:space-y-3 in-data-[density=compact]:leading-6',
].join(' ');

function token(allowed: readonly string[], value: unknown): string | undefined {
  return typeof value === 'string' && allowed.includes(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Keep only nodes React can draw. Anything else is dropped, never stringified into the page. */
function content(value: unknown): ReactNode {
  if (value == null || typeof value === 'boolean') return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (isValidElement(value)) return value;
  if (Array.isArray(value)) return value.map((item) => content(item));
  return null;
}

/** Puck passes slot content through a callback; inspect its child list to omit empty wrappers. */
function puckSlotHasContent(value: ReactNode): boolean | undefined {
  if (
    !isValidElement<{ as?: unknown }>(value) ||
    typeof value.type !== 'function' ||
    typeof value.props.as !== 'function' ||
    value.props.as.name !== 'SlotContent'
  )
    return;
  const renderSlot = value.type as (props: { as?: unknown }) => ReactNode;
  const rendered = renderSlot(value.props);
  return isValidElement<{ content?: unknown }>(rendered) && Array.isArray(rendered.props.content)
    ? rendered.props.content.length > 0
    : false;
}

function hasContent(value: ReactNode): boolean {
  if (value == null || typeof value === 'boolean') return false;
  if (typeof value === 'string') return value.length > 0;
  if (typeof value === 'number') return true;
  if (Array.isArray(value)) return value.some(hasContent);
  const puckSlotContent = puckSlotHasContent(value);
  if (puckSlotContent !== undefined) return puckSlotContent;
  if (isValidElement<{ children?: ReactNode }>(value)) {
    if ((value.type as unknown) === Symbol.for('react.fragment')) return hasContent(value.props.children);
    if (typeof value.type === 'function' && value.type.name === 'SlotContent') {
      return hasContent(value.props.children);
    }
  }
  return true;
}

/**
 * Provide content owned by the page host to its template's actions and personal slots, and the content the host
 * places right after the template's header: the view tabs.
 */
export function PageHost({
  actions,
  personal,
  afterHeader,
  children,
}: {
  actions?: ReactNode;
  personal?: ReactNode;
  afterHeader?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <PageHostContext.Provider
      value={{ actions: actions ?? null, personal: personal ?? null, afterHeader: afterHeader ?? null }}
    >
      {children}
    </PageHostContext.Provider>
  );
}

function choice<const Values extends readonly string[]>(
  values: Values,
  value: unknown,
  fallback: Values[number],
): Values[number] {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
    ? (value as Values[number])
    : fallback;
}

function Stack(props: Record<string, unknown>) {
  const gap = choice(['sm', 'md', 'lg'], props.gap, 'md');
  return <div className={stackGap[gap]}>{content(props.children)}</div>;
}

function Columns(props: Record<string, unknown>) {
  const split = choice(['even', 'start', 'end'], props.split, 'even');
  return (
    <div className={`${columnClass} ${columnSplit[split]}`}>
      <div className={columnChild}>{content(props.start)}</div>
      <div className={columnChild}>{content(props.end)}</div>
    </div>
  );
}

function Heading(props: Record<string, unknown>) {
  const locale = usePageLocale();
  const text = pageText(props.text, locale);
  const level = props.level === 1 || props.level === 3 || props.level === 4 ? props.level : 2;
  const Tag = headingTag[level];
  return (
    <Tag
      lang={level === 1 ? (text.lang ?? locale) : text.lang}
      className={`m-0 min-w-0 max-w-full font-semibold tracking-tight text-balance wrap-anywhere text-foreground ${headingClass[level]}`}
    >
      {text.text}
    </Tag>
  );
}

function paragraphs(text: string): string[][] {
  return text
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .split(/\n{2,}/)
    .filter((paragraph) => paragraph.length > 0)
    .map((paragraph) => paragraph.split('\n'));
}

function Text(props: Record<string, unknown>) {
  const text = pageText(props.text, usePageLocale());
  const blocks = paragraphs(text.text);
  if (blocks.length === 0) return null;
  return (
    <div lang={text.lang} className={`min-w-0 w-full wrap-anywhere ${textClass}`}>
      {blocks.map((lines, index) => (
        <p className="text-pretty" key={index}>
          {lines.reduce<ReactNode[]>((nodes, line, lineIndex) => {
            if (lineIndex > 0) nodes.push(<br key={lineIndex} />);
            nodes.push(line);
            return nodes;
          }, [])}
        </p>
      ))}
    </div>
  );
}

function SearchBox(props: Record<string, unknown>) {
  const locale = usePageLocale();
  const messages = usePageMessages();
  const placeholder = pageText(props.placeholder, locale);
  return (
    <form
      role="search"
      method="get"
      action={`/${encodeURIComponent(locale)}/search`}
      className="flex min-w-0 w-full max-w-3xl flex-wrap items-start gap-2"
    >
      <Input
        type="search"
        name="q"
        placeholder={placeholder.text}
        aria-label={placeholder.text}
        lang={placeholder.lang}
        className="h-12 min-w-0 max-w-full flex-[1_1_16rem] rounded-xl px-4 text-base"
      />
      <Button
        type="submit"
        size="lg"
        className="h-auto min-h-12 min-w-11 max-w-full shrink rounded-xl px-5 py-3 text-base whitespace-normal"
      >
        <span className="min-w-0 wrap-anywhere">{messages.search}</span>
      </Button>
    </form>
  );
}

function LinkGrid(props: Record<string, unknown>) {
  const locale = usePageLocale();
  const links = Array.isArray(props.links) ? props.links : [];
  return (
    <ul className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,11rem),1fr))] gap-3">
      {links.map((item, index) => {
        if (!isRecord(item) || typeof item.href !== 'string') return null;
        const label = pageText(item.label, locale);
        const href = item.href.startsWith('/') ? `/${encodeURIComponent(locale)}${item.href}` : item.href;
        return (
          <li className="min-w-0" key={`${item.href}:${index}`}>
            <a
              href={href}
              lang={label.lang}
              className="flex min-h-14 min-w-0 w-full items-center justify-center rounded-xl border border-border/70 bg-card px-4 py-3 text-center font-semibold text-card-foreground shadow-sm transition-colors hover:border-link/50 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="min-w-0 wrap-anywhere">{label.text}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

function Slot(props: Record<string, unknown>) {
  const { actions, personal, afterHeader } = useContext(PageHostContext);
  const children = content(props.children);
  switch (props.name) {
    case 'header':
      return (
        <>
          <header className={headerSlotClass}>{children}</header>
          {afterHeader}
        </>
      );
    case 'actions': {
      if (!hasContent(actions) && !hasContent(children)) return null;
      return (
        <div className={actionsSlotClass} data-slot="actions">
          {actions}
          {children}
        </div>
      );
    }
    case 'personal': {
      if (!hasContent(personal)) return null;
      return (
        <section className={slotClass} data-slot="personal">
          {personal}
          {children}
        </section>
      );
    }
    case 'hero':
      return (
        <section className={slotClass} data-slot="hero">
          {children}
        </section>
      );
    case 'entity':
      return <article className={slotClass}>{children}</article>;
    case 'aside':
      return <aside className={slotClass}>{children}</aside>;
    case 'footer':
      return <footer className={slotClass}>{children}</footer>;
    default:
      return <div className={slotClass}>{children}</div>;
  }
}

export const layoutComponents = { Stack, Columns, Heading, Text, SearchBox, LinkGrid, Slot };

/** One wrapper. Appearance tokens are emitted only when they belong to `APPEARANCE`. */
export function PageRoot(props: Record<string, unknown>) {
  const appearance = isRecord(props.appearance) ? props.appearance : {};
  return (
    <div
      className={rootClass}
      data-cover={token(APPEARANCE.cover, appearance.cover)}
      data-density={token(APPEARANCE.density, appearance.density)}
      data-heading-scale={token(APPEARANCE.headingScale, appearance.headingScale)}
      data-radius={token(APPEARANCE.radius, appearance.radius)}
      data-surface={token(APPEARANCE.surface, appearance.surface)}
    >
      {content(props.children)}
    </div>
  );
}
