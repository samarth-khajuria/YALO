# tf-service-tester-chat — Project Brief

A complete build brief. An agent (or developer) with no prior context should be able to build, run, and deploy the whole project from this single document. It defines the intent, the final goal, the architecture, every component's spec, the connections, the Dockerfiles, and the three delivery phases (build, GitHub, TrueFoundry hosting).

---

## 1. Intent and final goal

**Intent.** A small, throwaway, multi-service web app whose real purpose is to learn how to host a multi-service website on TrueFoundry end to end. The app is a vehicle. The valuable parts are the connections between the services and the containerization (Dockerfiles), because those are what the hosting exercise tests.

**Final goal.** The app:
1. builds and runs locally with one `docker compose up`,
2. is pushed to a GitHub repo,
3. is hosted on TrueFoundry with every piece connected and working: the fixed test user can log in, chat with two different personas, and see the conversation persisted,
4. is reachable at a public URL and protected so that only the intended user can use it.

**Non-goals.** Not production-grade. Not a faithful replication of any larger system. Keep every service as small as it can be while still exercising the real connections. Do not add features beyond what is specified here.

---

## 2. Scope: what to build

- Three backend microservices in Python + FastAPI:
  - `control-plane` (public): login/auth, routes chat to a persona service, persists chat, serves the API the UI calls.
  - `cowboy-service` (internal): returns a reply in a cowboy tone.
  - `osho-service` (internal): returns a reply in an Osho tone.
- One static UI (two pages) served by nginx, deployed as its own service (public).
- PostgreSQL (durable chat store) and Redis (session + recent-message cache).

---

## 3. Architecture and request flow

| Workload | Role | Port | Public |
|---|---|---|---|
| control-plane | login, auth, routing, persistence, the UI's API | 8000 | Yes |
| cowboy-service | cowboy-tone reply (LLM) | 8001 | No (internal only) |
| osho-service | Osho-tone reply (LLM) | 8002 | No (internal only) |
| ui | two static pages via nginx | 80 | Yes |
| postgres | durable chat store | 5432 | No |
| redis | session + recent cache | 6379 | No |

Request flow: browser -> UI -> `control-plane /api/chat` -> `cowboy-service` or `osho-service` `/reply` -> reply -> control-plane writes both messages to Postgres and caches recent ones in Redis -> reply returned to the browser. The two persona services are never exposed publicly; only the control-plane may call them.

This mirrors the shape of a larger system (a control plane fronting internal services, talking to a UI, backed by Postgres and Redis). Only the connection pattern matters, not internal code style.

---

## 4. Project structure

```
tf-service-tester-chat/
  PROJECT-BRIEF.md            (this file)
  README.md                   (how to run locally; write during build)
  .gitignore                  (__pycache__, .env, .venv)
  .env.example                (all env vars with placeholders; real .env is gitignored)
  docker-compose.yml          (all six workloads for local run)
  init/01-schema.sql          (optional local DB bootstrap; see 5.4)
  services/
    control-plane/  Dockerfile  requirements.txt  app/__init__.py  app/main.py
    cowboy-service/ Dockerfile  requirements.txt  app/__init__.py  app/main.py
    osho-service/   Dockerfile  requirements.txt  app/__init__.py  app/main.py
  ui/
    Dockerfile  nginx.conf  entrypoint.sh  html/index.html  html/about.html  html/app.js  html/styles.css
```

Keep each service to a single small `app/main.py`. No adapter layers, ORMs beyond a thin engine, or settings frameworks.

---

## 5. Component specifications

### 5.1 control-plane (public, port 8000)

FastAPI app. Enable CORS for the UI origin (env `UI_ORIGIN`, default `*`). Reads all config from environment (section 6).

Endpoints:
- `GET /health` -> `{"status":"ok","service":"control-plane"}` (liveness; never touches dependencies).
- `GET /ready` -> checks Postgres with `SELECT 1`; returns 503 if the DB is unreachable, else `{"status":"ok"}` (readiness).
- `POST /login` body `{"email","password"}` -> compare against `LOGIN_EMAIL` / `LOGIN_PASSWORD` using a constant-time compare. On match, mint a JWT (HS256, signed with `JWT_SECRET`, ~1 hour expiry, a random `jti`), store `session:{jti}` in Redis with the same TTL (fail-soft if Redis is down), return `{"token": "<jwt>"}`. On mismatch, 401.
- `POST /api/chat` (auth required) body `{"persona":"cowboy"|"osho","message":"..."}` -> validate the persona, `httpx` POST to that service's `/reply` with `{"message":...}`, get `{"reply":...}`, persist the user message and the assistant reply to Postgres, push both onto the Redis recent list, return `{"persona":..., "reply":...}`. If the persona service is unreachable, 502.
- `GET /api/history?persona=cowboy` (auth required) -> return the recent messages for this session (from Postgres; Redis cache is an optimization) as `{"messages":[{"role","persona","content"}, ...]}` oldest-first.

