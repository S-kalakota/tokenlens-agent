import json
import subprocess
import sys
from pathlib import Path

import pytest

PLUGIN_ROOT = Path(__file__).resolve().parents[1] / "claude-code"
sys.path.insert(0, str(PLUGIN_ROOT))

from compatibility import (  # noqa: E402
    REQUIRED_CAPABILITIES,
    HostDescriptor,
    UnsupportedNativeHostError,
    evaluate_host,
    require_compatible,
)


class Provider:
    def __init__(self, descriptor: HostDescriptor) -> None:
        self.descriptor = descriptor

    def describe_host(self) -> HostDescriptor:
        return self.descriptor


def descriptor(
    capabilities: frozenset[str], api_revision: str | None = "composer-v1"
) -> HostDescriptor:
    return HostDescriptor(
        host_name="Fake Claude Host",
        host_version="1.0.0",
        adapter_name="fake-native",
        adapter_version="1.0.0",
        api_revision=api_revision,
        capabilities=capabilities,
    )


def test_all_six_capabilities_and_revision_are_required() -> None:
    report = require_compatible(Provider(descriptor(frozenset(REQUIRED_CAPABILITIES))))
    assert report.compatible is True
    assert report.missing == ()

    missing = frozenset(REQUIRED_CAPABILITIES[:-1])
    with pytest.raises(
        UnsupportedNativeHostError, match="release_into_current_session_once"
    ):
        require_compatible(Provider(descriptor(missing)))

    with pytest.raises(UnsupportedNativeHostError, match="no supported native"):
        require_compatible(
            Provider(descriptor(frozenset(REQUIRED_CAPABILITIES), api_revision=None))
        )


def test_unknown_capabilities_do_not_satisfy_contract() -> None:
    report = evaluate_host(descriptor(frozenset({"everything"})))
    assert report.compatible is False
    assert report.missing == REQUIRED_CAPABILITIES


def test_public_hook_probe_fails_directly_but_session_hook_is_non_blocking() -> None:
    direct = subprocess.run(
        [sys.executable, str(PLUGIN_ROOT / "compatibility.py"), "--json"],
        check=False,
        capture_output=True,
        text=True,
    )
    report = json.loads(direct.stdout)
    assert direct.returncode == 1
    assert report["compatible"] is False
    assert report["adapter_name"] == "public-plugin-hooks"
    assert report["missing"] == list(REQUIRED_CAPABILITIES)

    hook = subprocess.run(
        [sys.executable, str(PLUGIN_ROOT / "compatibility.py"), "--hook"],
        check=False,
        capture_output=True,
        text=True,
    )
    payload = json.loads(hook.stdout)
    assert hook.returncode == 0
    assert payload["continue"] is True
    assert "inactive" in payload["systemMessage"]


def test_plugin_manifest_enables_local_display_hook_without_duplicate_path() -> None:
    manifest = json.loads(
        (PLUGIN_ROOT / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8")
    )
    hooks = json.loads(
        (PLUGIN_ROOT / "hooks" / "hooks.json").read_text(encoding="utf-8")
    )
    assert manifest["name"] == "tokenlens-native"
    assert manifest["defaultEnabled"] is True
    # Claude automatically loads hooks/hooks.json. Explicitly listing the same
    # file in the manifest makes current Claude Code reject the whole plugin as
    # a duplicate, leaving prompts ungated.
    assert "hooks" not in manifest
    assert set(hooks["hooks"]) == {"SessionStart", "UserPromptSubmit"}
    command = hooks["hooks"]["SessionStart"][0]["hooks"][0]["command"]
    assert '"${CLAUDE_PLUGIN_ROOT}/compatibility.py"' in command
    prompt_command = hooks["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"]
    assert '"${CLAUDE_PLUGIN_ROOT}/prompt_hook.py"' in prompt_command
