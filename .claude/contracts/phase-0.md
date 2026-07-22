# Phase 0 — FROZEN CONTRACT (Bootstrap)

**Authority:** ARCHITECT (Opus) · **Date:** 2026-07-22 · **Status:** FROZEN
**Source of truth above this doc:** `PRD.md`. Where this doc pins a detail the PRD left open, this doc wins.
**Consumers:** SLICE A, B, C, D, E implementation agents — who never talk to each other.

> **Every name, number, and path in this document is FINAL.** If an implementer finds
> something unspecified, they MUST stop and escalate to the orchestrator → architect.
> They must NEVER invent a name that another slice could also need.

---

## 0. Phase 0 scope boundary (READ THIS FIRST)

Phase 0 produces **scaffolds only**. The gate is: *CI green on empty apps; `docker compose config` valid.*

**IN SCOPE (Phase 0):**
- Workspace wiring, tooling presets, tsconfigs, turbo pipeline.
- Three apps that **install, lint, typecheck, build, and boot**.
- A trivial health surface per app (defined in §13).
- One shared package that exports **constants and types only** (no logic).
- Dockerfiles + compose + DB init SQL + CI workflow + harness docs.

**OUT OF SCOPE (do NOT build — belongs to Phase 1–5):**
| Thing | Owning phase |
|---|---|
| Sale state machine, DTO schemas/validators, Zod/class-validator | 1 |
| `purchase.lua`, Redis service, ioredis client wiring | 1 |
| `SaleModule`, `PurchaseModule`, rate limiting, CORS beyond default | 2 |
| Health endpoint that actually pings Redis/Postgres | 2 |
| BullMQ queue/worker/DLQ/compensation, any queue connection | 3 |
| Any prototype UI, Tailwind theme, shadcn components, polling, countdown | 4 |
| k6 scripts, audit script, Testcontainers | 5 |

An agent that implements out-of-scope work has **failed the slice** and its diff is rejected.
Phase 0 apps contain **zero business logic**. No `ioredis`, no `pg`, no `bullmq`, no `tailwindcss`
dependencies are installed in Phase 0 unless listed in §14.

---

## 1. Package naming — FROZEN

Scope: **`@flash`**. No other scope, ever. Root package is unscoped.

| Workspace path | `name` field | private | version |
|---|---|---|---|
| `/` (root) | `bookipi-technical-test` | `true` | `0.0.0` |
| `apps/api` | `@flash/api` | `true` | `0.0.0` |
| `apps/worker` | `@flash/worker` | `true` | `0.0.0` |
| `apps/web` | `@flash/web` | `true` | `0.0.0` |
| `packages/shared` | `@flash/shared` | `true` | `0.0.0` |
| `packages/tooling` | `@flash/tooling` | `true` | `0.0.0` |

Internal dependency specifier is always **`"workspace:*"`**. Never `"*"`, never a version range.

Turbo filter names used in scripts/CI are exactly the `name` fields above
(e.g. `pnpm --filter @flash/api build`).

---

## 2. Slice ownership map — FROZEN

Exclusive path ownership. A slice **must not create, edit, or delete** a path owned by another slice.
If slice X needs a change inside slice Y's path, it escalates; it never edits.

| Slice | Owns | Agent role |
|---|---|---|
| **A — Foundation & tooling** | root configs, `packages/tooling/**`, `packages/shared/**` | implementer |
| **B — Backend scaffolds** | `apps/api/**`, `apps/worker/**` | implementer |
| **C — Frontend scaffold** | `apps/web/**` | frontend-implementer |
| **D — Infra & CI** | `infra/**`, `.github/**`, `scripts/**`, `load/**`, `.env.example` | implementer |
| **E — Harness & docs** | `AGENTS.md`, `STATE.md`, `README.md`, `.claude/agents/**`, `.claude/settings.json` | implementer |

**Ordering:** A, B, C, D, E may all run in parallel — the trees are disjoint. B/C/D/E write files
that *reference* A's outputs by the exact frozen paths/names in this contract; they do not read A's work.
The orchestrator merges in order **A → B → C → D → E**, then runs the integration check in §16.

---

## 3. Directory tree — FROZEN, file by file

Every file below MUST exist at the end of Phase 0. No other files may be created
(generated `dist/`, `node_modules/`, `.turbo/` excepted).

