'use client';

import type { Copy } from './messages.ts';
import { ingredients, type RecipeState, steps } from './model.ts';
import { readingOf } from './reading.ts';
import { directionOf } from '../studio/types.ts';
import type { WorkPageMessages } from '../work-page/messages.ts';
import { RecipeContent } from '../work-page/types/recipe.tsx';

/** How the recipe reads on its page, from what the editor holds now. The page's own component draws it. */
export function Preview({ state, title, description, notes, language, t, messages }: {
  state: RecipeState; title: string; description: string; notes: string; language: string; t: Copy; messages: WorkPageMessages;
}) {
  const lang = { lang: language, dir: directionOf(language) } as const;
  const body = notes.trim();
  const empty = !title && !description && !body && !ingredients(state).length && !steps(state).length && !state.measures.length;
  return <article aria-labelledby="recipe-preview" className="grid gap-5 rounded-2xl border border-border/60 bg-card p-4 sm:p-5">
    <div className="grid gap-1">
      <h2 id="recipe-preview" className="font-semibold text-sm text-muted-foreground">{t.previewHeading}</h2>
      <p className="text-muted-foreground text-xs">{t.previewHelp}</p>
    </div>
    {empty ? <p className="text-muted-foreground text-sm">{t.previewEmpty}</p> : <div {...lang} className="grid gap-5">
      {title ? <h3 className="font-semibold font-work-title text-2xl/tight">{title}</h3> : null}
      {description ? <p className="whitespace-pre-wrap text-pretty text-muted-foreground">{description}</p> : null}
      <RecipeContent page={readingOf(state)} units="written" messages={messages} notes={body || null} columns={false} />
    </div>}
  </article>;
}
