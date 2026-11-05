---
status: open
researcher: claude-opus-5-5
date: 2026-11-04
decision: pending (supermanager; cross-cutting)
---

# Prompt and documentation architecture

Desk research for one decision: how REZICS organizes the instructions its agents receive, how documentation is slimmed
and kept slim, and which deterministic mechanisms replace prose rules. Measured 2026-11-04 18:54–19:20 UTC on worktree
base `ba9999f3fb` and the live state in the main checkout (`.temp/goal`, read-only). The measurement scripts are in
this worktree's `.temp/research/` (`brief_profile.py`, `manager_closure.py`, `research_links.py`, `overlap.py`,
`reconstruct_prompt.ts`); they read files and open the Goal database read-only.

## Summary

The always-on layer is already small and mostly good: `AGENTS.md` is 1,977 bytes, the workflow skill entry 2,767,
the worker wrapper about 5,400–5,900 characters. The instruction mass and the contradictions sit in three other
places:

1. **Goal-local manager state used as instructions.** The 12 local manager briefs total 545 KB. A fresh accounts
   manager is told to "read it completely": 181 KB, then 32 KB of decision files and an 8 KB continuation. That is
   about 56k tokens before the first inbox event. These briefs are append-only decision logs: 21 dated headings in
   commerce, 41.7 glued identifier tokens per 1,000 words in accounts, and 329 uses of words agent conduct forbids.
2. **Code-side prompt text that outranks briefs without saying so.** `launch.ts` renders a minimal-verification
   fragment that forbids browser and native checks and "overrides contract … instructions". The fragment is live
   (`verification-mode` = `minimal`). The reconstructed prompt for a live browser-return brief contains both the
   brief's cached-page restoration cases and the ban.
3. **Evidence and ledgers used as owner documents.** One 469 KB research report is linked by 167 briefs in three
   days. Module READMEs reach 597 KB and grow about four lines per line deleted. Since the 2026-10-25 reset, 313
   research files were added and 16 deleted.

Recommendation:

- Four instruction layers (global, role, Goal, task), each with one file as authority and a character budget as the
  agent receives it.
- Role text moves out of TypeScript string literals into versioned templates. Policy numbers fill those templates and
  the docs tables from one source.
- The control plane resolves conflicts at dispatch, so no rendered prompt contains two contradictory instructions.
- Every attempt records a prompt manifest, so prompt changes can be measured and reverted.
- Documentation gets an owner set, a research lifecycle that removes reports from `main` once adopted, per-file and
  per-directory budgets with a ratchet, and one authority-and-size check that runs at landing in about two seconds.

## 1. Measured inventory

### 1.1 What each role receives

