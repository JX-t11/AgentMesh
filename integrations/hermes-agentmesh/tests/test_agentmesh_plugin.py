"""Unit and protocol tests for Hermes AgentMesh plugin and WS daemon."""

from __future__ import annotations

import asyncio
import contextlib
import importlib.util
import io
import json
import os
import sys
import tempfile
import threading
import unittest
from unittest import mock
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
# 回执文件默认写在 HOME 下；测试进程统一指向临时目录，避免污染真实 HOME。
os.environ["AGENTMESH_TOOL_RECEIPT_FILE"] = str(Path(tempfile.mkdtemp()) / "tool-receipts.jsonl")


def _load_plugin_package():
    pkg_dir = Path(__file__).resolve().parent.parent
    spec = importlib.util.spec_from_file_location(
        "hermes_agentmesh_pkg",
        pkg_dir / "__init__.py",
        submodule_search_locations=[str(pkg_dir)],
    )
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules["hermes_agentmesh_pkg"] = mod
    spec.loader.exec_module(mod)
    return mod


PKG = _load_plugin_package()
from hermes_agentmesh_pkg.client import AgentMeshClient, AgentMeshConfig, AgentMeshApiError  # noqa: E402
from hermes_agentmesh_pkg.daemon import FileCursorStore, HermesMeshDaemon  # noqa: E402
from hermes_agentmesh_pkg import daemon as plugin_daemon  # noqa: E402
from hermes_agentmesh_pkg import tools as plugin_tools  # noqa: E402


class _FakeCtx:
    def __init__(self) -> None:
        self.tools = {}

    def register_tool(self, *, name, toolset, schema, handler, check_fn=None, description="", emoji=""):
        self.tools[name] = {
            "toolset": toolset,
            "schema": schema,
            "handler": handler,
            "check_fn": check_fn,
            "description": description,
            "emoji": emoji,
        }


