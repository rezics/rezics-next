# Native current-reader acceptance

Goal: web  
Manager: web

The [Page states capability](../../docs/goals/web.capabilities.md#page-states) owns the recovery behavior and acceptance.
Keep the existing native reader and producer ownership. Semantic supplies Search/Library participant configuration
for native identity work; receive its completed owner work through normal integration rather than adding another
producer. Preserve HTTP 202 admission, poll the supplied Location under current session authority until
native `done:true/result`, and then follow the supplied canonical return.

Native fixture journeys, served-persona behavior, browser review and promoted acceptance remain open.
The original acceptance command is:

```sh
bun specs/support/verify-outcome-suite.ts specs/web-publication-outcomes.test.ts WEB_PUBLICATION_DRIVER "Web publication driver is required"
```
