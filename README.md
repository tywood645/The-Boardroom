# BoardRoom

**Convene a board of specialized AI advisors, drawn from six different LLM vendors, and make them argue.**

BoardRoom is a CLI tool that seats six advisors (CEO, COO, CFO, CTO, CMO, and a Devil's Advocate), each backed by a *different* LLM provider and each locked into a single business mindset, then runs their deliberation through one of two protocols: a sealed-bid exploration (`ask`) or formal parliamentary procedure under Robert's Rules (`motion`). The point is not another chat wrapper. The point is structured disagreement: different vendors, different priors, different roles, all forced to commit to a position and defend it.

---

## What it does and why

A solo founder talking to one model gets one model's blind spots, amplified by that model's eagerness to agree. BoardRoom attacks both problems at once.

- **Six vendors, not one.** Each advisor runs on a different provider (Anthropic, OpenAI, xAI, Google, DeepSeek, Perplexity), so a single vendor's training bias cannot quietly dominate the room.
- **Six locked roles, not a generalist.** The CFO only cares about runway. The Devil's Advocate is told to attack and not offer the upside. Advisors are instructed not to hedge and not to cover angles outside their role, which forces real disagreement along business axes instead of safe consensus.
- **Two protocols, not freeform chat.** Use `ask` to explore a question with parallel, independent answers (optionally followed by cross-examination). Use `motion` when you want a binding, recorded decision: the board seconds, debates, votes, and the outcome is written to disk.

This is a serious independent engineering project, not a product with users or production scale. It is a single-operator tool that runs locally and writes its state to your home directory.

---

## Example session (illustrative)

> The transcript below is illustrative formatting, not a captured run. Real output depends on your providers and keys.

```
$ boardroom "Should we hire a VP Sales or build inside sales?"

Convening 6 advisors: CEO=anthropic, COO=openai, CFO=deepseek, CTO=xai, CMO=google, Devil=perplexity
Loaded prior board context (1840 chars)

  CEO   Build inside sales first. A VP hire this early buys org chart, not pipeline...
  COO   Inside sales. You do not have the deal volume to keep a VP busy or honest...
  CFO   Inside sales, on runway grounds. A VP Sales fully loaded is ~$250k/yr...
  CTO   Neutral on the hire itself, but note the CRM and attribution work either path needs...
  CMO   Neither until you can name the buyer. "VP vs inside" is downstream of positioning...
  Devil This is a hiring question dressed up as a strategy question. The real risk is...

  session cost: $0.04
```

Motion mode produces a recorded decision instead of a discussion:

```
$ boardroom motion "We commit 12 months to AI feature parity instead of new product lines"

Motion phases: brief -> second -> debate -> vote -> minutes

  SECOND   4 of 6 seconded -> proceeds to debate
  DEBATE   CEO SUPPORT, COO OPPOSE, CFO OPPOSE, CTO SUPPORT, CMO UNDECIDED, Devil OPPOSE
  VOTE     AYE 3  NAY 3  ABSTAIN 0   (CMO flipped UNDECIDED -> AYE)
  OUTCOME  TIED

  Minutes: ~/.boardroom/meetings/2026-06-20-1432.md
```

---

## Features

- **Ask Mode (sealed-bid exploration).** Six advisors answer in parallel, none seeing another's answer first. Optional round 2 cross-examines round 1, letting advisors disagree, concede, or hold position. Tunable response budget per panelist.
- **Motion Mode (Robert's Rules).** A concrete motion runs through four phases: second, debate, vote, minutes. A motion needs at least two seconds or it dies. Votes track whether an advisor flipped between their debate stance and their final ballot. Minority dissent is captured by name. A decision needs a quorum: if fewer than a majority of the seated advisors answer the second or the vote (vendor errors, budget blocks, a deadline), the outcome is "no quorum", the command exits 1, and nothing is recorded as decided.
- **Persistent institutional memory.** Settled decisions and a user-editable standing context are auto-loaded and prepended to future meetings so the board builds on prior judgment instead of re-litigating it. Disable per run with `--no-recall`.
- **Optional research consultant.** A single web-grounded provider (typically Perplexity) produces a terse briefing that is prepended to every advisor's prompt, so disagreements are about judgment rather than stale training data. The briefing, like every other model's text passed between advisors, is inserted as a line-by-line quote, so nothing in it can pose as part of the prompt. Everything a model or vendor returns is also made inert before it reaches your terminal or the minutes file: control characters, including the ESC that starts every ANSI sequence, are shown as visible escapes like `\x1b`, so a response cannot clear the screen, forge status lines, plant hyperlinks or set your clipboard. `--json` output stays raw, with JSON's own escaping. Disable with `--no-consultant` to isolate each vendor's priors.
- **Cost transparency with budget guards.** A per-model pricing table drives live cost reporting, with optional session, daily, and weekly spend caps (soft warning and hard block).
- **Resilient by default.** Every provider call retries with exponential backoff and uses a connect-only timeout that never kills a long stream. Retries stop once the response body has started producing text, so a mid-stream failure surfaces as an error rather than silently duplicating output.
- **Partial board operation.** If a provider is missing a key or fails mid-run, its seat reports an error and the rest of the board proceeds. Two providers is the minimum to convene.
- **Runs free, local or hosted.** Beyond per-vendor keys, BoardRoom can seat the whole board from local [Ollama](https://ollama.com) models (no keys, no cost) or from a single OpenRouter key, selected with `BOARDROOM_BACKEND`. See "Running without paid API keys" below.

---

## Architecture

BoardRoom is roughly 2,000 lines of TypeScript across 21 source files, with a small node:test suite. Four layers do the work.

### 1. Provider abstraction

A single streaming interface (`LLMProvider.createMessage`, an `AsyncGenerator` of normalized stream events) sits over two concrete clients:

- `AnthropicProvider`: a native Anthropic Messages API client (SSE parsing, no SDK dependency).
- `OpenAICompatProvider`: one OpenAI-compatible client reused for xAI, Google, DeepSeek, and Perplexity by swapping only the base URL. Its chunk parser normalizes OpenAI-style deltas, including the end-of-stream usage chunk, back into the same event shape the Anthropic path emits. The same client also powers the OpenRouter and Ollama backends, again by swapping only the base URL.

Because both clients yield the same events, the rest of the codebase never branches on vendor. You add or swap a provider by setting an environment variable, not by touching code.

### 2. Ask vs Motion protocols (two state machines)

- **Boardroom (`ask`)**: builds one seat per detected provider, optionally fetches a consultant briefing, prepends recall plus briefing to the question, then runs all seats in parallel via `Promise.all`, collecting streamed text per advisor. An optional round 2 compiles round 1 into a review packet and asks each advisor where they disagree.
- **Motion (`motion`)**: four sequential phases. **Second** parses a strict `SECOND: yes/no` reply and requires two or more to proceed (otherwise the motion dies). **Debate** forces a `STANCE: SUPPORT | OPPOSE | UNDECIDED` plus a short case. **Vote** shows every advisor the full debate transcript and records `AYE | NAY | ABSTAIN`, flagging any advisor whose final vote contradicts their debate stance. **Tally** maps the count to `passed` / `failed` / `tied` / `died_for_lack_of_second`.

### 3. Role assignment

A fixed vendor-to-role map (Anthropic = CEO, OpenAI = COO, DeepSeek = CFO, xAI = CTO, Google = CMO, Perplexity = Devil's Advocate). Each role carries a distinct three-to-four-sentence mindset that is injected into the system prompt, with explicit instructions to stay in role and not cover the angles other roles own.

### 4. State and cost

- `~/.boardroom/context.md`: user-editable standing context (founder, company, constraints, things not to re-debate). A stub is created on first run and a heuristic skips it from briefings until you actually edit it.
- `~/.boardroom/state.json`: the most recent decisions (bounded to the last 20), each with motion text, tally, outcome, and per-role dissent records. The recall block surfaces a handful of the most recent. Recalled text is flattened to one bounded line per field before it reaches a prompt, so a past response cannot inject instructions into later meetings. Writes are locked and atomic; a corrupt state file is renamed to `state.json.corrupt` rather than overwritten.
- `~/.boardroom/meetings/{id}.md`: human-readable Markdown minutes per motion. Ids carry seconds and a random suffix, and existing minutes are never overwritten.
- `~/.boardroom/usage/YYYY-MM.jsonl`: the billing ledger, one append-only file per month, kept for the current and previous month. Each call writes a worst-case hold before dispatch and its actual cost after, so concurrent runs see each other's spend and in-flight reservations. A pre-ledger `usage.json` is still read, never written.

All state files are created `0o600`, and the directory `0o700`.

---

## Quickstart

Requires **Node.js 18+**.

```bash
git clone https://github.com/tywood645/boardroom.git
cd boardroom
npm install
npm run build      # compiles TypeScript to dist/
npm start -- "Should we raise now or extend runway six months?"
```

`npm test` runs the node:test suite.

### Environment variables

BoardRoom detects providers purely from which keys are present. Set at least two; set all six to seat the full board. Keys load from your shell environment, or from a `.env` file in either of two places: BoardRoom's own project root (the `boardroom/` directory you cloned), or `~/.boardroom/.env`. Copy `.env.example` to one of those and fill in the keys you have.

A `.env` in whatever directory you happen to run `boardroom` from is **not** read, and BoardRoom prints a notice when it skips one. Otherwise running it inside someone else's directory would let their `.env` pick the backend and its address, and send them your prompts and standing context. On Linux and macOS, a settings file that is not yours or is writable by others is also skipped; `chmod 600` fixes it. The shell environment always wins over either file, and `~/.boardroom/.env` wins over the project root.

```bash
# .env  (never commit this; .gitignore already excludes it)
ANTHROPIC_API_KEY=...     # seats the CEO
OPENAI_API_KEY=...        # seats the COO
DEEPSEEK_API_KEY=...      # seats the CFO
XAI_API_KEY=...           # seats the CTO
GOOGLE_API_KEY=...        # seats the CMO
PERPLEXITY_API_KEY=...    # seats the Devil's Advocate and the research consultant
```

If fewer than two keys are set, BoardRoom tells you which it found and exits.

### Running without paid API keys

You do not need six vendor keys. `BOARDROOM_BACKEND` selects how the board is seated (default `auto`, which prefers per-vendor keys, then OpenRouter, then Ollama):

- **Ollama (local, free, private).** Run open models on your own machine, no keys and no cost. Install [Ollama](https://ollama.com), pull a few models, then point BoardRoom at it:
  ```bash
  for m in llama3.1 qwen2.5 deepseek-r1 mistral gemma2 phi3; do ollama pull $m; done
  export BOARDROOM_BACKEND=ollama          # or just set OLLAMA_HOST to let auto pick it
  boardroom "Should we raise now or extend runway six months?"
  ```
  Each seat defaults to a different open model. Override any with `BOARDROOM_OLLAMA_<SEAT>` (for example `BOARDROOM_OLLAMA_ANTHROPIC=llama3.3`). Seat keys: `ANTHROPIC OPENAI DEEPSEEK XAI GOOGLE PERPLEXITY`.

- **OpenRouter (one key, many models).** A single `OPENROUTER_API_KEY` seats the whole board through OpenRouter. Choose free models (see https://openrouter.ai/models?max_price=0) to run at no cost:
  ```bash
  export OPENROUTER_API_KEY=...
  export BOARDROOM_BACKEND=openrouter
  export OPENROUTER_MODEL='meta-llama/llama-3.1-8b-instruct'   # or a :free slug
  boardroom "Pivot to AI or stay B2B SaaS?"
  ```
  Override per seat with `BOARDROOM_OPENROUTER_<SEAT>`. Local models and any `:free` slug are tracked at zero cost.

### Example commands

```bash
# Sealed-bid exploration, one round, six advisors in parallel (default mode)
boardroom "Should we hire a VP Sales or build inside sales?"

# Add a cross-examination round
boardroom --rounds 2 "Pivot to AI or stay B2B SaaS?"

# Formal motion: second -> debate -> vote -> minutes
boardroom motion "We commit 12 months to AI feature parity instead of new product lines"

# Skip the research briefing to isolate each vendor's priors
boardroom --no-consultant "Quick gut check on pricing"

# Ignore prior decisions for a fresh take
boardroom --no-recall "Fresh perspective on business model"

# Custom response budget
boardroom --max-tokens 2048 "Deep strategy question"

# Machine-readable: the full result as JSON on stdout, progress on stderr
boardroom --json "Should we raise prices?" > result.json
boardroom motion --json "Adopt the plan" > motion.json
```

Exit codes: `boardroom` (ask) exits `0` when at least one advisor answered and `1` when none did. `boardroom motion` exits `1` when there was no quorum, `0` otherwise.

Default response budgets are 1024 tokens per panelist in `ask` mode and 600 tokens per phase response in `motion` mode.

---

## `boardroom delegate` — cheap-first tiered dispatch

A sibling of the board, not a layer under it. The board seats one vendor per role to *manufacture disagreement*; the delegator picks one model per task to *minimise cost*. Opposite objectives, so `roles.ts` is untouched and this is a separate command.

Most work sent to a frontier model does not need one. The problem is knowing which work, and being able to prove it afterwards. Four things make that possible here. (For what prompted this and what it owes to [pilotfish](https://github.com/Nanako0129/pilotfish), see [Prior art](#prior-art).)

**Tiers are price bands, not model aliases.** A tier resolves at runtime against whichever vendors you have credentialed, ranked by the same catalog that prices the budget gate, so the delegator can never select a model it cannot price:

```
$ boardroom delegate stats
=== Tier resolution ===
  cheap    → google/gemini-3.1-flash-lite  $0.56/Mtok blended
  mid      → google/gemini-3.6-flash       $3.00/Mtok blended
  frontier → anthropic/claude-opus-5       $10.00/Mtok blended
```

Add an OpenAI key to that same setup and cheap resolves to `gpt-5-nano` at `$0.05/$0.40` instead — against haiku's `$1.00/$5.00`, over 10x on identical work. A tier with no reachable vendor downgrades and reports `downgradedFrom` rather than failing or silently substituting.

The catalog carries current-generation models only. "Still has a published price" and "is current" are different questions: `gpt-4o` is four generations behind and still sells. Answering only the first is how the table came to hold seven models that were retired, shut down, or superseded.

Nothing here is a constraint, though. Every board seat takes `BOARDROOM_<VENDOR>_MODEL` (`BOARDROOM_OPENAI_MODEL`, `BOARDROOM_GOOGLE_MODEL`, and so on for all six), and the delegator takes `--model vendor:model` or `BOARDROOM_TIER_<TIER>`. Any of those accept a model string the catalog has never heard of: it is dispatched normally and priced at the warned default. So a model released tomorrow is usable today, and a stale default here is a nuisance rather than a wall.

**The catalog is checked against the vendors, not trusted.** It is a hand-maintained table, and it rots silently — a model can be retired, shut down, or quietly superseded with nothing in the build noticing:

```
$ boardroom delegate --verify-catalog
=== Catalog vs vendor ===
  anthropic   ok
  google      stale
      gone: gemini-2.0-flash — the vendor no longer lists this
      1 carried and confirmed, 47 served but not carried (--json to list)
  openai      skipped — no credentials
```

It asks every credentialed vendor which models it actually serves and exits non-zero when the catalog names one that is gone — that entry cannot be called at all, and since tiers resolve by price, a cheap dead model wins its tier outright and every delegation routed to it fails. A vendor that cannot be reached is reported but does not fail the run, because being unable to ask is not evidence the catalog is wrong; `--strict` inverts that for a release gate, where a run that checked nothing must not read as a pass. The count of models a vendor serves but the catalog does not carry is the other half: it is how you notice a model is still purchasable but several generations behind, which no liveness check would ever flag.

**Escalation is bought, not spent by default.** The cheapest capable tier is attempted first; a checker at the *same* tier on a *different vendor* tries to refute it; only a concretely named defect buys a more expensive attempt. A cheap answer therefore costs roughly one more cheap call to check, not a frontier call — and the check comes from a model with genuinely different priors, where a larger sibling from the same family tends to share the blind spot that produced the error. Three loop-safety rules matter:

- A `REFUTED` that names no defect is treated as `CONFIRMED`. Otherwise a model that reflexively refuses to approve anything drives the ladder to the most expensive tier for free.
- An unparseable verdict does not escalate. Failing open on escalation while failing closed on budget is the right asymmetry: a parser miss must never be able to spend frontier money.
- The top tier is not verified by default, since a refutation there has nowhere to go and it is the most expensive call the delegator can make. One answer in five is checked anyway, by another top-tier model, so the measured stats can learn whether reaching the top tier actually helps. That verdict never escalates anything; a refuted sample is returned marked as refuted. Set the share with `BOARDROOM_VERIFY_FRONTIER` (`0` turns it off).

The checker is chosen from the catalog, ignoring `--model` and `BOARDROOM_TIER_*` pins (a pin names the worker, and the checker must be a different model), and from a different vendor wherever one is credentialed at that tier; a same-vendor sibling is used only when it is all there is, and the verdict says so. Verdicts and votes are read strictly: the field must be a line of its own, an echoed format line (`VERDICT: CONFIRMED | REFUTED`) is not an answer, and a reply that contradicts itself counts as no answer.

Exit codes: `0` an answer that was not refuted, `1` no answer, `2` the only answer produced was refuted by the checker and no better attempt completed.

`delegate` works on all three backends:

- **Per-vendor keys:** as described above.
- **OpenRouter:** the same tiers and catalog, with each model sent under its OpenRouter ID (`openai/gpt-5-nano`, `x-ai/grok-4.5`). Those IDs are derived as `<vendor>/<catalog id>`, which is a convention, not a guarantee. Run `boardroom delegate --verify-catalog` with the OpenRouter backend selected to check every one against OpenRouter's live list, and correct any that differ with `BOARDROOM_OPENROUTER_IDS` (see `.env.example`).
- **Ollama:** a local install has no price tiers, so every tier resolves to your configured local model and nothing escalates. If a second seat has a different local model, it checks the answer; a refuted answer is returned marked as refuted, with exit code `2`.

Caps must be positive amounts; a value that is not (a typo, `0`) stops the run instead of running uncapped, and `--session-cap none` turns one off deliberately. `delegate` defaults to a $1.00 session cap unless `BOARDROOM_SESSION_CAP` or the flag says otherwise. A model with no catalog entry is priced at the catalog's highest rate so a cap still holds; set `BOARDROOM_MODEL_PRICES` to give its real price.

**Delegation is measured, not guessed.** Every attempt lands in `~/.boardroom/delegations.jsonl` with its tier, vendor, cost, latency and outcome. `pickStartTier` starts from the class prior and walks up while the measured confirm rate at the current tier is poor, needing a minimum sample count so one bad run never moves the delegator. A refutation counts against a tier only when a higher tier in the same run was then confirmed; runs where nothing was ever confirmed say the task was unsatisfiable, not that the tier was weak, and are ignored, so crafted tasks cannot push routing up the ladder. Every decision carries a `why` string naming its evidence — a delegator you cannot audit is a delegator you will not trust.

**Limits are enforced, not stated.** Budget, concurrency and deadline are applied inside `collectStream()`, the single function every provider call passes through. `tests/enforcement-invariant.test.ts` asserts that no other file calls `createMessage`, so there is no path to a provider that skips the gate. The budget check runs *before* the request is sent and prices the worst case: full `--max-tokens` of output, and input at its UTF-8 byte length, which no tokenizer can exceed. That amount is *held* against every cap until the call settles, so concurrent calls cannot all pass against the same total, and other processes see the hold too. Every call settles, including ones that fail mid-stream or hit the deadline; where a vendor reports no usage, or an implausible count, a conservative estimate is charged instead.

```bash
boardroom delegate "summarize this changelog"            # classify, dispatch, verify
boardroom delegate --explain --class code "..."          # show the decision and every attempt
boardroom delegate --min-tier mid --session-cap 0.25 "..."
boardroom delegate --model deepseek:deepseek-v4-flash "..."  # pin one model, no escalation
boardroom delegate stats                                 # what each tier resolves to, and how it has been doing
```

Task classes are `recon`, `extract`, `summarize`, `draft`, `code`, `reason`, `research`, plus an internal `review`. Classification is a deterministic rules table, never a model call — classifying with a model to decide which model to use is circular and adds a call to every route.

---

## Engineering highlights

For anyone reading the source, these are the parts worth a look:

- **One streaming contract over six vendors.** `src/provider/openai-compat.ts` translates four different OpenAI-flavored SSE streams (including the `stream_options.include_usage` end chunk) into the exact same event union that `src/provider/anthropic.ts` emits, so all downstream logic is vendor-blind.
- **Resilience that does not truncate streams.** Both clients retry up to three times with exponential backoff on 429 and 5xx, and the 30-second timeout is wired to an `AbortController` whose timer is cleared the moment headers return (`.finally(() => clearTimeout(...))`). The connection has to be fast; the body can take as long as the model needs. Retries are bounded to the part of the call that is safe to repeat: once the body has yielded its first text delta, a failure is raised rather than retried, because consumers accumulate text outside the stream and a re-issued request would concatenate a partial attempt with a complete one.

- **Accounting at the point of spend.** Every provider call goes through a single `collectStream()` (`src/provider/collect.ts`), which is where the budget gate holds the worst case *before* the request is sent and settles it to actual cost afterwards, on success or failure. `tests/enforcement-invariant.test.ts` asserts that no other file calls `createMessage`, so there is no path to a provider that skips the gate.
- **Robert's Rules as real control flow.** `src/motion/protocol.ts` is the deliberation engine: a two-second threshold that can kill a motion before any tokens are spent on debate, strict format parsing for each phase, and stance-versus-vote flip detection so the minutes can show who changed their mind during debate.
- **Per-model cost caps with a hard block.** `src/cost/tracker.ts` carries a pricing table for eleven models (Opus through Sonar), accumulates session/daily/weekly spend from the shared append-only ledger (including other processes' in-flight holds), and can return a `blocked` alert when a cap is hit, not just a warning.
- **Durable, careful local state.** `src/state/store.ts` bounds decision history, writes with restrictive permissions, and refuses to clobber an unreadable `state.json` (it renames it to `state.json.corrupt` so history is recoverable).

---

## Tech stack

- **TypeScript 5.6** targeting **ES2022**
- **Node.js 18+** (uses built-in `fetch`, `AbortController`, and the `node:` core modules)
- **Commander.js 11** for CLI parsing
- **Chalk 5** for terminal color
- **dotenv 17** for env loading
- Native **Anthropic** Messages client plus an **OpenAI-compatible** client covering five vendors
- **node:test** as the test runner (run with **tsx**)

No LLM SDK dependency: both provider clients are hand-rolled `fetch` + SSE.

---

## Roadmap

These are directions the architecture already invites, not commitments:

- Prompt caching across the three motion phases, which resend the same recall and briefing to the same vendor each time.
- Configurable vendor-to-role assignment (the map is currently fixed in `roles.ts`).
- Richer minutes: per-advisor token and cost breakdown inside the meeting file.
- A `history` command to browse and cite past decisions from the CLI.
- Tool-use is modeled in the provider types but unused by the protocols; advisor-side research tools are a natural extension.

---

## Prior art

`boardroom delegate` was prompted by [pilotfish](https://github.com/Nanako0129/pilotfish) by [@Nanako0129](https://github.com/Nanako0129) (MIT), a configuration layer that routes Claude Code's work across Anthropic model tiers. It framed the problem clearly, and three ideas here follow its lead: a three-tier hierarchy, an adversarial checker that returns a `CONFIRMED`/`REFUTED` verdict, and a hard cap on how many times work may be escalated.

The implementation is independent. No pilotfish code is used — it is Python and markdown templates written into `~/.claude/`, this is TypeScript that dispatches calls at runtime, and nothing was copied between them. The approach diverges accordingly: pilotfish states its orchestration policy as prose for a model to follow, while this enforces limits in code at a single choke point; its tiers are Anthropic aliases, while these are price bands resolved across whichever vendors you have credentialed; its verifier runs on the frontier tier, while this one runs same-tier on a different vendor. pilotfish's own design doc lists enforcement hooks and a telemetry feedback loop among the things it deliberately excludes, and those two exclusions are most of what this adds.

Credit where it is due in both directions: the claim that independent fresh-context verification beats self-critique is one pilotfish cites from Anthropic's documentation, and originates with neither project.

---

## License

MIT, see [LICENSE](LICENSE). Authored by Tyler Wood ([github.com/tywood645](https://github.com/tywood645)).