class HermesPluginTest(unittest.TestCase):
    def test_register_exposes_all_25_tools(self) -> None:
        ctx = _FakeCtx()
        PKG.register(ctx)
        self.assertEqual(len(ctx.tools), 25)
        self.assertIn("agentmesh_update_profile", ctx.tools)
        self.assertIn("agentmesh_create_group", ctx.tools)
        self.assertIn("agentmesh_send_group_message", ctx.tools)
        self.assertIn("agentmesh_join_group", ctx.tools)
        self.assertIn("agentmesh_request_dm", ctx.tools)
        self.assertIn("agentmesh_respond_dm_request", ctx.tools)
        self.assertIn("agentmesh_list_dm_requests", ctx.tools)
        self.assertIn("agentmesh_list_dm_sessions", ctx.tools)
        self.assertIn("agentmesh_create_forum_comment", ctx.tools)
        for tool in ctx.tools.values():
            self.assertEqual(tool["toolset"], "agentmesh")
            self.assertIn("parameters", tool["schema"])

    def test_update_profile_and_create_private_group(self) -> None:
        self_id = "11111111-1111-4111-8111-111111111111"
        peer_id = "22222222-2222-4222-8222-222222222222"
        priv_group_id = "99999999-9999-4999-8999-999999999999"
        captured = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format, *args):
                return

            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                if self.path == "/api/v1/agents/by-slug/openclaw-alpha":
                    self.wfile.write(
                        json.dumps(
                            {
                                "agent": {"id": peer_id, "slug": "openclaw-alpha"}
                            }
                        ).encode("utf-8")
                    )

            def do_PATCH(self):
                length = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(length).decode("utf-8"))
                captured.append(("PATCH", self.path, body))
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(
                    json.dumps(
                        {
                            "agent": {
                                "id": self_id,
                                "slug": "hermes-gamma",
                                "display_name": body.get("display_name", "Gamma"),
                                "capabilities": body.get("capabilities", []),
                            }
                        }
                    ).encode("utf-8")
                )

            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(length).decode("utf-8"))
                captured.append(("POST", self.path, body))
                self.send_response(201)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(
                    json.dumps(
                        {
                            "group": {
                                "id": priv_group_id,
                                "slug": body["slug"],
                                "name": body["name"],
                                "visibility": body["visibility"],
                                "creator_agent_id": self_id,
                            }
                        }
                    ).encode("utf-8")
                )

        srv = HTTPServer(("127.0.0.1", 0), Handler)
        t = threading.Thread(target=srv.serve_forever, daemon=True)
        t.start()
        try:
            client = AgentMeshClient(
                AgentMeshConfig(base_url=f"http://127.0.0.1:{srv.server_port}", token="amesh_tok")
            )
            updated = client.update_profile(display_name="Gamma Autonomous", capabilities=["python", "sql"])
            self.assertEqual(updated["agent"]["display_name"], "Gamma Autonomous")
            created = client.create_group(
                slug="hermes-lab",
                name="Hermes Lab",
                join_policy="invite_only",
                members=["@openclaw-alpha"],
            )
            self.assertEqual(created["group"]["id"], priv_group_id)
            self.assertEqual(
                captured[0],
                (
                    "PATCH",
                    "/api/v1/agents/me",
                    {"display_name": "Gamma Autonomous", "capabilities": ["python", "sql"]},
                ),
            )
            self.assertEqual(
                captured[1],
                (
                    "POST",
                    "/api/v1/groups",
                    {
                        "slug": "hermes-lab",
                        "name": "Hermes Lab",
                        "visibility": "private",
                        "join_policy": "invite_only",
                        "member_agent_ids": [peer_id],
                    },
                ),
            )
        finally:
            srv.shutdown()
            srv.server_close()

    def test_client_covers_directory_social_dm_forum_inbox_and_errors(self) -> None:
        self_id = "11111111-1111-4111-8111-111111111111"
        peer_id = "22222222-2222-4222-8222-222222222222"
        group_id = "33333333-3333-4333-8333-333333333333"
        board_id = "44444444-4444-4444-8444-444444444444"
        post_id = "66666666-6666-4666-8666-666666666666"
        comment_id = "77777777-7777-4777-8777-777777777777"
        dm_request_id = "88888888-8888-4888-8888-888888888888"
        dm_group_id = "99999999-9999-4999-8999-999999999999"
        message_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        created = "2026-11-16T00:00:00Z"
        captured = []

        agent = {
            "id": self_id,
            "slug": "hermes-gamma",
            "display_name": "Gamma",
            "framework": "hermes",
            "description": None,
            "owner_user_id": None,
            "revoked_at": None,
            "created_at": created,
        }
        peer = {**agent, "id": peer_id, "slug": "openclaw-alpha", "display_name": "Alpha"}
        group = {
            "id": group_id,
            "slug": "mesh-general",
            "name": "Mesh General",
            "description": None,
            "is_dm": False,
            "visibility": "public",
            "join_policy": "open",
            "required_capabilities": [],
            "creator_agent_id": peer_id,
            "creator_user_id": None,
            "last_seq": 2,
            "member_count": 2,
            "created_at": created,
        }
        board = {"id": board_id, "slug": "rfcs", "name": "RFCs", "description": None, "post_count": 1, "created_at": created}
        post = {
            "id": post_id,
            "board_id": board_id,
            "author_agent_id": peer_id,
            "client_req_id": "p1",
            "title": "Protocol RFC",
            "content": "Discuss the protocol",
            "mention_agent_ids": [],
            "comment_count": 1,
            "last_activity_at": created,
            "created_at": created,
        }
        comment = {
            "id": comment_id,
            "post_id": post_id,
            "seq": 1,
            "author_agent_id": peer_id,
            "client_req_id": "c1",
            "parent_comment_id": None,
            "content": "Looks good",
            "mention_agent_ids": [],
            "created_at": created,
        }
        message = {
            "id": message_id,
            "group_id": group_id,
            "seq": 2,
            "sender_agent_id": peer_id,
            "client_msg_id": "m1",
            "content": "hello",
            "reply_to_msg_id": None,
            "mention_agent_ids": [],
            "created_at": created,
        }
        dm_request = {
            "id": dm_request_id,
            "sender_agent_id": peer_id,
            "sender_slug": peer["slug"],
            "sender_display_name": peer["display_name"],
            "receiver_agent_id": self_id,
            "receiver_slug": agent["slug"],
            "receiver_display_name": agent["display_name"],
            "status": "pending",
            "request_message": "sync",
            "dm_group_id": None,
            "created_at": created,
            "updated_at": created,
        }
        inbox_item = {
            "inbox_seq": 1,
            "kind": "post_mention",
            "source_id": post_id,
            "group_id": None,
            "post_id": post_id,
            "actor_agent_id": peer_id,
            "summary": "Gamma mentioned",
            "is_acked": False,
            "created_at": created,
        }

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format, *args):
                return

            def _reply(self, payload, status=200):
                raw = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def _captured_body(self):
                length = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(length).decode("utf-8")) if length else None
                captured.append((self.command, self.path, body))
                return body

            def _route(self):
                path = urlparse(self.path).path
                self._captured_body()
                if path == "/api/v1/agents/me" and self.command == "PATCH":
                    return self._reply({"agent": {**agent, "display_name": "Renamed"}})
                if path == "/api/v1/agents/me":
                    return self._reply({"agent": agent})
                if path == "/api/v1/agents":
                    return self._reply({"agents": [agent, peer]})
                if path == "/api/v1/agents/search":
                    return self._reply({"agents": [peer], "next_cursor": "next", "has_more": True})
                if path == f"/api/v1/agents/by-slug/{peer['slug']}":
                    return self._reply({"agent": peer})
                if "/api/v1/agents/me/follows/" in path or "/api/v1/agents/me/board-subscriptions/" in path:
                    return self._reply({"ok": True})
                if path == "/api/v1/agents/me/feed":
                    return self._reply({"board_id": None, "posts": [post], "next_cursor": None, "has_more": False})
                if path == "/api/v1/agents/me/home":
                    return self._reply({"feed": {"posts": [post]}, "inbox": {"items": [inbox_item]}, "pending_dm_requests": [dm_request]})
                if path == "/api/v1/groups" and self.command == "GET":
                    return self._reply({"groups": [group]})
                if path == "/api/v1/groups" and self.command == "POST":
                    return self._reply({"group": group}, 201)
                if path == f"/api/v1/groups/{group_id}/members":
                    return self._reply({"group_id": group_id, "members": [agent, peer]})
                if path == f"/api/v1/groups/{group_id}/join":
                    return self._reply({"group": group})
                if path == f"/api/v1/groups/{group_id}/messages" and self.command == "POST":
                    return self._reply({"message": message}, 201)
                if path == f"/api/v1/groups/{group_id}/messages":
                    return self._reply({"group_id": group_id, "messages": [message], "has_more": False})
                if path == "/api/v1/boards":
                    return self._reply({"boards": [board], "hidden_platform_count": 0, "next_cursor": None, "has_more": False})
                if path == f"/api/v1/boards/{board_id}/posts" and self.command == "POST":
                    return self._reply({"post": post}, 201)
                if path == f"/api/v1/boards/{board_id}/posts":
                    return self._reply({"board_id": board_id, "posts": [post], "next_cursor": "next", "has_more": True})
                if path == f"/api/v1/posts/{post_id}":
                    return self._reply({"post": post})
                if path == f"/api/v1/posts/{post_id}/comments" and self.command == "POST":
                    return self._reply({"comment": comment, "post_comment_count": 2}, 201)
                if path == f"/api/v1/posts/{post_id}/comments":
                    return self._reply({"post_id": post_id, "comments": [comment], "next_cursor": None, "has_more": False})
                if path == "/api/v1/posts" or path.startswith("/api/v1/posts?"):
                    return self._reply({"board_id": None, "posts": [post], "next_cursor": None, "has_more": False})
                if path == f"/api/v1/dm/requests/{dm_request_id}/respond":
                    return self._reply({"request": {**dm_request, "status": "accepted", "dm_group_id": dm_group_id}})
                if path == "/api/v1/dm/requests" and self.command == "POST":
                    return self._reply({"request": dm_request}, 201)
                if path == "/api/v1/dm/requests":
                    return self._reply({"requests": [dm_request]})
                if path == "/api/v1/dm/sessions":
                    return self._reply({"sessions": [{"group_id": dm_group_id, "slug": "dm-hermes-openclaw", "peer_agent_id": peer_id}]})
                if path == "/api/v1/inbox/ack":
                    return self._reply({"acked_inbox_seq": 1})
                if path == "/api/v1/inbox":
                    return self._reply({"items": [inbox_item], "next_after_inbox_seq": 1, "acked_inbox_seq": 1, "has_more": False})
                return self._reply({"error": {"code": "not_found", "message": "not found"}}, 404)

            def do_GET(self):
                self._route()

            def do_POST(self):
                self._route()

            def do_PATCH(self):
                self._route()

            def do_PUT(self):
                self._route()

            def do_DELETE(self):
                self._route()

        srv = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=srv.serve_forever, daemon=True)
        thread.start()
        try:
            client = AgentMeshClient(AgentMeshConfig(base_url=f"http://127.0.0.1:{srv.server_port}", token="amesh_tok"))
            me = client.whoami()
            self.assertEqual(me["agent"]["id"], self_id)
            self.assertEqual(len(me["directory"]), 2)

            client.update_profile(display_name="Renamed", description=" Coordinate ", capabilities=["python"])
            with self.assertRaises(ValueError):
                client.update_profile()
            self.assertEqual(len(client.list_agents()), 2)
            self.assertTrue(client.find_agents(q="alpha", framework="openclaw", capability="research", limit=10)["has_more"])
            self.assertEqual(client.follow_agent(f"@{peer['slug']}", True), {"agent_id": peer_id, "following": True})
            self.assertEqual(client.follow_agent(peer_id, False), {"agent_id": peer_id, "following": False})
            self.assertEqual(client.subscribe_board("rfcs", True), {"board_id": board_id, "subscribed": True})
            self.assertEqual(client.subscribe_board(board_id, False), {"board_id": board_id, "subscribed": False})
            self.assertEqual(len(client.read_feed(cursor="next", limit=10)["posts"]), 1)
            self.assertEqual(len(client.read_home()["pending_dm_requests"]), 1)
            self.assertEqual(client.list_groups(), [group])
            created_group = client.create_group(
                slug="task",
                name="Task",
                description="Work",
                join_policy="capability_restricted",
                required_capabilities=["python"],
                members=[f"@{peer['slug']}"],
            )
            self.assertEqual(created_group["group"]["id"], group_id)
            self.assertEqual(len(client.group_members("mesh-general")["members"]), 2)
            self.assertEqual(client.join_group(group_id)["group"]["id"], group_id)
            self.assertFalse(client.request_dm(f"@{peer['slug']}", message=" sync ")["already_existed"])
            self.assertEqual(client.respond_dm_request(dm_request_id, "accept")["request"]["status"], "accepted")
            self.assertEqual(client.list_dm_requests("pending"), [dm_request])
            self.assertEqual(client.list_dm_requests(), [dm_request])
            self.assertEqual(len(client.list_dm_sessions()), 1)
            self.assertEqual(client.read_group_messages("mesh-general", after_seq=0, before_seq=3, limit=20)["messages"], [message])
            sent = client.send_group_message("mesh-general", "hello", client_msg_id="m1", reply_to_msg_id=message_id, mentions=[peer_id])
            self.assertFalse(sent["idempotent_reused"])
            self.assertEqual(client.list_forum_boards(), [board])
            self.assertTrue(client.list_forum_posts("rfcs", sort="active", cursor="next", limit=10)["has_more"])
            detail = client.read_forum_post(post_id, limit=20)
            self.assertEqual(detail["post"]["id"], post_id)
            self.assertEqual(detail["comments"], [comment])
            created_post = client.create_forum_post("rfcs", "Protocol RFC", "Discuss the protocol", client_req_id="p1", mentions=[f"@{peer['slug']}"])
            self.assertEqual(created_post["post"]["id"], post_id)
            created_comment = client.create_forum_comment(post_id, "Looks good", client_req_id="c1", parent_comment_id=comment_id, mentions=[peer_id])
            self.assertEqual(created_comment["post_comment_count"], 2)
            self.assertEqual(client.search_posts("protocol", board="rfcs", limit=10)["posts"], [post])
            self.assertEqual(client.poll_inbox(after_inbox_seq=0, unread_only=True, limit=20)["items"], [inbox_item])
            self.assertEqual(client.ack_inbox(1), {"acked_inbox_seq": 1})

            with self.assertRaises(ValueError):
                client.follow_agent(peer_id, "yes")
            with self.assertRaises(ValueError):
                client.list_dm_requests("unknown")
            with self.assertRaises(ValueError):
                client.list_forum_posts("rfcs", sort="hot")
            with self.assertRaises(ValueError):
                client.read_group_messages("mesh-general", limit=101)
            with self.assertRaises(ValueError):
                client.request_dm("")
            with self.assertRaises(ValueError):
                client.ack_inbox(-1)

            error_client = AgentMeshClient(AgentMeshConfig(base_url=f"http://127.0.0.1:{srv.server_port}", token="amesh_tok"))
            with self.assertRaises(PKG.client.AgentMeshApiError) as caught:
                error_client._request_with_status("GET", "/api/v1/missing")
            self.assertEqual(caught.exception.status, 404)
            self.assertEqual(caught.exception.code, "not_found")
        finally:
            srv.shutdown()
            srv.server_close()

    def test_tool_helpers_serialize_success_and_errors(self) -> None:
        class FakeClient:
            def whoami(self):
                return {"agent": {"id": "agent-id", "slug": "hermes-gamma"}}

            def update_profile(self, **kwargs):
                assert kwargs == {
                    "display_name": "Gamma",
                    "description": None,
                    "capabilities": ["python"],
                }
                return {"agent": {"display_name": "Gamma"}}

            def find_agents(self, **kwargs):
                assert kwargs["q"] == "alpha"
                return {"agents": [{"id": "peer-id"}]}

            def read_feed(self, **kwargs):
                raise AgentMeshApiError(503, "unavailable", "backend is unavailable")

            def follow_agent(self, target_agent, following):
                assert target_agent == "alpha"
                assert following == "not-a-bool"
                raise ValueError("following must be a boolean")

            def list_agents(self):
                raise AgentMeshApiError(503, "unavailable", "backend is unavailable")

        original_client = plugin_tools._get_client
        plugin_tools._get_client = lambda: FakeClient()
        try:
            with mock.patch.dict(os.environ, {"AGENTMESH_TOKEN": "amesh_token"}):
                self.assertTrue(plugin_tools.check_agentmesh_available())
                self.assertEqual(json.loads(plugin_tools.handle_whoami({}, **{}))["agent"]["slug"], "hermes-gamma")
                profile = json.loads(
                    plugin_tools.handle_update_profile(
                        {"display_name": "Gamma", "capabilities": ["python"]},
                        **{},
                    )
                )
                self.assertEqual(profile["agent"]["display_name"], "Gamma")
                found = json.loads(plugin_tools.handle_find_agents({"q": "alpha"}, **{}))
                self.assertEqual(found["agents"][0]["id"], "peer-id")

                invalid = json.loads(plugin_tools.handle_follow_agent({"target_agent": "alpha", "following": "not-a-bool"}, **{}))
                self.assertEqual(invalid["error"]["code"], "invalid_input")
                unavailable = json.loads(plugin_tools.handle_feed({}, **{}))
                self.assertEqual(unavailable["error"]["code"], "unavailable")
                self.assertEqual(unavailable["error"]["status"], 503)
        finally:
            plugin_tools._get_client = original_client

    def test_daemon_builds_prompt_for_dm_group_and_post_events(self) -> None:
        client = AgentMeshClient(AgentMeshConfig(base_url="http://127.0.0.1:1", token="amesh_tok"))
        client.read_group_messages = lambda **_kwargs: {
            "group_id": "group-id",
            "messages": [
                {
                    "id": "message-id",
                    "group_id": "group-id",
                    "seq": 7,
                    "sender_agent_id": "peer-id",
                    "client_msg_id": "m1",
                    "content": "review required",
                    "reply_to_msg_id": None,
                    "mention_agent_ids": ["self-id"],
                    "created_at": "2026-11-16T00:00:00Z",
                }
            ],
            "has_more": False,
        }
        client.read_forum_post = lambda **_kwargs: {
            "post": {"id": "post-id", "title": "Protocol RFC", "content": "Please review"},
            "comments": [
                {
                    "id": "comment-id",
                    "post_id": "post-id",
                    "seq": 1,
                    "author_agent_id": "peer-id",
                    "client_req_id": "c1",
                    "parent_comment_id": None,
                    "content": "Approved",
                    "mention_agent_ids": [],
                    "created_at": "2026-11-16T00:00:00Z",
                }
            ],
            "next_cursor": None,
            "has_more": False,
        }
        daemon = HermesMeshDaemon(client, mock.Mock(), lambda *_: asyncio.sleep(0), log=lambda _: None)

        group_prompt = daemon._build_wake_prompt({
            "kind": "group_mention",
            "inbox_seq": 1,
            "actor_agent_id": "peer-id",
            "source_id": "message-id",
            "group_id": "group-id",
            "post_id": None,
            "summary": "please review",
        })
        self.assertIn("target_message_id=message-id", group_prompt)
        self.assertIn("target_message_seq=7", group_prompt)

        dm_prompt = daemon._build_wake_prompt({
            "kind": "dm_accepted",
            "inbox_seq": 2,
            "actor_agent_id": "peer-id",
            "source_id": "request-id",
            "group_id": "dm-group-id",
            "post_id": None,
            "summary": "accepted",
        })
        self.assertIn("dm_group_id=dm-group-id", dm_prompt)
        self.assertIn("agentmesh_send_group_message", dm_prompt)

        post_prompt = daemon._build_wake_prompt({
            "kind": "post_mention",
            "inbox_seq": 3,
            "actor_agent_id": "peer-id",
            "source_id": "post-id",
            "group_id": None,
            "post_id": "post-id",
            "summary": "new post",
        })
        self.assertIn("title=\"Protocol RFC\"", post_prompt)
        self.assertIn("post_content=\"Please review\"", post_prompt)

        comment_prompt = daemon._build_wake_prompt({
            "kind": "comment_mention",
            "inbox_seq": 4,
            "actor_agent_id": "peer-id",
            "source_id": "comment-id",
            "group_id": None,
            "post_id": "post-id",
            "summary": "new comment",
        })
        self.assertIn("target_comment_id=comment-id", comment_prompt)
        self.assertIn("target_comment_content=\"Approved\"", comment_prompt)

    def test_daemon_catches_up_filters_self_and_persists_cursor(self) -> None:
        self_id = "11111111-1111-4111-8111-111111111111"
        peer_id = "22222222-2222-4222-8222-222222222222"
        group_id = "33333333-3333-4333-8333-333333333333"
        msg_id = "44444444-4444-4444-8444-444444444444"
        state = {"acked": 0}

        inbox_items = [
            {
                "inbox_seq": 1,
                "kind": "group_mention",
                "source_id": "55555555-5555-4555-8555-555555555555",
                "group_id": group_id,
                "post_id": None,
                "actor_agent_id": self_id,
                "summary": "self ping",
                "is_acked": False,
                "created_at": "2026-11-16T00:00:00Z",
            },
            {
                "inbox_seq": 2,
                "kind": "group_mention",
                "source_id": msg_id,
                "group_id": group_id,
                "post_id": None,
                "actor_agent_id": peer_id,
                "summary": "@hermes-gamma review",
                "is_acked": False,
                "created_at": "2026-11-16T00:00:01Z",
            },
            {
                "inbox_seq": 3,
                "kind": "dm_request",
                "source_id": "66666666-6666-4666-8666-666666666666",
                "group_id": None,
                "post_id": None,
                "actor_agent_id": peer_id,
                "summary": "DM request from @openclaw-alpha",
                "is_acked": False,
                "created_at": "2026-11-16T00:00:02Z",
            },
        ]

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format, *args):
                return

            def do_GET(self):
                parsed = urlparse(self.path)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                if parsed.path == "/api/v1/agents/me":
                    self.wfile.write(
                        json.dumps({"agent": {"id": self_id, "slug": "hermes-gamma"}}).encode("utf-8")
                    )
                elif parsed.path == "/api/v1/agents":
                    self.wfile.write(json.dumps({"agents": []}).encode("utf-8"))
                elif parsed.path == "/api/v1/inbox":
                    after = int(parse_qs(parsed.query).get("after_inbox_seq", ["0"])[0])
                    items = [i for i in inbox_items if i["inbox_seq"] > after]
                    next_seq = items[-1]["inbox_seq"] if items else after
                    self.wfile.write(
                        json.dumps(
                            {
                                "items": items,
                                "next_after_inbox_seq": next_seq,
                                "acked_inbox_seq": state["acked"],
                                "has_more": False,
                            }
                        ).encode("utf-8")
                    )
                elif parsed.path == f"/api/v1/groups/{group_id}/messages":
                    self.wfile.write(
                        json.dumps(
                            {
                                "group_id": group_id,
                                "messages": [
                                    {
                                        "id": msg_id,
                                        "group_id": group_id,
                                        "seq": 3,
                                        "sender_agent_id": peer_id,
                                        "client_msg_id": "m1",
                                        "content": "@hermes-gamma review",
                                        "reply_to_msg_id": None,
                                        "mention_agent_ids": [self_id],
                                        "created_at": "2026-11-16T00:00:01Z",
                                    }
                                ],
                                "has_more": False,
                            }
                        ).encode("utf-8")
                    )

            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(length).decode("utf-8"))
                state["acked"] = max(state["acked"], int(body["up_to_inbox_seq"]))
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"acked_inbox_seq": state["acked"]}).encode("utf-8"))

        srv = HTTPServer(("127.0.0.1", 0), Handler)
        t = threading.Thread(target=srv.serve_forever, daemon=True)
        t.start()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                cursor_path = Path(tmp) / "cursor.json"
                client = AgentMeshClient(AgentMeshConfig(base_url=f"http://127.0.0.1:{srv.server_port}", token="amesh_tok"))
                runs = []

                async def run_turn(kind, key, _prompt):
                    runs.append(f"{kind}:{key}")

                async def scenario():
                    d1 = HermesMeshDaemon(client, FileCursorStore(cursor_path), run_turn, log=lambda _: None)
                    await d1.startup_and_intent("init-1", "Hello peers")
                    d2 = HermesMeshDaemon(client, FileCursorStore(cursor_path), run_turn, log=lambda _: None)
                    await d2.startup_and_intent("init-1", "Hello peers")

                asyncio.run(scenario())
                self.assertEqual(runs, ["inbox:inbox:2", "inbox:inbox:3", "intent:intent:init-1"])
                self.assertEqual(state["acked"], 3)
        finally:
            srv.shutdown()
            srv.server_close()


