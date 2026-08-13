"""Invoke the compiled TokenLens graph directly, bypassing MCP."""

import argparse

from agent.graph import build_graph, invocation_config
from agent.state import AgentState


def run(prompt: str, session_id: str) -> AgentState:
    graph = build_graph()
    initial_state: AgentState = {"prompt": prompt, "session_id": session_id}
    return graph.invoke(initial_state, invocation_config(session_id))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("prompt")
    parser.add_argument("--session-id", default="local-session")
    args = parser.parse_args()
    print(run(args.prompt, args.session_id))


if __name__ == "__main__":
    main()
