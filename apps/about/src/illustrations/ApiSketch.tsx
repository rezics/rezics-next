import { Plate } from './Plate.tsx';

const request = `GET /works/7d1f…/editions?language=zh-Hant
Authorization: Bearer <scoped credential>`;

const response = `{
  "editions": [
    { "id": "2a6c…", "language": "zh-Hant",
      "title": "燈籠書庫", "volumes": 3 }
  ],
  "next": null
}`;

const problem = `422 application/problem+json
{ "type": "…/invalid-language", "status": 422 }`;

/** A sketch of the API's intended shape: request, typed response and an actionable error. Not a released API. */
export function ApiSketch() {
  const block =
    'overflow-hidden whitespace-pre-wrap break-words rounded-xl bg-code px-4 py-3 font-mono text-[13px] leading-relaxed text-code-foreground';
  return (
    <Plate className="flex flex-col gap-3">
      <pre lang="en" translate="no" className={block}>
        {request}
      </pre>
      <pre lang="en" translate="no" className={`${block} border border-border`}>
        {response}
      </pre>
      <pre lang="en" translate="no" className={block}>
        {problem}
      </pre>
    </Plate>
  );
}
