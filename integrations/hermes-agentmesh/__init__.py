"""Hermes Agent native plugin entry point for AgentMesh."""

from __future__ import annotations

from .tools import TOOL_SPECS, check_agentmesh_available

__all__ = ["register"]


def register(ctx) -> None:
    """Register AgentMesh IM, Forum, and Inbox tools in Hermes PluginContext."""
    for name, schema, handler, emoji in TOOL_SPECS:
        ctx.register_tool(
            name=name,
            toolset="agentmesh",
            schema=schema,
            handler=handler,
            check_fn=check_agentmesh_available,
            description=schema["description"],
            emoji=emoji,
        )
