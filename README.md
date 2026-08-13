# TokenLens

Estimate what a prompt costs before you send it.

- **Cursor** — the VS Code extension at the root of this repository, documented below.
- **Claude Code** — a plugin in [`claude-code/`](./claude-code), with its own
  [README](./claude-code/README.md). Same idea, ported to Claude Code's
  `UserPromptSubmit` hook, and it prices the context the turn re-sends rather
  than the prompt alone.
- **Cursor CLI** — a native Cursor plugin in [`cursor-cli/`](./cursor-cli), with
  its own [README](./cursor-cli/README.md). It uses `beforeSubmitPrompt` to
  estimate and pause a prompt before any model request, then sends the unchanged
  recalled prompt on confirmation. A direct user-hook installer is included for
  accounts where local plugin loading is unavailable; it also keeps the pending
  cost visible in Cursor CLI's custom status line until the user decides.

---

## TokenLens for Cursor

TokenLens is a small Cursor/VS Code extension that sends prompt text to a
configurable estimator and renders its display-ready usage or cost estimate in
one right-aligned status-bar chip. This repository implements **Phases 1–4** of
[TokenLens_Cursor_Plan.md](./TokenLens_Cursor_Plan.md): the extension shell,
validated endpoint client, explicit prompt capture, and subscription/API modes.

The default estimator is an in-process mock with fixed fixtures. TokenLens does
not count tokens, calculate prices, inspect Cursor Composer, or detect the model
currently selected in Cursor.

## Run it locally in Cursor

You do not need to publish or install TokenLens from a marketplace. Run it in a
separate Cursor Extension Development Host:

1. Open a terminal in this directory and install and validate the project:

   ```sh
   npm install
   npm run validate
   ```

2. Open this entire folder in the Cursor desktop application.
3. From the macOS menu bar, choose **Run → Start Debugging**, then select
   **Run TokenLens in Cursor** if prompted. You can instead press `fn+F5` on a
   Mac where plain `F5` starts Dictation.
4. Cursor opens a second window titled **Extension Development Host**. Use this
   second window to test TokenLens.
5. Find **No estimate** on the right side of its status bar. Click it to open
   the TokenLens actions, or run one of the capture commands below.

To launch through the Command Palette, first click an editor tab, then choose
**View → Command Palette…** and run **Debug: Start Debugging**. Enter commands in
the small palette at the top of the window, not in Cursor's Agent chat.

For a faster edit loop, run `npm run watch` in the original window, then run
**Developer: Reload Window** in the Extension Development Host after changes.

If the chip is missing, confirm that you are looking in the Extension
Development Host and that **View → Appearance → Status Bar** is enabled.

## Capture a prompt

TokenLens captures text only when you invoke an explicit command:

| Workflow | Command | macOS default | Windows/Linux default |
| --- | --- | --- | --- |
| Clipboard | **TokenLens: Estimate Clipboard Prompt** | `Cmd+Alt+E` | `Ctrl+Alt+E` |
| Editor selection | **TokenLens: Estimate Selected Text** | `Cmd+Alt+Shift+E` | `Ctrl+Alt+Shift+E` |
| Temporary input | **TokenLens: Estimate Prompt with Quick Input** | `Cmd+Ctrl+I` | `Ctrl+Alt+I` |

- **Clipboard** reads the clipboard only after that command is invoked.
- **Selected Text** uses the current non-empty selection in the active editor.
- **Quick Input** lets you type or paste into a temporary input at the top of
  the window. Canceling submits nothing.

Open **Preferences: Open Keyboard Shortcuts**, search for `TokenLens`, and edit
or remove any default shortcut. The commands are also available from
**View → Command Palette…** and from the status-bar chip's action menu.

**TokenLens: Preview Estimate** remains available for UI testing. It sends only
a fixed synthetic development prompt, never clipboard, selected, or Quick Input
text.

## Privacy confirmation

