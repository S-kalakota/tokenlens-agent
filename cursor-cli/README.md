# TokenLens for Cursor CLI

TokenLens pauses a Cursor CLI prompt before any backend request, shows an
estimated usage cost, and lets the identical recalled prompt through when you
confirm it. Editing the prompt produces a fresh estimate.

The gate uses Cursor's native `beforeSubmitPrompt` hook. Its first response is
`continue: false`, so the estimate itself does not call a model or consume
usage.

## Install

The reliable user-level install works in every project and does not depend on
Cursor plugin feature flags:

```sh
cd cursor-cli
npm run install:cursor
```

This copies the small local runtime to `~/.cursor/tokenlens/runtime` and safely
adds one `beforeSubmitPrompt` entry to `~/.cursor/hooks.json`. Existing Cursor
hooks are preserved. It also adds a TokenLens line to Cursor's supported custom
status-line configuration when no other custom status line is configured.
Existing custom status lines are left untouched. To remove only the TokenLens
hook, status line, and runtime later:

```sh
cd cursor-cli
npm run uninstall:cursor
```

This repository also contains `.cursor/hooks.json`, so the hook works directly
when Cursor CLI is launched from this checkout. Do not combine the project
hook, user install, and plugin install; choose one registration method so the
same prompt is not processed twice.

Then enter a normal prompt. Cursor CLI versions and terminal modes can either
leave a blocked prompt in the composer or require recalling it, so the flow is:

1. Press **Enter**. TokenLens blocks the submission and displays the estimate.
   The detailed yellow notice is temporary, but the cost remains in the
   TokenLens status line above the composer.
2. If the composer is empty, press **Up Arrow** to recall the prompt. Press
   **Enter** with that exact prompt. TokenLens verifies its fingerprint, lets it
   through, and clears the pending-cost line.
3. If you type a new prompt or edit the recalled text, TokenLens replaces the
   pending line with a newly calculated cost and waits for confirmation again.

Cursor history adds one trailing line ending to a recalled prompt. TokenLens
normalizes only that Cursor-added line ending for confirmation. User-authored
leading, trailing, or internal whitespace changes require a new estimate.

### Persistent cost line

Cursor renders `beforeSubmitPrompt.user_message` as a temporary notice and
clears it after about 30 seconds. Hooks cannot change that native timer.
TokenLens therefore stores the numeric pending cost alongside the prompt's
one-way fingerprint and renders this compact line through Cursor CLI's custom
status-line command:

```text
TokenLens $0.0072 pending · ↑ if needed + Enter: send · changed: recalculate
```

The line contains no prompt text. It remains until the unchanged prompt is
confirmed, a new estimate replaces it, the pending state expires, or TokenLens
is disabled. If `~/.cursor/cli-config.json` already contains a custom
`statusLine`, the installer preserves it and reports that the persistent line
was not installed; the normal detailed estimate notice still appears.

## Native Cursor plugin

The same implementation is also packaged as a native Cursor plugin. Add this
repository as a plugin marketplace from the published branch:

```sh
agent plugin marketplace add \
  https://github.com/S-kalakota/Cursor_Token_Price_Estimator.git \
  --git-ref cursor-cli-double-enter
```

Open Cursor's Customize page or use `/add-plugin` in Agent to install
`tokenlens-cursor-cli` after the marketplace has been indexed. For local plugin
development, `agent --plugin-dir ./cursor-cli` works when Cursor has enabled
local user plugins for the signed-in account. Use the user-level installer
above when that capability is unavailable or when you want the persistent
pending-cost status line.

## Controls

These phrases are intercepted by the hook and never reach the model:

| Type this | Effect |
| --- | --- |
| `tokenlens off` | Disable the gate. |
| `tokenlens on` | Enable the gate. |
| `tokenlens status` | Show current settings. |

Cursor's own slash commands, including `/model`, `/plan`, and `/compress`, are
always allowed without gating.

## What is estimated

TokenLens uses information Cursor supplies to `beforeSubmitPrompt`:

- the submitted prompt;
- the selected model name;
- the local conversation transcript path, when transcripts are enabled.

Cursor's transcript currently contains message content but not billing token
counts, so TokenLens approximates transcript and prompt tokens at four
characters per token. Existing context is priced at the cached-input rate, the
new prompt at the input rate, and an assumed reply at the output rate. Cursor
may make several model calls in one agent turn, so this is an estimate rather
than a quote.

The built-in prices include Cursor Auto plus Claude Opus, Sonnet, and Haiku
families. Unrecognized model names use the Auto fallback rate so a new model
never produces a zero-dollar estimate. Override the rates for other selected
models or account-specific pricing in the config file.

## Configuration

TokenLens creates `~/.cursor/tokenlens/config.json` on the first control change.
Defaults:

```json
{
  "enabled": true,
  "expectedOutputTokens": 1200,
  "thresholdUsd": 0,
  "pricing": {
    "auto":   { "input": 1.25, "output": 6,  "cachedInput": 0.25 },
    "opus":   { "input": 15,   "output": 75, "cachedInput": 1.5 },
    "sonnet": { "input": 3,    "output": 15, "cachedInput": 0.3 },
    "haiku":  { "input": 1,    "output": 5,  "cachedInput": 0.1 }
  }
}
```

- `thresholdUsd`: prompts below this estimate pass immediately.
- `expectedOutputTokens`: assumed output length used by the estimate.
- `pricing`: USD per million tokens. Update this as provider rates change.

Set `TOKENLENS_HOME` to relocate the config and pending-confirmation state.

## Privacy and failure behavior

- Prompt text is never written to disk. Pending confirmation stores only a
  SHA-256 fingerprint and numeric estimate scoped to the Cursor conversation.
- Transcript content is read locally only to approximate context length.
- The plugin makes no network calls of its own.
- Hook errors, malformed input, missing conversation IDs, unreadable
  transcripts, and state-write failures all fail open so TokenLens cannot lock
  a user out of Cursor.
- The plugin uses Cursor's native `{ "continue", "user_message" }` response
  schema and explicitly configures `failClosed: false`.

## Development

```sh
cd cursor-cli
npm test
```

The tests cover the decision flow, pricing, Cursor transcript shape, native
hook protocol, installer merge/uninstall behavior, privacy invariant, and
plugin manifests, including the persistent status-line lifecycle.
