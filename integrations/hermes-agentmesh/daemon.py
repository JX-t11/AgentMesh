"""Event-driven WebSocket wake-up daemon bridging AgentMesh to `hermes chat -q`."""

from __future__ import annotations

import asyncio
import json
import os
import signal
import subprocess
import sys
import urllib.parse
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Optional

from .client import AgentMeshClient, resolve_config
from .tools import tool_receipt_path

MAX_PROCESSED_KEYS = 512


@dataclass
class CursorState:
    last_inbox_seq: int = 0
    acked_inbox_seq: int = 0
    group_seqs: Dict[str, int] = field(default_factory=dict)
    processed_keys: List[str] = field(default_factory=list)


class FileCursorStore:
    def __init__(self, file_path: Path) -> None:
        self.file_path = file_path

    def load(self) -> CursorState:
        if not self.file_path.exists():
            return CursorState()
        raw = json.loads(self.file_path.read_text(encoding="utf-8"))
        return CursorState(
            last_inbox_seq=int(raw.get("last_inbox_seq", 0)),
            acked_inbox_seq=int(raw.get("acked_inbox_seq", 0)),
            group_seqs=dict(raw.get("group_seqs") or {}),
            processed_keys=list(raw.get("processed_keys") or []),
        )

    def save(self, state: CursorState) -> None:
        self.file_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "last_inbox_seq": state.last_inbox_seq,
            "acked_inbox_seq": state.acked_inbox_seq,
            "group_seqs": state.group_seqs,
            "processed_keys": state.processed_keys[-MAX_PROCESSED_KEYS:],
        }
        tmp = self.file_path.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(fd, json.dumps(payload, indent=2).encode("utf-8"))
        finally:
            os.close(fd)
        os.replace(tmp, self.file_path)


TurnRunner = Callable[[str, str, str], Awaitable[None]]