```
bookipi-technical-test/
├── package.json                                   [A]
├── pnpm-workspace.yaml                            [A]
├── turbo.json                                     [A]
├── tsconfig.json                                  [A]  (solution-style, references only)
├── .npmrc                                         [A]
├── .gitignore                                     [A]
├── .prettierrc.mjs                                [A]
├── .prettierignore                                [A]
├── .editorconfig                                  [A]
├── .nvmrc                                         [A]
├── eslint.config.mjs                              [A]  (root: ignores + re-export base)
├── .env.example                                   [D]
├── PRD.md                                         (exists)
├── AGENTS.md                                      [E]
├── STATE.md                                       [E]
├── README.md                                      [E]
│
├── packages/
│   ├── tooling/
│   │   ├── package.json                           [A]
│   │   ├── eslint/base.js                         [A]
│   │   ├── eslint/nest.js                         [A]
│   │   ├── eslint/react.js                        [A]
│   │   ├── prettier/index.js                      [A]
│   │   └── tsconfig/base.json                     [A]
│   │       tsconfig/node.json                     [A]
│   │       tsconfig/react.json                    [A]
│   └── shared/
│       ├── package.json                           [A]
│       ├── tsconfig.json                          [A]
│       ├── eslint.config.mjs                      [A]
│       └── src/
│           ├── index.ts                           [A]
│           ├── constants.ts                       [A]
│           └── health.ts                          [A]
│
├── apps/
│   ├── api/
│   │   ├── package.json                           [B]
│   │   ├── tsconfig.json                          [B]
│   │   ├── tsconfig.build.json                    [B]
│   │   ├── nest-cli.json                          [B]
│   │   ├── eslint.config.mjs                      [B]
│   │   ├── vitest.config.ts                       [B]
│   │   └── src/
│   │       ├── main.ts                            [B]
│   │       ├── app.module.ts                      [B]
│   │       ├── config/env.ts                      [B]
│   │       └── health/
│   │           ├── health.module.ts               [B]
│   │           ├── health.controller.ts           [B]
│   │           └── health.controller.spec.ts      [B]
│   ├── worker/
│   │   ├── package.json                           [B]
│   │   ├── tsconfig.json                          [B]
│   │   ├── tsconfig.build.json                    [B]
│   │   ├── nest-cli.json                          [B]
│   │   ├── eslint.config.mjs                      [B]
│   │   ├── vitest.config.ts                       [B]
│   │   └── src/
│   │       ├── main.ts                            [B]
│   │       ├── worker.module.ts                   [B]
│   │       ├── config/env.ts                      [B]
│   │       └── health/
│   │           ├── health.module.ts               [B]
│   │           ├── health.controller.ts           [B]
│   │           └── health.controller.spec.ts      [B]
│   └── web/
│       ├── package.json                           [C]
│       ├── tsconfig.json                          [C]
│       ├── tsconfig.node.json                     [C]
│       ├── vite.config.ts                         [C]
│       ├── vitest.config.ts                       [C]
│       ├── eslint.config.mjs                      [C]
│       ├── index.html                             [C]
│       └── src/
│           ├── main.tsx                           [C]
│           ├── App.tsx                            [C]
│           ├── App.test.tsx                       [C]
│           ├── env.ts                             [C]
│           ├── vite-env.d.ts                      [C]
│           └── index.css                          [C]
│
├── infra/
│   ├── docker-compose.yml                         [D]
│   ├── api.Dockerfile                             [D]
│   ├── worker.Dockerfile                          [D]
│   ├── web.Dockerfile                             [D]
│   ├── web.nginx.conf                             [D]
│   └── postgres/init/001_schema.sql               [D]
│
├── scripts/
│   └── stress.mjs                                 [D]  (Phase-0 placeholder, see §5)
│
├── load/
│   ├── k6/.gitkeep                                [D]
│   └── README.md                                  [D]  (one paragraph: "populated in Phase 5")
│
├── .github/
│   └── workflows/ci.yml                           [D]
│
├── .claude/
│   ├── contracts/phase-0.md                       (this file — architect)
│   ├── agents/architect.md                        [E]
│   ├── agents/implementer.md                      [E]
│   ├── agents/frontend-implementer.md             [E]
│   ├── agents/adversarial-reviewer.md             [E]
│   ├── agents/security-reviewer.md                [E]
│   ├── agents/mechanic.md                         [E]
│   ├── settings.json                              [E]
│   └── skills/                                    (exists — do not touch)
│
└── prototype/index.html                           (exists — READ ONLY, never edit)
```

---

## 4. Root `package.json` — FROZEN

```jsonc
{
  "name": "bookipi-technical-test",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.9.0",
  "engines": {
    "node": ">=22.14.0 <23",
    "pnpm": ">=11.9.0"
  },
  "scripts": {
    "dev": "turbo run dev",
    "build": "turbo run build",
    "lint": "turbo run lint",
    "lint:fix": "turbo run lint -- --fix",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test",
    "test:integration": "turbo run test:integration",
    "stress": "node scripts/stress.mjs",
    "format": "prettier --write . --ignore-path .gitignore",
    "format:check": "prettier --check . --ignore-path .gitignore",
    "clean": "turbo run clean && rm -rf node_modules .turbo"
  },
  "devDependencies": {
    "@flash/tooling": "workspace:*",
    "prettier": "^3.4.2",
    "turbo": "^2.3.3",
    "typescript": "^5.7.2"
  }
}
```

- `"type": "module"` at root applies to root `*.js` only; **apps/packages set their own `type`** (§14).
- `stress` intentionally does not shell out to `k6` in Phase 0 (k6 is not installed in CI).
- No `postinstall`, no `prepare`, no husky in Phase 0.

`.nvmrc` content: `22.14.0`
`.npmrc` content (exactly):
```
node-linker=isolated
strict-peer-dependencies=false
auto-install-peers=true
```

---

## 5. `scripts/stress.mjs` — FROZEN (SLICE D)

Phase-0 placeholder. Exact behavior: print
`stress: k6 scenarios land in Phase 5 (see PRD §6.2). Nothing to run yet.`
to stdout and `process.exit(0)`. No dependencies, no k6 invocation.

---

## 6. `pnpm-workspace.yaml` — FROZEN

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

No `catalog:` usage in Phase 0 (keep it boring; versions live in each package.json).

---

## 7. `turbo.json` — FROZEN

Turborepo 2.x schema (`tasks`, not `pipeline`).

