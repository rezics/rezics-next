'use client';

import type { Copy } from './messages.ts';
import { groups, ingredients, linesOf, measureOf, minutesOf, type RecipeState, steps } from './model.ts';
import { amountText } from './quantity.ts';
import { directionOf } from '../studio/types.ts';

const minutesText = (t: Copy, minutes: number | 'other' | null) => minutes === null || minutes === 'other' ? null : `${minutes} ${t.minutesUnit}`;

/** How the recipe reads on its page, from what the editor holds now. */
export function Preview({ state, title, description, language, t }: { state: RecipeState; title: string; description: string;
  language: string; t: Copy }) {
  const lang = { lang: language, dir: directionOf(language) } as const;
  const yielded = measureOf(state, 'yield');
  const servings = measureOf(state, 'servings');
  const facts = [
    yielded ? `${t.makes} ${amountText(yielded.value)} ${yielded.unitText ?? ''}`.trim() : null,
    servings && !(yielded?.unitText === t.servingsWord) ? `${t.servings} ${amountText(servings.value)}` : null,
    ...(['preparation', 'cooking', 'total'] as const).map(name => {
      const text = minutesText(t, minutesOf(measureOf(state, name)));
      return text ? `${name === 'preparation' ? t.prepTime : name === 'cooking' ? t.cookTime : t.totalTime} ${text}` : null;
    }),
  ].filter((fact): fact is string => fact !== null);
  const sections = groups(state);
  const loose = linesOf(state, null);
  const method = steps(state);
  const names = new Map(ingredients(state).map(node => [node.occurrence, node.qualifier.originalText.value]));
  const empty = !title && !description && !ingredients(state).length && !method.length;
  return <article aria-labelledby="recipe-preview" className="grid gap-5 rounded-2xl border border-border/60 bg-card p-4 sm:p-5">
    <div className="grid gap-1">
      <h2 id="recipe-preview" className="font-semibold text-sm text-muted-foreground">{t.previewHeading}</h2>
      <p className="text-muted-foreground text-xs">{t.previewHelp}</p>
    </div>
    {empty ? <p className="text-muted-foreground text-sm">{t.previewEmpty}</p> : <>
      {title ? <h3 {...lang} className="font-semibold font-work-title text-2xl/tight">{title}</h3> : null}
      {description ? <p {...lang} className="whitespace-pre-wrap text-pretty text-muted-foreground">{description}</p> : null}
      {facts.length ? <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">{facts.map(fact => <span key={fact}>{fact}</span>)}</p> : null}
      {ingredients(state).length ? <div className="grid gap-3">
        <h4 className="font-semibold">{t.ingredientsHeading}</h4>
        {loose.length ? <ul {...lang} className="grid gap-1.5">{loose.map(node => <li key={node.occurrence}>{node.qualifier.originalText.value}</li>)}</ul> : null}
        {sections.map(group => {
          const lines = linesOf(state, group.occurrence);
          return lines.length ? <div key={group.occurrence} className="grid gap-1.5">
            <h5 {...lang} className="font-medium text-sm">{group.label?.value}</h5>
            <ul {...lang} className="grid gap-1.5">{lines.map(node => <li key={node.occurrence}>{node.qualifier.originalText.value}</li>)}</ul>
          </div> : null;
        })}
      </div> : null}
      {method.length ? <div className="grid gap-3">
        <h4 className="font-semibold">{t.methodHeading}</h4>
        <ol className="grid gap-3">{method.map((node, index) => <li key={node.occurrence} className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-2">
          <span aria-hidden="true" className="flex size-7 items-center justify-center rounded-full bg-primary/10 font-semibold text-xs">{index + 1}</span>
          <div className="grid gap-1" {...lang}><p className="whitespace-pre-wrap">{node.qualifier.instructionText.value}</p>
            {node.qualifier.usesIngredient.length ? <p className="text-muted-foreground text-xs">
              {node.qualifier.usesIngredient.map(id => names.get(id)).filter(Boolean).join(' · ')}</p> : null}</div>
        </li>)}</ol>
      </div> : null}
    </>}
  </article>;
}
