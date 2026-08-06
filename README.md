# TokenLens for Cursor

TokenLens is a deliberately small Cursor extension with one behavior: when its
estimate gate is enabled, pressing **Enter** in Cursor side chat stops the prompt
before the Agent runs and shows one local dollar estimate based on prompt
length.

There are no subscription/API modes, HTTP estimator endpoints, mock scenarios,
model settings, clipboard capture, selected-text capture, or alternate display
formats.

## What happens when you press Enter

1. Cursor calls the project `beforeSubmitPrompt` hook.
2. The hook passes only the submitted prompt to TokenLens over an authenticated
   `127.0.0.1` connection.
3. TokenLens calculates the estimate, updates the status-bar chip, and returns
   `continue: false` with an explanatory message.
4. Cursor stops the submission before the Agent runs and shows the estimate.

While the gate is enabled, every submitted prompt is blocked. Run **TokenLens:
Disable Enter-to-Estimate Gate** when you want prompts to run normally, then
submit the prompt again.

## Run and test it

1. In a terminal opened in this repository, run:

   ```sh
   npm install
   npm run validate
   ```

2. Open this entire folder in Cursor.
3. Choose **Run → Start Debugging → Run TokenLens in Cursor**. On a Mac where
   `F5` starts Dictation, use `fn+F5` or the menu.
4. Use the second window titled **Extension Development Host**.
5. Open **View → Command Palette…** in that second window. Do not type the
   command into the Agent chat.
6. Run **TokenLens: Enable Enter-to-Estimate Gate** and accept the warning that
   prompts will be stopped.
7. Type a prompt in Cursor side chat and press **Enter**.

Expected result:

- The Agent does not start.
- Cursor reports that TokenLens stopped the prompt.
- The message shows one value such as **Estimated cost: $0.01100**.
- The status-bar chip shows the same value.

If Cursor was already open when `.cursor/hooks.json` changed, run **Developer:
Reload Window** once in the Extension Development Host.

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
- Only the submitted prompt is forwarded. Attachments, files, chat history,
  hidden context, and live draft keystrokes are not read.
- Prompt text remains in memory and is not written to logs or disk.
- `.tokenlens/bridge.json` contains only a temporary port and random secret.
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
