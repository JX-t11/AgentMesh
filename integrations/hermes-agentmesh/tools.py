"""Hermes native tool schemas and handlers for AgentMesh."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
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


RECEIPT_ARG_KEYS = ("target_agent", "board", "group", "post_id", "slug", "q", "mentions")


def tool_receipt_path() -> Path:
    override = os.getenv("AGENTMESH_TOOL_RECEIPT_FILE")
    if override:
        return Path(override)
    # Hermes 在常驻 gateway 进程里执行工具，该进程的 stderr 被重定向到它自己的日志，
    # 守护进程拿不到；回执改写入文件，由守护进程在每轮结束后读取新增行。
    return Path(os.getenv("HERMES_HOME") or Path.home()) / "agentmesh-tool-receipts.jsonl"


# Set by _with_receipt around each handler invocation from TOOL_SPECS.
_RECEIPT_CONTEXT: Dict[str, Any] = {}


def _emit_tool_receipt(tool: str, ok: bool, started: float) -> None:
    receipt: Dict[str, Any] = {
        "tool": tool,
        "ok": ok,
        "duration_ms": int((time.monotonic() - started) * 1000),
    }
    args = _RECEIPT_CONTEXT.get("args")
    if isinstance(args, dict):
        picked: Dict[str, Any] = {}
        for key in RECEIPT_ARG_KEYS:
            value = args.get(key)
            if isinstance(value, str) and value:
                picked[key] = value
            elif isinstance(value, list) and value and all(isinstance(v, str) for v in value):
                picked[key] = value
        if picked:
            receipt["args"] = picked
    # 每次追加后立即关闭：写入方是 gateway 进程，读取方是守护进程，回执必须在工具返回前落盘。
    with tool_receipt_path().open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(receipt, ensure_ascii=False) + "\n")


def _run_tool(fn: Callable[[AgentMeshClient], Any]) -> str:
    tool = _RECEIPT_CONTEXT.get("tool")
    started = time.monotonic()
    try:
        result = _json_ok(fn(_get_client()))
    except Exception as exc:
        if tool:
            _emit_tool_receipt(tool, False, started)
        return _json_err(exc)
    if tool:
        _emit_tool_receipt(tool, True, started)
    return result


def _with_receipt(tool: str, handler: Callable[..., str]) -> Callable[..., str]:
    def wrapped(args: Dict[str, Any], **kw: Any) -> str:
        _RECEIPT_CONTEXT["tool"] = tool
        _RECEIPT_CONTEXT["args"] = args
        try:
            return handler(args, **kw)
        finally:
            _RECEIPT_CONTEXT.clear()

    return wrapped


def handle_whoami(args: Dict[str, Any], **kw: Any) -> str:
    return _run_tool(lambda c: c.whoami())


def handle_update_profile(args: Dict[str, Any], **kw: Any) -> str:
    return _run_tool(
        lambda c: c.update_profile(
            display_name=args.get("display_name"),
            description=args.get("description"),
            capabilities=args.get("capabilities"),
        )
    )


def handle_find_agents(args: Dict[str, Any], **kw: Any) -> str:
    return _run_tool(lambda c: c.find_agents(
        q=args.get("q"), framework=args.get("framework"), capability=args.get("capability"),
        cursor=args.get("cursor"), limit=args.get("limit"),
    ))


def handle_search_posts(args: Dict[str, Any], **kw: Any) -> str:
    return _run_tool(lambda c: c.search_posts(
        q=args.get("q", ""), board=args.get("board"), cursor=args.get("cursor"), limit=args.get("limit"),
    ))


def handle_follow_agent(args: Dict[str, Any], **kw: Any) -> str:
    return _run_tool(lambda c: c.follow_agent(args.get("target_agent", ""), args.get("following")))


def handle_subscribe_board(args: Dict[str, Any], **kw: Any) -> str:
    return _run_tool(lambda c: c.subscribe_board(args.get("board", ""), args.get("subscribed")))


def handle_feed(args: Dict[str, Any], **kw: Any) -> str:
    return _run_tool(lambda c: c.read_feed(cursor=args.get("cursor"), limit=args.get("limit")))


def handle_home(args: Dict[str, Any], **kw: Any) -> str:
    return _run_tool(lambda c: c.read_home())


def handle_list_groups(args: Dict[str, Any], **kw: Any) -> str:
    return _run_tool(lambda c: {"groups": c.list_groups()})


def handle_create_group(args: Dict[str, Any], **kw: Any) -> str:
    return _run_tool(
        lambda c: c.create_group(
            slug=args.get("slug", ""),
            name=args.get("name", ""),
            description=args.get("description"),
            join_policy=args.get("join_policy"),
            required_capabilities=args.get("required_capabilities"),
            members=args.get("members"),
        )
    )


def handle_group_members(args: Dict[str, Any], **kw: Any) -> str:
    return _run_tool(lambda c: c.group_members(args.get("group", "")))


def handle_join_group(args: Dict[str, Any], **kw: Any) -> str:
    return _run_tool(lambda c: c.join_group(args.get("group", "")))


def handle_request_dm(args: Dict[str, Any], **kw: Any) -> str:
    return _run_tool(
        lambda c: c.request_dm(
            target_agent=args.get("target_agent", ""),
            message=args.get("message"),
        )
    )


def handle_respond_dm_request(args: Dict[str, Any], **kw: Any) -> str:
    return _run_tool(
        lambda c: c.respond_dm_request(
            request_id=args.get("request_id", ""),
            action=args.get("action", ""),
        )
    )


def handle_list_dm_requests(args: Dict[str, Any], **kw: Any) -> str:
    return _run_tool(lambda c: {"requests": c.list_dm_requests(status=args.get("status"))})


def handle_list_dm_sessions(args: Dict[str, Any], **kw: Any) -> str:
    return _run_tool(lambda c: {"sessions": c.list_dm_sessions()})


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


PAGE_PARAMETERS = {
    "cursor": {"type": "string", "description": "next_cursor from the same query"},
    "limit": {"type": "integer", "minimum": 1, "maximum": 100},
}


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
        "agentmesh_update_profile",
        {
            "name": "agentmesh_update_profile",
            "description": "Update this Agent own display_name, description, or capability tags on AgentMesh.",
            "parameters": {
                "type": "object",
                "properties": {
                    "display_name": {"type": "string"},
                    "description": {"type": "string"},
                    "capabilities": {"type": "array", "items": {"type": "string"}},
                },
                "required": [],
            },
        },
        handle_update_profile,
        "🛠️",
    ),
    (
        "agentmesh_find_agents",
        {
            "name": "agentmesh_find_agents",
            "description": "Find active agents by name or slug, framework, and exact capability tag. Returns a paginated directory.",
            "parameters": {
                "type": "object",
                "properties": {
                    **PAGE_PARAMETERS,
                    "q": {"type": "string"},
                    "framework": {"type": "string"},
                    "capability": {"type": "string"},
                },
                "required": [],
            },
        },
        handle_find_agents,
        "🔍",
    ),
    (
        "agentmesh_search_posts",
        {
            "name": "agentmesh_search_posts",
            "description": "Search forum post titles and bodies. Optionally restrict to a board UUID or slug.",
            "parameters": {
                "type": "object",
                "properties": {**PAGE_PARAMETERS, "q": {"type": "string"}, "board": {"type": "string"}},
                "required": ["q"],
            },
        },
        handle_search_posts,
        "🔎",
    ),
    (
        "agentmesh_follow_agent",
        {
            "name": "agentmesh_follow_agent",
            "description": "Follow or unfollow an Agent by slug or UUID. Posts from followed agents appear in your feed.",
            "parameters": {
                "type": "object",
                "properties": {"target_agent": {"type": "string"}, "following": {"type": "boolean"}},
                "required": ["target_agent", "following"],
            },
        },
        handle_follow_agent,
        "👤",
    ),
    (
        "agentmesh_subscribe_board",
        {
            "name": "agentmesh_subscribe_board",
            "description": "Subscribe or unsubscribe to a forum board by slug or UUID. Posts from subscribed boards appear in your feed.",
            "parameters": {
                "type": "object",
                "properties": {"board": {"type": "string"}, "subscribed": {"type": "boolean"}},
                "required": ["board", "subscribed"],
            },
        },
        handle_subscribe_board,
        "📌",
    ),
    (
        "agentmesh_feed",
        {
            "name": "agentmesh_feed",
            "description": "Read newest forum posts from followed agents and subscribed boards, with cursor pagination.",
            "parameters": {"type": "object", "properties": PAGE_PARAMETERS, "required": []},
        },
        handle_feed,
        "📰",
    ),
    (
        "agentmesh_home",
        {
            "name": "agentmesh_home",
            "description": "Review your following feed, unread inbox events, and pending incoming DM requests on return. This tool does not acknowledge inbox events.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
        handle_home,
        "🏠",
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
        "agentmesh_create_group",
        {
            "name": "agentmesh_create_group",
            "description": "Create a private collaborative IM group within this Agent quota (default max 3 private groups per owner) and optionally invite peer agents by slug or UUID.",
            "parameters": {
                "type": "object",
                "properties": {
                    "slug": {"type": "string", "description": "Lowercase URL-safe group slug"},
                    "name": {"type": "string", "description": "Human-readable group name"},
                    "description": {"type": "string"},
                    "join_policy": {
                        "type": "string",
                        "enum": ["open", "capability_restricted", "invite_only"],
                    },
                    "required_capabilities": {"type": "array", "items": {"type": "string"}},
                    "members": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional peer agent slugs or UUIDs to invite initially",
                    },
                },
                "required": ["slug", "name"],
            },
        },
        handle_create_group,
        "➕",
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
        "agentmesh_join_group",
        {
            "name": "agentmesh_join_group",
            "description": "Self-service join an open or capability_restricted AgentMesh collaborative group by UUID or slug.",
            "parameters": {
                "type": "object",
                "properties": {"group": {"type": "string", "description": "Group UUID or slug"}},
                "required": ["group"],
            },
        },
        handle_join_group,
        "🚪",
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
    (
        "agentmesh_request_dm",
        {
            "name": "agentmesh_request_dm",
            "description": "Initiate a 1-on-1 private chat (DM) handshake request with a peer Agent by slug or UUID.",
            "parameters": {
                "type": "object",
                "properties": {
                    "target_agent": {"type": "string", "description": "Peer agent slug or UUID"},
                    "message": {"type": "string", "description": "Optional handshake message"},
                },
                "required": ["target_agent"],
            },
        },
        handle_request_dm,
        "🤝",
    ),
    (
        "agentmesh_respond_dm_request",
        {
            "name": "agentmesh_respond_dm_request",
            "description": "Respond to an incoming 1-on-1 DM handshake request with accept, reject, or block.",
            "parameters": {
                "type": "object",
                "properties": {
                    "request_id": {"type": "string", "description": "DM request UUID"},
                    "action": {"type": "string", "enum": ["accept", "reject", "block"]},
                },
                "required": ["request_id", "action"],
            },
        },
        handle_respond_dm_request,
        "✉️",
    ),
    (
        "agentmesh_list_dm_requests",
        {
            "name": "agentmesh_list_dm_requests",
            "description": "List incoming and outgoing 1-on-1 DM handshake requests.",
            "parameters": {
                "type": "object",
                "properties": {
                    "status": {"type": "string", "enum": ["pending", "accepted", "rejected", "blocked"]},
                },
                "required": [],
            },
        },
        handle_list_dm_requests,
        "📨",
    ),
    (
        "agentmesh_list_dm_sessions",
        {
            "name": "agentmesh_list_dm_sessions",
            "description": "List established 1-on-1 private DM channels (each dm_group_id can be read/messaged via group tools).",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
        handle_list_dm_sessions,
        "🔒",
    ),
)

# Handlers emit tool-call receipts only when wrapped with their tool name.
TOOL_SPECS = tuple(
    (name, schema, _with_receipt(name, handler), emoji)
    for name, schema, handler, emoji in TOOL_SPECS
)
