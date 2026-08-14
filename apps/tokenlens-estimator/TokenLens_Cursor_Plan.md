# TokenLens for Cursor

## Product Goal

Build a lightweight Cursor extension that shows a small cost or usage estimate beside the user's AI coding workflow. The primary target will be Claude Sonnet 4-family models.

The user-facing element should remain compact:

```text
● Est. $0.02–$0.06
```

Hovering over the chip should display additional information without opening a large permanent panel.

TokenLens will be the application that users interact with. It will **not** implement the estimation logic, machine-learning model, token prediction, or cost calculations. All estimate generation will be handled by a separate endpoint that can initially return mock data and later connect to a machine-learning estimator.

## Product Scope

This project includes:

- A Cursor-compatible extension.
- A compact estimate chip.
- A hover card with additional information.
- Commands for providing a prompt to TokenLens.
- Settings for selecting the Claude model and access type.
- A client that sends estimation requests to a configurable endpoint.
- UI states for loading, success, warning, unavailable, and error responses.
- A mock endpoint adapter for development.
- Local privacy controls and safe handling of prompt text.

This project does **not** include:

- Training or evaluating a machine-learning model.
- Creating an estimation algorithm.
- Counting tokens inside the extension.
- Calculating token prices inside the extension.
- Comparing predicted estimates against actual usage.
- Measuring estimator accuracy.
- Building billing or invoice reconciliation.
- Scraping or modifying Cursor's internal Composer interface.
- Detecting which model Cursor is currently using. The model field is a user-declared setting, not a detected one.

## Target User Experience

1. The user writes a prompt for Cursor Agent or Composer.
2. The user explicitly provides the prompt to TokenLens through a supported capture method.
3. TokenLens sends the prompt and configured metadata to the estimator endpoint.
4. The endpoint returns a display-ready estimate.
5. TokenLens displays the estimate in a small chip.
6. Hovering over the chip reveals the details returned by the endpoint.
7. Clicking the chip opens compact settings or actions when needed.

Example chip:

```text
● Est. $0.02–$0.06
```

Example hover content:

```text
Claude Sonnet 4 · Estimated API cost

Estimated range: $0.02–$0.06
Access: Token-based API
Estimate status: Ready

This is a predicted range, not a final bill.
Model reflects your TokenLens setting, not a detected value.
```

The estimate content in the hover (numbers, cost or usage language, and disclaimers about the estimate itself) should come from the estimator endpoint rather than being independently calculated by the Cursor extension. The model-source note described in "Model Value Is Self-Declared, Not Detected" is the one exception: it is always rendered by the extension itself, since only the extension knows whether that value was configured or detected.

## Important Cursor Constraint

Cursor supports standard VS Code extension surfaces such as status-bar items, commands, settings, Webviews, Quick Pick, and MCP integrations. Cursor currently does not expose a supported public API that allows a third-party extension to:

- Read the live draft inside Cursor Agent or Composer.
- Add a custom component directly inside the Composer input box.
- Add a custom control to the Composer toolbar.
- Inspect Cursor's complete hidden model request.
- Retrieve Cursor's exact internal token usage or billing calculation before submission.

Therefore, the first supported version cannot place the chip directly beside the Composer submit button as shown in the concept mockup. The closest durable implementation is a compact right-aligned status-bar chip with a hover tooltip.

One consequence of the missing model-request visibility: TokenLens cannot confirm which model Cursor is actually using for a given prompt. The `tokenlens.model` setting described in "Claude Sonnet 4 Model Focus" is a user-declared value, not a detected one, and the application must treat it that way rather than implying it has been verified.

The extension can receive prompts through copied text, selected text, or an optional TokenLens input. Unsupported DOM injection should not be used because Cursor interface changes could break it without warning.

## Recommended Cursor MVP

### Compact Chip

Create one right-aligned Cursor status-bar item:

```text
$(circle-filled) Est. $0.02–$0.06
```

The chip should:

- Occupy only one compact status-bar item.
- Use Cursor's active theme.
- Display the endpoint's short estimate label.
- Show a richer Markdown tooltip on hover.
- Always include an extension-rendered note in the tooltip stating that the model field is a user setting, not detected from Cursor's active session. This note is independent of whatever the endpoint returns.
- Show a loading state while waiting for the endpoint.
- Show a neutral unavailable state when no estimate exists.
- Show a warning icon when the endpoint marks an estimate as over budget.
- Open compact actions or settings when clicked.

Suggested states:

