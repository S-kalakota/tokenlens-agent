# TokenLens Cursor Plan

## Current product goal

Build one local estimate gate for Cursor side chat:

1. The user explicitly enables the gate for a workspace.
2. The user writes a side-chat prompt and presses Enter.
3. Cursor's supported `beforeSubmitPrompt` hook sends only that submitted prompt
   to the running TokenLens extension.
4. TokenLens calculates one length-based dollar estimate.
5. TokenLens returns `continue: false`, so the prompt pauses before the Agent
   runs.
6. Cursor tells the user the estimate and the status-bar chip shows the same
   value.
7. A second Enter sends the prompt if it is unchanged. Editing it requires a
   new estimate and then one more unchanged Enter.

The gate remains active until the user disables it. Disabling it restores
one-Enter prompt submission.

## Single supported estimate

TokenLens supports one output format:

```text
Est. $0.01100
```

The local calculation is:

```text
$0.001 + (Unicode character count × $0.00001)
```

Approximate tokens are reported as the character count divided by four and
rounded up. This approximation is descriptive only and is not used for billing.

Longer prompts must produce a higher unrounded estimate. TokenLens does not try
to match a particular model, provider, subscription, or API price.

## Removed scope

The current version does not support:

- Subscription and API modes.
- Configurable estimator endpoints.
- Mock response scenarios.
- Model selection or model detection.
- Budget thresholds.
- Clipboard, editor-selection, or Quick Input capture.
- Alternate usage, warning, error, or cost-range formats.
- Live estimation on each draft keystroke.
- Token billing, invoices, or provider-accurate pricing.

## Cursor constraint

Cursor's supported `beforeSubmitPrompt` hook runs after the user presses Enter
and before the backend request. It can stop the submission and show a user
message. Cursor does not expose a supported event for every live side-chat draft
change, so TokenLens estimates at Enter time rather than continuously while the
user types.

No internal DOM injection or private Cursor command is used.

## Privacy and security

- Gate activation requires an explicit per-workspace confirmation.
- The project hook forwards only prompt text and a conversation identifier.
- Attachments, files, hidden context, and chat history are excluded.
- The bridge binds only to `127.0.0.1` and requires a random per-session token.
- Prompt text is never persisted.
- The bridge registration file stores only connection metadata.
- Transport or extension failure must fail open so TokenLens never accidentally
  prevents the user from working.

## Implemented phases

### Phase 1: Single local estimator

- Deterministic length-based dollar estimate.
- One status-bar presentation.
- Longer-prompt monotonicity tests.

### Phase 2: Enter-to-estimate gate

- Project `beforeSubmitPrompt` hook.
- Managed hook installation into whichever trusted project is open.
- Authenticated loopback bridge.
- `continue: false` response while the estimate is shown only in the status-bar
  chip.
- Conversation-scoped in-memory fingerprint confirmation: first Enter
  estimates, second unchanged Enter sends.
- Per-workspace enable and disable commands.
- Fail-open behavior when the bridge is unavailable.

### Phase 3: Verification

- Unit tests for the formula and presentation.
- Integration tests covering hook → bridge → blocking response.
- Cross-project hook-install tests, including preservation of existing JSONC
  comments and hooks.
- Tests confirming prompts are not written to the registration file.
- TypeScript and production-bundle validation.

## Reference

- [Cursor Hooks documentation](https://cursor.com/docs/hooks)
