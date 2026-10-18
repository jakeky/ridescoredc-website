# ridescoredc-website

Web application for the DC Bike Safety Map — interactive map, survey tool, and REST API.

Part of the [RidescoreDC](https://github.com/civictechdc/ridescoredc) project by [Civic Tech DC](https://www.civictechdc.org/).

**Related repos**
- [ridescoredc](https://github.com/civictechdc/ridescoredc) — parent repo and project overview
- [ridescoredc-models](https://github.com/civictechdc/ridescoredc-models) — data processing and scoring model (Jupyter notebooks, PostGIS setup)

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML/JS, MapLibre GL |
| API | Python 3.12, FastAPI |
| Tile server | Martin (MVT) |
| Database | PostgreSQL 17 + PostGIS |
| Container | Docker Compose |

---

## Developer Spinup

For step-by-step instructions, use the [Frontend Developer Guide](docs/local-frontend-development.md)
for page changes or the [Full Stack Developer Guide](docs/local-fullstack-development.md)
for a local database, API, and tile server. The quick start below runs the full stack.

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- Git
- Node.js 22.12 or newer (includes npm)
- [uv](https://docs.astral.sh/uv/getting-started/installation/) for loading data and applying migrations

### 1. Clone and configure

```bash
git clone https://github.com/civictechdc/ridescoredc-website
cd ridescoredc-website
```

Copy both example environment files. The defaults are suitable for local development:

```bash
cp api/.env.example api/.env
cp .env.example .env
```

In PowerShell, use `Copy-Item` in place of `cp`. `api/.env` holds the database connection
and password; `.env` holds local settings such as `DB_PORT` and `DB_DATA_DIR`. Both are
ignored by Git. See the full-stack guide if a local port is already in use.

### 2. Start the stack

```bash
npm run stack
```

This starts four services:

| Service | Address | Purpose |
|---|---|---|
| `nginx` | http://localhost:8000 | Reverse proxy — the single entry point |
| `fastapi` | internal | FastAPI survey API |
| `martin` | internal | MVT tile server |
| `db` | localhost:5432 | PostGIS database |

Open the app at **http://localhost:8000** — that's NGINX, which serves `frontend/` directly, routes `/tiles/` to Martin, and routes `/api/` and `/health` to FastAPI. Only NGINX and the database are published to the host; `fastapi` and `martin` are reached *through* NGINX, exactly as on the servers.

The `fastapi` service runs the stock `python:3.12-slim` image with `api/` mounted in, installing its dependencies on start — so the first boot takes a little longer while pip runs. If the database container isn't ready yet, the API retries the connection for up to 20 seconds before serving. The survey tables are created separately by this repository's yoyo migrations in `api/migrations/`, applied in step 3.

**Routing mirrors staging and production.** Both locally and on the servers, **NGINX is the front door and routes by path** — `/api` → `fastapi` and `/tiles/` → Martin — so the frontend uses relative URLs (`/tiles/update_score/...`) that work in every environment. This is a deliberate convention: **tiles must go through `/tiles/` to Martin**, and because Martin isn't reachable any other way locally, a hardcoded direct URL fails in dev instead of silently breaking in production. Locally the proxy config lives at `nginx/default.conf`; `nginx/server.conf.example` documents the server routing (ask an org admin to apply server configuration changes).

### 3. Load the published data and create the survey tables

Leave the stack running and use a second terminal in the repository:

```bash
npm run setup
```

This runs `npm run data` to download the published roads, crashes, scores, and serving SQL,
then `npm run migrate` to create the survey tables. The data loader also restarts Martin so
it discovers the loaded tile sources. **A production database dump is not needed.**

The data version is recorded in `data.load_record`. For selecting a particular version or
loading a package built locally, see the [full-stack guide](docs/local-fullstack-development.md#loading-different-data-versions).

### 4. Open the app

Open the [map](http://localhost:8000/) or the [survey](http://localhost:8000/survey/).
Check [API health](http://localhost:8000/health) for `{"status":"ok"}`. A healthy API alone
does not mean the road data has been loaded; check that streets appear on the map too.

### 5. Tear down

```bash
docker compose down
```

This stops the containers and preserves the database files. For a fresh local database,
follow [Starting over](docs/local-fullstack-development.md#starting-over); that section
also explains how to keep the old data by choosing another `DB_DATA_DIR`.

---

## Database

The database has three schemas with separate responsibilities:

| Schema | Holds | Updated by |
|---|---|---|
| `data` | Published roads, crashes, and scores | `npm run data` |
| `serving` | Views and functions used by Martin | The published serving bundle, loaded with the data |
| `app` | Survey responses | FastAPI; schema changes in `api/migrations/` |

Survey responses record durable `segment_id` values and the source package version.
Reloading road data replaces the derived `data` and `serving` schemas, not survey responses.

PostgreSQL stores its local files in `pg_data/`, or the directory selected by `DB_DATA_DIR`.
This is a bind mount, so the files survive both `docker compose down` and `down -v`.
It is ignored by Git and should never be committed. `api/migrations-legacy/` is historical;
current survey migrations are in `api/migrations/`.

The scoring pipeline lives in [ridescoredc-models](https://github.com/civictechdc/ridescoredc-models).

---

## Deploy

Deployment is driven entirely by Git. You develop on a feature branch, verify it locally with the linter and tests, then open a pull request into `develop`. Merging to `develop` deploys to staging; merging to `main` deploys to production. GitHub Actions runs the same lint and test checks on pushes and pull requests to `develop` and `main`, and a branch that fails them cannot be deployed.

### Branching (Gitflow)

This project follows [Gitflow](https://www.atlassian.com/git/tutorials/comparing-workflows/gitflow-workflow). Never commit directly to `develop` or `main` — start every piece of work from a new branch off `develop`:

```bash
git checkout develop
git checkout -b feature/FEATURE_NAME_HERE   # creates a new feature branch
```

When the work is ready, push the branch and open a pull request back into `develop`.

### Lint and Tests

Run the linter and tests **before every commit** — CI runs the same checks, and a branch that fails them will not deploy. The `fastapi` service already installed `ruff` and `pytest` (from `requirements-dev.txt`) when it started, so with the stack running (from [step 2](#2-start-the-stack)) you just `exec` into it — no Python needed on your host:

**Lint (Ruff):**

```bash
docker compose exec fastapi ruff check .
```

**Tests (Pytest):**

```bash
docker compose exec fastapi pytest tests/ -v
```

Because `api/` is mounted into the container, these check your current working-tree code. The tests mock the database, so they never touch the running `db` service.

### GitHub Actions

CI runs on every push and pull request to `develop` and `main`.

| Job | Trigger | What it does |
|---|---|---|
| `lint` | PRs, pushes to `develop`/`main` | Runs Ruff on `api/` |
| `test` | PRs, pushes to `develop`/`main` | Runs Pytest against mocked DB |
| `check-migrations` | PRs, pushes to `develop`/`main` | Applies survey migrations to PostgreSQL and checks a second apply changes nothing |
| `stage` | push to `develop` | Deploys to [dev.ridescoredc.com](https://dev.ridescoredc.com) |
| `deploy` | push to `main` | Deploys to [ridescoredc.com](https://ridescoredc.com) |

The `stage` and `deploy` jobs wait for the required CI checks. Deployment applies survey migrations before restarting FastAPI and Martin. Loading a new road-data package is a separate operation.

When you open a pull request from your feature branch into `develop`, **check the GitHub Actions tab (or the checks on the PR) and confirm `lint` and `test` pass** before asking for review. Fix any failures and push again — the checks re-run automatically.

Promotion from `develop` to production is handled with care: a **senior dev will help you open the pull request from `develop` into `main`**. Merging to `develop` deploys to the staging server and merging to `main` deploys to the production server, both automatically, so the `develop` → `main` step is done deliberately and with review.

### SSH Access

Deployments use SSH keys stored as GitHub Actions secrets (`STG_SSH_PRIVATE_KEY`, `PRD_SSH_PRIVATE_KEY`). To get access to the staging or production server, **request an SSH key from an org admin**.

---

## Project Structure

```
ridescoredc-website/
├── api/
│   ├── main.py              # Survey submission API and database health
│   ├── requirements.txt     # Production dependencies
│   ├── requirements-dev.txt # Dev/test dependencies
│   ├── .env.example         # API/database settings template
│   ├── migrations/          # Current app-schema migrations
│   ├── yoyo.ini             # Migration configuration
│   └── tests/               # API tests
├── frontend/
│   ├── index.html           # Scored map
│   ├── survey/index.html    # Survey with unscored road geometry
│   └── src/shared/          # Shared map configuration and controls
├── docs/                    # Frontend and full-stack developer guides
├── nginx/
│   ├── default.conf         # Local routing and static pages
│   └── server.conf.example  # Server configuration reference
├── scripts/
│   ├── load_data.py         # Load published road data and serving SQL
│   ├── migrate.py           # Apply this repository's survey migrations
│   └── gitlab-ci/deployment.sh # Deployment script used by GitHub Actions
├── .env.example             # Local ports, data directory, Vite upstream
├── docker-compose.yml
├── martin.yaml              # Tile server configuration
└── .github/workflows/ci.yml
```
