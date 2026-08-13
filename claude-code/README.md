# TokenLens for Claude Code

The Claude Code counterpart to the Cursor extension in this repository. It does
one thing: when the gate is on, submitting a prompt **pauses it** and shows what
sending it would cost. Confirming sends it unchanged.

Nothing is sent to the model while a prompt is paused, so the estimate itself is
free.

## Install

```sh
claude plugin marketplace add S-kalakota/Cursor_Token_Price_Estimator
claude plugin install tokenlens@tokenlens
claude plugin enable tokenlens@tokenlens
```

The plugin ships **disabled**, so installing it never silently starts gating
your prompts. The `enable` step is the opt-in. To try it from a local checkout,
run `claude plugin marketplace add ./` from the repository root instead.

### The reply-length estimator

The cost of a turn depends on how long the reply will be, and that is predicted
by a trained model rather than assumed. It runs as a small local service from
[Token_Counter](https://github.com/nkanthed06/Token_Counter):

```sh
python3 service/app.py --port 8787
```

The endpoint and timeout live in `model/feature-manifest.json` under
`inference`. Nothing is sent anywhere else: the service receives the 14-feature
payload only, which by design carries no prompt text.

**It answers for `claude-haiku-4-5` and `claude-sonnet-5` only** — the models the
predictor was trained on. Any other model, Opus included, is refused rather than
guessed at, and the estimate says so instead of showing an invented number.

If the service is not running, the gate falls back to the flat
`expectedOutputTokens` assumption and labels it. A broken estimator never blocks
a prompt.

## The two-step flow

1. Type a prompt and press **Enter**.
2. TokenLens pauses it and prints the estimate. No model call happens.
3. Press **Up**, then **Enter**, to send that prompt unchanged.

```text
TokenLens paused this prompt. Nothing was sent, so nothing was billed.

  Estimated cost    $0.236
  This prompt       88 chars ~ 22 tokens
  Context re-sent   97,222 tokens
  Assumed reply     1,200 tokens
  Model             claude-opus-5

Press UP then ENTER to send it unchanged. Edit it and you get a fresh estimate.
Type "tokenlens off" to stop gating.
```

Editing the prompt makes it a new prompt: the next Enter estimates it again, and
one more confirmation sends it.

### Why Up-then-Enter, and not a second Enter

The Cursor build is a true double-Enter because Cursor leaves the prompt sitting
in the composer when a `beforeSubmitPrompt` hook returns `continue: false`.

Claude Code does not. A blocked `UserPromptSubmit` hook **erases the prompt** —
that is documented behavior, and it is what the shipped binary does; the block
path only pushes a warning message and never restores the input. So the
confirming keystroke has to recall the prompt from history first. Claude Code
also echoes `Original prompt: …` beneath the estimate, so nothing is lost even
if you would rather retype or paste it.

This is the one behavior that could not be ported exactly. Everything else
matches: estimate first, confirm to send, edits require a fresh estimate.

## What the estimate actually measures

The Cursor version priced prompt length alone. In Claude Code that would be
misleading, because the dominant cost of a turn is that **the whole conversation
is re-sent every time**. In the example above the 22-token prompt accounts for
well under a cent of the $0.236; the 97k tokens of carried context is the bill.

So TokenLens reads the session transcript for the real numbers. Before pricing,
it also builds and validates a local, named 14-feature payload for the ML
estimator boundary:

- requested output format, task type, detail level, repository identity, and
  model identity;
- prompt, mentioned-code, relevant-code, requirement, question, and word
  metrics;
- bounded, cached repository line/file counts and accepted `@file` count.

The payload is ordered only at the adapter boundary according to
`model/feature-manifest.json`; prompt text, absolute paths, and source contents
are not part of it and are never written to disk. The repository does not yet
ship a trained preprocessing/model artifact, so the prediction boundary retains
the deterministic price estimator below until that artifact is supplied.

| Component | Priced at | Source |
| --- | --- | --- |
| Context re-sent | cache-read rate (0.1x input) | last assistant turn's usage |
| This prompt | cache-write rate (1.25x input) | manifest-pinned Unicode characters / 4 |
| Assumed reply | output rate | `expectedOutputTokens` |

The model is read from the transcript too, so an Opus session is priced as Opus.
Before the first assistant turn there is no usage data yet, so context reads as
`first turn, nothing carried in yet`; the model identity comes from Claude's
configured model setting until the transcript records the exact model id.

**This is an estimate, not a quote.** Two things in particular make the real
number higher: token counts are approximated from character length, and one
Claude Code turn often makes several model calls as it runs tools, while this
prices the next call only. Treat it as a floor.

## Controls

Typed straight into the prompt. The hook intercepts these itself, so they cost
nothing and never reach the model:

| Type this | Effect |
| --- | --- |
| `tokenlens off` | Stop gating. Prompts send on one Enter. |
| `tokenlens on` | Resume gating. |
| `tokenlens status` | Show the current settings. |

`/tokenlens on|off|status` works too, via the bundled slash command.

To turn the whole thing off, disable the plugin:

```sh
claude plugin disable tokenlens@tokenlens
```

## Configuration

`~/.claude/tokenlens/config.json`, created on first use:

```json
{
  "enabled": true,
  "expectedOutputTokens": 1200,
  "thresholdUsd": 0,
  "featureLogging": true,
  "pricing": {
    "opus":   { "input": 15, "output": 75, "cacheWrite": 18.75, "cacheRead": 1.5 },
    "sonnet": { "input": 3,  "output": 15, "cacheWrite": 3.75,  "cacheRead": 0.3 },
    "haiku":  { "input": 1,  "output": 5,  "cacheWrite": 1.25,  "cacheRead": 0.1 }
  }
}
```

- `thresholdUsd` — raise it above `0` to send cheap prompts on one Enter and
  only pause the expensive ones.
- `expectedOutputTokens` — raise it if your turns typically run long.
- `featureLogging` — while `true`, append each newly extracted prompt and its
  14 features to the local JSONL inspection log. Set it to `false` to stop.
- `pricing` — per-million-token list prices. Edit these when rates change or if
  your account is priced differently; anything you omit falls back to the
  built-in value.

Set `TOKENLENS_HOME` to relocate the config and state directory.

## Feature inspection log

For temporary ML feature inspection, every new or edited prompt is appended to:

```text
~/.claude/tokenlens/logs/ml-features.jsonl
```

Watch it live while submitting prompts:

```sh
tail -F ~/.claude/tokenlens/logs/ml-features.jsonl | jq .
```

Each JSON line contains `logged_at`, `session_id`, `schema_version`, the exact
submitted `prompt`, and the exactly 14 named properties under `features`.
Unchanged Up-then-Enter confirmations, control commands, slash commands, empty
prompts, and prompts submitted while TokenLens is disabled do not create a new
entry. If `TOKENLENS_HOME` is set, the log is under that directory instead.

## Privacy and failure behavior

- While `featureLogging` is enabled, exact prompt text and the 14 extracted
  features are deliberately written to the private inspection log above. The
  log directory is mode `0700` and the log file is mode `0600`.
- Pending confirmation state still stores only a SHA-256 fingerprint; source
  contents, workspace paths, transcript paths, and repository URLs are not
  written to the feature log.
- Repository metrics are cached as counts and timestamps only. The cache never
  stores repository paths or source contents.
- Nothing leaves your machine. There is no network call anywhere in the gate.
- The transcript is read locally, and only for token counts and the model name.
- **Every failure path allows the prompt.** Unreadable config, corrupt state, a
  malformed payload, an unexpected exception — all of them fall through to
  sending. A broken estimator must never be able to lock you out of a session.
- Slash commands and empty prompts are never gated, so `/clear` and `/model`
  keep working while the gate is on.

## Development

```sh
npm install
npm test
claude plugin validate ./
```

The test suite covers all 14 collectors, schema and manifest validation, safe
workspace traversal, cache invalidation, model-row ordering, pricing math,
decision logic, transcript parsing, and the hook itself end to end — spawning
`scripts/gate.mjs` the way Claude Code does, feeding it JSON on stdin and
asserting on the decision it prints.

| Path | Role |
| --- | --- |
| `scripts/gate.mjs` | Hook entry point. Reads stdin, prints the decision. |
| `scripts/control.mjs` | `on`/`off`/`status` for the slash command and scripts. |
| `src/gate.mjs` | Cheap preflight and predicted-cost decisions. |
| `src/hook.mjs` | Ordered hook orchestration and fail-open integration seam. |
| `src/estimator.mjs` | Token and dollar math. |
| `src/features/` | Deterministic collectors, validation, and repository cache. |
| `src/feature-log.mjs` | Private JSONL prompt and 14-feature inspection log. |
| `src/ml-feature-adapter.mjs` | Manifest-ordered, exactly-14-column model row. |
| `model/feature-manifest.json` | Versioned proposed-v1 feature contract. |
| `contracts/ml-feature-payload.v1.schema.json` | Canonical payload JSON Schema. |
| `src/transcript.mjs` | Context size and model, read from the session log. |
| `src/state.mjs` | Per-session pending fingerprints. |
| `hooks/hooks.json` | Registers the `UserPromptSubmit` hook. |
