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

## Does the premise hold?

BoardRoom's entire claim is in one sentence: **six different vendors disagree more usefully than one vendor wearing six hats.** That is a falsifiable claim, so the repo ships the instrument that tries to falsify it.

`boardroom eval` runs a fixed corpus of 30 hand-written, closed-form business decisions past the board and measures how often the six advisors actually split. Then it runs the identical corpus with **one vendor seated in all six roles** and measures the same thing. If multi-vendor divergence is not meaningfully higher than single-vendor divergence, the premise is wrong and this README should say so.

```bash
boardroom eval                        # six vendors, one per seat
boardroom eval --control anthropic    # one vendor in all six seats
boardroom eval --compare anthropic    # run both arms and print the premise check
boardroom eval --category capital --limit 5 --json out.json
```

```
BoardRoom divergence eval - 30 questions, multi-vendor panel (6 vendors)

  parse rate        172/180 votes (95.6%)
  scored questions  30 of 30  (>=2 parsed votes)
  divergence rate   0.633   (19 of 30 questions split)
  mean minority     0.244   (share of panel on the losing side)
  unscored votes    5 ambiguous, 3 no-match, 0 provider errors

  by category             scored  divergent    rate
      capital                  8          6   0.750
      hiring                   7          4   0.571
      product                  8          5   0.625
      gtm                      7          4   0.571

  most contrarian   Devil (perplexity)  0.407
  least contrarian  CEO (anthropic)     0.115

  run cost: $0.4120

=== Premise check ===
  multi-vendor divergence   0.633
  single-vendor divergence  0.300
  delta                     +0.333

  Six vendors disagreed measurably more than one vendor in six roles.
```

> **Numbers above are format, not results.** The corpus, the extractor, and the scorer are in the repo and run today; the headline figure needs a funded run across six paid vendors, which has not happened yet. This section gets replaced with real output, including the single-vendor control, or the claim gets retracted. Until then BoardRoom is unmeasured and you should treat it accordingly.

### Why this is an eval and not a vibe

No human reads the answers, and no model grades them.

Each question is a forced binary — *raise now* or *extend runway* — with a hand-written alias list per option. The `ask` protocol already mandates that an advisor's **first sentence is their recommendation**, so the scorer reads only that sentence and matches it against the alias lists. One option matched means a recorded vote. Both matched, or an alias sitting behind a negation, means **ambiguous**; nothing matched means **no match**. Ambiguous and unmatched votes are never guessed at and never sent to a judge model — they are dropped from scoring and surface as the **parse rate**, which is itself a reported number.

Reading only the first sentence is deliberate. The format also requires a closing counterargument, and that sentence names the option the advisor *rejected* — so scanning the full answer would match both options on nearly every question. The strict window is what makes the extraction deterministic.

Eval runs skip the consultant briefing and prior-decision recall. Both inject text that varies between runs, and a measurement you cannot reproduce is not a measurement.

---

## Features

- **Ask Mode (sealed-bid exploration).** Six advisors answer in parallel, none seeing another's answer first. Optional round 2 cross-examines round 1, letting advisors disagree, concede, or hold position. Tunable response budget per panelist.
- **Motion Mode (Robert's Rules).** A concrete motion runs through four phases: second, debate, vote, minutes. A motion needs at least two seconds or it dies. Votes track whether an advisor flipped between their debate stance and their final ballot. Minority dissent is captured by name.
- **Persistent institutional memory.** Settled decisions and a user-editable standing context are auto-loaded and prepended to future meetings so the board builds on prior judgment instead of re-litigating it. Disable per run with `--no-recall`.
- **Optional research consultant.** A single web-grounded provider (typically Perplexity) produces a terse briefing that is prepended to every advisor's prompt, so disagreements are about judgment rather than stale training data. Disable with `--no-consultant` to isolate each vendor's priors.
- **A measurement, not just a demo.** `boardroom eval` scores a fixed 30-question corpus for how often the board actually splits, using a deterministic extractor rather than a judge model, and can run a single-vendor control that is capable of refuting the project's own premise. See "Does the premise hold?" above.
- **Cost transparency with budget guards.** A per-model pricing table drives live cost reporting, with optional session, daily, and weekly spend caps (soft warning and hard block).
- **Resilient by default.** Every provider call retries with exponential backoff and uses a connect-only timeout that never kills a long stream.
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
- `~/.boardroom/state.json`: the most recent decisions (bounded to the last 20), each with motion text, tally, outcome, and per-role dissent records. The recall block surfaces a handful of the most recent. A corrupt state file is renamed to `state.json.corrupt` rather than overwritten.
- `~/.boardroom/meetings/{id}.md`: human-readable Markdown minutes per motion.
- `~/.boardroom/usage.json`: append-only usage log with rolling 30-day retention, driving session/daily/weekly spend math.

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

BoardRoom detects providers purely from which keys are present. Set at least two; set all six to seat the full board. Keys load from your shell environment (or a `.env` file in the project root via dotenv). Copy `.env.example` to `.env` and fill in the keys you have.

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

# Measure how often the board actually splits (30-question corpus)
boardroom eval

# Same corpus, one vendor in all six seats, then compare the two
boardroom eval --compare anthropic

# Smoke test the harness cheaply before a full run
boardroom eval --category capital --limit 3
```

Default response budgets are 1024 tokens per panelist in `ask` mode and 600 tokens per phase response in `motion` mode.

---

## Engineering highlights

For anyone reading the source, these are the parts worth a look:

- **One streaming contract over six vendors.** `src/provider/openai-compat.ts` translates four different OpenAI-flavored SSE streams (including the `stream_options.include_usage` end chunk) into the exact same event union that `src/provider/anthropic.ts` emits, so all downstream logic is vendor-blind.
- **Resilience that does not truncate streams.** Both clients retry up to three times with exponential backoff on 429 and 5xx, and the 30-second timeout is wired to an `AbortController` whose timer is cleared the moment headers return (`.finally(() => clearTimeout(...))`). The connection has to be fast; the body can take as long as the model needs.
- **Robert's Rules as real control flow.** `src/motion/protocol.ts` is the deliberation engine: a two-second threshold that can kill a motion before any tokens are spent on debate, strict format parsing for each phase, and stance-versus-vote flip detection so the minutes can show who changed their mind during debate.
- **Per-model cost caps with a hard block.** `src/cost/tracker.ts` carries a pricing table for eleven models (Opus through Sonar), accumulates session/daily/weekly spend from the usage log, and can return a `blocked` alert when a cap is hit, not just a warning.
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

- Configurable vendor-to-role assignment (the map is currently fixed in `roles.ts`).
- Surfacing budget caps and warn thresholds as CLI flags rather than constructor config.
- Richer minutes: per-advisor token and cost breakdown inside the meeting file.
- A `history` command to browse and cite past decisions from the CLI.
- Tool-use is modeled in the provider types but unused by the protocols; advisor-side research tools are a natural extension.

---

## License

MIT, see [LICENSE](LICENSE). Authored by Tyler Wood ([github.com/tywood645](https://github.com/tywood645)).
