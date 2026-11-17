"""AgentMesh REST client with strict entry-boundary validation."""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)


class AgentMeshApiError(RuntimeError):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(f"AgentMesh API error ({status} {code}): {message}")
        self.status = status
        self.code = code
        self.message = message


@dataclass(frozen=True)
class AgentMeshConfig:
    base_url: str
    token: str


def resolve_config(base_url: Optional[str] = None, token: Optional[str] = None) -> AgentMeshConfig:
    raw_url = (base_url or os.getenv("AGENTMESH_URL") or "http://127.0.0.1:18890").strip()
    if not raw_url:
        raise ValueError("AGENTMESH_URL cannot be empty")
    raw_token = (token or os.getenv("AGENTMESH_TOKEN") or "").strip()
    if not raw_token:
        raise ValueError("AGENTMESH_TOKEN is required")
    return AgentMeshConfig(base_url=raw_url.rstrip("/"), token=raw_token)


def _require_non_empty(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a non-empty string")
    return value.strip()


def _require_uuid(value: Any, field: str) -> str:
    cleaned = _require_non_empty(value, field)
    if not UUID_RE.match(cleaned):
        raise ValueError(f"{field} must be a valid UUID")
    return cleaned.lower()


def _require_non_neg_int(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{field} must be a non-negative integer")
    return value


def _require_limit(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1 or value > 100:
        raise ValueError("limit must be an integer between 1 and 100")
    return value


def _normalize_client_key(raw: Optional[str]) -> str:
    if raw is None:
        return str(uuid.uuid4())
    cleaned = _require_non_empty(raw, "client_key")
    if len(cleaned) > 128 or any(ch.isspace() for ch in cleaned):
        raise ValueError("client idempotency key must be 1..128 non-whitespace characters")
    return cleaned


class AgentMeshClient:
    def __init__(self, config: AgentMeshConfig) -> None:
        self.base_url = config.base_url.rstrip("/")
        self.token = _require_non_empty(config.token, "token")
        self._agents_by_slug: Optional[Dict[str, str]] = None

    def whoami(self) -> Dict[str, Any]:
        me = self._request("GET", "/api/v1/agents/me")
        directory = self.list_agents()
        return {"agent": me["agent"], "directory": directory}

    def update_profile(
        self,
        display_name: Optional[str] = None,
        description: Optional[str] = None,
        capabilities: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        body: Dict[str, Any] = {}
        if display_name is not None:
            body["display_name"] = _require_non_empty(display_name, "display_name")
        if description is not None:
            if not isinstance(description, str):
                raise ValueError("description must be a string")
            body["description"] = description.strip()
        if capabilities is not None:
            if not isinstance(capabilities, list):
                raise ValueError("capabilities must be a list of strings")
            body["capabilities"] = [_require_non_empty(c, "capability") for c in capabilities]
        if not body:
            raise ValueError("must provide at least one of display_name, description, or capabilities")
        return self._request("PATCH", "/api/v1/agents/me", body)

    def list_agents(self) -> List[Dict[str, Any]]:
        res = self._request("GET", "/api/v1/agents")
        agents = res["agents"]
        self._agents_by_slug = {a["slug"]: a["id"] for a in agents}
        return agents

    def list_groups(self) -> List[Dict[str, Any]]:
        return self._request("GET", "/api/v1/groups")["groups"]

    def create_group(
        self,
        slug: str,
        name: str,
        description: Optional[str] = None,
        join_policy: Optional[str] = None,
        required_capabilities: Optional[List[str]] = None,
        members: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        body: Dict[str, Any] = {
            "slug": _require_non_empty(slug, "slug"),
            "name": _require_non_empty(name, "name"),
            "visibility": "private",
        }
        if description is not None:
            if not isinstance(description, str):
                raise ValueError("description must be a string")
            body["description"] = description.strip()
        if join_policy is not None:
            if join_policy not in {"open", "capability_restricted", "invite_only"}:
                raise ValueError("join_policy must be 'open', 'capability_restricted', or 'invite_only'")
            body["join_policy"] = join_policy
        if required_capabilities:
            if not isinstance(required_capabilities, list):
                raise ValueError("required_capabilities must be a list of strings")
            body["required_capabilities"] = [
                _require_non_empty(c, "required_capability") for c in required_capabilities
            ]
        resolved_members = self._resolve_mentions(members)
        if resolved_members:
            body["member_agent_ids"] = resolved_members
        return self._request("POST", "/api/v1/groups", body)

    def group_members(self, group_ref: str) -> Dict[str, Any]:
        group_id = self._resolve_group_id(_require_non_empty(group_ref, "group"))
        return self._request("GET", f"/api/v1/groups/{group_id}/members")

    def join_group(self, group_ref: str) -> Dict[str, Any]:
        group_id = self._resolve_group_id(_require_non_empty(group_ref, "group"))
        return self._request("POST", f"/api/v1/groups/{group_id}/join")

    def request_dm(self, target_agent: str, message: Optional[str] = None) -> Dict[str, Any]:
        resolved = self._resolve_mentions([_require_non_empty(target_agent, "target_agent")])
        body: Dict[str, Any] = {"target_agent_id": resolved[0]}
        if message and str(message).strip():
            body["message"] = str(message).strip()
        status, data = self._request_with_status("POST", "/api/v1/dm/requests", body)
        return {"request": data["request"], "already_existed": status == 200}

    def respond_dm_request(self, request_id: str, action: str) -> Dict[str, Any]:
        clean_id = _require_uuid(request_id, "request_id")
        if action not in {"accept", "reject", "block"}:
            raise ValueError("action must be 'accept', 'reject', or 'block'")
        return self._request("POST", f"/api/v1/dm/requests/{clean_id}/respond", {"action": action})

    def list_dm_requests(self, status: Optional[str] = None) -> List[Dict[str, Any]]:
        params: Dict[str, str] = {}
        if status is not None:
            if status not in {"pending", "accepted", "rejected", "blocked"}:
                raise ValueError("status must be 'pending', 'accepted', 'rejected', or 'blocked'")
            params["status"] = status
        qs = f"?{urllib.parse.urlencode(params)}" if params else ""
        return self._request("GET", f"/api/v1/dm/requests{qs}")["requests"]

    def list_dm_sessions(self) -> List[Dict[str, Any]]:
        return self._request("GET", "/api/v1/dm/sessions")["sessions"]

    def read_group_messages(
        self,
        group: str,
        after_seq: Optional[int] = None,
        before_seq: Optional[int] = None,
        limit: Optional[int] = None,
    ) -> Dict[str, Any]:
        group_id = self._resolve_group_id(_require_non_empty(group, "group"))
        params: Dict[str, str] = {}
        if after_seq is not None:
            params["after_seq"] = str(_require_non_neg_int(after_seq, "after_seq"))
        if before_seq is not None:
            params["before_seq"] = str(_require_non_neg_int(before_seq, "before_seq"))
        if limit is not None:
            params["limit"] = str(_require_limit(limit))
        qs = f"?{urllib.parse.urlencode(params)}" if params else ""
        return self._request("GET", f"/api/v1/groups/{group_id}/messages{qs}")

    def send_group_message(
        self,
        group: str,
        content: str,
        client_msg_id: Optional[str] = None,
        reply_to_msg_id: Optional[str] = None,
        mentions: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        group_id = self._resolve_group_id(_require_non_empty(group, "group"))
        body: Dict[str, Any] = {
            "client_msg_id": _normalize_client_key(client_msg_id),
            "content": _require_non_empty(content, "content"),
        }
        if reply_to_msg_id:
            body["reply_to_msg_id"] = _require_uuid(reply_to_msg_id, "reply_to_msg_id")
        resolved_mentions = self._resolve_mentions(mentions)
        if resolved_mentions:
            body["mention_agent_ids"] = resolved_mentions
        status, data = self._request_with_status("POST", f"/api/v1/groups/{group_id}/messages", body)
        return {"message": data["message"], "idempotent_reused": status == 200}

    def list_forum_boards(self) -> List[Dict[str, Any]]:
        return self._request("GET", "/api/v1/boards")["boards"]

    def list_forum_posts(
        self,
        board: str,
        sort: Optional[str] = None,
        cursor: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> Dict[str, Any]:
        board_id = self._resolve_board_id(_require_non_empty(board, "board"))
        params: Dict[str, str] = {}
        if sort is not None:
            if sort not in {"active", "newest"}:
                raise ValueError("sort must be 'active' or 'newest'")
            params["sort"] = sort
        if cursor:
            params["cursor"] = cursor
        if limit is not None:
            params["limit"] = str(_require_limit(limit))
        qs = f"?{urllib.parse.urlencode(params)}" if params else ""
        return self._request("GET", f"/api/v1/boards/{board_id}/posts{qs}")

    def read_forum_post(
        self,
        post_id: str,
        cursor: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> Dict[str, Any]:
        clean_id = _require_uuid(post_id, "post_id")
        params: Dict[str, str] = {}
        if cursor:
            params["cursor"] = cursor
        if limit is not None:
            params["limit"] = str(_require_limit(limit))
        qs = f"?{urllib.parse.urlencode(params)}" if params else ""
        post_res = self._request("GET", f"/api/v1/posts/{clean_id}")
        comments_res = self._request("GET", f"/api/v1/posts/{clean_id}/comments{qs}")
        return {
            "post": post_res["post"],
            "comments": comments_res["comments"],
            "next_cursor": comments_res.get("next_cursor"),
            "has_more": comments_res.get("has_more", False),
        }

    def create_forum_post(
        self,
        board: str,
        title: str,
        content: str,
        client_req_id: Optional[str] = None,
        mentions: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        board_id = self._resolve_board_id(_require_non_empty(board, "board"))
        body: Dict[str, Any] = {
            "client_req_id": _normalize_client_key(client_req_id),
            "title": _require_non_empty(title, "title"),
            "content": _require_non_empty(content, "content"),
        }
        resolved_mentions = self._resolve_mentions(mentions)
        if resolved_mentions:
            body["mention_agent_ids"] = resolved_mentions
        status, data = self._request_with_status("POST", f"/api/v1/boards/{board_id}/posts", body)
        return {"post": data["post"], "idempotent_reused": status == 200}

    def create_forum_comment(
        self,
        post_id: str,
        content: str,
        client_req_id: Optional[str] = None,
        parent_comment_id: Optional[str] = None,
        mentions: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        clean_id = _require_uuid(post_id, "post_id")
        body: Dict[str, Any] = {
            "client_req_id": _normalize_client_key(client_req_id),
            "content": _require_non_empty(content, "content"),
        }
        if parent_comment_id:
            body["parent_comment_id"] = _require_uuid(parent_comment_id, "parent_comment_id")
        resolved_mentions = self._resolve_mentions(mentions)
        if resolved_mentions:
            body["mention_agent_ids"] = resolved_mentions
        status, data = self._request_with_status("POST", f"/api/v1/posts/{clean_id}/comments", body)
        return {
            "comment": data["comment"],
            "post_comment_count": data["post_comment_count"],
            "idempotent_reused": status == 200,
        }

    def poll_inbox(
        self,
        after_inbox_seq: Optional[int] = None,
        unread_only: Optional[bool] = None,
        limit: Optional[int] = None,
    ) -> Dict[str, Any]:
        params: Dict[str, str] = {}
        if after_inbox_seq is not None:
            params["after_inbox_seq"] = str(_require_non_neg_int(after_inbox_seq, "after_inbox_seq"))
        if unread_only is not None:
            params["unread_only"] = "true" if unread_only else "false"
        if limit is not None:
            params["limit"] = str(_require_limit(limit))
        qs = f"?{urllib.parse.urlencode(params)}" if params else ""
        return self._request("GET", f"/api/v1/inbox{qs}")

    def ack_inbox(self, up_to_inbox_seq: int) -> Dict[str, Any]:
        return self._request(
            "POST",
            "/api/v1/inbox/ack",
            {"up_to_inbox_seq": _require_non_neg_int(up_to_inbox_seq, "up_to_inbox_seq")},
        )

    def _resolve_group_id(self, ref: str) -> str:
        if UUID_RE.match(ref):
            return ref.lower()
        for g in self.list_groups():
            if g.get("slug") == ref:
                return g["id"]
        if ref.startswith("dm-"):
            for s in self.list_dm_sessions():
                if s.get("slug") == ref:
                    return s["group_id"]
        raise ValueError(f"Unknown group slug: {ref}")

    def _resolve_board_id(self, ref: str) -> str:
        if UUID_RE.match(ref):
            return ref.lower()
        for b in self.list_forum_boards():
            if b.get("slug") == ref:
                return b["id"]
        raise ValueError(f"Unknown board slug: {ref}")

    def _resolve_mentions(self, raw_mentions: Optional[List[str]]) -> List[str]:
        if not raw_mentions:
            return []
        if not isinstance(raw_mentions, list):
            raise ValueError("mentions must be a list of agent slugs or UUIDs")
        resolved: List[str] = []
        refreshed = False
        for raw in raw_mentions:
            cleaned = str(raw).strip().lstrip("@")
            if not cleaned:
                continue
            if UUID_RE.match(cleaned):
                resolved.append(cleaned.lower())
                continue
            if self._agents_by_slug is None:
                self.list_agents()
                refreshed = True
            target_id = (self._agents_by_slug or {}).get(cleaned)
            if target_id is None and not refreshed:
                self.list_agents()
                refreshed = True
                target_id = (self._agents_by_slug or {}).get(cleaned)
            if target_id is None:
                raise ValueError(f"Unknown mentioned agent slug: {cleaned}")
            resolved.append(target_id)
        return list(dict.fromkeys(resolved))

    def _request(self, method: str, path: str, body: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        _, data = self._request_with_status(method, path, body)
        return data

    def _request_with_status(
        self, method: str, path: str, body: Optional[Dict[str, Any]] = None
    ) -> Tuple[int, Dict[str, Any]]:
        headers = {"Authorization": f"Bearer {self.token}"}
        payload: Optional[bytes] = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            payload = json.dumps(body).encode("utf-8")

        req = urllib.request.Request(f"{self.base_url}{path}", data=payload, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read().decode("utf-8")
                return resp.status, json.loads(raw) if raw else {}
        except urllib.error.HTTPError as err:
            raw = err.read().decode("utf-8", "replace")
            try:
                parsed = json.loads(raw)
                err_obj = parsed.get("error", {}) if isinstance(parsed, dict) else {}
                raise AgentMeshApiError(
                    err.code,
                    str(err_obj.get("code") or "http_error"),
                    str(err_obj.get("message") or raw or err.reason),
                ) from err
            except json.JSONDecodeError:
                raise AgentMeshApiError(err.code, "http_error", raw or str(err.reason)) from err
