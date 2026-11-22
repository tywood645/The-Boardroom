# Changelog

## 0.3.0 (2026-11-22)

The first tagged release. It adds the `delegate` command and hardens budget enforcement, board deliberation and local state against the findings of three security reviews. Several defaults changed; read **Upgrading** before you update.

### Upgrading from 0.1.0

- **Move your `.env`** if it is not in BoardRoom's own project folder. Settings are now read only from the shell environment, `~/.boardroom/.env` and the `.env` in the project folder; a `.env` in the directory you run `boardroom` from is ignored, with a notice.
- **Make your `.env` private.** On Linux and macOS a settings file that is not yours, or that others can write, is skipped. Run `chmod 600` on it.
- **Turn caps off with `none`, not `0`.** `--session-cap 0`, a typo, or a value like `1,00` now stops the run instead of silently running with no cap.
- **Check scripts that read exit codes.** A motion without a quorum exits `1`. A `delegate` run whose only answer the checker refuted exits `2`. A run stopped with Ctrl-C exits `130`.
- **Declare prices for uncatalogued models.** A model the catalog does not carry, including the default OpenRouter model, is priced at the catalog's highest rate so caps still hold. Set `BOARDROOM_MODEL_PRICES` (see `.env.example`) to use its real price.
- **Spend history moved** to `~/.boardroom/usage/YYYY-MM.jsonl`. An existing `~/.boardroom/usage.json` is still read for history but no longer written.

### Added

- `boardroom delegate`: cheap-first, cross-vendor tiered dispatch, with a different-vendor checker that must name a concrete defect before work escalates (#1).
- `delegate --verify-catalog`: asks each vendor which models it still serves.
- `BOARDROOM_MODEL_PRICES` to price models the catalog does not carry.
- `none` as an explicit value to disable a budget cap.

### Security

Budget caps now actually hold (#4):
- The worst case of each call is reserved before dispatch, so concurrent calls cannot all pass against the same total.
- Spend is written to an append-only ledger shared by every process, so parallel runs no longer erase each other's records.
- Failed, interrupted, retried and deadline-aborted calls are charged, as are streams that report no usage.
- Input is reserved at its byte length, not chars/4, and vendor token counts are used only when plausible.
- Unknown and gateway-prefixed models are no longer under-priced, and a model is free only on the backend where it really is.

Board integrity (#4):
- A motion needs a quorum: one surviving vote can no longer be recorded as "PASSED (1-0)".
- Votes, stances, seconds and verdicts are read only as a line of their own, so an echoed format line is not counted as an answer.
- Text from one model is quoted, not pasted, into another's prompt, and recalled decisions are flattened, so neither can inject instructions.
- Unsatisfiable delegate tasks can no longer push routing to the most expensive tier, and the checker is no longer silently skipped when a tier is pinned.

Local safety (#4, #5):
- Model and vendor output is made inert before it reaches the terminal, the logs or the minutes file: escape sequences are shown as visible text like `\x1b`, so they cannot clear the screen, forge output, plant links or set the clipboard.
- `.env` is no longer read from the working directory, so a directory you run BoardRoom in cannot redirect your prompts to another server.
- State is never written to the current directory when `HOME` is unset.
- Motion minutes are never overwritten, and state, lock and ledger writes are safe under concurrency.

### Fixed

- `--version` reports the version in `package.json` instead of a hard-coded `0.1.0`.
- dotenv's banner no longer corrupts `delegate --json` output.
- `--concurrency` is never exceeded.