| State | Example chip |
| --- | --- |
| No estimate | `$(circle-outline) No estimate` |
| Loading | `$(loading~spin) Estimating…` |
| Ready | `$(circle-filled) Est. $0.02–$0.06` |
| Subscription | `$(circle-filled) Usage: Low` |
| Over budget | `$(warning) Est. $0.18–$0.25` |
| Endpoint unavailable | `$(error) Estimate unavailable` |

### Prompt Capture

Provide these supported capture methods:

1. **Clipboard command:** `TokenLens: Estimate Clipboard Prompt`
2. **Selected-text command:** `TokenLens: Estimate Selected Text`
3. **Keyboard shortcut:** invoke one of the estimate commands quickly.
4. **Optional Quick Input:** type or paste a prompt into a temporary TokenLens input.

The clipboard should only be read after an explicit user action. Prompt text should remain in memory only long enough to send the request and render the response unless the user opts into history.

## Claude Sonnet 4 Model Focus

The initial product should be designed around Claude Sonnet 4-family models. The exact model identifier must remain configurable so the application does not depend on one hard-coded model version.

Example settings:

```json
{
  "tokenlens.provider": "anthropic",
  "tokenlens.model": "claude-sonnet-4",
  "tokenlens.accessMode": "subscription",
  "tokenlens.endpoint": "http://localhost:8787/v1/estimates"
}
```

The extension will pass the selected model identifier to the endpoint. It will not maintain model-specific tokenizer or pricing logic.

### Model Value Is Self-Declared, Not Detected

Because Cursor does not expose Composer's internal model request (see "Important Cursor Constraint"), TokenLens cannot confirm that `tokenlens.model` matches the model actually active in the user's session. The extension must treat this field as unverified input, not a detected fact, and the UI must communicate that clearly rather than implying the estimate is tied to a confirmed model.

To reduce silent mismatches:

- The hover tooltip always includes a short, extension-rendered note that the model reflects the configured setting, not a detected value.
- The status-bar tooltip and Quick Pick settings surface the current `tokenlens.model` value so it stays visible and easy to correct.
- Switching the active model inside Cursor does not automatically update `tokenlens.model`. Users are responsible for updating the setting when they change models.

## Subscription Versus Token API Cost

TokenLens must distinguish between two user experiences.

### Subscription Mode

Subscription users generally do not pay a direct per-token bill for each prompt. In this mode, the endpoint may return a usage-impact estimate instead of a dollar estimate.

Examples:

```text
Usage: Low
```

```text
Estimated subscription impact: Medium
```

The hover should clearly state:

```text
This estimates relative usage under a subscription plan. It is not a per-prompt charge.
```

### Token-Based API Mode

Users accessing Claude through a metered API may receive a dollar-denominated estimate.

Example:

```text
Est. $0.02–$0.06
```

The hover should clearly state:

```text
This is an estimated API cost range. The provider's final usage record controls the actual charge.
```

### Application Responsibility

The Cursor extension does not decide how subscription usage or API cost is calculated. It only sends the selected access mode and renders the response returned by the endpoint. It also does not verify that the selected model or access mode matches what the user is actually running in Cursor; both are self-declared settings the user is responsible for keeping current.

## System Architecture

```text
Cursor Extension
├── Prompt Capture
│   ├── Clipboard command
│   ├── Selected-text command
│   └── Optional Quick Input
├── Estimate API Client
│   ├── Request validation
│   ├── Timeout handling
│   ├── Response parsing
│   └── Error handling
├── Cursor UI
│   ├── Status-bar chip
│   ├── Markdown hover tooltip
│   ├── Quick Pick actions
│   └── Settings
└── Local State
    ├── Selected model
    ├── Subscription/API mode
    ├── Endpoint URL
    └── Optional budget threshold

Estimator Endpoint
├── Mock response during application development
└── Future machine-learning estimator behind the same contract
```

The application should depend only on the endpoint contract. Replacing the mock endpoint with a machine-learning service later should not require significant Cursor extension changes.

## Estimator Endpoint Placeholder

### Endpoint

```http
POST /v1/estimates
Content-Type: application/json
```

### Example Request

```json
{
  "prompt": "Refactor the login flow and add tests.",
  "provider": "anthropic",
  "model": "claude-sonnet-4",
  "accessMode": "api",
  "client": {
    "name": "tokenlens-cursor",
    "version": "0.1.0"
  },
  "preferences": {
    "currency": "USD",
    "budgetThreshold": 0.10
  }
}
```

Only fields known to the extension should be sent. The extension should not invent hidden Cursor context or claim that it has captured Cursor's complete model request.