Auth dependency: read the `Authorization: Bearer <jwt>` header, verify the signature and expiry, and if Redis is up, verify `session:{jti}` still exists; if Redis is down, accept a validly-signed token. Missing/invalid token -> 401. The session identity is the token's `jti`, used as `session_id` for storage.

Postgres access: one `sqlalchemy.create_engine(DATABASE_URL, pool_pre_ping=True, future=True)`; `sa.text()` with bound params; `.connect()` for reads, `.begin()` for writes. On startup, create the `messages` table idempotently (`CREATE TABLE IF NOT EXISTS`, see 5.4).

Redis access: a factory `redis.from_url(REDIS_URL, decode_responses=True, socket_connect_timeout=2)` that returns `None` on any failure; every Redis call is wrapped in try/except and degrades gracefully (the app must work even if Redis is down).

### 5.2 cowboy-service and osho-service (internal, ports 8001 and 8002)

Near-identical FastAPI apps; they differ only by persona name, system prompt, and fallback line.

Endpoints:
- `GET /health` -> `{"status":"ok","service":"<persona>-service"}`.
- `GET /ready` -> `{"status":"ok","llm_configured": <bool LLM_API_KEY present>}` (200 always; the LLM is best-effort).
- `POST /reply` body `{"message":"..."}` -> call the LLM with the persona system prompt, return `{"reply":"...","persona":"<persona>"}`.

LLM call (`llm`): provider-agnostic, OpenAI-compatible chat completions. POST to `${LLM_BASE_URL}/chat/completions` with header `Authorization: Bearer ${LLM_API_KEY}` and body `{model: LLM_MODEL, messages: [{role:"system",content:SYSTEM_PROMPT},{role:"user",content:message}], temperature: 0.8}`; read `choices[0].message.content`. Timeout ~30s. If `LLM_API_KEY` is empty or the call fails, return the persona's fallback line (graceful degradation, so the service always responds). The same interface works later against the TrueFoundry AI Gateway (also OpenAI-compatible). If the operator prefers Anthropic/Claude, the model id and base URL are just env values; check the current Claude model ids before setting them.

Persona system prompts (use verbatim or close):
- Cowboy: "You are a cowboy from the old American West. Speak with a warm, easy drawl, call the user 'partner', lean on frontier, cattle-trail, and campfire metaphors, and keep replies short and folksy. Never break character."
- Osho: "You are a serene meditation teacher in the spirit of Osho. Speak calmly and playfully, offering gentle paradoxes about presence, awareness, silence, and letting go. Keep replies short, poetic, and meditative. Never break character."

Fallback lines:
- Cowboy: "Well partner, my thinkin' rope's a mite tangled right now. Try me again in a spell."
- Osho: "Breathe. The words are resting just now. Ask again, and let the silence answer."

### 5.3 UI (public, nginx, port 80)

Two static pages, plain HTML/CSS/JS, no build step.
- `index.html` (Home = chatbot): if there is no token in `localStorage`, show a login form (email prefilled `tester@wns.com`, password blank). After login, show a Cowboy/Osho radio toggle, a scrolling message list, and a text input. Each send calls `POST {CONTROL_PLANE_URL}/api/chat` with `Authorization: Bearer <token>`; on load and on toggle change, call `/api/history`. A 401 clears the token and returns to the login view. Include a Log out control and links to Home and About.
- `about.html`: a static page describing the app and the two personas.
- `app.js`: reads `window.CONTROL_PLANE_URL` (from `config.js`, see below), holds the token in `localStorage`, implements login, send, history, logout.
- Runtime config (important): the backend URL must NOT be baked at build time. `config.js` is generated at container start by `entrypoint.sh` from the `CONTROL_PLANE_URL` env var (write `window.CONTROL_PLANE_URL = "<value>";`), then nginx starts. This lets the same image point at localhost during local runs and at the deployed control-plane URL on TrueFoundry with no rebuild.

### 5.4 Data model

Postgres, one table (public schema is fine):
```sql
CREATE TABLE IF NOT EXISTS messages (
    id BIGSERIAL PRIMARY KEY,
    session_id TEXT NOT NULL,
    persona TEXT NOT NULL,
    role TEXT NOT NULL,          -- 'user' or 'assistant'
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```
The control-plane creates this at startup so it also works on managed or in-cluster databases that never run an init script. `init/01-schema.sql` may contain the same statement as a local-compose convenience.