```jsonc
{
  "$schema": "https://turbo.build/schema.json",
  "ui": "stream",
  "globalDependencies": [".env", "packages/tooling/**"],
  "globalEnv": ["NODE_ENV"],
  "globalPassThroughEnv": [
    "API_HOST", "API_PORT", "WORKER_HEALTH_PORT", "WEB_PORT",
    "DATABASE_URL", "REDIS_URL", "LOG_LEVEL", "CORS_ORIGIN",
    "SALE_ID", "SALE_NAME", "SALE_STARTS_AT", "SALE_ENDS_AT", "SALE_TOTAL_STOCK",
    "RATE_LIMIT_MAX", "RATE_LIMIT_WINDOW_MS",
    "ORDERS_QUEUE_NAME", "WORKER_CONCURRENCY", "WORKER_MAX_ATTEMPTS",
    "VITE_API_BASE_URL"
  ],
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "typecheck": {
      "dependsOn": ["^build"],
      "outputs": []
    },
    "lint": {
      "dependsOn": ["^build"],
      "outputs": []
    },
    "test": {
      "dependsOn": ["^build"],
      "outputs": ["coverage/**"]
    },
    "test:integration": {
      "dependsOn": ["^build"],
      "cache": false,
      "outputs": []
    },
    "dev": {
      "dependsOn": ["^build"],
      "cache": false,
      "persistent": true
    },
    "clean": {
      "cache": false,
      "outputs": []
    }
  }
}
```

Rationale for `dependsOn: ["^build"]` on `typecheck`/`lint`/`test`: apps import `@flash/shared`
by its **built** `dist/` types, so upstream build must precede them. Do not change this.

Every workspace package MUST define all of: `build`, `typecheck`, `lint`, `test`, `clean`.
`dev` is defined by `@flash/api`, `@flash/worker`, `@flash/web` only.
`test:integration` is defined by `@flash/api` and `@flash/worker` only; in Phase 0 both are exactly
`"test:integration": "vitest run --passWithNoTests integration"` (a filename filter, so it is safe
before any `test/integration/` directory exists). Integration specs added from Phase 2 onward are
named `*.integration.spec.ts` and live in `<app>/test/integration/`.
Packages that have no real work for a task use a no-op that exits 0 (see §14 per-package scripts).

---

## 8. `packages/tooling` — FROZEN

`packages/tooling/package.json`:

```jsonc
{
  "name": "@flash/tooling",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    "./eslint/base": "./eslint/base.js",
    "./eslint/nest": "./eslint/nest.js",
    "./eslint/react": "./eslint/react.js",
    "./prettier": "./prettier/index.js",
    "./tsconfig/base.json": "./tsconfig/base.json",
    "./tsconfig/node.json": "./tsconfig/node.json",
    "./tsconfig/react.json": "./tsconfig/react.json"
  },
  "scripts": {
    "build": "echo \"@flash/tooling: no build\"",
    "typecheck": "echo \"@flash/tooling: no typecheck\"",
    "lint": "echo \"@flash/tooling: no lint\"",
    "test": "echo \"@flash/tooling: no tests\"",
    "clean": "echo \"@flash/tooling: nothing to clean\""
  },
  "dependencies": {
    "@eslint/js": "^9.17.0",
    "eslint-config-prettier": "^9.1.0",
    "eslint-plugin-react-hooks": "^5.1.0",
    "eslint-plugin-react-refresh": "^0.4.16",
    "globals": "^15.14.0",
    "typescript-eslint": "^8.18.2"
  },
  "peerDependencies": {
    "eslint": "^9.17.0",
    "prettier": "^3.4.2",
    "typescript": "^5.7.2"
  }
}
```

### 8.1 Consumption — exact, no variation

**ESLint** (flat config). Every app/package has `eslint.config.mjs`:

```js
// apps/api/eslint.config.mjs   (worker identical)
import nest from '@flash/tooling/eslint/nest';
export default nest;
```
```js
// apps/web/eslint.config.mjs
import react from '@flash/tooling/eslint/react';
export default react;
```
```js
// packages/shared/eslint.config.mjs
import base from '@flash/tooling/eslint/base';
export default base;
```
```js
// eslint.config.mjs (repo root)
import base from '@flash/tooling/eslint/base';
export default [
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**', 'prototype/**', 'load/k6/**'] },
  ...base,
];
```

Each config array is exported as a **default array export** (`export default [...]`), so spreading works.
`base.js` MUST end with `eslint-config-prettier` so formatting rules never conflict.
`base.js` MUST set `languageOptions.parserOptions.projectService: true` and
`tsconfigRootDir` derived from `process.cwd()`.

**Prettier.** Root `.prettierrc.mjs`:
```js
export { default } from '@flash/tooling/prettier';
```
Frozen prettier options: `singleQuote: true`, `semi: true`, `trailingComma: 'all'`,
`printWidth: 100`, `arrowParens: 'always'`, `endOfLine: 'lf'`.
`.prettierignore`: `dist`, `node_modules`, `.turbo`, `pnpm-lock.yaml`, `prototype`, `coverage`.

**TypeScript.** Apps extend by package path, never by relative path:
```jsonc
{ "extends": "@flash/tooling/tsconfig/node.json" }   // api, worker, shared
{ "extends": "@flash/tooling/tsconfig/react.json" }  // web
```
Each consumer lists `"@flash/tooling": "workspace:*"` in its `devDependencies`.

---

## 9. TypeScript strategy — FROZEN

