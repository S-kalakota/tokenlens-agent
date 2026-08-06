# TokenLens for Cursor

TokenLens is a deliberately small Cursor extension with one behavior: when its
estimate gate is enabled, the first **Enter** in Cursor side chat pauses the
prompt before the Agent runs and shows one local dollar estimate based on prompt
length. A second **Enter** sends it if the prompt is unchanged.

There are no subscription/API modes, HTTP estimator endpoints, mock scenarios,
model settings, clipboard capture, selected-text capture, or alternate display
formats.

## What happens when you press Enter

1. Cursor calls the project `beforeSubmitPrompt` hook.
2. The hook passes only the submitted prompt to TokenLens over an authenticated
   `127.0.0.1` connection.
3. TokenLens calculates the estimate, updates the status-bar chip, and returns
   `continue: false` with an explanatory message.
4. Cursor pauses the submission before the Agent runs and shows the estimate.
5. Pressing Enter again on the unchanged prompt returns `continue: true`, so
   Cursor sends it normally.

If the prompt is edited after its estimate, the changed text is treated as a
new prompt: the next Enter recalculates and pauses it, and one more unchanged
Enter sends it. Run **TokenLens: Disable Enter-to-Estimate Gate** to bypass this
two-step workflow entirely.

## Install and use it in normal Cursor

This is the recommended workflow. It installs TokenLens locally; it does not
publish anything.

1. In a terminal opened in this repository, run:

   ```sh
   npm install
   npm run package:vsix
   "/Applications/Cursor.app/Contents/Resources/app/bin/cursor" \
     --install-extension tokenlens-cursor.vsix --force
   ```

2. In normal Cursor, open the project where you want estimates.
3. Press **Cmd+Shift+P** to open the Command Palette.
4. Run **TokenLens: Enable Enter-to-Estimate Gate** and confirm **Enable
   estimate gate**.
5. Wait for **TokenLens is ready** and check that the bottom status bar says
   **Enter → estimate**.
6. Type a prompt in Cursor side chat and press **Enter** to estimate it.
7. Press **Enter** again without editing to send it.

The Agent should not start after the first Enter. Cursor shows the estimate, and
the status-bar chip changes to the estimated amount. The Agent starts after the
second unchanged Enter. Run **TokenLens: Disable Enter-to-Estimate Gate** when
you want one-Enter prompt submission.

After installing a newly built VSIX while Cursor is already open, run
**Developer: Reload Window** once from the Command Palette.

## Developer-only debugging workflow

Use this only while changing TokenLens source code. Normal use does not require
Run or Debugging.

1. In a terminal opened in this repository, run:

   ```sh
   npm install
   npm run validate
   ```

2. Open this entire folder in Cursor.
3. Choose **Run → Start Debugging → Run TokenLens in Cursor**. On a Mac where
   `F5` starts Dictation, use `fn+F5` or the menu.
4. Use the second window titled **Extension Development Host**.
5. Keep this repository open, or open a different project you want to test.
6. Open **View → Command Palette…** in that second window. Do not type the
   command into the Agent chat.
7. Run **TokenLens: Enable Enter-to-Estimate Gate** and accept the warning that
   prompts will be stopped.
8. Wait for the **TokenLens is ready** message, then type a prompt in Cursor
   side chat and press **Enter** to estimate it. Press **Enter** again without
   editing to send it.

Expected result:

- The Agent does not start after the first Enter.
- Cursor reports that TokenLens paused the prompt.
- The message shows one value such as **Estimated cost: $0.01100**.
- The status-bar chip shows the same value.
- The second unchanged Enter sends the prompt and starts the Agent.

When you enable the gate, TokenLens safely merges its managed
`beforeSubmitPrompt` entry into the project’s `.cursor/hooks.json` and copies
its forwarding script into `.cursor/hooks/`. It preserves other valid hooks and
JSON comments. This is what makes the gate work in a project other than the
TokenLens source repository.

After rebuilding TokenLens itself, run **Developer: Reload Window** once in the
Extension Development Host so that window loads the new extension bundle.

## Estimate formula

The estimate is intentionally simple and deterministic:

```text
estimate = $0.001 + (number of prompt characters × $0.00001)
approximate tokens = round up(number of characters ÷ 4)
```

Examples:

| Prompt length | Displayed estimate |
| ---: | ---: |
| 100 characters | $0.00200 |
| 1,000 characters | $0.01100 |
| 10,000 characters | $0.10100 |

The value is not a provider quote or bill. Its purpose is to make the behavior
easy to test: a longer prompt always produces a larger unrounded estimate.

## Privacy and failure behavior

- Enabling the gate requires explicit consent for that workspace.
- Only the submitted prompt and Cursor's conversation identifier are forwarded.
  Attachments, files, chat history, hidden context, and live draft keystrokes
  are not read.
- Prompt text remains in memory and is not written to logs or disk.
- Pending confirmation stores only an in-memory SHA-256 prompt fingerprint, not
  the prompt text, and is cleared after the unchanged prompt is allowed.
- `.tokenlens/bridge.json` contains only a temporary port and random secret.
- The managed `.cursor` hook stays in the project after disabling the gate, but
  it immediately allows prompts through whenever the private bridge is absent.
- If the extension or bridge is unavailable, the hook fails open and Cursor
  allows the prompt to continue normally.

Cursor exposes submitted prompts after **Enter**, not live per-keystroke draft
changes. TokenLens therefore estimates at submission time.

## Development commands

```sh
npm run typecheck
npm test
npm run build
npm run validate
npm run watch
```
