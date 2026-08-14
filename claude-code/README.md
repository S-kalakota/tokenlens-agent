# TokenLens native Claude Code bridge

This directory is an installable Claude Code plugin
skeleton for the native TokenLens workflow. It contains the state machine and
host boundary needed for:

```text
first Enter -> analyze -> Accept/Skip -> second Enter -> release once
```

## Current compatibility status

The public Claude Code plugin API in Claude Code 2.1.231 does not expose the
composer operations this workflow requires. In particular, a
`UserPromptSubmit` hook cannot preserve/replace the input buffer, render native
selectable controls, observe the next empty Enter, or release a replacement
into the current session. Consequently no hook, slash command, MCP tool, or
terminal wrapper implements the native workflow.

## Temporary supported mode: display-only suggestions

Set `TOKENLENS_NATIVE_HOOK_APPROXIMATION=1` in the repository `.env`, then
launch Claude Code with this development plugin:

```sh
claude --plugin-dir ./claude-code \
  --settings '{"enabledPlugins":{"tokenlens@tokenlens":false}}'
```

On the first Enter, the real TokenLens analysis runs and the hook blocks that
submission while displaying copyable suggestions. Public Claude Code erases the
blocked composer, so TokenLens cannot apply a selection. Press **Up**, then
**Enter** to send the original unchanged. To use a suggestion, paste or edit it
into the composer, press Enter to analyze that new text, then press Up + Enter
to send it. The settings argument disables only the separately installed legacy
`tokenlens@tokenlens` gate for this Claude process; it does not modify global
settings.

This compatibility mode is opt-in and intentionally does not pretend to meet
the native composer contract above. A hook timeout or host-level failure may be
fail-open in public Claude Code.

The SessionStart hook runs a compatibility report only. It never blocks a
prompt. `compatibility.py` rejects hook-only hosts until a supported native host
adapter supplies all six capabilities in `REQUIRED_CAPABILITIES`.

## Development checks

From `tokenlens-agent/`:

```sh
claude plugin validate ./claude-code
python3 claude-code/compatibility.py --json
python3 -m pytest -q tests/test_native_*.py
```

The compatibility command currently exits non-zero by design and prints the
missing capabilities. The tests use a fake host that implements the proposed
`NativeComposerPort`; this proves the safety/state contract without pretending
that the current public Claude Code binary implements that port.

Do not mistake this display-only mode for native composer integration. Once
Claude Code publishes a supported composer extension surface, implement one
version-pinned adapter, make its capability handshake pass, and run the
real-host acceptance suite before enabling the exact workflow.
