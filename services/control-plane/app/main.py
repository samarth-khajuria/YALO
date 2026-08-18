"""control-plane (public, port 8000).

Login/auth, routes chat to a persona service, persists chat to Postgres,
caches recent messages in Redis, and serves the API the UI calls. The two
persona services are internal-only; only this service calls them.

Everything degrades gracefully if Redis is down. Config comes entirely from
environment variables (see .env.example).
"""
import hmac
import os
import time
import uuid

import httpx
import jwt
import redis
import sqlalchemy as sa
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# --- config from environment ---
PORT = int(os.getenv("PORT", "8000"))
UI_ORIGIN = os.getenv("UI_ORIGIN", "*")
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://app:app@postgres:5432/appdb")
REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/0")
JWT_SECRET = os.getenv("JWT_SECRET", "change-me")
LOGIN_EMAIL = os.getenv("LOGIN_EMAIL", "tester@wns.com")
LOGIN_PASSWORD = os.getenv("LOGIN_PASSWORD", "halotest")

PERSONA_URLS = {
    "cowboy": os.getenv("COWBOY_SERVICE_URL", "http://cowboy-service:8001"),
    "osho": os.getenv("OSHO_SERVICE_URL", "http://osho-service:8002"),
}

TOKEN_TTL_SECONDS = 3600  # ~1 hour
RECENT_MAX = 50           # capped recent list per session+persona
RECENT_TTL = 3600         # ~1 hour

# Dialect-specific DDL. Postgres is the deployment target; SQLite is supported
# so the app can run locally with no external database (no Docker required).
_CREATE_TABLE_DDL = {
    "postgresql": """
        CREATE TABLE IF NOT EXISTS messages (
            id BIGSERIAL PRIMARY KEY,
            session_id TEXT NOT NULL,
            persona TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    """,
    "sqlite": """
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            persona TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    """,
}

# SQLite (local no-Docker run) needs check_same_thread disabled because FastAPI
# runs sync endpoints across a thread pool.
_connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = sa.create_engine(DATABASE_URL, pool_pre_ping=True, future=True, connect_args=_connect_args)

app = FastAPI(title="control-plane")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[UI_ORIGIN] if UI_ORIGIN != "*" else ["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_redis():
    """Return a Redis client, or None if unreachable. Never raises."""
    try:
        client = redis.from_url(REDIS_URL, decode_responses=True, socket_connect_timeout=2)
        client.ping()
        return client
    except Exception:
        return None


@app.on_event("startup")
def on_startup():
    # Create the messages table idempotently so this works against managed or
    # in-cluster databases that never run an init script.
    ddl = _CREATE_TABLE_DDL.get(engine.dialect.name, _CREATE_TABLE_DDL["postgresql"])
    with engine.begin() as conn:
        conn.execute(sa.text(ddl))


# ----------------------------- models -------------------------------------
class LoginIn(BaseModel):
    email: str
    password: str


class ChatIn(BaseModel):
    persona: str
    message: str


# ----------------------------- auth ---------------------------------------
def make_token() -> tuple[str, str]:
    jti = uuid.uuid4().hex
    now = int(time.time())
    payload = {"sub": LOGIN_EMAIL, "jti": jti, "iat": now, "exp": now + TOKEN_TTL_SECONDS}
    token = jwt.encode(payload, JWT_SECRET, algorithm="HS256")
    return token, jti


def require_auth(authorization: str | None = Header(default=None)) -> str:
    """Validate the Bearer JWT and return the session id (the token's jti).

    Verifies signature + expiry. If Redis is up, also requires the session key
    to still exist; if Redis is down, a validly-signed token is accepted.
    """
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = authorization.split(" ", 1)[1].strip()
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    jti = payload.get("jti")
    if not jti:
        raise HTTPException(status_code=401, detail="Invalid token")

    r = get_redis()
    if r is not None:
        try:
            if not r.exists(f"session:{jti}"):
                raise HTTPException(status_code=401, detail="Session expired")
        except HTTPException:
            raise
        except Exception:
            pass  # Redis hiccup: fall back to accepting the signed token.
    return jti


# ----------------------------- endpoints -----------------------------------
@app.get("/health")
def health():
    # Liveness: never touches dependencies.
    return {"status": "ok", "service": "control-plane"}


@app.get("/ready")
def ready():
    # Readiness: the DB must be reachable.
    try:
        with engine.connect() as conn:
            conn.execute(sa.text("SELECT 1"))
    except Exception:
        raise HTTPException(status_code=503, detail="database unreachable")
    return {"status": "ok"}


@app.post("/login")
def login(body: LoginIn):
    email_ok = hmac.compare_digest(body.email, LOGIN_EMAIL)
    pw_ok = hmac.compare_digest(body.password, LOGIN_PASSWORD)
    if not (email_ok and pw_ok):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    token, jti = make_token()
    r = get_redis()
    if r is not None:
        try:
            r.setex(f"session:{jti}", TOKEN_TTL_SECONDS, LOGIN_EMAIL)
        except Exception:
            pass  # fail-soft: login still succeeds without Redis.
    return {"token": token}


@app.post("/api/chat")
def chat(body: ChatIn, session_id: str = Depends(require_auth)):
    persona = body.persona
    if persona not in PERSONA_URLS:
        raise HTTPException(status_code=400, detail="Unknown persona")

    try:
        resp = httpx.post(
            f"{PERSONA_URLS[persona]}/reply",
            json={"message": body.message},
            timeout=35.0,
        )
        resp.raise_for_status()
        reply = resp.json()["reply"]
    except Exception:
        raise HTTPException(status_code=502, detail="persona service unreachable")

    # Persist both messages to Postgres (source of truth).
    insert = sa.text(
        "INSERT INTO messages (session_id, persona, role, content) "
        "VALUES (:sid, :persona, :role, :content)"
    )
    with engine.begin() as conn:
        conn.execute(insert, {"sid": session_id, "persona": persona, "role": "user", "content": body.message})
        conn.execute(insert, {"sid": session_id, "persona": persona, "role": "assistant", "content": reply})

    # Cache recent messages in Redis (optimization; fail-soft).
    r = get_redis()
    if r is not None:
        try:
            key = f"recent:{session_id}:{persona}"
            r.rpush(key, f"user::{body.message}", f"assistant::{reply}")
            r.ltrim(key, -RECENT_MAX, -1)
            r.expire(key, RECENT_TTL)
        except Exception:
            pass

    return {"persona": persona, "reply": reply}


@app.get("/api/history")
def history(persona: str, session_id: str = Depends(require_auth)):
    if persona not in PERSONA_URLS:
        raise HTTPException(status_code=400, detail="Unknown persona")

    select = sa.text(
        "SELECT role, persona, content FROM messages "
        "WHERE session_id = :sid AND persona = :persona "
        "ORDER BY id ASC"
    )
    with engine.connect() as conn:
        rows = conn.execute(select, {"sid": session_id, "persona": persona}).mappings().all()
    messages = [{"role": row["role"], "persona": row["persona"], "content": row["content"]} for row in rows]
    return {"messages": messages}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORT)
