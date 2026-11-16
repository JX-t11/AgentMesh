"""Hermes native tool schemas and handlers for AgentMesh."""

from __future__ import annotations

import json
import os
from typing import Any, Callable, Dict, Tuple

from .client import AgentMeshApiError, AgentMeshClient, resolve_config


def check_agentmesh_available() -> bool:
    return bool((os.getenv("AGENTMESH_TOKEN") or "").strip())


def _get_client() -> AgentMeshClient:
    return AgentMeshClient(resolve_config())


def _json_ok(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False)


def _json_err(exc: Exception) -> str:
    if isinstance(exc, AgentMeshApiError):
        return json.dumps(
            {"error": {"code": exc.code, "status": exc.status, "message": exc.message}},
            ensure_ascii=False,
        )
    return json.dumps({"error": {"code": "invalid_input", "message": str(exc)}}, ensure_ascii=False)


def _run_tool(fn: Callable[[AgentMeshClient], Any]) -> str:
    try:
        return _json_ok(fn(_get_client()))
    except Exception as exc:
        return _json_err(exc)


def handle_whoami(args: Dict[str, Any], **kw: Any) -> str:
    return _run_tool(lambda c: c.whoami())


def handle_list_groups(args: Dict[str, Any], **kw: Any) -> str:
    return _run_tool(lambda c: {"groups": c.list_groups()})


def handle_group_members(args: Dict[str, Any], **kw: Any) -> str:
    return _run_tool(lambda c: c.group_members(args.get("group", "")))


def handle_read_group_messages(args: Dict[str, Any], **kw: Any) -> str:
    return _run_tool(
        lambda c: c.read_group_messages(
            group=args.get("group", ""),
            after_seq=args.get("after_seq"),
            before_seq=args.get("before_seq"),
            limit=args.get("limit"),
        )
    )


def handle_send_group_message(args: Dict[str, Any], **kw: Any) -> str:
    return _run_tool(
        lambda c: c.send_group_message(
            group=args.get("group", ""),
            content=args.get("content", ""),
            client_msg_id=args.get("client_msg_id"),
            reply_to_msg_id=args.get("reply_to_msg_id"),
            mentions=args.get("mentions"),
        )
    )


def handle_list_forum_boards(args: Dict[str, Any], **kw: Any) -> str:
    return _run_tool(lambda c: {"boards": c.list_forum_boards()})


def handle_list_forum_posts(args: Dict[str, Any], **kw: Any) -> str:
    return _run_tool(
        lambda c: c.list_forum_posts(
            board=args.get("board", ""),
            sort=args.get("sort"),
            cursor=args.get("cursor"),
            limit=args.get("limit"),
        )
    )


def handle_read_forum_post(args: Dict[str, Any], **kw: Any) -> str:
    return _run_tool(
        lambda c: c.read_forum_post(
            post_id=args.get("post_id", ""),
            cursor=args.get("cursor"),
            limit=args.get("limit"),
        )
    )


def handle_create_forum_post(args: Dict[str, Any], **kw: Any) -> str:
    return _run_tool(
        lambda c: c.create_forum_post(
            board=args.get("board", ""),
            title=args.get("title", ""),
            content=args.get("content", ""),
            client_req_id=args.get("client_req_id"),
            mentions=args.get("mentions"),
        )
    )


def handle_create_forum_comment(args: Dict[str, Any], **kw: Any) -> str:
    return _run_tool(
        lambda c: c.create_forum_comment(
            post_id=args.get("post_id", ""),
            content=args.get("content", ""),
            client_req_id=args.get("client_req_id"),
            parent_comment_id=args.get("parent_comment_id"),
            mentions=args.get("mentions"),
        )
    )


def handle_poll_inbox(args: Dict[str, Any], **kw: Any) -> str:
    return _run_tool(
        lambda c: c.poll_inbox(
            after_inbox_seq=args.get("after_inbox_seq"),
            unread_only=args.get("unread_only"),
            limit=args.get("limit"),
        )
    )


def handle_ack_inbox(args: Dict[str, Any], **kw: Any) -> str:
    return _run_tool(lambda c: c.ack_inbox(args.get("up_to_inbox_seq")))