### Example API-Mode Response

```json
{
  "estimateId": "est_123",
  "status": "ready",
  "provider": "anthropic",
  "model": "claude-sonnet-4",
  "accessMode": "api",
  "display": {
    "chipText": "Est. $0.02–$0.06",
    "title": "Claude Sonnet 4 · Estimated API cost",
    "summary": "Estimated range: $0.02–$0.06",
    "disclaimer": "This is a predicted range, not a final bill."
  },
  "budget": {
    "isOverThreshold": false
  },
  "metadata": {
    "estimatorVersion": "placeholder-v1",
    "generatedAt": "2026-08-05T00:00:00Z"
  }
}
```

### Example Subscription-Mode Response

```json
{
  "estimateId": "est_124",
  "status": "ready",
  "provider": "anthropic",
  "model": "claude-sonnet-4",
  "accessMode": "subscription",
  "display": {
    "chipText": "Usage: Low",
    "title": "Claude Sonnet 4 · Subscription usage",
    "summary": "Estimated subscription impact: Low",
    "disclaimer": "This is a relative usage estimate, not a per-prompt charge."
  },
  "budget": {
    "isOverThreshold": false
  },
  "metadata": {
    "estimatorVersion": "placeholder-v1",
    "generatedAt": "2026-08-05T00:00:00Z"
  }
}
```

### Error Response

```json
{
  "status": "error",
  "error": {
    "code": "ESTIMATOR_UNAVAILABLE",
    "message": "An estimate is temporarily unavailable."
  }
}
```

The endpoint should return display-ready strings so the application does not need to reproduce estimation or pricing rules.

## Development Mock

During application development, use a mock adapter or local mock endpoint that returns fixed fixture responses. The mock exists only to exercise the user interface and API integration.

The mock should support:

- A successful API-mode response.
- A successful subscription-mode response.
- A loading delay.
- An over-budget response.
- An unavailable response.
- A malformed response for parser testing.

The mock should not contain real estimation calculations or machine-learning logic.

## Suggested Technology Stack

- **Language:** TypeScript
- **Extension framework:** VS Code Extension API, tested specifically in Cursor
- **UI:** `vscode.window.createStatusBarItem()` with a `MarkdownString` tooltip
- **Input:** Clipboard, selected editor text, and optional Quick Input
- **API client:** Native `fetch` or a small HTTP wrapper with timeouts
- **Validation:** Zod or JSON Schema for endpoint responses
- **Settings:** VS Code configuration contributions
- **State:** `globalState` and `workspaceState` for non-sensitive preferences
- **Secrets:** VS Code SecretStorage only if authentication is added later
- **Testing:** Vitest or Jest for application logic and a compatible extension test runner for Cursor/VS Code behavior
- **Distribution:** Local `.vsix` first

## Implementation Phases

### Phase 0: Cursor Feasibility Spike

Timebox: 1–2 days.

- Scaffold a minimal TypeScript extension.
- Install it into the current Cursor version using a `.vsix`.
- Verify status-bar text, hover tooltips, commands, settings, Quick Input, and clipboard behavior.
- Confirm that no documented Composer contribution point is available.
- Avoid production dependencies on undocumented Cursor commands or internal DOM elements.

Exit condition: the supported UI and prompt-capture methods work in the target Cursor version.

### Phase 1: Extension Shell

- Create the extension activation and deactivation lifecycle.
- Register the TokenLens commands.
- Register the right-aligned status-bar item.
- Add settings for endpoint, model, access mode, and optional budget threshold.
- Add loading, ready, warning, and unavailable UI states.

Exit condition: the extension renders and responds to commands using local fixture data.

### Phase 2: Endpoint Contract and Client

- Define TypeScript request and response types.
- Add runtime validation for responses.
- Build the estimator endpoint client.
- Add request cancellation and timeout handling.
- Add a mock adapter for local development.
- Keep endpoint and mock implementations behind the same interface.

Exit condition: the UI can switch between mock data and a configured endpoint without code changes.

### Phase 3: Prompt Capture

- Implement the clipboard estimation command.
- Implement the selected-text estimation command.
- Add an optional Quick Input workflow.
- Add configurable keyboard shortcuts.
- Clear transient prompt data after the request completes.

Exit condition: a user can submit prompt text to the endpoint through one explicit action.

### Phase 4: Subscription and API Modes

- Add a setting for `subscription` or `api` access.
- Pass the selected access mode to the endpoint.
- Render subscription-language responses without presenting them as charges.
- Render token API responses as estimated cost ranges.
- Display endpoint-provided disclaimers in the hover card.

