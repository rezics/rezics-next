# Private moderation decision read

The route and these stories share `DecisionPageView`. The selected generated `KernelClient` call reads one exact
`GET /v1/moderation-decisions/{id}` response; Web does not hydrate a post or thread, reread the decision to compose a
page, scan a queue, or poll. Content's source contract composes appeal advice, current target context and final native
provenance into that response, but the installed generated type currently exposes only the existing receipt fields.
Because the actor/session/source tuple is missing, the production route stays at its typed unavailable seam. The
presenter keeps target context and appeal unavailable and offers no appeal form until generated publication supplies
the closed variants and provenance. Existing pending, upheld and reversed receipt results remain independently
readable by the installed type.

The fixtures and stories cover only installed generated fields. They are interface examples, not native response
recordings or proof of source disclosure, permission, or successful appeal. Stories for available, concealed and
unavailable native context; permitted, unavailable and unsupported native advice; exact retry/readback; and visit
replacement remain owed with generated publication. Native advice must control appeal presentation; target authorship,
readability and the local clock cannot create authority. The existing appeal command still reauthorizes natively.

The private reader binds the prepared server origin, current browser session and exposure to one exact decision ID and
native source observation. Account, credential/CSRF epoch, locale, exposure, route, source replacement and late
callbacks retire the visit. Recovery is explicit and admits a fresh read of the same ID. Reasons, current context,
destinations, advice, draft, command/readback state and delayed focus must share that lifetime. Private responses use
`no-store`; no bearer or persistent draft enters browser storage.

### Cost

- Touches: one selected composed decision read plus existing session preparation; one explicit appeal command and one
  supported selected decision readback.
- Bound: one exact decision ID and one visit. No target hydration, queue scan, polling, persistent draft or accumulated
  receipts. The supplied statement/context/advice is retained only for that visit.
- Growth: the producer schema has no read-side `maxLength` or byte cap for decision statements, appeal resolution
  statements or context titles. Appeal submissions are capped at 2,000 characters and takedown reason writes at 1,024.
  Consumer checks vary supplied text/context and unrelated fixture history without enumerating it. This does not bound
  nested native work or total response bytes; Content/controller owns physical growth evidence.

The controller owns frozen acceptance, generated publication, native verification, Storybook custody and rendered
phone/desktop, light/dark, keyboard and eight-locale review. None is claimed by these source-only examples.