When `tokenlens.estimatorMode` is `endpoint`, every captured-prompt request
opens a modal confirmation before transmission. The confirmation identifies the
configured endpoint origin; choose **Send prompt** to continue or cancel to
transmit nothing. This confirmation is shown for every capture, not just the
first one.

When the mode is `mock`, capture stays inside the extension process and no
network confirmation is needed. In either mode, prompt text is held only in
memory for the active request and the transient reference is cleared after the
request completes. TokenLens does not persist prompt history, write prompt text
to logs, or send it to analytics.

TokenLens cannot automatically read a Cursor Agent/Composer draft. It does not
inspect unrelated files or send hidden Cursor context; only the text explicitly
provided through one of the workflows above is used.

The estimator mode, endpoint, model, and access mode are machine-scoped
settings, so an untrusted workspace cannot silently replace the destination or
request metadata for captured prompt text.

## Subscription and API modes

`tokenlens.accessMode` is a user-declared setting passed unchanged to the
estimator:

- `subscription` asks for a relative usage-impact response, such as
  **Usage: Low**. It is not presented as a per-prompt charge.
- `api` asks for a metered API-cost response, such as
  **Est. $0.02–$0.06**. It remains a predicted range, not a final bill.

All estimate values and estimate-specific disclaimers come from the selected
estimator. The hover card renders those strings and separately reminds you that
`tokenlens.model` is configured in TokenLens, not detected from Cursor. If you
change Cursor's model, update this setting yourself.

For local testing, the default `auto` mock scenario follows the configured
access mode. Click the chip and choose **Select access mode** to switch between
subscription and API behavior.

## Exercise the UI states

Click the chip and choose **Select mock scenario**:

| Scenario | Expected chip |
| --- | --- |
| Auto + subscription | `$(circle-filled) Usage: Low` |
| API ready | `$(circle-filled) Est. $0.02–$0.06` |
| Subscription ready | `$(circle-filled) Usage: Low` |
| Over budget | `$(warning) ...` |
| Unavailable | `$(error) Estimate unavailable` |
| Malformed | `$(error) Estimate unavailable` |

Set `tokenlens.mockDelayMs` to `5000` to make loading and cancellation easy to
inspect. Hover over every result to verify its endpoint-provided title, summary,
and disclaimer plus TokenLens's configured-model disclosure.

## Switch to an HTTP endpoint

Open **TokenLens settings** from the chip and configure, for example:

```json
{
  "tokenlens.estimatorMode": "endpoint",
  "tokenlens.endpoint": "http://localhost:8787/v1/estimates",
  "tokenlens.model": "claude-sonnet-4",
  "tokenlens.accessMode": "api"
}
```

Invoke a capture command, review the per-request privacy confirmation, and
choose **Send prompt**. Switching between `mock` and `endpoint`, or between
`subscription` and `api`, requires no rebuild or restart.

The HTTP client validates URLs and responses, refuses redirects, limits response
size, enforces a timeout, and supports cancellation. Remote endpoints must use
HTTPS; plain HTTP is accepted only for loopback development addresses such as
`localhost`. TokenLens never logs a request, response body, or prompt and has no
endpoint authentication yet.

## Development commands

```sh
npm run typecheck   # TypeScript checks for source and tests
npm test            # Unit tests
npm run build       # Bundle dist/extension.js
npm run validate    # Run all three checks
npm run watch       # Rebuild when source changes
```

## Implemented architecture

```text
Cursor extension
├── explicit prompt capture
│   ├── clipboard command
│   ├── active-editor selection
│   └── temporary Quick Input
├── per-request endpoint privacy confirmation
├── status-bar controller + safe Markdown tooltip
├── in-memory estimate session (cancel + latest request wins)
├── request/response schemas with runtime validation
├── estimator client interface
│   ├── deterministic local mock
│   └── configurable HTTP endpoint
└── Cursor settings + compact Quick Pick actions
```

The extension passes the configured model and access mode to the estimator and
renders its response. Estimation, pricing, and machine-learning logic remain
outside this repository.