Exit condition: users can clearly distinguish subscription impact from metered API cost.

### Phase 5: UI Polish

- Match Cursor's active light or dark theme.
- Keep the chip compact.
- Add accessible labels and keyboard navigation.
- Add click actions for re-estimate, model selection, and access-mode selection.
- Avoid opening a full Webview unless the user requests detailed settings.

Exit condition: the chip remains useful without distracting from coding.

### Phase 6: Packaging and Release

- Add onboarding for endpoint, Claude model, and access mode.
- Add privacy documentation.
- Package the extension as a `.vsix`.
- Test on supported Cursor versions and operating systems.
- Document the limitation around Cursor Composer access.
- Decide on marketplace distribution after local compatibility testing.

Exit condition: a new user can install the extension, configure an endpoint, and request an estimate without editing source files.

## Privacy and Security Requirements

- Process prompt text locally until it is sent to the configured endpoint.
- Clearly inform users that the prompt will be sent to that endpoint.
- Do not transmit prompts to analytics services.
- Do not store clipboard contents or prompts in logs.
- Do not request Cursor credentials.
- Do not inspect unrelated project files.
- Require an explicit action before reading the clipboard.
- Allow users to disable prompt history completely.
- Use secure secret storage if endpoint authentication is added later.
- Redact prompt content from error reporting.

## Application Testing Plan

Testing in this project should verify the application, not the quality of the future estimator.

### Client Contract Tests

- Correct request fields are sent.
- Subscription and API access modes serialize correctly.
- Valid responses are parsed.
- Invalid responses produce a safe unavailable state.
- Timeouts and cancellations do not freeze Cursor.
- Endpoint errors do not expose prompt text.

### Cursor UI Tests

- Status-bar chip renders and updates.
- Hover displays endpoint-provided content.
- Loading, ready, warning, and error states render correctly.
- Clipboard and selected-text commands work.
- Settings update the next request.
- Light and dark themes remain readable.
- Keyboard and screen-reader labels are available.

### Privacy Tests

- Prompt text is not written to logs.
- Prompt text is not persisted by default.
- Clipboard access occurs only after an explicit command.
- Errors and telemetry contain no prompt contents.

There will be no estimator-accuracy evaluation, token-calculation tests, or machine-learning tests in this application project.

## MVP Acceptance Criteria

- The extension installs and runs inside Cursor.
- The application defaults to a configurable Claude Sonnet 4-family model.
- The chip occupies one compact status-bar item.
- Hovering displays the endpoint-provided title, summary, disclaimer, and status.
- The hover tooltip always discloses, independent of the endpoint response, that the model field is a user setting and not detected from Cursor's active session.
- Users can provide clipboard or selected prompt text through one command or shortcut.
- The extension supports both subscription and token-based API modes.
- Subscription estimates are not presented as direct charges.
- API estimates are clearly labeled as predicted ranges.
- All estimate values come from the endpoint or mock fixture.
- The extension contains no machine-learning or estimation calculations.
- Prompt text is not stored or transmitted anywhere except the configured endpoint.
- No undocumented Cursor DOM injection is required.

## Future Machine-Learning Integration

The future machine-learning estimator will sit behind `POST /v1/estimates`. That project may later determine how estimates are produced, trained, evaluated, and updated. None of that work belongs in the Cursor extension.

When the estimator is ready:

1. Deploy it behind the existing endpoint contract.
2. Point TokenLens at the deployed endpoint.
3. Preserve the existing request and response fields where possible.
4. Add new optional response fields without requiring the extension to understand the internal model.

The Cursor application should continue treating the estimator as an external black box.

## Future Cursor Composer Integration

If Cursor releases a public Composer extension API, TokenLens can later:

1. Subscribe to Composer draft changes.
2. Send debounced requests to the estimator endpoint.
3. Place the compact chip beside the Composer submit control.
4. Refresh when the selected Claude model or mode changes.
5. Reuse the existing endpoint client and response-rendering UI.

## Relevant References

- [Cursor community discussion about programmatically interacting with Cursor Chat](https://forum.cursor.com/t/develop-an-extension-to-send-prompt-to-cursor-chat/81342)
- [Cursor MCP documentation](https://docs.cursor.com/context/model-context-protocol)
- [VS Code Status Bar UX guidance](https://code.visualstudio.com/api/ux-guidelines/status-bar)
- [VS Code `StatusBarItem` API](https://code.visualstudio.com/api/references/vscode-api)
- [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview)
