import { APPEARANCE, platformRegistry } from '@rezics/composition';
import { isValidElement, type ReactNode } from 'react';
import { pageText, usePageLocale } from './data';

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

const headingClass = {
  2: 'text-2xl leading-snug in-data-[heading-scale=lg]:text-3xl',
  3: 'text-xl leading-snug in-data-[heading-scale=lg]:text-2xl',
  4: 'text-lg leading-snug in-data-[heading-scale=lg]:text-xl',
} as const;

const headingTag = { 2: 'h2', 3: 'h3', 4: 'h4' } as const;

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
  const text = pageText(props.text, usePageLocale());
  const level = props.level === 3 || props.level === 4 ? props.level : 2;
  const Tag = headingTag[level];
  return (
    <Tag
      lang={text.lang}
      className={`m-0 font-semibold tracking-tight text-balance text-foreground ${headingClass[level]}`}
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
    <div lang={text.lang} className={textClass}>
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

function Slot(props: Record<string, unknown>) {
  const children = content(props.children);
  switch (props.name) {
    case 'header':
      return <header className={slotClass}>{children}</header>;
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

export const layoutComponents = { Stack, Columns, Heading, Text, Slot };

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