### 9.1 `tooling/tsconfig/base.json`
```jsonc
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "display": "Flash Base",
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "moduleDetection": "force",
    "strict": true,
    "noImplicitOverride": true,
    "noUncheckedIndexedAccess": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "exactOptionalPropertyTypes": false,
    "useUnknownInCatchVariables": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "incremental": true
  },
  "exclude": ["node_modules", "dist"]
}
```
`exactOptionalPropertyTypes` is deliberately **false** — Nest/Fastify DTO ergonomics. Do not flip it.

### 9.2 `tooling/tsconfig/node.json`
```jsonc
{
  "extends": "./base.json",
  "display": "Flash Node (CommonJS)",
  "compilerOptions": {
    "module": "CommonJS",
    "moduleResolution": "Node",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "types": ["node"]
  }
}
```
**Backend is CommonJS.** NestJS + Fastify + `emitDecoratorMetadata` on CJS is the boring,
fully-supported path. `apps/api`, `apps/worker`, `packages/shared` all emit CJS.
Their `package.json` MUST NOT set `"type": "module"`.

### 9.3 `tooling/tsconfig/react.json`
```jsonc
{
  "extends": "./base.json",
  "display": "Flash React (ESM/bundler)",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "noEmit": true,
    "declaration": false,
    "declarationMap": false,
    "allowImportingTsExtensions": true,
    "types": ["vite/client"]
  }
}
```

### 9.4 Per-package overrides — FROZEN

| File | extends | key overrides |
|---|---|---|
| `packages/shared/tsconfig.json` | `@flash/tooling/tsconfig/node.json` | `outDir: "dist"`, `rootDir: "src"`, `include: ["src/**/*"]` |
| `apps/api/tsconfig.json` | `@flash/tooling/tsconfig/node.json` | `outDir: "dist"`, `rootDir: "src"`, `baseUrl: "."`, `include: ["src/**/*", "test/**/*", "vitest.config.ts"]` |
| `apps/api/tsconfig.build.json` | `./tsconfig.json` | `exclude: ["**/*.spec.ts", "test", "vitest.config.ts", "dist", "node_modules"]` |
| `apps/worker/tsconfig.json` | same as api | same as api |
| `apps/worker/tsconfig.build.json` | `./tsconfig.json` | same as api |
| `apps/web/tsconfig.json` | `@flash/tooling/tsconfig/react.json` | `include: ["src/**/*", "vite.config.ts", "vitest.config.ts"]` |
| `apps/web/tsconfig.node.json` | `@flash/tooling/tsconfig/node.json` | `noEmit: true`, `include: ["vite.config.ts"]` |

**Path aliases:** there are **NONE**. No `@/*`, no `~/*`, in any package. Cross-package imports
use the package name `@flash/shared`; intra-package imports are relative. This is frozen to keep
Vitest/Vite/Nest/tsc resolution identical everywhere. Do not add `paths`.

Root `tsconfig.json` is a stub used only by editors:
```jsonc
{ "files": [], "references": [
  { "path": "packages/shared" }, { "path": "apps/api" },
  { "path": "apps/worker" }, { "path": "apps/web" }
] }
```
Composite project builds are **not** used (`tsc -b` is not in any script).

---

## 10. Ports — FROZEN, no conflicts

| Service | Container port | Host port (compose) | Host port (local `pnpm dev`) |
|---|---|---|---|
| `api` | **3000** | **3000** | 3000 |
| `worker` (health only) | **3001** | **3001** | 3001 |
| `web` (nginx in compose / vite locally) | **80** | **5173** | 5173 |
| `postgres` | **5432** | **5433** | n/a |
| `redis` | **6379** | **6380** | n/a |

Host-side Postgres/Redis are shifted off the defaults so a developer's locally-installed
Postgres/Redis cannot collide. **In-network** service URLs always use the default ports.

---

## 11. Environment variable contract — FROZEN (the integration seam)

Canonical spelling below is the **only** spelling. Compose, app config, CI, `.env.example`,
and README all use these exact names. Anything not in this table does not exist.

| Name | Type | Default (host dev) | Read by | Phase first used |
|---|---|---|---|---|
| `NODE_ENV` | `development \| test \| production` | `development` | api, worker, web | 0 |
| `LOG_LEVEL` | `fatal\|error\|warn\|info\|debug\|trace` | `info` | api, worker | 0 |
| `API_HOST` | string | `0.0.0.0` | api | 0 |
| `API_PORT` | int | `3000` | api | 0 |
| `WORKER_HEALTH_PORT` | int | `3001` | worker | 0 |
| `WEB_PORT` | int | `5173` | web (vite dev server) | 0 |
| `CORS_ORIGIN` | string (origin or `*`) | `http://localhost:5173` | api | 0 |
| `VITE_API_BASE_URL` | string | `http://localhost:3000/api` | web (build-time) | 0 |
| `DATABASE_URL` | postgres URL | `postgresql://flash:flash@localhost:5433/flash` | api, worker, load/audit | 2 |
| `REDIS_URL` | redis URL | `redis://localhost:6380` | api, worker, load/audit | 1 |
| `SALE_ID` | string | `flash-2026` | api, worker, seed | 1 |
| `SALE_NAME` | string | `Aurora — Founders Edition` | api, seed | 1 |
| `SALE_STARTS_AT` | ISO-8601 UTC | `2026-07-22T12:00:00.000Z` | api, seed | 1 |
| `SALE_ENDS_AT` | ISO-8601 UTC | `2026-07-22T13:00:00.000Z` | api, seed | 1 |
| `SALE_TOTAL_STOCK` | int > 0 | `500` | api, seed | 1 |
| `RATE_LIMIT_MAX` | int | `20` | api | 2 |
| `RATE_LIMIT_WINDOW_MS` | int | `1000` | api | 2 |
| `ORDERS_QUEUE_NAME` | string | `orders` | api, worker | 3 |
| `WORKER_CONCURRENCY` | int | `16` | worker | 3 |
| `WORKER_MAX_ATTEMPTS` | int | `5` | worker | 3 |
| `POSTGRES_USER` | string | `flash` | compose (postgres svc) only | 0 |
| `POSTGRES_PASSWORD` | string | `flash` | compose (postgres svc) only | 0 |
| `POSTGRES_DB` | string | `flash` | compose (postgres svc) only | 0 |

