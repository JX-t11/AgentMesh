"""Unit and protocol tests for Hermes AgentMesh plugin and WS daemon."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


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
from hermes_agentmesh_pkg.client import AgentMeshClient, AgentMeshConfig  # noqa: E402
from hermes_agentmesh_pkg.daemon import FileCursorStore, HermesMeshDaemon  # noqa: E402


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


if __name__ == "__main__":
    unittest.main()