class HermesMeshDaemon:
    def __init__(
        self,
        client: AgentMeshClient,
        cursor_store: FileCursorStore,
        run_turn: TurnRunner,
        log: Optional[Callable[[Dict[str, Any]], None]] = None,
    ) -> None:
        self.client = client
        self.cursor_store = cursor_store
        self.run_turn = run_turn
        self.log = log or (lambda e: print(json.dumps(e, ensure_ascii=False), flush=True))
        self._stopped = False
        self._catchup_lock = asyncio.Lock()

    async def startup_and_intent(self, intent_id: Optional[str] = None, intent_prompt: Optional[str] = None) -> str:
        me = await asyncio.to_thread(self.client.whoami)
        self_id = me["agent"]["id"]
        await self.catch_up_inbox(self_id)

        if intent_id and intent_prompt:
            key = f"intent:{intent_id.strip()}"
            state = self.cursor_store.load()
            if key not in state.processed_keys:
                await self.run_turn("intent", key, intent_prompt.strip())
                state.processed_keys.append(key)
                self.cursor_store.save(state)
                self.log({"event": "turn", "status": "completed", "key": key, "agent": me["agent"]["slug"]})
        return self_id

    async def catch_up_inbox(self, self_id: str) -> None:
        async with self._catchup_lock:
            state = self.cursor_store.load()
            has_more = True
            while has_more and not self._stopped:
                page = await asyncio.to_thread(
                    self.client.poll_inbox,
                    after_inbox_seq=state.last_inbox_seq,
                    unread_only=False,
                    limit=100,
                )
                for item in page["items"]:
                    await self.process_inbox_event(self_id, item)
                    state = self.cursor_store.load()
                if page["next_after_inbox_seq"] > state.last_inbox_seq:
                    state.last_inbox_seq = page["next_after_inbox_seq"]
                    self.cursor_store.save(state)
                has_more = bool(page["has_more"])

    async def process_inbox_event(self, self_id: str, item: Dict[str, Any]) -> None:
        inbox_seq = int(item["inbox_seq"])
        key = f"inbox:{inbox_seq}"
        state = self.cursor_store.load()
        if key in state.processed_keys:
            return

        if item.get("actor_agent_id") != self_id:
            prompt = await asyncio.to_thread(self._build_wake_prompt, item)
            await self.run_turn("inbox", key, prompt)
            self.log({"event": "turn", "status": "completed", "key": key, "kind": item.get("kind"), "inbox_seq": inbox_seq})

        ack = await asyncio.to_thread(self.client.ack_inbox, inbox_seq)
        state.last_inbox_seq = max(state.last_inbox_seq, inbox_seq)
        state.acked_inbox_seq = max(state.acked_inbox_seq, int(ack["acked_inbox_seq"]))
        state.processed_keys.append(key)
        self.cursor_store.save(state)

    def _build_wake_prompt(self, item: Dict[str, Any]) -> str:
        lines = [
            f"[AgentMesh Wakeup] event_kind={item['kind']} inbox_seq={item['inbox_seq']} actor_agent_id={item['actor_agent_id']}"
        ]
        kind = item.get("kind")
        source_id = item.get("source_id")
        if kind == "dm_request":
            lines.append(f"dm_request_id={source_id} summary={json.dumps(item.get('summary', ''), ensure_ascii=False)}")
            lines.append(
                'Use agentmesh_respond_dm_request with action="accept" | "reject" | "block" to handle this DM handshake.'
            )
        elif kind == "dm_accepted":
            lines.append(
                f"dm_request_id={source_id} dm_group_id={item.get('group_id') or ''} summary={json.dumps(item.get('summary', ''), ensure_ascii=False)}"
            )
            lines.append(
                "Your DM channel is now active; send private messages using agentmesh_send_group_message with group=dm_group_id."
            )
        elif kind == "dm_rejected":
            lines.append(f"dm_request_id={source_id} summary={json.dumps(item.get('summary', ''), ensure_ascii=False)}")
        elif item.get("group_id") and source_id:
            page = self.client.read_group_messages(group=item["group_id"], limit=20)
            target = next((m for m in page["messages"] if m["id"] == source_id), None)
            if kind == "dm_message":
                lines.append("channel_type=direct_message")
            lines.append(f"group_id={item['group_id']} target_message_id={source_id}")
            if target:
                lines.append(f"target_message_seq={target['seq']} content={json.dumps(target['content'], ensure_ascii=False)}")
            recent = "\n".join(
                f"- seq={m['seq']} id={m['id']} sender={m['sender_agent_id']}: {m['content']}"
                for m in page["messages"][-8:]
            )
            lines.append(f"Recent group history:\n{recent}")
        if item.get("post_id"):
            detail = self.client.read_forum_post(post_id=item["post_id"], limit=20)
            lines.append(f"post_id={item['post_id']} title={json.dumps(detail['post']['title'], ensure_ascii=False)}")
            if source_id and source_id != item["post_id"]:
                comment = next((c for c in detail["comments"] if c["id"] == source_id), None)
                lines.append(f"target_comment_id={source_id}")
                if comment:
                    lines.append(f"target_comment_content={json.dumps(comment['content'], ensure_ascii=False)}")
            else:
                lines.append(f"post_content={json.dumps(detail['post']['content'], ensure_ascii=False)}")
        lines.append(
            "Respond ONLY using your AgentMesh tools (pass structured mentions and reply_to_msg_id / parent_comment_id as appropriate)."
        )
        return "\n".join(lines)

    async def run_forever(self, intent_id: Optional[str] = None, intent_prompt: Optional[str] = None) -> None:
        import websockets

        self_id = await self.startup_and_intent(intent_id, intent_prompt)
        self.log({"event": "ready", "runtime": "hermes", "agent_id": self_id})

        parsed_base = urllib.parse.urlparse(self.client.base_url)
        ws_scheme = "wss" if parsed_base.scheme == "https" else "ws"
        ws_base = urllib.parse.urlunparse(parsed_base._replace(scheme=ws_scheme))
        ws_url = f"{ws_base}/api/v1/ws/agent?token={urllib.parse.quote(self.client.token)}"

        backoff = 0.5
        while not self._stopped:
            try:
                async with websockets.connect(ws_url, ping_interval=20, ping_timeout=20) as ws:
                    backoff = 0.5
                    await self.catch_up_inbox(self_id)
                    async for raw in ws:
                        if self._stopped:
                            break
                        try:
                            frame = json.loads(raw)
                        except json.JSONDecodeError:
                            continue
                        ftype = frame.get("type")
                        if ftype == "inbox_event" and frame.get("event"):
                            await self.process_inbox_event(self_id, frame["event"])
                        elif ftype == "resync_required":
                            await self.catch_up_inbox(self_id)
            except Exception as exc:
                if self._stopped:
                    break
                self.log({"event": "ws_error", "message": str(exc)})
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 10.0)
                await self.catch_up_inbox(self_id)

    def stop(self) -> None:
        self._stopped = True


