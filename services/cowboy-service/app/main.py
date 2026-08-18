"""cowboy-service (internal, port 8001).

Returns a reply in a cowboy tone. Calls an OpenAI-compatible chat-completions
endpoint; if the LLM is unconfigured or errors, returns a graceful fallback
line so the service always responds. Only the control-plane may reach it.
"""
import os

import httpx
from fastapi import FastAPI
from pydantic import BaseModel

PERSONA = "cowboy"

SYSTEM_PROMPT = (
    "You are a cowboy from the old American West. Speak with a warm, easy "
    "drawl, call the user 'partner', lean on frontier, cattle-trail, and "
    "campfire metaphors, and keep replies short and folksy. Never break "
    "character."
)

FALLBACK = "Well partner, my thinkin' rope's a mite tangled right now. Try me again in a spell."

# --- config from environment ---
PORT = int(os.getenv("PORT", "8001"))
LLM_API_KEY = os.getenv("LLM_API_KEY", "")
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "https://api.openai.com/v1").rstrip("/")
LLM_MODEL = os.getenv("LLM_MODEL", "gpt-4o-mini")

app = FastAPI(title=f"{PERSONA}-service")


class ReplyIn(BaseModel):
    message: str


def llm(message: str) -> str:
    """Provider-agnostic, OpenAI-compatible chat completion.

    Returns the persona fallback line if no key is set or the call fails.
    """
    if not LLM_API_KEY:
        return FALLBACK
    try:
        resp = httpx.post(
            f"{LLM_BASE_URL}/chat/completions",
            headers={"Authorization": f"Bearer {LLM_API_KEY}"},
            json={
                "model": LLM_MODEL,
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": message},
                ],
                "temperature": 0.8,
            },
            timeout=30.0,
        )
        resp.raise_for_status()
        content = resp.json()["choices"][0]["message"]["content"]
        return content.strip() if content else FALLBACK
    except Exception:
        return FALLBACK


@app.get("/health")
def health():
    return {"status": "ok", "service": f"{PERSONA}-service"}


@app.get("/ready")
def ready():
    # 200 always; the LLM is best-effort.
    return {"status": "ok", "llm_configured": bool(LLM_API_KEY)}


@app.post("/reply")
def reply(body: ReplyIn):
    return {"reply": llm(body.message), "persona": PERSONA}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORT)