| Role | Source (authority today) | As received | Notes |
| --- | --- | --- | --- |
| All Codex agents | `~/.codex/AGENTS.md` | 0 bytes (empty) | `project_doc_max_bytes` unset, so the 32 KiB default applies |
| All agents | `AGENTS.md` | 1,977 bytes | The only `AGENTS.md`; no `CLAUDE.md`, so Claude Code loads `AGENTS.md` (confirmed in this session's own context) |
| Worker | `launch.ts` `workerPrompt()` wrapper | 5,399 (normal) / 5,918 (minimal) chars | Rendered by the control plane's own function for `backlog/accounts/35-recovery-browser-return.md` |
| Worker | brief | median 5,699, p90 10,272, max 45,436 bytes (807 briefs, last 24 h) | 14% of all 11,442 briefs exceed 12,000; 5% of the last day's |
| Worker | reads the brief mandates | 33,684 bytes in the sample | `Read .temp/goal/accounts/decisions/… and current-owner-decisions.md before editing`: main-checkout local state; 24% of last-day briefs reference `.temp/goal/` |
| Worker total | | 15,629 prompt + 1,977 + 33,684 ≈ 51,300 chars | Agent-conduct limit: 20,000 |
| Manager | `managers.ts` opening | about 1,400 chars fixed + 400 spec text | The spec says the brief file "is authoritative … Read it completely" |
| Manager | local `.temp/goal/managers/<goal>.md` | 5,348 (kernel) … 181,064 (accounts) bytes | 545 KB total; no size limit anywhere |
| Manager | `CONTINUATION.md` | 7,927–7,999 chars, all nine Goals | Every one sits within 73 characters of the 8,000 cap |
| Manager | `.temp`/`tools` files the brief links (depth 1) | web 79 KB; semantic 509 KB; commerce 640 KB; accounts 1.18 MB | Includes `plan.md` (591 KB) and `tools/goal/README.md` (335 KB); an upper bound, since a manager may not open every link |
| Manager | owner and research docs a brief calls authoritative | web: 946 KB | `docs/goals/web.md`, `subject-pages.md`, `research/home-and-list-items.md` and `research/quality-round3-backlog.md`, named "authoritative" in `managers/web.md` |
| Supermanager | `MEMORY.md` index | 25,387 bytes, 129 lines | Over the 25 KB load limit; the last line was cut off at the start of this session |
| Supermanager | memory topic files | 130 files, 431,626 bytes | `maintainer-standing-asks.md` is 155 KB and 281 items; 201 items link no repository file |
| Supermanager | local reminders | 13 notes in `local.json` (4.4 KB) | Delivered as `instruction` inbox events |
| Supermanager | inbox | 45–1,658 `environment` events a day (10-31 to 11-04) | Plus 5–278 `instruction` and 7–14 `question` events a day |
| Researcher | brief and wrapper | about 12–15k | The research wrapper is one paragraph in `launch.ts` |

What an agent actually receives therefore differs from the documents. The reconstructed worker prompt is in
`.temp/research/reconstructed-worker-prompt-{minimal,normal}.txt`.

### 1.2 Documentation

Figures are tracked files, measured with Python stat (an earlier `du | tail -1` undercounts when `xargs` splits).

| Set | Files | Bytes |
| --- | --- | --- |
| `docs/` | 417 | 16,848,501 |
| `docs/research/` | 312 | 13,365,370 |
| All Markdown | 698 | 26,528,827 |
| README files | 94 | 5,007,813 |
| `docs/development/` | 16 | 389,074 (`page-stories.md` 209,613 is a 698-row ledger) |
| `docs/goals/` | 19 | 875,594 (Goal definitions 165,960; capability ledgers 709,634; `web.md` alone 99,893) |
| `tools/goal/README.md` | 1 | 334,778 (its "Control-plane policy" section, 109,696, restates `defaults.json` in prose) |
| Module READMEs over 200 KB | 10 | `kernel/src/access` 596,935; `content` 509,010; `library` 395,490; `importer` 323,369; `apps/web` 307,536; `auth` 304,488 … |
| `tools/goal/reports/` | 7 | 1.9 MB in two daily audits |
| Tracked under `.temp/` | 43 | 178,337 (continuation briefs kept by `.gitignore` exceptions) |

Research reports:

- Only one exceeds 1 MB (`growth-uncertainty-calibration.md`, 1,168,020). 21 exceed 100 KB, together 4.34 MB.
- 21 topics have more than one report (43 files, 2.30 MB). Suffixes: `-current` ×20, `-independent` ×19, `-deep` ×14,
  `-sol` ×6.
- 143 reports (5.85 MB) are linked from no owner document, Goal definition, code, manager brief or brief of the last
  three days.
- `home-and-list-items.md` (469 KB) is linked by 167 briefs and 3 manager briefs, but by only one Goal definition.
  `quality-round3-backlog.md` and `api-first-platform-coverage.md` are linked by 72 briefs each.

Growth since the reset (`git log --numstat`, Markdown):

- From 10-27 to 11-04, 15k–88k lines were added a day. Deletions were 18–36% of additions, apart from one cleanup
  day (11-01, 88%).
- `kernel/src/access/README.md`: 295 commits, +6,690 / −1,618 lines.

### 1.3 Contradictions found

| Topic | Source A | Source B | Effect seen |
| --- | --- | --- | --- |
| Brief size | `agent-conduct.md`: 12,000 characters | `defaults.json` `brief.bytes` 65,536, which `parseBrief` enforces; `tools/goal/README.md` says 64 KiB | 1,561 briefs over 12,000 |
| Worker verification | `agent-conduct.md`: "run the check the brief names" | `launch.ts` minimal fragment: "do not run acceptance, native or browser checks … This policy overrides contract …" | Search manager asked: "minimal launch policy forbids acceptance and overrides briefs. Which controller path executes their r[esults]" |
| Silent brief editing | Briefs are the contract | `workerPrompt` replaces brief paragraphs that match a regex with "[Superseded historical check instructions are omitted…]" | The worker cannot tell what was removed |
| Research models | `agent-conduct.md`: GPT-6 Astra xhigh + Opus 5.5 | `managers/web.md`: "Research uses Sol xhigh"; `commerce.md` briefs Sol xhigh research | Three answers for one rule |
| Screenshots | standing ask 1: "post … screenshots every 3 h" | `telegram-screenshot-duty` memory and `managers/web.md`: stop screenshots | The memory index still says "screenshots every 3 h" |
| Goal outcome | `docs/goals/semantic.md` "Done when" (tracked) | `managers/semantic.md` "Done when" (local, different text) | Under 2% 7-gram overlap: two definitions of done |
| Goal doc shape | `scripts/development-docs.test.ts`: exactly seven `##` sections | `docs/goals/semantic.md` has nine | The test fails on main (run 2026-11-04); doc-only landings run no gate, so nobody saw it |
| Plain words | `agent-conduct.md` bans "receiving", "sole", "custody", "UNRUN", "genuine", "authentic" | `managers/accounts.md` uses them 329 times, `commerce.md` 224 | 458 of 801 last-day briefs contain them (1,220 uses). This is an upper bound: "paid" has legitimate commerce uses. |
| Authority by branch | Owner docs are authoritative | `managers/web.md`: "Read these from dev where main lacks them" | The authority depends on which checkout the agent reads |

### 1.4 Overlap

- Shingle overlap (7-word, `overlap.py`) is low between layers: most restatement is paraphrase, so drift does not
  show up as copies.
- Manager briefs share 20–26% of their text with one another. The same delegation, hourly-delivery and how-to-work
  directives are pasted into seven briefs (`Delegation from 2026-10-30` appears in 7 of 12).
- The boilerplate "Added product output and deletion" paragraph appears in 2 of 807 recent briefs. The efficiency
  rule therefore reaches workers inconsistently. A separate global rule (AGENTS.md) carries it, so the paragraph is
  redundant either way.

## 2. Hypotheses

| | Hypothesis | Confidence | Evidence | What would change it |
| --- | --- | --- | --- | --- |
| H1 | Most instruction text is history and case law, not current rules | **0.9** for manager briefs and memory; 0.3 for `AGENTS.md`, agent conduct and the skill | Manager briefs open with "supersede contradictory historical sections below". Commerce has 21 dated headings. Accounts reads like "Performance29612 complete integrated86e9516a Core receiving/actual Source-fence API read; distinct owner/allowance total0/3/0/2/0/8/651/1 engine0". Standing asks are 281 dated items. | A sample showing managers act on the top section and ignore the rest (transcripts would show which sections they quote) |
| H2 | Rules live in several layers with no single authority | **0.85** | Section 1.3: nine concrete conflicts, including two "Done when" per Goal and three answers for research routing | Finding that the conflicting items are already resolved by an explicit precedence line every agent sees. The only precedence line is in `AGENTS.md` and it ranks "documents in this repository", not local briefs or code-rendered text. |
| H3 | Prose is used where a deterministic check is needed, and then violated | **0.85** | The 12k brief limit and 20k prompt limit are prose only. The banned-word list is prose only. The only docs check fails on main and is not run at landing. The reverse also occurs: code silently outranks prose (the minimal fragment). | Run logs showing the violations caused no lost attempts. The [token-efficiency report](agent-token-efficiency.md) found 52% of tokens in non-landing attempts; the share of those attributable to instruction conflicts is not measured. |
| H4 | Docs grow because nothing deletes or caps them, and research becomes de facto owner docs | **0.9** | 313 research files added and 16 deleted since the reset; 143 orphans; 167 briefs link a research report as the design; README growth at 4:1 | A deletion process that runs but lags. None exists in the tree. |
| H5 (own) | The mass sits in Goal-local state and module READMEs, not in the global or role layer | **0.85** | `AGENTS.md` 2 KB against 545 KB of manager briefs and 5 MB of READMEs | Slimming `AGENTS.md` therefore buys little; the work is in Goal and reference layers |
| H6 (own) | No prompt version is attributable to an outcome, so prompt changes are unevaluated | **0.8** | Attempt records carry `profile` and routing version but no prompt or fragment hash. Prompt strings are spread over `launch.ts`, `managers.ts`, `storybook.ts` and `launch-context.ts`. | Finding a prompt hash elsewhere in the attempt body |
| H7 (own) | A cap without a shape fills to the cap | **0.6** | All nine continuations are at 7,927–7,999 of 8,000 characters | Continuations that are full of live state, not old decisions; I did not read all nine |

H1 nuance: the role layer is not the problem. `agent-conduct.md` is current, short and mostly imperative. The problem
is that managers and the supermanager receive far larger, older texts with higher apparent authority ("authoritative",
"READ FIRST").

## 3. What vendors and research say

The sources below were retrieved on 2026-11-05. Most were retrieved by a delegated retrieval with verbatim quotes,
and I re-fetched the starred ones myself. Quotes are in `.temp/research/vendor-sources.md`.

- **Codex AGENTS.md**\* ([learn.chatgpt.com/docs/agent-configuration/agents-md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)):
  - Files are concatenated root-down, and "files closer to your current directory override earlier guidance because
    they appear later in the combined prompt".
  - Codex "stops adding files once the combined size reaches the limit defined by project_doc_max_bytes (32 KiB by
    default)".
  - Precedence is positional, and one cap covers the whole chain.
- **GPT-6 family guide**\* ([developers.openai.com/api/docs/guides/latest-model](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra)):
  - Astra "can be more sensitive to instructions contained in skills and other files, such as AGENTS.md. We strongly
    recommend auditing skills and other files…"
  - "unclear or conflicting guidance in a skill file may cause the model to pause and block work early. Make the
    priority of user instructions and skills explicit."
  - The same page's earlier-model tab reports leaner system prompts improving internal coding-agent evals by roughly
    10–15% with 41–66% fewer tokens. The delegated retrieval found this; my own fetch did not render that tab, so treat
    it as directional.