**Compose in-network overrides** (set explicitly in `docker-compose.yml`, not in `.env`):
`DATABASE_URL=postgresql://flash:flash@postgres:5432/flash`, `REDIS_URL=redis://redis:6379`,
`CORS_ORIGIN=http://localhost:5173`, `VITE_API_BASE_URL=http://localhost:3000/api`.

**Phase 0 rule:** `apps/api/src/config/env.ts` and `apps/worker/src/config/env.ts` MUST declare and
default the **entire** table above for their service (so the seam is real from day one), but Phase 0
code only *uses* the rows marked "Phase first used = 0". Parsing is plain `process.env` reads with
`Number()`/defaults — **no** `zod`, **no** `@nestjs/config` in Phase 0.

`.env.example` (SLICE D) contains every row's canonical name with the host-dev default,
grouped by the comment headers: `# runtime`, `# ports`, `# datastores`, `# sale`, `# rate limiting`, `# queue`, `# compose only`.
No `.env` file is ever committed; `.gitignore` includes `.env` and `!.env.example`.

---

## 12. Docker Compose — FROZEN (SLICE D)

File: `infra/docker-compose.yml`. No top-level `version:` key (obsolete in Compose v2).
Build contexts are the **repo root** (`context: ..`) so pnpm workspace files resolve.

Service names (FROZEN, referenced by DNS in URLs): **`redis`, `postgres`, `api`, `worker`, `web`**.
Network name: `flash-net`. Volumes: `flash-pgdata`, `flash-redisdata`.
Container names: `flash-redis`, `flash-postgres`, `flash-api`, `flash-worker`, `flash-web`.

| Service | image / build | ports | healthcheck `test` | interval/timeout/retries/start_period | depends_on |
|---|---|---|---|---|---|
| `redis` | `redis:7.4-alpine`, command `redis-server --appendonly yes --appendfsync everysec` | `6380:6379` | `["CMD","redis-cli","ping"]` | 5s / 3s / 10 / 5s | — |
| `postgres` | `postgres:16-alpine` | `5433:5432` | `["CMD-SHELL","pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]` | 5s / 3s / 10 / 10s | — |
| `api` | `build: { context: .., dockerfile: infra/api.Dockerfile }` | `3000:3000` | `["CMD-SHELL","node -e \"fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]` | 10s / 5s / 6 / 15s | `redis: service_healthy`, `postgres: service_healthy` |
| `worker` | `build: { context: .., dockerfile: infra/worker.Dockerfile }` | `3001:3001` | same shape, URL `http://127.0.0.1:3001/health` | 10s / 5s / 6 / 15s | `redis: service_healthy`, `postgres: service_healthy` |
| `web` | `build: { context: .., dockerfile: infra/web.Dockerfile }` | `5173:80` | `["CMD-SHELL","wget -q --spider http://127.0.0.1/ || exit 1"]` | 10s / 5s / 6 / 10s | `api: service_started` |