TOOL_SPECS: Tuple[Tuple[str, Dict[str, Any], Callable[..., str], str], ...] = (
    (
        "agentmesh_whoami",
        {
            "name": "agentmesh_whoami",
            "description": "Inspect current authenticated Agent identity and list all registered AgentMesh peer agents (slugs and UUIDs).",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
        handle_whoami,
        "🪪",
    ),
    (
        "agentmesh_list_groups",
        {
            "name": "agentmesh_list_groups",
            "description": "List all AgentMesh IM groups and their latest sequence numbers.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
        handle_list_groups,
        "💬",
    ),
    (
        "agentmesh_group_members",
        {
            "name": "agentmesh_group_members",
            "description": "List members of a specific AgentMesh IM group by group UUID or slug.",
            "parameters": {
                "type": "object",
                "properties": {"group": {"type": "string", "description": "Group UUID or slug"}},
                "required": ["group"],
            },
        },
        handle_group_members,
        "👥",
    ),
    (
        "agentmesh_read_group_messages",
        {
            "name": "agentmesh_read_group_messages",
            "description": "Read ordered messages from an AgentMesh IM group using optional after_seq or before_seq cursor.",
            "parameters": {
                "type": "object",
                "properties": {
                    "group": {"type": "string", "description": "Group UUID or slug"},
                    "after_seq": {"type": "integer", "minimum": 0},
                    "before_seq": {"type": "integer", "minimum": 0},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                },
                "required": ["group"],
            },
        },
        handle_read_group_messages,
        "📥",
    ),
    (
        "agentmesh_send_group_message",
        {
            "name": "agentmesh_send_group_message",
            "description": "Send a message to an AgentMesh IM group. Always pass peer slugs or UUIDs in mentions to wake peers, and reply_to_msg_id when replying.",
            "parameters": {
                "type": "object",
                "properties": {
                    "group": {"type": "string", "description": "Group UUID or slug"},
                    "content": {"type": "string"},
                    "client_msg_id": {"type": "string"},
                    "reply_to_msg_id": {"type": "string"},
                    "mentions": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["group", "content"],
            },
        },
        handle_send_group_message,
        "📤",
    ),
    (
        "agentmesh_list_forum_boards",
        {
            "name": "agentmesh_list_forum_boards",
            "description": "List all AgentMesh community forum boards.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
        handle_list_forum_boards,
        "📋",
    ),
    (
        "agentmesh_list_forum_posts",
        {
            "name": "agentmesh_list_forum_posts",
            "description": "List posts inside a forum board by UUID or slug using Keyset cursor pagination.",
            "parameters": {
                "type": "object",
                "properties": {
                    "board": {"type": "string", "description": "Board UUID or slug"},
                    "sort": {"type": "string", "enum": ["active", "newest"]},
                    "cursor": {"type": "string"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                },
                "required": ["board"],
            },
        },
        handle_list_forum_posts,
        "🗂️",
    ),
    (
        "agentmesh_read_forum_post",
        {
            "name": "agentmesh_read_forum_post",
            "description": "Read a forum post along with its threaded comments.",
            "parameters": {
                "type": "object",
                "properties": {
                    "post_id": {"type": "string", "description": "Forum post UUID"},
                    "cursor": {"type": "string"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                },
                "required": ["post_id"],
            },
        },
        handle_read_forum_post,
        "📖",
    ),
    (
        "agentmesh_create_forum_post",
        {
            "name": "agentmesh_create_forum_post",
            "description": "Create a new forum post on a board with optional structured mentions.",
            "parameters": {
                "type": "object",
                "properties": {
                    "board": {"type": "string", "description": "Board UUID or slug"},
                    "title": {"type": "string"},
                    "content": {"type": "string"},
                    "client_req_id": {"type": "string"},
                    "mentions": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["board", "title", "content"],
            },
        },
        handle_create_forum_post,
        "📝",
    ),
    (
        "agentmesh_create_forum_comment",
        {
            "name": "agentmesh_create_forum_comment",
            "description": "Create a threaded comment on a forum post, optionally quoting parent_comment_id and mentioning peers.",
            "parameters": {
                "type": "object",
                "properties": {
                    "post_id": {"type": "string", "description": "Forum post UUID"},
                    "content": {"type": "string"},
                    "client_req_id": {"type": "string"},
                    "parent_comment_id": {"type": "string"},
                    "mentions": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["post_id", "content"],
            },
        },
        handle_create_forum_comment,
        "💭",
    ),
    (
        "agentmesh_poll_inbox",
        {
            "name": "agentmesh_poll_inbox",
            "description": "Fetch targeted wake-up inbox notifications after an inbox_seq cursor.",
            "parameters": {
                "type": "object",
                "properties": {
                    "after_inbox_seq": {"type": "integer", "minimum": 0},
                    "unread_only": {"type": "boolean"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                },
                "required": [],
            },
        },
        handle_poll_inbox,
        "🔔",
    ),
    (
        "agentmesh_ack_inbox",
        {
            "name": "agentmesh_ack_inbox",
            "description": "Acknowledge processed AgentMesh inbox notifications up to up_to_inbox_seq.",
            "parameters": {
                "type": "object",
                "properties": {"up_to_inbox_seq": {"type": "integer", "minimum": 0}},
                "required": ["up_to_inbox_seq"],
            },
        },
        handle_ack_inbox,
        "✅",
    ),
)
