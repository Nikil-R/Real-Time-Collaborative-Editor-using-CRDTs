"""WebSocket message validation (docs/04-PROTOCOL.md).

The server checks only the SHAPE of messages. It never interprets what an
operation means: ordering, tombstones and conflicts belong to the clients.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError, field_validator

PROTOCOL_VERSION = 1

# Error codes (04-PROTOCOL.md section 3.7). REPLICA_IN_USE and DOC_NOT_FOUND
# close the connection.
BAD_MESSAGE = "BAD_MESSAGE"
TOO_LARGE = "TOO_LARGE"
RATE_LIMITED = "RATE_LIMITED"
DOC_NOT_FOUND = "DOC_NOT_FOUND"
REPLICA_IN_USE = "REPLICA_IN_USE"
INTERNAL = "INTERNAL"


class ProtocolError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class WireId(BaseModel):
    model_config = ConfigDict(extra="forbid")
    c: int = Field(ge=0)
    r: str = Field(max_length=128)


class OpId(BaseModel):
    model_config = ConfigDict(extra="forbid")
    r: str = Field(min_length=1, max_length=128)
    n: int = Field(ge=1)


class Op(BaseModel):
    """An operation as seen by the server: opaque apart from `op_id` and `kind`."""

    model_config = ConfigDict(extra="allow")
    op_id: OpId
    kind: Literal["ins", "del"]
    id: WireId | None = None
    origin: WireId | None = None
    ch: str | None = Field(default=None, max_length=2)
    target: WireId | None = None

    def check_shape(self) -> None:
        if self.kind == "ins" and (self.id is None or self.origin is None or not self.ch):
            raise ValueError("ins needs id, origin and ch")
        if self.kind == "del" and self.target is None:
            raise ValueError("del needs target")


class Hello(BaseModel):
    model_config = ConfigDict(extra="ignore")
    type: Literal["hello"]
    v: int
    last_seq: int = Field(default=0, ge=0)
    replica: str = Field(min_length=1, max_length=128)
    name: str = Field(default="Anonymous", max_length=64)
    color: str = Field(default="#888888", pattern=r"^#[0-9a-fA-F]{3,8}$")

    @field_validator("name")
    @classmethod
    def strip_name(cls, v: str) -> str:
        return v.strip() or "Anonymous"


class OpsMsg(BaseModel):
    model_config = ConfigDict(extra="ignore")
    type: Literal["ops"]
    batch_id: str = Field(min_length=1, max_length=128)
    ops: list[Op]


class PresenceMsg(BaseModel):
    model_config = ConfigDict(extra="ignore")
    type: Literal["presence"]
    anchor: WireId | None = None
    head: WireId | None = None


class PingMsg(BaseModel):
    model_config = ConfigDict(extra="ignore")
    type: Literal["ping"]
    t: int | float = 0


class SnapshotMsg(BaseModel):
    """Protocol v1.1: a client uploads its serialised state."""

    model_config = ConfigDict(extra="ignore")
    type: Literal["snapshot"]
    up_to_seq: int = Field(ge=1)
    state: dict[str, Any]


class SyncMsg(BaseModel):
    """Protocol v1.1: ask for the next page of catch-up operations."""

    model_config = ConfigDict(extra="ignore")
    type: Literal["sync"]
    last_seq: int = Field(ge=0)


ClientMessage = Annotated[
    Hello | OpsMsg | PresenceMsg | PingMsg | SnapshotMsg | SyncMsg,
    Field(discriminator="type"),
]
_adapter: TypeAdapter[ClientMessage] = TypeAdapter(ClientMessage)

KNOWN_TYPES = {"hello", "ops", "presence", "ping", "snapshot", "sync"}


def parse_client_message(data: Any, max_ops: int) -> ClientMessage:
    if not isinstance(data, dict):
        raise ProtocolError(BAD_MESSAGE, "message must be a JSON object")
    msg_type = data.get("type")
    if msg_type not in KNOWN_TYPES:
        raise ProtocolError(BAD_MESSAGE, f"unknown message type {msg_type!r}")
    if msg_type == "ops" and isinstance(data.get("ops"), list) and len(data["ops"]) > max_ops:
        raise ProtocolError(BAD_MESSAGE, "ops batch too large")
    try:
        msg = _adapter.validate_python(data)
    except ValidationError as exc:
        first = exc.errors()[0]
        loc = ".".join(str(p) for p in first["loc"])
        raise ProtocolError(BAD_MESSAGE, f"invalid {loc}: {first['msg']}") from exc
    if isinstance(msg, OpsMsg):
        try:
            for op in msg.ops:
                op.check_shape()
        except ValueError as exc:
            raise ProtocolError(BAD_MESSAGE, str(exc)) from exc
    if isinstance(msg, Hello) and msg.v != PROTOCOL_VERSION:
        raise ProtocolError(BAD_MESSAGE, f"unsupported protocol version {msg.v}")
    return msg


def error_message(code: str, message: str) -> dict[str, Any]:
    return {"type": "error", "code": code, "message": message}