Redis keys:
- `session:{jti}` -> the logged-in identity, TTL = token expiry (auth check).
- `recent:{session_id}:{persona}` -> a capped list of the latest messages, TTL ~1h (fast display / short context).

Single fixed user, so there is no users table.

### 5.5 Auth and API protection

Three layers:
1. Fixed login: only `tester@wns.com` / `halotest` can obtain a token. Credentials come from `LOGIN_EMAIL` / `LOGIN_PASSWORD` (a secret in deployment, plain in local `.env`), never hardcoded in source.
2. JWT on every `/api/*` call, verified against `JWT_SECRET` and a live Redis session.
3. Network isolation: the two persona services are never exposed; only the control-plane can reach them.
A fourth, platform layer is added during hosting (section 10, step 6).

---

## 6. Connections (the wiring that matters)

Every connection target is an environment variable, so the same images run locally and in the cloud with only the values changing.

| Consumer | Env var | Local value (docker-compose) | Deployed value (TrueFoundry) |
|---|---|---|---|
| control-plane -> cowboy | `COWBOY_SERVICE_URL` | `http://cowboy-service:8001` | `http://cowboy-service-<workspace>.svc.cluster.local:8001` |
| control-plane -> osho | `OSHO_SERVICE_URL` | `http://osho-service:8002` | `http://osho-service-<workspace>.svc.cluster.local:8002` |
| control-plane -> Postgres | `DATABASE_URL` | `postgresql://app:app@postgres:5432/appdb` | the deployed Postgres URL (secret) |
| control-plane -> Redis | `REDIS_URL` | `redis://redis:6379/0` | the deployed Redis URL (secret) |
| control-plane auth | `JWT_SECRET`, `LOGIN_EMAIL`, `LOGIN_PASSWORD` | from `.env` | `tfy-secret://...` references |
| persona -> LLM | `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` | from `.env` | key as `tfy-secret://...`; base/model plain |
| browser -> control-plane | `CONTROL_PLANE_URL` (on the UI container) | `http://localhost:8000` | the control-plane's public endpoint URL |

Locally, service-to-service uses docker-compose service-name DNS. On TrueFoundry it uses the cluster-internal DNS form `servicename-workspacename.svc.cluster.local:port`. The pattern is identical; only the hostname changes.

---

## 7. Dockerfiles

Backend services (`services/*/Dockerfile`): single-stage `python:3.12-slim`; `WORKDIR /app`; `pip install -r requirements.txt`; copy `app/`; create and switch to a non-root user; `ENV PORT=<800x>`; `EXPOSE ${PORT}`; an image-level `HEALTHCHECK` that GETs `http://localhost:${PORT}/health`; `CMD ["python","-m","app.main"]` where `app/main.py` reads `PORT` from env and launches uvicorn.

requirements — control-plane: `fastapi`, `uvicorn[standard]`, `sqlalchemy>=2.0`, `psycopg2-binary`, `redis`, `pyjwt`, `httpx`. Persona services: `fastapi`, `uvicorn[standard]`, `httpx`.

UI (`ui/Dockerfile`): `nginx:alpine`; copy `html/` to the web root and `nginx.conf`; copy `entrypoint.sh` (writes `config.js` from `CONTROL_PLANE_URL`, then `exec nginx -g 'daemon off;'`); `EXPOSE 80`; `ENTRYPOINT ["/entrypoint.sh"]`.

---

## 8. Local run (Phase 1 acceptance)

`docker-compose.yml` defines all six workloads: `postgres:16` (with a named volume and the `./init` bootstrap mount, `pg_isready` healthcheck), `redis:7-alpine` (ping healthcheck), the three built services, and the UI. Wire the env vars from the table above; put secrets (`LLM_API_KEY`, `JWT_SECRET`, `LOGIN_*`) in `.env` and reference them with `${...}` interpolation. The control-plane `depends_on` postgres and redis being healthy. Publish control-plane on host `8000` and the UI on host `8080`.

Done when: `cp .env.example .env`, set `LLM_API_KEY`, `docker compose up --build`, open `http://localhost:8080`, log in as `tester@wns.com` / `halotest`, chat with Cowboy and with Osho and get in-tone replies, confirm rows land in the `messages` table and keys appear in Redis, and confirm `POST /api/chat` without a token returns 401.

---

## 9. Phase 2: push to GitHub

Add a `README.md` (what it is, local run, the deploy summary) and a complete `.env.example`. Ensure `.env` is gitignored. `git init`, commit, create a GitHub repo named `tf-service-tester-chat`, push. (The person running this does the auth-bearing git and GitHub steps.)