- `postgres` mounts `./postgres/init:/docker-entrypoint-initdb.d:ro` and volume `flash-pgdata:/var/lib/postgresql/data`.
- `redis` mounts volume `flash-redisdata:/data`.
- All five services set `restart: unless-stopped`.
- `web` build passes `args: { VITE_API_BASE_URL: http://localhost:3000/api }` (build-time bake).
- Dockerfiles: multi-stage, `node:22.14-alpine` base (the `22.11-alpine` tag is below
  pnpm@11.9.0's minimum supported Node of `>=22.13`, and separately its bundled corepack
  has npm-registry signing keys that go stale over time independent of network reachability —
  see the Dockerfiles for the full rationale), pnpm installed directly via `npm install -g
  pnpm@11.9.0` (bypassing corepack's signature-verification path), `pnpm install
  --frozen-lockfile`, `pnpm --filter @flash/<app>... build`, then a runtime stage running as
  a non-root `node` user with `NODE_ENV=production`. `web.Dockerfile` runtime stage is `nginx:1.27-alpine`
  serving `/usr/share/nginx/html` with `infra/web.nginx.conf` (SPA fallback `try_files $uri /index.html`).
- Compose file must pass `docker compose -f infra/docker-compose.yml config` — **but do not run docker in Phase 0**
  (WSL integration disabled). Validation is by review.

---

## 13. Phase-0 health surface — FROZEN

| App | Surface | Exact response body |
|---|---|---|
| `api` | `GET /api/health` → 200 | `{ "status": "ok", "service": "api", "version": "0.0.0", "uptimeSeconds": <number> }` |
| `worker` | `GET /health` → 200 (Nest HTTP app on `WORKER_HEALTH_PORT`) | `{ "status": "ok", "service": "worker", "version": "0.0.0", "uptimeSeconds": <number> }` |
| `web` | Renders a single centered card showing `@flash/shared` `SERVICE_NAMES` and the fetched api health JSON, or an error line if unreachable | n/a |

- API global prefix is exactly `api` (`app.setGlobalPrefix('api')`). Health is therefore `/api/health`.
- The health payload **shape** is frozen; Phase 2 may ADD keys (`redis`, `postgres`, `queueDepth`)
  and a 503 branch, but must never rename `status`, `service`, `version`, `uptimeSeconds`.
- The `status` literal union `'ok' | 'degraded'` and the `HealthResponse` interface live in
  `@flash/shared` (`src/health.ts`) and are imported by api, worker, and web. This is the one
  Phase-0 shared contract that proves the wiring.
- Worker in Phase 0 is a **Nest HTTP application on the Fastify adapter** exposing only `/health`.
  It becomes a BullMQ consumer in Phase 3; the health server stays.
- API uses `FastifyAdapter` from `@nestjs/platform-fastify`. Listen on `API_HOST`/`API_PORT`.
- Logging in Phase 0 = Nest's built-in `Logger`. **pino arrives in Phase 2.**

`packages/shared/src/constants.ts` (Phase 0 contents, exhaustive):
```ts
export const SERVICE_NAMES = ['api', 'worker', 'web'] as const;
export type ServiceName = (typeof SERVICE_NAMES)[number];
export const API_GLOBAL_PREFIX = 'api';
export const HEALTH_PATH = 'health';
```
`packages/shared/src/index.ts` re-exports `./constants` and `./health` only.

---

## 14. Per-package `package.json` — FROZEN essentials

Dependency versions below are floors; implementers use `^` ranges as written and must not add
packages outside these lists.

### `packages/shared`
`type`: **absent** (CJS). `main: "./dist/index.js"`, `types: "./dist/index.d.ts"`,
`exports: { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } }`, `files: ["dist"]`.
Scripts: `build: "tsc -p tsconfig.json"`, `typecheck: "tsc -p tsconfig.json --noEmit"`,
`lint: "eslint ."`, `test: "vitest run"`, `clean: "rm -rf dist .turbo"`.
devDeps: `@flash/tooling`, `eslint`, `typescript`, `vitest ^2.1.8`.

### `apps/api`
`type`: absent (CJS).
Scripts: `dev: "nest start --watch"`, `build: "nest build -p tsconfig.build.json"`,
`start: "node dist/main.js"`, `typecheck: "tsc -p tsconfig.json --noEmit"`, `lint: "eslint ."`,
`test: "vitest run"`, `test:integration: "vitest run --passWithNoTests integration"`,
`clean: "rm -rf dist .turbo"`.
deps: `@flash/shared`, `@nestjs/common ^10.4.15`, `@nestjs/core ^10.4.15`,
`@nestjs/platform-fastify ^10.4.15`, `reflect-metadata ^0.2.2`, `rxjs ^7.8.1`.
devDeps: `@flash/tooling`, `@nestjs/cli ^10.4.9`, `@nestjs/testing ^10.4.15`, `@types/node ^22.10.2`,
`eslint`, `typescript`, `vitest ^2.1.8`, `unplugin-swc ^1.5.1`.
`vitest.config.ts` uses `unplugin-swc`'s `swc.vite({ module: { type: 'es6' } })` plugin so decorators
compile under Vitest; `test.globals: true`, `test.environment: 'node'`, `test.root: './'`.

### `apps/worker`
Identical shape to `apps/api` with `name: "@flash/worker"`. Same deps list. No `bullmq` yet.

### `apps/web`
`type`: `"module"` (ESM).
Scripts: `dev: "vite"` — the port is set in `vite.config.ts` from `process.env.WEB_PORT ?? 5173`
with `strictPort: true`. Do not pass `--port` on the command line.
`build: "tsc -p tsconfig.json --noEmit && vite build"`, `preview: "vite preview"`,
`typecheck: "tsc -p tsconfig.json --noEmit"`, `lint: "eslint ."`, `test: "vitest run"`,
`clean: "rm -rf dist .turbo"`.
deps: `@flash/shared`, `react ^18.3.1`, `react-dom ^18.3.1`.
devDeps: `@flash/tooling`, `@types/react ^18.3.17`, `@types/react-dom ^18.3.5`,
`@vitejs/plugin-react ^4.3.4`, `vite ^6.0.5`, `vitest ^2.1.8`, `jsdom ^25.0.1`,
`@testing-library/react ^16.1.0`, `@testing-library/jest-dom ^6.6.3`, `eslint`, `typescript`.
`vite.config.ts` MUST set `optimizeDeps: { include: ['@flash/shared'] }` and
`build.commonjsOptions: { include: [/@flash\/shared/, /node_modules/] }` because `@flash/shared` is CJS.
`vite.config.ts` MUST set `server: { port: Number(process.env.WEB_PORT ?? 5173), strictPort: true }`.
**No Tailwind, no shadcn, no Motion, no router, no state library in Phase 0.** `index.css` is a
~20-line plain-CSS reset + centered layout. Phase 4 replaces it wholesale.

`apps/web/src/env.ts` exports
`export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000/api';`

