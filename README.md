# YALO

A small, throwaway, multi-service chat app whose real purpose is to practice
hosting a multi-service website on TrueFoundry end to end. The app is a vehicle —
the valuable parts are the **connections between services** and the
**containerization**, because those are what the hosting exercise tests.

See [`PROJECT-BRIEF.md`](PROJECT-BRIEF.md) for the full specification.

## What's inside

| Workload | Role | Port | Public |
|---|---|---|---|
| `control-plane` | login, auth, chat routing, persistence, the UI's API | 8000 | Yes |
| `cowboy-service` | cowboy-tone reply (LLM) | 8001 | No (internal) |
| `osho-service` | Osho-tone reply (LLM) | 8002 | No (internal) |
| `ui` | two static pages via nginx | 80 | Yes |
| `postgres` | durable chat store | 5432 | No |
| `redis` | session + recent-message cache | 6379 | No |

**Request flow:** browser → UI → `control-plane /api/chat` → `cowboy-service` or
`osho-service` `/reply` → control-plane writes both messages to Postgres and
caches recent ones in Redis → reply returned to the browser. The persona
services are never exposed publicly; only the control-plane calls them.

Each persona answers via a real LLM through the **TrueFoundry AI Gateway**
(an OpenAI-compatible endpoint), set by env: `LLM_BASE_URL` is the gateway base
URL, `LLM_API_KEY` is a TrueFoundry Personal Access Token, and `LLM_MODEL` uses
the gateway's `provider_account/model_name` form (e.g. `openai-main/gpt-4o-mini`).
If no key is configured or the call fails, it returns a graceful in-character
fallback line, so a reply always comes back.

## Run locally

Prerequisites: **Docker Desktop** (or Docker Engine + Compose v2).

```bash
cp .env.example .env
# edit .env: set LLM_API_KEY (optional — omit to see fallback lines),
# and change JWT_SECRET / LOGIN_PASSWORD if you like.

docker compose up --build
```

Then:

1. Open <http://localhost:8080>.
2. Log in as `tester@wns.com` / `halotest`.
3. Toggle between **Cowboy** and **Osho** and chat — replies persist across reloads.

The control-plane API is on <http://localhost:8000> (`/health`, `/ready`, `/login`,
`/api/chat`, `/api/history`).

### Verify the plumbing

```bash
# Persistence — rows land in Postgres:
docker compose exec postgres psql -U app -d appdb -c "SELECT role, persona, left(content,40) FROM messages ORDER BY id;"

# Cache — recent keys appear in Redis:
docker compose exec redis redis-cli KEYS '*'

# Auth — no token is rejected:
curl -i -X POST http://localhost:8000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"persona":"cowboy","message":"howdy"}'   # -> 401
```

## Configuration

All wiring is environment-driven, so the same images run locally and in the
cloud with only the values changing. See [`.env.example`](.env.example) for the
full list (login credentials, `JWT_SECRET`, LLM settings, service URLs, and the
Postgres/Redis connection strings). `.env` is gitignored — never commit real
secrets.

The UI reads its backend URL from a runtime `config.js` generated at container
start from `CONTROL_PLANE_URL`, so the same UI image points at `localhost`
locally and at the deployed control-plane in the cloud with no rebuild.

## Deploy summary (TrueFoundry)

Full steps are in `PROJECT-BRIEF.md` §10. In short: deploy Postgres and Redis
in-cluster, create the secrets, deploy the persona services (internal) then the
control-plane (exposed) wired to the internal service DNS names, deploy the UI
(exposed) with `CONTROL_PLANE_URL` set to the control-plane's public endpoint,
and enable TrueFoundry's port-level endpoint authentication on the two public
services.