class ToolReceiptTest(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.receipt_file = self.tmp / "tool-receipts.jsonl"
        env = mock.patch.dict(os.environ, {"AGENTMESH_TOOL_RECEIPT_FILE": str(self.receipt_file)})
        env.start()
        self.addCleanup(env.stop)

    def _handler(self, name):
        for tool_name, _schema, handler, _emoji in plugin_tools.TOOL_SPECS:
            if tool_name == name:
                return handler
        raise AssertionError(f"missing tool {name}")

    def _call(self, name, client, args):
        handler = self._handler(name)
        original_client = plugin_tools._get_client
        plugin_tools._get_client = lambda: client
        try:
            return json.loads(handler(args))
        finally:
            plugin_tools._get_client = original_client

    def _receipts(self):
        if not self.receipt_file.exists():
            return []
        return [json.loads(line) for line in self.receipt_file.read_text(encoding="utf-8").splitlines()]

    def _write_fake_hermes(self) -> Path:
        # 与真实 CLI 相同：工具调用在另一处执行，其 stderr 写往 gateway 日志，
        # 而不是守护进程从这个子进程捕获的 stdio。
        pkg_dir = Path(__file__).resolve().parent.parent
        init_py = pkg_dir / "__init__.py"
        gateway_log = self.tmp / "gateway-stdio.log"
        fake_bin = self.tmp / "hermes-fake"
        fake_bin.write_text(
            f"""#!{sys.executable}
import contextlib, importlib.util, sys
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "hermes_agentmesh_pkg", r"{init_py}", submodule_search_locations=[r"{pkg_dir}"]
)
pkg = importlib.util.module_from_spec(spec)
sys.modules["hermes_agentmesh_pkg"] = pkg
spec.loader.exec_module(pkg)


class FakeClient:
    def search_posts(self, **_kwargs):
        return {{"posts": []}}


pkg.tools._get_client = lambda: FakeClient()
handler = next(h for name, _schema, h, _emoji in pkg.tools.TOOL_SPECS if name == "agentmesh_search_posts")
with open(r"{gateway_log}", "a", encoding="utf-8") as gateway_stdio, contextlib.redirect_stderr(gateway_stdio):
    print(handler({{"q": "mesh", "limit": 1}}))
print("session_id: local-test")
""",
            encoding="utf-8",
        )
        fake_bin.chmod(0o755)
        return fake_bin

    def _run_turn(self, fake_bin: Path, turn_key: str):
        buf = io.StringIO()
        with mock.patch.dict(os.environ, {"HERMES_BIN": str(fake_bin)}), contextlib.redirect_stdout(buf):
            runner = plugin_daemon.create_hermes_turn_runner()
            asyncio.run(runner("inbox", turn_key, "Do the work"))
        events = []
        for line in buf.getvalue().splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(event, dict) and event.get("event") == "tool_receipt":
                events.append(event)
        return events

    def test_wrapped_handler_appends_ok_receipt_with_whitelisted_args(self) -> None:
        class FakeClient:
            def follow_agent(self, target_agent, following):
                return {"following": following, "target_agent": target_agent}

        result = self._call("agentmesh_follow_agent", FakeClient(), {"target_agent": "alpha", "following": True})
        self.assertTrue(result["following"])

        receipts = self._receipts()
        self.assertEqual(len(receipts), 1)
        self.assertEqual(receipts[0]["tool"], "agentmesh_follow_agent")
        self.assertTrue(receipts[0]["ok"])
        self.assertIsInstance(receipts[0]["duration_ms"], int)
        self.assertEqual(receipts[0]["args"], {"target_agent": "alpha"})

    def test_failed_handler_appends_ok_false_receipt_without_error_content(self) -> None:
        class FakeClient:
            def search_posts(self, **_kwargs):
                raise ValueError("secret backend failure")

        result = self._call("agentmesh_search_posts", FakeClient(), {"q": "mesh"})
        self.assertIn("error", result)

        receipts = self._receipts()
        self.assertEqual(len(receipts), 1)
        self.assertEqual(receipts[0]["tool"], "agentmesh_search_posts")
        self.assertFalse(receipts[0]["ok"])
        self.assertEqual(receipts[0]["args"], {"q": "mesh"})
        self.assertNotIn("secret", self.receipt_file.read_text(encoding="utf-8"))

    def test_turn_runner_forwards_receipt_written_outside_the_child_stdio(self) -> None:
        events = self._run_turn(self._write_fake_hermes(), "inbox:9")

        self.assertEqual(len(events), 1)
        receipt = events[0]
        self.assertIsInstance(receipt.pop("duration_ms"), int)
        self.assertEqual(
            receipt,
            {
                "event": "tool_receipt",
                "turn": "inbox:9",
                "tool": "agentmesh_search_posts",
                "ok": True,
                "args": {"q": "mesh"},
            },
        )

    def test_turn_runner_ignores_receipts_from_earlier_turns(self) -> None:
        self.receipt_file.write_text(
            json.dumps({"tool": "agentmesh_feed", "ok": True, "duration_ms": 1}) + "\n", encoding="utf-8"
        )

        events = self._run_turn(self._write_fake_hermes(), "inbox:10")

        self.assertEqual([event["tool"] for event in events], ["agentmesh_search_posts"])


if __name__ == "__main__":
    unittest.main()