---

## 10. Phase 3: host on TrueFoundry

1. Prerequisites: `tfy` CLI installed and logged in; a container registry connected on the Integrations page (or deploy build-from-source directly from the GitHub repo, which still needs a registry); a workspace in a dev environment.
2. Databases: deploy Postgres and Redis in-cluster from the console using the Helm-chart deployment feature with persistence enabled (this is "postgres/redis from the website"). Capture their in-cluster URLs. (Managed cloud databases are the production alternative and are not needed for this test.)
3. Secrets: create `JWT_SECRET`, `LOGIN_EMAIL`, `LOGIN_PASSWORD`, `LLM_API_KEY`, and the DB/Redis connection URLs as `tfy-secret://...` references (a secret group, or an external manager such as AWS SSM). TrueFoundry injects them as env vars at runtime.
4. Deploy the services in order: cowboy-service (internal, 8001), osho-service (internal, 8002), then control-plane (exposed, 8000). Deploy each build-from-source from the GitHub repo (set the build context to that service's folder) or as a prebuilt image. Set control-plane's `COWBOY_SERVICE_URL` / `OSHO_SERVICE_URL` to the internal cluster DNS names, and the DB/Redis/JWT/login/LLM values from the secrets. Liveness `/health`, readiness `/ready`.
5. Deploy the UI (exposed). Set `CONTROL_PLANE_URL` to the control-plane's public endpoint. Because the UI reads a runtime `config.js`, this needs no image rebuild.
6. Protect the endpoints: enable TrueFoundry's built-in port-level endpoint authentication on the exposed control-plane and UI. Options: username/password, JWT (validated against an IdP's JWKS via a Custom JWT Auth integration), or Login-with-TrueFoundry. For a single tester, username/password or Login-with-TrueFoundry is simplest. This platform guard sits on top of the app's own login and satisfies "no one else can use it." Note: per-endpoint IP allowlisting is not available; only cluster-wide load-balancer `source-ranges`.
7. Verify: dry-run each manifest first, then deploy, open the UI's public URL, pass the platform auth, log in as `tester@wns.com` / `halotest`, chat with both personas, confirm persistence, and confirm the persona services are not reachable from outside.

---

## 11. Decisions already made (do not re-litigate)

- Personas answer via a real LLM using an API key (OpenAI-compatible client, provider and model set by env; a graceful fallback line covers errors/missing key).
- The UI is its own separate service (nginx static + runtime config), not served by the control-plane.
- Fixed login is `tester@wns.com` / `halotest`.
- Project name is `tf-service-tester-chat`.
- Internals stay minimal; this is a learning scaffold, not a full or production replication.

---

## 12. Definition of done

- Local: `docker compose up` brings up all six workloads; login gate holds; both personas reply in tone; chat persists in Postgres and Redis; 401 without a token.
- GitHub: repo pushed; `.env` not committed; `.env.example` complete.
- TrueFoundry: manifests dry-run clean; deployed; both the platform auth and the app login are enforced; the persona services are internal-only; a full login-and-chat works against the public URL.

---

## 13. Open items for the builder

- LLM provider and model: set via env/secret. Default to an OpenAI-compatible endpoint; confirm the exact model id the operator's key supports.
- A container registry must be connected to TrueFoundry before Phase 3, and the account needs cluster/workspace access.
- `postgres:16` is sufficient; no vector extension is needed by this app.

---

## 14. Sources (TrueFoundry facts to trust, verified 2026-08-18)

- Port-level endpoint authentication (username/password, JWT, Login-with-TrueFoundry), configured per port: https://www.truefoundry.com/docs/endpoint-authentication and https://www.truefoundry.com/docs/define-ports-and-domains
- Secrets `tfy-secret://user:group:name` and external managers (AWS SSM, etc.), injected at runtime: https://www.truefoundry.com/docs/environment-variables-and-secrets and https://www.truefoundry.com/docs/manage-secrets
- Internal service DNS `servicename-workspacename.svc.cluster.local:port`, `expose: true`, and public endpoint form: https://www.truefoundry.com/docs/define-ports-and-domains
- Build-from-source from a git repo and the required configured registry: https://www.truefoundry.com/docs/api-reference-image-and-build and https://www.truefoundry.com/docs/deploy-job-from-a-public-github-repository
- In-cluster databases via Helm charts and persistent volumes: https://www.truefoundry.com/docs/deploy-helm-charts and https://www.truefoundry.com/docs/introduction-to-volume
- Cluster-level IP `source-ranges` only (no per-endpoint allowlist): https://www.truefoundry.com/docs/loadbalancers