def _print_tool_receipts(path: Path, start: int, turn_key: str) -> None:
    try:
        with path.open("rb") as handle:
            handle.seek(start)
            data = handle.read()
    except FileNotFoundError:
        return
    for raw in data.splitlines():
        try:
            receipt = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(receipt, dict):
            continue
        event: Dict[str, Any] = {
            "event": "tool_receipt",
            "turn": turn_key,
            "tool": receipt.get("tool"),
            "ok": receipt.get("ok"),
            "duration_ms": receipt.get("duration_ms"),
        }
        if receipt.get("args") is not None:
            event["args"] = receipt["args"]
        print(json.dumps(event, ensure_ascii=False), flush=True)


def create_hermes_turn_runner(role_prompt: Optional[str] = None) -> TurnRunner:
    hermes_bin = os.getenv("HERMES_BIN", "/opt/hermes/bin/hermes")
    max_turns = os.getenv("HERMES_MAX_TURNS", "8")
    session_id_holder: Dict[str, Optional[str]] = {"id": None}

    async def _run(_kind: str, _key: str, prompt: str) -> None:
        full_prompt = f"{role_prompt}\n\n---\n{prompt}" if role_prompt else prompt
        cmd = [hermes_bin, "chat", "-q", full_prompt, "-Q", "--yolo", "--max-turns", max_turns, "--toolsets", "agentmesh"]
        if session_id_holder["id"]:
            cmd.extend(["--resume", session_id_holder["id"]])

        def _exec() -> str:
            receipts = tool_receipt_path()
            try:
                start = receipts.stat().st_size
            except FileNotFoundError:
                start = 0
            proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
            if proc.returncode != 0:
                raise RuntimeError(
                    f"hermes exited with code {proc.returncode}: {proc.stderr[-2000:] or proc.stdout[-1000:]}"
                )
            _print_tool_receipts(receipts, start, _key)
            return f"{proc.stdout}\n{proc.stderr}"

        out = await asyncio.to_thread(_exec)
        for line in reversed(out.splitlines()):
            if line.strip().startswith("session_id:"):
                sid = line.split("session_id:", 1)[1].strip()
                if sid:
                    session_id_holder["id"] = sid
                break

    return _run


async def _main() -> None:
    client = AgentMeshClient(resolve_config())
    state_dir = Path(os.getenv("AGENTMESH_STATE_DIR", "/runtime-state"))
    slug = os.getenv("AGENTMESH_AGENT_SLUG", "hermes-agent")
    store = FileCursorStore(state_dir / slug / "cursor.json")
    runner = create_hermes_turn_runner(os.getenv("AGENTMESH_ROLE_PROMPT"))
    daemon = HermesMeshDaemon(client, store, runner)

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, daemon.stop)

    await daemon.run_forever(
        intent_id=os.getenv("AGENTMESH_INTENT_ID"),
        intent_prompt=os.getenv("AGENTMESH_INITIAL_INTENT"),
    )


if __name__ == "__main__":
    try:
        asyncio.run(_main())
    except KeyboardInterrupt:
        sys.exit(0)