- **OpenAI blog, Sep 2026** ([rethinking skills and prompts for GPT-6 Astra](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra)):
  - "frequently revisit each instruction and ask yourself whether it's still needed"
  - "overly specific guidance can now hinder results"
  - Old boundaries "could take it too seriously and may stop work".
- **OpenAI blog, Oct 2026** ([maintaining software with the GPT-6 family](https://developers.openai.com/blog/maintaining-software-with-the-gpt-6-family)):
  replay the same session twice, "with the current AGENTS.md instruction unchanged" and "with only that one
  instruction removed or fixed", then compare quality, tokens and cost.
- **GPT-5 guide** ([cookbook](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide)):
  contradictory instructions are "more damaging … as it expends reasoning tokens searching for a way to reconcile the
  contradictions".
- **Claude Code memory**\* ([code.claude.com/docs/en/memory](https://code.claude.com/docs/en/memory.md)):
  - CLAUDE.md is "context, not enforced configuration. To block an action regardless of what Claude decides, use a
    PreToolUse hook".
  - "target under 200 lines per CLAUDE.md file"
  - "if two instructions contradict each other, Claude may pick one arbitrarily"
  - "Claude reads AGENTS.md only when you have no CLAUDE.md"
  - "The first 200 lines of MEMORY.md, or the first 25KB … are loaded"
- **Claude Code best practices and hooks** ([best-practices](https://code.claude.com/docs/en/best-practices.md),
  [hooks guide](https://code.claude.com/docs/en/hooks-guide.md)):
  - "If something has to happen every time, make it a hook, a deny rule, or a managed setting."
  - Hooks give "deterministic control: certain actions always happen rather than relying on the LLM".
- **Claude Code skills** ([skills](https://code.claude.com/docs/en/skills.md)): a skill body "loads only when it's
  used"; keep `SKILL.md` "under 500 lines".
- **Anthropic prompting** ([best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices.md),
  [context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)):
  - Put long documents first and the query last.
  - Soften "CRITICAL: You MUST" language.
  - Aim for "the smallest possible set of high-signal tokens".
- **Cursor** ([cursor.com/docs/rules](https://cursor.com/docs/rules)):
  - Rules are scoped by globs or description.
  - "Keep rules under 500 lines."
  - Nested AGENTS.md is supported, with more specific instructions taking precedence.
- **Research:**
  - Lost in the Middle ([arXiv 2307.03172](https://arxiv.org/abs/2307.03172)): position matters.
  - IFScale ([2507.11538](https://arxiv.org/abs/2507.11538)): best models reach 68% at 500 simultaneous instructions,
    with a bias towards earlier instructions.
  - Context length alone ([2510.05381](https://arxiv.org/abs/2510.05381)): degradation of 13.9–85% even with perfect
    retrieval.
  - Instruction hierarchy ([2404.13208](https://arxiv.org/abs/2404.13208)): priority must be explicit or trained.
  - Evaluating AGENTS.md ([2602.11988](https://arxiv.org/abs/2602.11988), abstract only): context files "do not
    generally improve task success rates, while increasing inference cost by over 20%". Their instructions are
    followed, but repository overviews do not help.

Principles adopted from these sources:

1. **P1. State each rule once, in the layer whose scope matches it.** Conflicts are worse than omissions for both
   vendors' current models.
2. **P2. Precedence is explicit and enforced.** It is not left to position or to the model.
3. **P3. Always-on text holds only what an agent cannot infer and needs on most tasks.** Everything else loads on
   demand: skills, owner-doc sections.
4. **P4. A rule without legitimate exceptions is a check, hook or tool shape.** Its prose is then deleted.
5. **P5. Budgets are measured as the agent receives the text,** including mandated reads.
6. **P6. Instruction changes are evaluated on real tasks and can be reverted.**
7. **P7. The current rule set is rewritten, not appended to.** History lives in Git.

## 4. Target instruction architecture

### 4.1 Layers

| Layer | Holds | Single authority | Delivered | Budget as received |
| --- | --- | --- | --- | --- |
| **L0 Global** | Precedence, language, one authority, legacy, temporary files, IDs, where each role's text lives | `AGENTS.md` | Auto-loaded by Codex, Claude Code and Cursor | ≤ 3,000 chars (now 1,977) |
| **L1 Role** | How a worker, manager, researcher or supermanager works | `tools/goal/prompts/<role>.md`, with `{{policy.*}}` placeholders | Rendered by the control plane; for the supermanager, by a SessionStart hook | worker ≤ 3,500; manager ≤ 5,000; researcher ≤ 2,500; supermanager ≤ 8,000 |
| **L1c Conditions** | Mode text: minimal verification, proof run, shared workspace, local placement, retry, rebase | `tools/goal/prompts/conditions/<id>.md` | Appended by condition; each id recorded | ≤ 1,500 total per prompt |
| **L2 Goal** | Outcome, Done when, scope, ownership, links to adopted decisions | `docs/goals/<goal>.md` (tracked) | Manager opening includes it verbatim | ≤ 12,000 |
| **L2s Goal state** | Live tasks, open decisions, next actions; no rules | `.temp/goal/<goal>/CONTINUATION.md` with fixed headings | Manager opening | ≤ 8,000, with field limits |
| **L3 Task** | Outcome in user terms, paths, acceptance, decisions made for this task, owner-doc section links | brief | Worker prompt | ≤ 12,000 bytes, enforced |
| **R Reference** | Owner docs, module READMEs, runbooks, skill stages | Tracked files | Read on demand, by section | Per-file budgets (section 5.4) |
| **M Memory** | Local facts: accounts, allowances, hosts, credentials, people, machine quirks, pointers | Claude memory directory | Index auto-loaded | Index ≤ 120 lines and ≤ 12 KB; total ≤ 60 KB |

Totals at session start:

| Role | Total |
| --- | --- |
| Worker | ≤ 20,000: 3,000 + 3,500 + 1,500 + 12,000 |
| Manager | ≤ 30,000: 3,000 + 5,000 + 12,000 + 8,000 + an inbox digest of up to 2,000 |
| Supermanager | ≤ 30,000 of project text: AGENTS + role + memory index + a 4,000 state digest |
| Researcher | ≤ 15,000 |

Budgets constrain what loads at session start, not what an agent may read later. Reading a whole module README stays
possible; it is simply never mandated.

What disappears:

- **The local manager brief file as an instruction layer.** Its durable decisions go to owner docs, its Done when to
  the tracked Goal definition and its live state to the continuation. Cross-Goal directives go to the manager role
  template once, instead of being pasted into seven briefs.
- **Instructions in memory.** Memory points to the repository and holds only local facts.
- **Instructions in timed reminders** (`local.json` notes), other than true reminders such as "check X at 15:00".
- **Brief paragraphs that repeat global rules** (efficiency target, plain words). L0 and L1 carry them.

### 4.2 Precedence and conflict resolution

`AGENTS.md` states the only precedence, once:

> The maintainer's current instruction, then this file, then your role prompt, then your Goal definition, then your
> task brief, for anything inside that brief's scope. Role and condition text never overrides a requirement a brief
> states; when they would conflict, the control plane resolves it before launch and the prompt says what was decided.

Deterministic part:

- The brief declares acceptance needs, for example `acceptance.requires: [browser]`; interface kinds and stories
  paths imply browser.
- A condition declares what it defers, for example `minimal: defers [acceptance, native, browser, root]`.
- At dispatch, a non-empty intersection is recorded on the task as `deferredAcceptance` with an owner (the dev
  verifier). The condition fragment then names those exact items. Alternatively, dispatch holds the brief, if the
  condition says deferral is not allowed for that class.
- The rendered prompt never contains both "run X" and "do not run X".
- The regex rewrite of "superseded historical check instructions" becomes a dispatch-time refusal with a fix hint.
  Briefs are not edited silently.

Whether minimal verification should still exist is the supermanager's decision. The architecture only guarantees that
whatever the mode is, it is stated once, applied by code, and visible on the task.

### 4.3 What is generated from what

| Source | Generated | Check |
| --- | --- | --- |
| `tools/goal/defaults.json` (+ a short description per leaf) | `{{policy.*}}` values in role templates; the Limits table in `agent-conduct.md`; the policy reference in `tools/goal/README.md` (replacing the 110 KB prose section) | Generated blocks between `<!-- generated:<id> -->` markers must equal their render |
| `tools/goal/prompts/*.md` + task + conditions | Worker, manager and researcher prompts; prompt manifest | Golden renders for about six representative tasks, reviewed as diffs; budget assertions |
| `docs/goals/<goal>.md` + continuation | Manager opening | Opening ≤ 30,000 |
| Storybook index + route inventory | Coverage cells of `page-stories.md` (209 KB today) | Later migration, step 8 |
| Capability ledgers | Structured data plus a short generated summary | Later migration; `capabilities.ts` exists, but I did not check whether it parses these files |

### 4.4 From prose to a deterministic mechanism

A rule moves down this ladder when it has no legitimate exception, when a violation has been observed twice, or when
one violation is costly or irreversible:

1. **Guideline:** prose in a role template, for judgment calls.
2. **Lint:** dispatch or landing refuses or warns, with the rule and the fix in the message.
3. **Tool shape:** the wrong action is not offered (the check wrapper returning ids instead of a wait is the existing
   example).
4. **Hook:** a Claude Code PreToolUse, Stop or SessionStart hook. The Stop hook that requires a watcher already
   exists.
5. **Controller decision in code:** for example continuation renewal and the ready floor.

After promotion, delete the prose or cut it to one line that names the check.

| Rule now in prose | Lives in | Observed violation | Mechanism |
| --- | --- | --- | --- |
| Brief ≤ 12,000 characters | agent conduct | 1,561 briefs over | `policy.brief.bytes` = 12,288 at `parseBrief` |
| Worker prompt ≤ 20,000 | agent conduct | ≈ 51k in the sample, counting mandated reads | Render refuses > 20,000; brief lint refuses `.temp/goal/` and absolute main-checkout paths |
| Plain words | agent conduct | 329 / 224 / 33 uses in manager briefs | Lint on briefs, manager messages and continuations: warn, then refuse |
| Continuation replaced, ≤ 8,000 | `managers.ts` prose | All at the cap | Fixed headings (Live tasks, Open decisions, Next actions, Links) with per-field limits; the controller rejects other headings |
| Research pair and effort | agent conduct, memory, briefs | Three answers | The existing dual-research route in `routing.json` and CLI; delete the prose from briefs and memory |
| No blocking question | `supermanager.md`, memory | A 5.5 h stall | PreToolUse hook denies `AskUserQuestion` in the resident session |
| Edit `tools/goal` only in a worktree | memory | Four workers killed | PreToolUse hook denies Edit/Write under the live main checkout's `tools/goal/` |
| Watcher before ending a turn | memory, Stop hook | Seven idles; the hook was silently disabled once when its registry was purged | SessionStart hook registers the session and fails loudly if the registry is missing |
| Memory index small | memory rule | 25.4 KB, truncated | PostToolUse hook on writes under the memory directory measures lines and bytes and blocks over 120 lines or 12 KB |
| Goal doc shape and links | `development-docs.test.ts` | Fails on main | Part of the landing docs check (section 5.5) |
| Superseded material dropped | `AGENTS.md` | 313 added, 16 deleted | Research lifecycle state plus the ratchet (section 5) |
| Configuration picked up by long-lived processes | none | An hour lost | Each service records the hash of the policy and settings it loaded; `goal status` compares it with disk and raises an alarm. Templates are read at each launch, not at process start. I did not confirm how `config.ts` reloads, so treat the class as probable. |

### 4.5 Versioning and evaluation

- **Prompt manifest per attempt** (in the attempt body):
  - SHA of `AGENTS.md`, the role template, each condition fragment and the brief;
  - the policy hash;
  - rendered characters per layer.
- **One commit per prompt change** (`prompt(worker): …`), touching `tools/goal/prompts/` and its golden renders. Its
  message names the expected effect and the metric.
- **Measure** in a comparison window of 24 h or at least 40 attempts per task class, split by manifest. Metrics:
  - first-attempt landing rate;
  - attempts per landed task;
  - superseded share;
  - allowance tokens per landed product line;
  - `question` and `blocker` events per manager-hour;
  - `spec-conflict` blockers;
  - landing check refusals.

  For a risky change, reuse the routing experiment mechanism, which already rotates by durable task sequence, to run
  two prompt variants side by side.
- **Disputed removals:** use OpenAI's replay method on two or three past sessions where the instruction mattered.
- **Rollback:** `git revert` the prompt commit. Templates are read per launch, so the next launch uses the previous
  text without a restart, and the manifest shows which running sessions still have the old one.

## 5. Documentation policy

### 5.1 Owner documents

Authoritative, tracked and budgeted:

- `AGENTS.md`;
- `docs/architecture.md` and `docs/scope.md`;
- product owner docs `docs/<capability>.md`;
- Goal definitions `docs/goals/<goal>.md`;
- workflow rules `docs/development/*.md`;
- role prompts `tools/goal/prompts/`;
- the control-plane runbook `tools/goal/README.md`;
- module contract READMEs;
- the workflow skill (procedures that link rules).

Not owners:

- `docs/research/` (evidence);
- `tools/goal/reports/` (measurements);
- `.temp/` (state);
- memory.

A brief may link only owner documents as authority. It may link an `open` research report only as background.

### 5.2 Research lifecycle

1. **Open.** The report is written as `docs/research/<topic>-<researcher>.md` with front matter: `status: open`,
   `researcher`, `date`, `decision: pending`. A re-run overwrites the same file name; Git keeps the previous version.
   Names carry no `-current`, `-deep` or `-independent`.
2. **Decided.** The owner records the decision in the owner document: the decision, constraints, rationale in a few
   lines, and links to the reports at a commit. The same change moves the reports off `main`, to an orphan
   `archive/research` branch in the same way finished Goal history goes to `archive/goals`. A rejected or superseded
   report is deleted in the change that rejects or supersedes it.
3. **Exception.** A report that briefs use as a living specification is converted, not kept: the decision extraction
   is that conversion. The `home-and-list-items` case is the first.
4. **Limits.** At most one report per researcher per topic on `main`; ≤ 100 KB each; an open report older than 14 days
   is flagged to its owner by the docs check.

The current pairs and triples are handled by the topic's owner, who picks the decision source. The rest are archived
in the same change.

### 5.3 Per-task notes and state

- Continuation briefs, manager working files, decision drafts and daily audits are state. They stay under `.temp/`
  (untracked) or go to the archive branch.
- Remove the `.gitignore` exceptions that track 43 continuation briefs.
- Move `tools/goal/reports/daily-step-audit-*.md` (1.9 MB) out of the tree and keep the template.
- Workers must not be told to read main-checkout `.temp/goal/` files. A decision a worker needs is in an owner doc,
  or quoted in the brief within its budget.

### 5.4 Budgets

Budgets are bytes. Over-cap files already present are recorded in a baseline and may not grow; shrinking lowers the
baseline automatically.

| Path | Cap per file | Cap per directory | Now |
| --- | --- | --- | --- |
| `AGENTS.md` | 3,000 | — | 1,977 |
| `docs/development/*.md` | 16,000 | 120,000 | 389,074 (`page-stories.md` 209,613; `web-check-entrypoints.md` 44,736; `verification.md` 38,845) |
| `docs/goals/<goal>.md` | 12,000 | — | `web.md` 99,893; `library.md` 15,254; `commerce.md` 14,780 |
| `docs/goals/*.capabilities.*` | 40,000 (data) | 300,000 | 709,634 |
| `docs/*.md` (product owners) | 40,000 | 1,200,000 | 2,218,463 (`subject-pages.md` 229,588) |
| Module `README.md` | 80,000 | — | 10 files over 200 KB |
| `tools/goal/README.md` | 80,000, with the generated policy reference | — | 334,778 |
| `tools/goal/prompts/**` | Role budgets in section 4.1 | 30,000 | — |
| `docs/research/*.md` | 100,000 | 2,000,000 | 13,365,370 |
| `.agents/skills/**` | `SKILL.md` 5,000; references 6,000 | 30,000 | 19,904 |
| `.temp/**` tracked | 0 | 0 | 178,337 |

The numbers are judgment, calibrated to the vendor limits (32 KiB Codex chain, 200 lines per CLAUDE.md, 25 KB of
memory, 500 lines per skill or rule). Those vendor limits are about always-on text, and these budgets apply to
documents read on demand. The README cap is the least certain number. Settle it by measuring how often workers read
whole READMEs, which shows up in run-log tool calls.

### 5.5 The authority-and-size check

`bun scripts/docs-check.ts [--changed <base>]`, run at dev landing for any change that touches `**/*.md`,
`tools/goal/prompts/**` or `tools/goal/defaults.json`, and in the root gate. It reads file sizes by stat and parses
only the changed Markdown, so it stays under two seconds; the existing 56-line docs test takes 1.66 s with Bun
start-up. Rules, all errors unless marked:

1. File and directory caps from `docs/budgets.json`, with the ratchet baseline. A baseline may only decrease; raising
   it requires a `Budget-Raise:` commit trailer stating why.
2. Research front matter is valid. An `adopted` report must not be on `main`. An `open` report older than 14 days is
   a warning.
3. Owner documents contain no dated headings (`^#+ .*20\d\d-\d\d-\d\d`), no "historical"/"superseded" headings, at most
   one H1, no task IDs, no `.temp/` paths and none of the agent-conduct plain-word list.
4. Owner documents' relative links resolve. An owner document linking a research report must link an open one or a
   commit permalink.
5. Generated blocks equal their render.
6. Goal definitions have the seven required sections in order. Extra sections are allowed only from a ratcheted list,
   and shrinking that list is encouraged.
7. Nothing under `.temp/` is tracked.

Brief lint at dispatch uses the same module:

- size ≤ 12,288 bytes;
- no `.temp/goal/` or absolute main-checkout reads;
- no research links as authority;
- plain-word list;
- a warning when sentences starting with "Do not" or "Never" outnumber the other imperatives (agent conduct already
  says prohibitions must not outweigh instructions).

## 6. The supermanager's memory

The memory is 130 files and 432 KB. I classified the files by name and description; I did not read each one.

**Stay local (about 35 files).** Accounts and allowances:

- `codex-accounts`, `codex-weekly-window`, `codex-28-day-resets`, `quota-exhaustion-pause`, `no-fast-tier`,
  `fable-shares-5h`.

Hosts and the machine:

- `host-swap-zram`, `check-host-disk`, `check-host-sshd-limits`, `host-proxy-process-lookup`, `host-clean-env`,
  `inotify-instance-limit`, `btrfs-maintenance-blocks-docker`.

Local tool quirks:

- `pgrep-self-match`, `git-c-not-cd`, `codex-exec-stdin`, `grok-session-size-limit`, `browser-is-browseros`,
  `termspaces`, `shared-mcp-list`.

People and budget:

- `maintainer-budget-and-scope`, the user profile.

Pointers to sibling repositories:

- `about-redesign-state`, `launcher-repo`, `telegram-reference-source`.

**Already in the repository; reduce to a pointer or delete.** I verified six of six:

| Memory | Repository home |
| --- | --- |
| `no-blocking-questions` | `supermanager.md` "Questions for the maintainer" |
| `hourly-target-duty` | `supermanager.md` "Hourly target" |
| `dual-research-complex-design` | `agent-conduct.md` "Research" |
| `decisions-live-in-docs` | `docs/development/README.md` |
| `docs-english-one-authority` | `AGENTS.md` "Language" |
| `no-task-ids-in-tree` | `AGENTS.md` "Working rules" |

**Move to the repository (about 60 files).**

Product direction goes to `docs/architecture.md`, `docs/scope.md` or the owning product doc:

- `person-is-a-brand`, `one-engine-simple-backend`, `semantic-web-is-the-abstraction`, `vertical-engine-thesis`,
  `competitor-coverage-test`, `wiki-toolkit-thin-neutral`, `gradual-opening-launch-scope`, `status-labels`,
  `import-responsibility-split`, `content-adoption-boundary`, `brand-color-contrast`, `report-in-overflow-menu`,
  `writes-through-api`, `existing-solutions-first`, `dependency-channels`.

Verification and performance rules go to `verification.md`:

- `asymptotic-scale-criterion`, `perf-by-algorithm`, `performance-derive-then-verify`,
  `seeded-growth-performance-check`, `api-first-method`, `product-must-boot`.

Workflow rules go to the role templates or `docs/development/*`:

- `third-attempt-investigate`, `infra-failure-not-flake`, `reshape-only-idle-tasks`, `reshape-names-own-tests`,
  `brief-records-decisions`, `briefs-fence-other-goals`, `supermanager-delegates`, `supermanager-inbox-scope`,
  `copy-supermanager-on-declines`, `crossed-messages-before-reversing` and similar.

These rules apply to managers too, and managers cannot read this memory. That is why "managers asking questions
their documents answer" also happens with rules that exist only here.

**Delete as stale (about 15 files).** Examples:

- `commit-explicit-paths` (legacy era);
- `codex-one-account-only` (superseded by `codex-accounts`);
- `goal-paused-for-docs` (state);
- `rewrite-reset-20261025` (history);
- `audit-round-3` and `coordinator-rollout-incomplete` (finished work);
- the screenshot item in the standing asks (superseded).

**Standing asks (155 KB).**

- Each live ask becomes a GitHub issue labelled `ask`, with what done means. The repository already uses `question`
  issues the same way.
- Each ask's durable rule goes to its owner document without attribution.
- The memory keeps one line: "open asks: `gh issue list -l ask`".
- Met asks are closed, not kept.

**Size enforcement:** the PostToolUse hook in section 4.4 (index ≤ 120 lines and 12 KB, lines ≤ 150 characters), and
a weekly count of memory bytes. Target: ≤ 60 KB in total.

## 7. Migrations in order

| # | Step | Owner | Cut, merge, move or delete | Before → after |
| --- | --- | --- | --- | --- |
| 0 | Freeze and declutter the supermanager's own context | supermanager, 1–2 h | Standing asks → `ask` issues + owner docs; delete stale memories; resolve the screenshot, research-model and Done-when conflicts by one decision each in their owner docs | Memory 432 KB → ≤ 120 KB now, ≤ 60 KB after step 6; index 25.4 KB → ≤ 12 KB |
| 1 | **Journey 1:** authority-and-size check with ratchet | control-plane manager | New check + `docs/budgets.json`; fix the failing docs test | Growth of over-budget files: unbounded → 0 |
| 2 | **Journey 2:** role prompts as single-source templates, enforced budgets, prompt manifest, conflict resolution at dispatch | control-plane manager | Move prompt literals out of `launch.ts` (873 lines) and `managers.ts`; delete the regex brief rewrite; raise no limits | Worker wrapper 5,918 → ≤ 3,500 + ≤ 1,500 conditions; enforced worker total ≤ 20,000 |
| 3 | **Journey 3:** replace the accounts manager brief (pilot) | accounts manager, with a worker for the doc edits | `managers/accounts.md` 181 KB → tracked `docs/goals/accounts.md` ≤ 12 KB + `docs/accounts.md` decisions + continuation ≤ 8 KB; archive the rest | Manager opening ≈ 226 KB mandated → ≤ 30 KB |
| 4 | The same for commerce, semantic, imports, content, performance, catalogue, interop | each manager | 364 KB of local briefs → Goal definitions and owner docs | 545 KB → about 50 KB of tracked Goal text in total |
| 5 | Research lifecycle backfill | docs worker per owner | Front matter on 312 reports; archive the 143 orphans; convert `home-and-list-items`, `quality-round3-backlog` and `api-first-platform-coverage` into owner decisions; resolve the 21 duplicate topics | `docs/research` 13.37 MB → ≤ 2 MB |
| 6 | Role text consolidation | supermanager | `agent-conduct.md` → cross-role principles + links to templates; supermanager role template via SessionStart hook, with a live state digest | `agent-conduct.md` 9,111 → ≤ 5,000; supermanager start text bounded |
| 7 | Control-plane README | control-plane manager | Generated policy reference replaces the 110 KB prose section; move release and proof case law out | 334,778 → ≤ 80,000 |
| 8 | Ledgers to data | web and Goal owners | `page-stories.md` and capability ledgers to data + generated summaries | 919 KB → ≤ 340 KB |
| 9 | Module README ratchet-down | each module owner, as part of normal work | Rewrite current contracts and cost bounds; remove the record of past attempts | 10 files over 200 KB → ≤ 80 KB each, over weeks |

Steps 1 and 2 are independent and can run in parallel. Step 3 should follow step 1, so its result is held by the
check.

### Journey 1 brief

```markdown
---
goal: control-plane
manager: control-plane
kind: implementation
paths:
  - scripts/docs-check.ts
  - scripts/docs-check.test.ts
  - scripts/development-docs.test.ts
  - docs/budgets.json
  - scripts/gate.ts
  - Taskfile.yml
  - docs/development/maintenance.md
riskAreas: []
criticalPath: false
waiting: []
estimate: { lines: 800, files: 7 }
---

# Documentation stays inside its budgets and keeps one authority at every landing

## Outcome

An agent that adds or edits Markdown learns within two seconds, from one command, that its change would grow a file
or directory past its budget, make a research report act as an owner document, put case law or local state into an
owner document, or break a link. The message names the rule, the file and the fix. Files that are already over budget
cannot grow and may shrink; shrinking lowers their recorded baseline.

## Decisions already made

- Command: `bun scripts/docs-check.ts [--changed <base-ref>]`. Without `--changed` it checks every tracked Markdown
  file; with it, it parses only changed files and uses `git ls-files` plus stat for sizes.
- Budgets live in `docs/budgets.json`: caps by glob for files and directories, a `baseline` map from path to current
  byte size for every file already over its cap, and `goalExtraSections` (see rule 6). Initial caps:
  `AGENTS.md` 3,000;
  `docs/development/*.md` 16,000 per file, 120,000 per directory;
  `docs/goals/<goal>.md` 12,000;
  `docs/goals/*.capabilities.*` 40,000 per file, 300,000 per directory;
  `docs/*.md` 40,000 per file, 1,200,000 per directory;
  `**/README.md` 80,000;
  `docs/research/*.md` 100,000 per file, 2,000,000 per directory;
  `.agents/skills/**/SKILL.md` 5,000;
  tracked `.temp/**` 0.
  Generate the baseline from current main in this task.
- A baseline entry may only decrease. When a file shrinks, the check prints the new value, and `--write-baseline`
  updates it. An increase fails unless the commit message being landed has a `Budget-Raise:` trailer. The check reads
  it from `git log -1 --format=%B` when run at landing; skip the trailer test when there is no commit.
- Rules, errors unless marked:
  1. Caps and baseline as above.
  2. Every `docs/research/*.md` has front matter with `status` (open, adopted, rejected, superseded), `researcher`,
     `date` and `decision`. Status other than `open` fails, because such reports leave main. An open report older
     than 14 days is a warning. During the backfill, files without front matter are listed in the baseline as
     `legacyResearch` and only warn; the list may only shrink.
  3. Owner documents (everything tracked except `docs/research/**`, `tools/goal/reports/**`, `.temp/**` and fixture
     directories) contain:
     - no heading with a date (`^#+ .*20\d\d-\d\d-\d\d`);
     - no heading containing "historical", "superseded" or "previous";
     - at most one H1;
     - no task identifiers of the form `G-<digits>`;
     - no `.temp/` path;
     - none of the plain-word list in `docs/development/agent-conduct.md` "Write little" (read it from that file, so
       there is one list).

     Existing occurrences are recorded per file in the baseline as counts that may only decrease.
  4. Relative links in owner documents resolve. An owner document may link `docs/research/<x>.md` only if `<x>` has
     `status: open`; otherwise it must use a commit permalink.
  5. Blocks between `<!-- generated:<id> -->` and `<!-- /generated:<id> -->` must equal the output of their registered
     renderer. Register none yet; provide the mechanism and one test.
  6. `docs/goals/<goal>.md` has the seven sections in the order the existing test lists. Extra `##` sections are
     allowed only when listed for that file in `goalExtraSections`; initialize the list from main.
  7. No tracked file under `.temp/`, except the baseline-listed ones; the list may only shrink.
- Replace the heading assertion in `scripts/development-docs.test.ts` with the rule 6 implementation, so that test
  passes on main. Keep its reachability assertions.
- Wire `bun scripts/docs-check.ts --changed <base>` into `scripts/gate.ts` and add a `docs:check` task to
  `Taskfile.yml`. Registering it as a dev landing check for Markdown-only changes is a control-plane change under
  `tools/goal/`. If this brief cannot include it, write that registration as a continuation brief for the
  control-plane manager.
- Document the command and the baseline procedure in `docs/development/maintenance.md`, in at most ten lines.

## Done means

- On current main, `bun scripts/docs-check.ts` exits 0 after the baseline is generated, and
  `bun test scripts/development-docs.test.ts scripts/docs-check.test.ts` passes.
- Fixture tests show each rule failing with a message naming rule, file and fix:
  - a grown over-budget file;
  - an adopted research report on main;
  - a dated heading in an owner document;
  - a `.temp/` path;
  - a broken link;
  - a generated block that differs from its render;
  - an unlisted extra Goal section;
  - a raised baseline without the trailer.
- A whole-tree run takes under three seconds on this repository, measured by `time`. `--changed` with one file takes
  under one second.
- No existing document is rewritten by this task; only the baseline records current state.
```

### Journey 2 brief

```markdown
---
goal: control-plane
manager: control-plane
kind: implementation
paths:
  - tools/goal/prompts/**
  - tools/goal/src/prompts.ts
  - tools/goal/src/prompts.test.ts
  - tools/goal/src/launch.ts
  - tools/goal/src/managers.ts
  - tools/goal/src/storybook.ts
  - tools/goal/src/briefs.ts
  - tools/goal/src/dispatch-preparation.ts
  - tools/goal/src/types.ts
  - tools/goal/defaults.json
  - tools/goal/README.md
riskAreas: []
criticalPath: false
waiting: []
estimate: { lines: 1500, files: 14 }
---

# Every agent receives one consistent, measured prompt, and every attempt records which prompt it was

## Outcome

Workers, managers and researchers receive prompts rendered from versioned templates instead of string literals spread
across the control plane. No rendered prompt contains two instructions that contradict each other. Each prompt stays
inside its character budget, or the launch is refused with the reason. Each attempt records which template, condition
fragments, brief and policy produced its prompt, so a later report can compare outcomes by prompt version. Changing a
template takes effect at the next launch without restarting the services.

## Decisions already made

- Templates live in `tools/goal/prompts/`: `worker.md`, `manager.md`, `research.md` and `conditions/<id>.md`.
  Condition ids: `minimal-verification`, `proof-run`, `registered-proof`, `local-placement`, `no-wrapper`, `wrapper`,
  `shared-workspace`, `retry`, `rebase`, `storybook`, `bulk-text`, `continuation`. They hold the text now in
  `workerPrompt`, `workerCheckProtocol`, `storybookPrompt` and the manager `opening`, rewritten once:
  - shorter;
  - no repeated sentences;
  - no capitals for emphasis;
  - no private shorthand.

  Placeholders are `{{policy.<dotted.path>}}` and `{{task.<field>}}`, filled from the loaded policy and task. An
  unknown placeholder is an error.
- `tools/goal/src/prompts.ts` renders them. Read templates from disk at each render, so a changed template applies at
  the next launch; cache by file modification time if needed.
- Budgets in `defaults.json` under `policy.prompt`:
  - `workerRoleCharacters` 3,500;
  - `conditionCharacters` 1,500 (all conditions in one prompt);
  - `workerTotalCharacters` 20,000;
  - `managerRoleCharacters` 5,000;
  - `managerOpeningCharacters` 30,000;
  - `researchRoleCharacters` 2,500.

  Set `policy.brief.bytes` to 12,288. A render over a budget refuses the launch with the measured sizes per layer.
  Unit tests render every template for representative tasks and assert the budgets, so an over-budget template fails
  before release.
- Conflict resolution happens at dispatch, not in the prompt:
  - Briefs may declare `acceptance.requires` as a list of `browser`, `native` and `root`; `interface` briefs and
    briefs whose paths include stories imply `browser`.
  - A condition fragment declares in its front matter which of these it defers.
  - When a launch would combine a brief requirement with a condition deferring it, record
    `deferredAcceptance: [<items>]` on the task with owner `dev-verifier`, and render one sentence naming exactly those
    items as deferred to the verifier.
  - Delete the sentence "This policy overrides contract, saved-session and retry-manifest instructions…" and every
    sentence of that form.
- Delete the regex that replaces brief paragraphs mentioning saved or historical check instructions. Instead, dispatch
  refuses a brief containing such a paragraph, with the hint "remove superseded check instructions from the brief".
  Dispatch also refuses a brief that references `.temp/goal/` or an absolute path in the main checkout, with the hint
  "link an owner document section or quote the decision in the brief".
- Prompt manifest: add `prompt` to the attempt record. It holds:
  - git blob SHAs of `AGENTS.md`, the role template, each condition fragment and the brief;
  - a hash of the policy object;
  - rendered characters per layer.

  `attempts --json` exports it. Do not change routing.
- The manager opening becomes: role template + `docs/goals/<goal>.md`, verbatim + `CONTINUATION.md`. Keep the existing
  spec `brief` field working as an extra paragraph while Goals migrate. Measure the opening against
  `managerOpeningCharacters` and log a warning, not a refusal, until every Goal has migrated; record the measured size
  in the manager state.
- Keep golden renders for six tasks under `tools/goal/prompts/golden/`:
  - a dev implementation;
  - an interface with stories;
  - research;
  - a verification proof;
  - a shared-workspace task;
  - a retry with a manifest.

  Tests compare renders with them, so every prompt change shows up as a reviewed diff of the text agents receive.
- In `tools/goal/README.md`, replace the prose describing these prompts with a short section naming the templates,
  the budgets and the manifest. Do not expand the README.

## Done means

- `bun run --cwd tools/goal check` passes, including new tests showing:
  - each template renders within budget;
  - an over-budget render refuses the launch with per-layer sizes;
  - a minimal-verification launch of a browser-requiring brief records `deferredAcceptance: [browser]` and its prompt
    contains no instruction to run browser checks and no "overrides" sentence;
  - a brief with `.temp/goal/` references is refused at dispatch;
  - the manifest is present in a new attempt record;
  - editing a template file changes the next render without reloading the module.
- The golden render for a dev implementation brief like `backlog/accounts/35-recovery-browser-return.md` shrinks from
  5,918 characters of wrapper to at most 5,000 including conditions.
- No behaviour of checks, routing, landing or retries changes beyond what is listed here; existing tests asserting the
  old prompt sentences are this task's to update.
```

### Journey 3 brief

The supermanager or the accounts manager first copies the inputs into the worker's worktree at
`.temp/ref/accounts/`:

- `managers/accounts.md`;
- `accounts/current-owner-decisions.md`;
- `accounts/autonomy-cleanup/identity-history-product-recovery.md`;
- `accounts/CONTINUATION.md`;
- `supermanager/road/decisions.md`.

This follows the existing practice of staging references for workers.

```markdown
---
goal: accounts
manager: accounts
kind: specification
paths:
  - docs/goals/accounts.md
  - docs/accounts.md
  - services/auth/README.md
riskAreas: []
criticalPath: false
waiting: []
estimate: { lines: 600, files: 3 }
---

# The accounts manager starts from one short, current Goal definition instead of a 181 KB log

## Outcome

A new accounts manager session can act after reading under 30,000 characters: its role prompt, the tracked Goal
definition `docs/goals/accounts.md`, and a continuation holding only live state. Every accounts decision still in
force is written once, in plain words, in the owner document it governs. Superseded decisions, dispositions of past
attempts, counts and commit pins are not carried over; Git and the archive keep them.

## Inputs

The staged copies under `.temp/ref/accounts/` are the only inputs; do not read other `.temp` paths:

- the local manager brief (181,064 bytes);
- current owner decisions (32,299);
- the combined outcome note;
- the continuation;
- the shared road decisions.

The first section of the manager brief says which decisions are adopted: road decisions A1/A2/S4/X1–X6 and the dev
architecture supersede contradictory older sections. Where two statements conflict, the later adopted one wins. When
you cannot tell, keep the statement that matches current code on your base and name the choice in your summary.

## Decisions already made

- `docs/goals/accounts.md` keeps its seven required sections and stays within 12,000 bytes:
  - "Done when" states the user-visible outcomes and the completion rule once. Reconcile the tracked text and the
    local brief's Done when into one list; where they differ, the tracked document's completion rule wins.
  - "Ownership" and "Dependencies" name owners and interfaces, not tasks.
  - Remove any extra sections not in the allowed list.
- Durable product and contract decisions go to `docs/accounts.md` under the heading of the behaviour they govern. Use
  `services/auth/README.md` instead when the decision is an Auth service contract. Each decision is a few lines: the
  rule, its constraint and, if needed, one line of rationale.
- Do not record who decided, dates, task or attempt numbers, commit hashes, allowance figures, "receiving",
  "disposition", "sole", "custody", "UNRUN" or similar shorthand. Use plain words.
- Live state stays out of tracked files:
  - task identifiers;
  - what is running or held;
  - next actions.

  List it in your summary under "Continuation content", at most 2,000 characters, so the manager can write its
  continuation.
- Do not add sections about history or superseded material. Do not create new documents.

## Done means

- `docs/goals/accounts.md` is at most 12,000 bytes; `docs/accounts.md` and `services/auth/README.md` grow by no more
  than the decisions they receive.
- `bun scripts/docs-check.ts --changed origin/dev` passes, if present on your base; otherwise
  `bun test scripts/development-docs.test.ts` passes for accounts.
- Your summary lists:
  - each adopted decision you moved, as one line with its destination heading;
  - each decision you judged superseded, as one line each, with the statement that superseded it;
  - the continuation content.
- After landing, the supermanager points the accounts manager spec at the tracked Goal definition (spec text: "Your
  Goal is docs/goals/accounts.md; your live state is .temp/goal/accounts/CONTINUATION.md") and moves
  `managers/accounts.md` to the archive. That step is not part of this task.
```

Evaluate Journey 3 before rolling it out to the other Goals:

1. Take ten questions the accounts manager sent to the supermanager since 10-31 (`manager_inbox`, kind `question` or
   `blocker`).
2. In a fresh session with only the new opening, check whether each is answered. At least eight of ten should be
   answered, or the manager should decide them itself.
3. Compare the manager's first-hour decisions and brief readiness with its previous renewal.

## 8. Weekly metrics

Baselines were measured on 2026-11-04. Each metric is computed from the Goal database, `git`, file sizes and the
prompt manifest once Journey 2 lands.

| Metric | Baseline | Target after four weeks |
| --- | --- | --- |
| Worker prompt as received, p90, including mandated reads | ≈ 51k chars in the sample; unmeasured p90 | ≤ 20,000, enforced |
| Briefs over 12,000 bytes | 5% (last day) | 0, refused |
| Briefs referencing `.temp/goal/` | 24% | 0 |
| Manager opening, mandated characters | ≈ 226 KB (accounts: brief + named decision files + continuation); web names 946 KB as authoritative | ≤ 30,000 |
| Manager `question` + `blocker` events to the supermanager | 7–14 questions and 1–35 blockers a day across all managers (10-31 to 11-04) | Down 50%, and at most 1 in 10 already answered by an owner doc (sampled weekly) |
| Attempts superseded | 37–42% a day | Watch; attribute to the prompt manifest. I did not verify what `superseded` covers, so set a target only after classifying a sample. |
| First-attempt landing rate per task class | Not measured yet | Baseline in week 1, then +10 points |
| Tokens per landed product line | Report via `report --json` | Not worse while prompts shrink |
| Contradictions found by audit (a script, as in section 1.3) | 9 | 0 open for more than a week |
| `docs/research` bytes / reports without a decision older than 14 days | 13.37 MB / not computed | ≤ 2 MB / 0 |
| Markdown lines added minus deleted per week | 15k–88k added a day, 18–36% deleted | Owner docs: net ≤ 0 outside new capabilities |
| Files over budget (baseline entries) | Generated by Journey 1 | Monotonic decrease |
| Memory index / memory total | 25.4 KB / 432 KB | ≤ 12 KB / ≤ 60 KB |
| Docs check runtime at landing | — | ≤ 2 s p95 |

Guardrails:

- If first-attempt landing or tokens per landed line worsen for two consecutive days after a prompt change, revert
  that prompt commit.
- If the question rate rises after a manager migration, run the ten-question replay before migrating the next Goal.

## 9. Uncertainty and what would change the recommendation

- **I measured what agents are told to read, not what they read.** Run logs and Codex rollouts would show whether
  managers really read 181 KB, and whether workers open the `.temp/goal` files they are pointed at. If managers mostly
  skim the top section, the token cost is lower than estimated, but the authority conflict remains.
- **The cost split is not measured.** The [token-efficiency report](agent-token-efficiency.md) found 52% of tokens in
  non-landing attempts, with prompt text a small share of raw tokens. This architecture's value is then mainly fewer
  lost attempts and questions from conflicts, not fewer prompt tokens. Classifying the lost attempts since 10-31 by
  cause would show what share follows from instruction conflicts. If that share is small, steps 4–9 drop in priority,
  and Journeys 1–3 remain worth doing for authority alone.
- **Two budget numbers are judgment:** the 80 KB README cap and the 12 KB Goal-definition cap. The Goal cap is
  calibrated to `docs/goals/accounts.md` (3.8 KB today) and `search.md` (12 KB). `web.md` at 100 KB needs a split
  between the Goal definition and its owner docs. That split is part of step 4.
- **Whether `superseded` attempts are waste or normal retries** is not established.
- **I did not confirm how long-lived services reload settings.** The configuration-pickup row in section 4.4 is a
  probable class, not a verified defect.
- **The leaner-prompt percentages** come from an OpenAI internal sample on earlier models, retrieved through
  delegation. They support the direction, not a forecast.
- **The other researcher may weigh tokens more heavily.** I would change the recommendation if their measurements
  show agents ignore long local briefs without harm, or that the minimal-verification override caused no lost or
  wrong landings. I found one manager question that names the override directly, and the product-must-boot incident
  of 11-04 is consistent with checks being deferred and never run.
