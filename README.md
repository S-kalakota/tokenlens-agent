# TokenLens for Cursor

TokenLens shows one local cost estimate in Cursor's status bar while you type in
the native side-chat prompt box. Pressing **Enter** still submits normally on the
first press. TokenLens does not install a `beforeSubmitPrompt` hook or block a
prompt.

Current local target: Cursor 3.14.27 on Apple-silicon macOS.

## Install and use it

From a terminal in this repository, run:

```sh
npm install
npm run package:vsix
"/Applications/Cursor.app/Contents/Resources/app/bin/cursor" \
  --install-extension tokenlens-cursor-darwin-arm64.vsix --force
```

Then:

1. In Cursor, run **Developer: Reload Window** from the Command Palette.
2. Open the Command Palette with **Cmd+Shift+P**. Do not type the command into
   Agent chat.
3. Run **TokenLens: Enable Live Estimate** and accept the privacy explanation.
4. Grant Accessibility access if macOS asks. If it does not, run **TokenLens:
   Request Accessibility Permission**, then open **System Settings → Privacy &
   Security → Accessibility**.
5. Focus Cursor's native side-chat box and type. The bottom status-bar chip
   changes from **Start typing for estimate** to a value such as
   **Est. $0.01100**.
6. Press **Enter** once to send the prompt normally.

The chip is the only routine estimate display. Click it for enable, disable,
permission, and diagnostic actions. Run **TokenLens: Disable Live Estimate** to
stop the native helper immediately in every open Cursor window. The app-wide
setting is synchronized across Cursor extension hosts; use the commands rather
than editing the setting directly so Cursor shows the privacy explanation.

Normal use does not require Run, Debugging, F5, or an Extension Development
Host.

## What each chip state means

| Chip | Meaning |
| --- | --- |
| **Live estimate off** | Observation is disabled and no helper is running. |
| **Grant Accessibility** | macOS has not granted the required permission. |
| **Live estimate paused** | This Cursor window is not currently focused. |
| **Waiting for Cursor chat** | Cursor is focused, but its side-chat input is not. |
| **Start typing for estimate** | TokenLens found the chat box and its draft is empty. |
| **Est. $…** | A non-empty chat draft was counted locally. |
| **Live estimate unavailable** | The helper, platform, or current Cursor accessibility signature is unsupported. |

## How live detection works

Cursor's supported extension API does not publish native side-chat draft-change
events. TokenLens therefore bundles a small local macOS Accessibility helper.
The helper accepts a field only when all of these match:

- the frontmost app has Cursor's expected bundle ID;
- the focused element is an accessibility text area;
- it has Cursor's `aislash-editor-input` DOM class; and
- it is under Cursor's `composer-*` input ancestors.

Only after that metadata-only check succeeds does the helper read the field in
memory. It counts Unicode scalar values, discards the string, and writes only a
number to the extension over private process pipes. If Cursor changes this
signature, TokenLens fails closed and shows **Waiting for Cursor chat** or
**Live estimate unavailable** instead of reading another field.

## Estimate formula

```text
estimate = $0.001 + (Unicode character count × $0.00001)
approximate tokens = round up(Unicode character count ÷ 4)
```

| Prompt length | Displayed estimate |
| ---: | ---: |
| 100 characters | $0.00200 |
| 1,000 characters | $0.01100 |
| 10,000 characters | $0.10100 |

The result is deliberately simple and is not a provider quote or bill. Every
additional character increases the unrounded estimate.

## Privacy and failure behavior

- Live observation is off until explicitly enabled.
- The helper runs only on supported macOS and only while live estimation is on.
- Prompt text never crosses the helper pipe and is never logged, persisted,
  copied to the clipboard, sent through a socket, or sent over a network.
- Attachments, files, chat history, hidden context, and model responses are not
  inspected.
- TokenLens never sets accessibility values, performs accessibility actions,
  synthesizes keys, or intercepts Enter.
- Background Cursor windows tell their helper to pause.
- Enable and disable changes propagate to every already-open Cursor window.
- Permission denial, malformed helper output, or a helper crash cannot block a
  Cursor prompt.
- **TokenLens: Diagnose Live Draft Detection** prints only roles, DOM
  identifiers/classes, supported attribute names, and booleans—never `AXValue`.

macOS Accessibility permission is broad even though TokenLens intentionally
uses only this narrow behavior.

The local helper is ad-hoc signed. Reloading the same installed build preserves
permission on the tested machine, but a rebuilt helper has a different macOS
code identity and may require Accessibility permission to be granted again.

## Upgrade cleanup

Version 0.4.0 removes the older two-Enter gate. On activation it performs a
one-time, ownership-checked cleanup in each open workspace:

- removes only the exact TokenLens `beforeSubmitPrompt` entry;
- preserves unrelated hooks, JSONC comments, formatting, and file modes;
- deletes the old hook script only when its TokenLens ownership marker exists;
- deletes the old bridge registration only when its complete schema matches;
- refuses ambiguous or symlinked files instead of modifying them.

The packaged VSIX contains no Cursor hook or loopback prompt bridge.

## Development commands

```sh
npm run typecheck
npm run build
npm test
npm run validate
npm run package:vsix
```

`npm run build` compiles and ad-hoc signs the arm64 native helper before bundling
the TypeScript extension. `npm run package:vsix` verifies the helper
architecture, executable mode, signature, archive contents, and native
self-tests.

For source debugging only, open this folder in Cursor and choose **Run → Start
Debugging → Run TokenLens in Cursor**. Native helper changes require a full
`npm run build`; the TypeScript watcher does not rebuild Objective-C sources.