Test floors: each app ships **exactly one** trivial spec (health controller returns the frozen shape;
`App` renders the service list). Coverage thresholds are not configured in Phase 0.

---

## 15. Postgres schema DDL — FROZEN (SLICE D → `infra/postgres/init/001_schema.sql`)

Verbatim. Column names, types, and constraint names are frozen; Phase 2/3 code must match them exactly.

```sql
-- Flash sale schema. Applied by postgres docker-entrypoint-initdb.d on first boot.
-- Phase 0: schema only. No seed rows here (seeding lands in Phase 1).

BEGIN;

CREATE TYPE order_status AS ENUM ('reserved', 'persisted', 'compensated');

CREATE TABLE sales (
  id          text        PRIMARY KEY,
  name        text        NOT NULL,
  total_stock integer     NOT NULL,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_total_stock_nonneg CHECK (total_stock >= 0),
  CONSTRAINT sales_window_valid       CHECK (ends_at > starts_at)
);

CREATE TABLE orders (
  id           uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      text         NOT NULL,
  sale_id      text         NOT NULL REFERENCES sales (id) ON DELETE RESTRICT,
  status       order_status NOT NULL DEFAULT 'reserved',
  created_at   timestamptz  NOT NULL DEFAULT now(),
  persisted_at timestamptz,
  CONSTRAINT orders_user_id_len CHECK (char_length(user_id) BETWEEN 3 AND 64)
);

-- I2 (one confirmed order per user) — the second, independent enforcement point.
-- Deliberately on user_id ALONE, not (sale_id, user_id): the brief scopes this system
-- to a single limited-stock product, and a global uniqueness guarantee is the stronger
-- statement. Revisit only if multi-sale support is ever added.
CREATE UNIQUE INDEX orders_user_id_uniq ON orders (user_id);

CREATE INDEX orders_sale_id_status_idx ON orders (sale_id, status);
CREATE INDEX orders_created_at_idx     ON orders (created_at DESC);

COMMIT;
```

Notes frozen for downstream phases:
- The worker's idempotent write is `INSERT INTO orders (user_id, sale_id, status, persisted_at)
  VALUES ($1, $2, 'persisted', now()) ON CONFLICT (user_id) DO NOTHING` — relies on `orders_user_id_uniq`.
- `gen_random_uuid()` is built into Postgres 16; **no** `pgcrypto`/`uuid-ossp` extension.
- No ORM is chosen in Phase 0. Phase 3 uses the `pg` driver directly against this DDL.
- No migration tool in Phase 0; `001_schema.sql` is the single source. If Phase 2+ needs a change,
  it adds `002_*.sql` — never edits `001_schema.sql`.

---

## 16. Redis key naming scheme — FROZEN

`{...}` braces are **literal characters in the key**, per PRD §3.1. They are Redis Cluster hash tags
that co-locate every key of one sale in a single slot, which is what makes the multi-key Lua script
in PRD §3.2 legal under cluster mode. Do not strip the braces.

With `SALE_ID=flash-2026` the concrete keys are:

| Purpose | Key format | Type | Written by |
|---|---|---|---|
| Remaining stock | `sale:{<saleId>}:stock` | string (integer) | Lua `DECR`, DLQ `INCR`, boot reconcile |
| Buyers set (I2 hot-path) | `sale:{<saleId>}:buyers` | set of `userId` | Lua `SADD`, DLQ `SREM` |
| Sale config | `sale:{<saleId>}:config` | hash: `saleId`, `name`, `startsAt`, `endsAt`, `totalStock` | boot reconcile / seed |
| Attempt outcome counters (ops panel) | `sale:{<saleId>}:metrics` | hash: `confirmed`, `already_purchased`, `sold_out`, `sale_not_active`, `rate_limited` | api `HINCRBY` |
| Lua script SHA cache | in-process only, **no Redis key** | — | api |
| BullMQ | prefix `bull`, queue `orders` → `bull:orders:*` | BullMQ-managed | api (producer), worker (consumer) |

- Timestamps in the `config` hash are stored as **ISO-8601 UTC strings**, not epoch millis.
- BullMQ `jobId` is exactly `` `${saleId}:${userId}` `` — this is the idempotency key for I4.
- Queue name comes from `ORDERS_QUEUE_NAME` (default `orders`); the BullMQ `prefix` option is
  the literal string `bull` and is not configurable.
- Key builders live in `@flash/shared` from **Phase 1** (`saleStockKey(saleId)` etc.).
  Phase 0 does **not** create them — no Redis client exists yet.

---

## 17. CI job graph — FROZEN (SLICE D → `.github/workflows/ci.yml`)

Triggers: `push` to `main`, `pull_request` to `main`, `workflow_dispatch`.
`concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }`.
Runner: `ubuntu-latest`. Node via `actions/setup-node@v4` with `node-version-file: .nvmrc`
and `cache: pnpm`. pnpm via `pnpm/action-setup@v4` (version read from `packageManager`).
Every job starts with checkout → pnpm setup → node setup → `pnpm install --frozen-lockfile`.

```mermaid
flowchart LR
  L[lint] --> B[build]
  T[typecheck] --> B
  U[unit] --> I[integration]
  T --> I
  B --> K[k6-smoke]
  C[compose-config]
