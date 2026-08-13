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

A blocked `UserPromptSubmit` hook **erases the prompt** — the block path pushes
a warning message but does not restore the input. So the confirming keystroke
has to recall the prompt from history first. Claude Code also echoes
`Original prompt: …` beneath the estimate, so nothing is lost even if you would
rather retype or paste it.

The Cursor CLI counterpart in `cursor-cli/` uses the same Up-then-Enter flow:
its native `beforeSubmitPrompt` hook also clears the composer when it blocks a
submission. Both implementations estimate first, confirm to send, and require
a fresh estimate after an edit.

## What the estimate actually measures

The Cursor version priced prompt length alone. In Claude Code that would be
misleading, because the dominant cost of a turn is that **the whole conversation
is re-sent every time**. In the example above the 22-token prompt accounts for
well under a cent of the $0.236; the 97k tokens of carried context is the bill.

So TokenLens reads the session transcript for the real numbers:

| Component | Priced at | Source |
| --- | --- | --- |
| Context re-sent | cache-read rate (0.1x input) | last assistant turn's usage |
| This prompt | cache-write rate (1.25x input) | characters / 4 |
| Assumed reply | output rate | `expectedOutputTokens` |

The model is read from the transcript too, so an Opus session is priced as Opus.
Before the first assistant turn there is no usage data yet, so context reads as
`first turn, nothing carried in yet` and pricing falls back to Sonnet.

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
- `pricing` — per-million-token list prices. Edit these when rates change or if
  your account is priced differently; anything you omit falls back to the
  built-in value.

Set `TOKENLENS_HOME` to relocate the config and state directory.

## Privacy and failure behavior

- Prompt text is never written to disk. The pending state stores only a SHA-256
  fingerprint, which is enough to prove the confirming prompt is unchanged.
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

The test suite covers the pricing math, the decision logic, transcript parsing,
and the hook itself end to end — spawning `scripts/gate.mjs` the way Claude Code
does, feeding it JSON on stdin and asserting on the decision it prints.

| Path | Role |
| --- | --- |
| `scripts/gate.mjs` | Hook entry point. Reads stdin, prints the decision. |
| `scripts/control.mjs` | `on`/`off`/`status` for the slash command and scripts. |
| `src/gate.mjs` | The decision, as one pure function. |
| `src/estimator.mjs` | Token and dollar math. |
| `src/transcript.mjs` | Context size and model, read from the session log. |
| `src/state.mjs` | Per-session pending fingerprints. |
| `hooks/hooks.json` | Registers the `UserPromptSubmit` hook. |