```

| Job id | `needs` | Runs |
|---|---|---|
| `lint` | — | `pnpm format:check` then `pnpm lint` |
| `typecheck` | — | `pnpm typecheck` |
| `unit` | — | `pnpm test` |
| `build` | `[lint, typecheck]` | `pnpm build` |
| `integration` | `[typecheck, unit]` | `pnpm test:integration` with **service containers** `redis:7.4-alpine` (6379:6379) and `postgres:16-alpine` (5432:5432, env `POSTGRES_USER/PASSWORD/DB=flash`), both with healthchecks; job env `REDIS_URL=redis://localhost:6379`, `DATABASE_URL=postgresql://flash:flash@localhost:5432/flash` |
| `compose-config` | — | `docker compose -f infra/docker-compose.yml config -q` |
| `k6-smoke` | `[build]` | Phase 0: job exists with `if: false` and a single `echo "k6 smoke lands in Phase 5"` step. Phase 5 enables it with a `dorny/paths-filter` gate on `apps/api/**`, `apps/worker/**` |

Phase 0 acceptance: `lint`, `typecheck`, `unit`, `build`, `integration`, `compose-config` all green.
No `continue-on-error` anywhere. No matrix. No caching beyond setup-node's pnpm cache and
`actions/cache` for `.turbo` keyed on `${{ runner.os }}-turbo-${{ github.sha }}`.

---

## 18. Required contents of `AGENTS.md` (SLICE E writes it — architect specifies it here)

`AGENTS.md` is the **runtime-agnostic rulebook**. Its success test: *a fresh Codex session, given
only the repo at tag `phase-N-done` and this file, can resume the build correctly with zero
conversational context.* It must be self-contained — never say "as discussed" or "see the chat".
It must not use Claude-Code-specific syntax (no `/slash` commands, no `Task` tool names) except in a
clearly-labelled "Claude Code specifics" appendix.

Required sections, in this order:

1. **What this repo is** — one paragraph + pointer to `PRD.md` as the authoritative spec.
2. **Hard invariants I1–I4** — quoted verbatim from PRD §2, with the one-line enforcement mechanism
   for each (Lua atomicity / unique index / window guard / DLQ compensation). Marked *never negotiable*.
3. **Resume protocol** — the exact command sequence: `git tag --list 'phase-*-done'` → read `STATE.md`
   → `git checkout <latest tag>` → read `.claude/contracts/phase-<next>.md` → execute next actions.
   Must state that `STATE.md` is the only source of truth for "where are we".
4. **Phase map & gates** — the PRD §8 table, plus the gate ritual: verification green → commit →
   `git tag phase-N-done` → update `STATE.md`. State that tags are annotated (`git tag -a`).
5. **Orchestrator contract** — PRD §9.1 verbatim in spirit: the orchestrator NEVER writes source code;
   it plans, spawns, arbitrates, and maintains `STATE.md`/tags only.
6. **Model routing policy** — PRD §9.2 table, plus a runtime-mapping note ("on Codex, read
   Opus↦deep-reasoning mode, Sonnet↦default, Haiku↦fast mode").
7. **Subagent roster** — PRD §9.3, with the hard rule that a frontend agent MUST load the
   `frontend-design` skill before writing UI code, and the skill-provisioning rule from PRD §9.5.
8. **Verification loop & loop budget** — max 3 implement→verify iterations, then mandatory escalation;
   verification is command-evidence based, never self-attestation. Include the exact verification
   command block: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
9. **Fan-out rules** — exclusive path ownership; slices integrate only through frozen contracts in
   `.claude/contracts/`; cross-slice changes route through the architect, never agent-to-agent.
10. **Conventions** — package scope `@flash`, no path aliases, backend CJS / web ESM, env var table
    pointer to `.env.example`, Conventional Commits (`feat|fix|chore|docs|test|ci|refactor(scope): subject`),
    branch naming `phase-N/<slice>`, never commit `.env`, never edit `prototype/`.
11. **Local dev quickstart** — `pnpm i`, `docker compose -f infra/docker-compose.yml up -d`, `pnpm dev`,
    plus the port table from §10 of this contract.
12. **Definition of done per phase** — one bullet per phase mirroring PRD §8 "Gate evidence".
13. **Claude Code specifics (appendix)** — `.claude/agents/*` roster files, settings hooks. Explicitly
    marked as optional/ignorable by other runtimes.

`AGENTS.md` must NOT contain: implementation code, duplicated DDL/env tables (link to
`.claude/contracts/phase-0.md` and `.env.example` instead), or anything that goes stale per-phase
(that belongs in `STATE.md`).

`STATE.md` (also SLICE E) required sections: **Current phase**, **Last tag**, **Verification evidence**
(pasted command output summary), **Open issues**, **Exact next actions** (numbered, imperative),
**Changelog** (one line per gate). Phase 0 initial content records phase 0 in progress with next
actions pointing at Phase 1.

---

## 19. Definition of done — Phase 0 gate

From a clean clone, all of the following succeed:

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:integration     # passes with no integration tests present
pnpm stress               # prints the Phase-5 placeholder, exits 0
```

Plus, by review (docker unavailable this phase):
- `infra/docker-compose.yml` declares exactly the five services, ports, healthchecks of §12.
- `infra/postgres/init/001_schema.sql` matches §15 byte-for-byte in column/constraint names.
- `.env.example` contains every row of §11 with the frozen spelling.
- `AGENTS.md` contains all 13 sections of §18.
- No file exists outside the tree in §3.

Then: commit → `git tag -a phase-0-done -m "Phase 0: bootstrap"` → update `STATE.md`.
