# Phase 4 contract — frontend

**Status:** FROZEN for implementation once handed off
**Base:** annotated tag `phase-3-done`, commit `e7d43d09a415186a557dd0b554c67af849893465`
**Phase branch:** `phase-4/frontend`
**Authoritative inputs:** `PRD.md` in full; `AGENTS.md`; `STATE.md`; the read-only
`prototype/index.html`; Phase 1 DTO contracts; Phase 2 API contract and shipped endpoints; Phase 3
durability/status semantics.

This file is the complete implementation contract for Phase 4. Implementers do not invent shared
names, response meanings, routes, paths, polling behavior, or test evidence outside it. After
dispatch, changes are additive, numbered amendments authored by the architect; side-channel drift
is not allowed.

---

## 0. Scope boundary

### 0.1 In scope

- Replace the Phase 0 `@flash/web` scaffold with the React SPA represented by
  `prototype/index.html`.
- Preserve the prototype's Aurora identity, product story, acquisition console, sale state,
  countdown, supply display, identifier form, purchase feedback, reservation check, protocol
  explanation, compact operations ledger, and footer.
- Drive all business state from the shipped API:
  - `GET /api/sale/status`
  - `POST /api/purchase`
  - `GET /api/purchase/:userId`
  - `GET /api/sale/metrics`
  - `GET /api/health/ready`
- Implement bounded, non-overlapping sale polling with jittered backoff and a server-time-derived
  countdown.
- Add deterministic Vitest unit/component coverage and Playwright Chromium browser smoke,
  accessibility, responsive, and visual-regression coverage.
- Add only the frontend test dependencies frozen in §14.

### 0.2 Out of scope

- Any edit under `prototype/**`. It is read-only, including whitespace and generated screenshots.
- Any edit under `apps/api/**`, `apps/worker/**`, `packages/**`, `infra/**`, `load/**`,
  `.github/**`, `.env.example`, `turbo.json`, `STATE.md`, or this contract after dispatch.
- New or changed API endpoints, DTOs, Redis keys/scripts, queues, Postgres schema, authentication,
  payments, carts, multiple products/sales, admin mutation controls, SSE, or WebSockets.
- A frontend scenario switcher or reset action. The prototype's **demo-only** Upcoming / Active /
  Sold out / Ended / Reset controls mutate local fake state and must not ship in the real SPA.
- Worker-port polling. The browser consumes API readiness, which already summarizes Redis,
  Postgres, clock, sale, and queue health. It must not call the worker on port 3001.
- Phase 5 k6/stress work or Phase 6 README/ship documentation.
- Client-side enforcement of I1-I4. Client state is presentation; Redis/Postgres/worker remain the
  enforcement points.

### 0.3 Deliberate resolutions of reference/API differences

These are explicit decisions, not accidental visual drift.

| Difference | Phase 4 decision | Why |
| --- | --- | --- |
| Prototype is an in-browser simulation | Remove all fake buyers, stock mutation, scenario buttons, reset, artificial purchase delay, and fake persistence timer | Production UI must never fabricate a business result |
| Prototype hard-codes `50` units | Render `name`, `totalStock`, `stockRemaining`, and window from `/sale/status`; preserve the 50-segment visual signature with truthful proportional semantics for larger totals (§7.4) | `.env.example` currently configures 500; hard-coded 50 would lie |
| PRD describes one dependency-aware `/health` | Poll shipped `GET /api/health/ready`; do not poll liveness `/api/health` | Phase 2 intentionally split liveness and readiness to avoid restart storms |
| PRD summary lists reserved/persisted | Also render shipped terminal `compensated` with `purchased: false` | Phase 3 compensation returns stock; saying the buyer still holds it would violate I4 truthfulness |
| Prototype counters are local | Display aggregate server metrics from `/sale/metrics`; never increment counters locally as if durable | Multiple clients and async persistence make local counters misleading |
| Prototype imports Tailwind/Basecoat/Motion CDNs | Implement with React and plain CSS; no runtime CSS/animation CDN and no Tailwind/Motion dependency | Existing web convention is plain CSS; fewer runtime dependencies and identical production/offline build behavior |
| Shared Zod schemas exist at `@flash/shared/schemas` | Import DTOs with `import type` only; use small defensive response decoders local to web | Phase 1 explicitly keeps Zod out of the browser bundle |

---

## 1. Hard invariants — Phase 4 obligations

The frontend is not an enforcement boundary, but it can misrepresent or amplify outcomes. These
rules are mandatory.

| Invariant | Phase 4 mechanism |
| --- | --- |
| **I1 — no oversell** | The SPA never decrements stock optimistically and never synthesizes `CONFIRMED`. Stock changes only from parsed API responses: `/sale/status`, or non-null `stockRemaining` in a purchase envelope. A button click produces exactly one POST while in flight. |
| **I2 — one per user** | The SPA trims and validates the identifier before POST, disables duplicate submission while the request is pending, and renders `ALREADY_PURCHASED` as the original reservation still standing. It never treats a duplicate as a new success or creates a client-side entitlement. Redis buyers plus `orders_user_id_uniq` remain authoritative. |
| **I3 — half-open window `[startsAt, endsAt)`** | The countdown and disabled state derive from server-time offset and the shipped millisecond fields. This is advisory UX only. The SPA never claims its clock enforces the window and always renders `SALE_NOT_STARTED` / `SALE_ENDED` from the server. The unchanged Redis `TIME` Lua check remains the actual enforcement point. |
| **I4 — no lost confirmations** | Only HTTP 201 with a valid `status: CONFIRMED` envelope may say “secured”. Transport failure/abort after POST is **ambiguous**, never “failed”: render “Result unknown — check your reservation before trying again” and expose the status action. Never automatically retry POST. Status distinguishes `reserved`, `persisted`, and `compensated`; compensated is explicitly not purchased and may be attempted again while active. The client never compensates. |

Any implementation that updates stock/counters before a server response, auto-retries POST, shows
success from an HTTP class without a valid envelope, or maps `compensated` to held inventory is a
critical rejection.

---

## 2. Exclusive ownership and dispatch sequence

Phase 4 is intentionally one vertical slice. Splitting React components and their shared state
across concurrent implementers would create overlapping ownership under `apps/web` and violate
`AGENTS.md` §9.

### F1 — frontend production + proof (`frontend-implementer` only)

F1 exclusively owns these existing paths:

```text
apps/web/index.html
apps/web/package.json
apps/web/tsconfig.json
apps/web/tsconfig.node.json
apps/web/vite.config.ts
apps/web/vitest.config.ts
apps/web/src/App.tsx
apps/web/src/App.test.tsx
apps/web/src/env.ts
apps/web/src/index.css
apps/web/src/main.tsx
apps/web/src/vite-env.d.ts
pnpm-lock.yaml
.gitignore                         # only the two Playwright output rows in §13.4
```

F1 may create only the new paths named in §3. F1 does not own any other path. Generated
`apps/web/dist/**`, `apps/web/.turbo/**`, `apps/web/node_modules/**`, `test-results/**`, and
`playwright-report/**` are evidence/output, never authored source.

### Sequence

1. Root/architect freezes this file.
2. Root dispatches exactly one `frontend-implementer` with Brief F1 in §17 and the mandatory skill
   manifest in §16.
3. F1 implements and runs its slice evidence (§15.1). Maximum three implement/verify iterations.
4. Root independently reruns the checks with Turbo cache bypassed, then runs the browser/a11y/
   visual evidence (§15.2).
5. Only after verification is green, dispatch an `adversarial-reviewer` to inspect the complete
   Phase 4 diff and exercise the browser (§15.3). Any fix routes back to F1; the reviewer does not
   edit.
6. Root alone commits, tags `phase-4-done`, and updates `STATE.md` (§15.4).

No parallel implementation fan-out is permitted in this phase.

---

## 3. Frozen file tree

The final authored Phase 4 tree under `apps/web` is:

```text
apps/web/
├── e2e/
│   ├── __screenshots__/
│   │   ├── desktop-chromium/
│   │   │   └── active-sale.png
│   │   └── mobile-chromium/
│   │       └── active-sale.png
│   ├── fixtures.ts
│   └── flash-sale.spec.ts
├── src/
│   ├── api/
│   │   ├── client.spec.ts
│   │   ├── client.ts
│   │   ├── contracts.ts
│   │   ├── decoders.spec.ts
│   │   └── decoders.ts
│   ├── components/
│   │   ├── AcquisitionConsole.tsx
│   │   ├── BrandNav.tsx
│   │   ├── Countdown.tsx
│   │   ├── OpsLedger.tsx
│   │   ├── ProductStory.tsx
│   │   ├── ProtocolSteps.tsx
│   │   ├── PurchaseForm.tsx
│   │   ├── PurchaseStatusCheck.tsx
│   │   └── StockMeter.tsx
│   ├── hooks/
│   │   ├── useOpsSnapshot.ts
│   │   └── useSaleStatus.ts
│   ├── lib/
│   │   ├── polling.spec.ts
│   │   ├── polling.ts
│   │   ├── time.spec.ts
│   │   ├── time.ts
│   │   ├── user-id.spec.ts
│   │   └── user-id.ts
│   ├── App.test.tsx
│   ├── App.tsx
│   ├── env.ts
│   ├── index.css
│   ├── main.tsx
│   └── vite-env.d.ts
├── eslint.config.mjs             # unchanged
├── index.html
├── package.json
├── playwright.config.ts
├── tsconfig.json
├── tsconfig.node.json
├── vite.config.ts
└── vitest.config.ts
```

Do not create a router, state-management package, CSS framework config, asset-generation script,
service worker, Storybook, or alternate component tree.

---

## 4. Route and API interface contract

### 4.1 Browser route

There is one SPA surface: **`GET /`**. No client router and no path-based screens. Purchase status
is an inline disclosure in the acquisition console, matching the prototype.

Unknown paths remain the existing nginx SPA fallback but are not product routes and receive no
special React rendering in this phase.

### 4.2 API base

`apps/web/src/env.ts` exports exactly:

```ts
API_BASE_URL: string
```

- Source: `import.meta.env.VITE_API_BASE_URL`.
- Development fallback remains `http://localhost:3000/api`.
- Strip trailing `/` characters once so path construction cannot produce `//sale/status`.
- Add no new environment variable. `VITE_API_BASE_URL` remains the sole browser env value and is
  already frozen in `.env.example`, Compose, and `turbo.json`.
- Never append a client-supplied `saleId`; the system is single-sale.

### 4.3 Exact client paths

`createApiClient` in `src/api/client.ts` constructs only:

| Function | Method and URL | Body |
| --- | --- | --- |
| `getSaleStatus(signal?)` | `GET ${API_BASE_URL}/sale/status` | none |
| `purchase(userId, signal?)` | `POST ${API_BASE_URL}/purchase` | JSON `{ "userId": trimmed }` |
| `getPurchaseStatus(userId, signal?)` | `GET ${API_BASE_URL}/purchase/${encodeURIComponent(userId)}` | none |
| `getSaleMetrics(signal?)` | `GET ${API_BASE_URL}/sale/metrics` | none |
| `getReadiness(signal?)` | `GET ${API_BASE_URL}/health/ready` | none |

POST sets `Content-Type: application/json`. GETs have no body. Do not send credentials or custom
identity headers. Do not invent a request ID; the API owns it.

### 4.4 Shared DTO use

Use erased imports only:

```ts
import type {
  PurchaseResponse,
  PurchaseStatusResponse,
  SaleStatusResponse,
} from '@flash/shared/schemas';
```

Value imports may come from `@flash/shared` for frozen zero-dependency constants/types such as
`ATTEMPT_OUTCOMES`, `SALE_METRIC_FIELDS`, `USER_ID_MIN_LENGTH`, `USER_ID_MAX_LENGTH`, and
`USER_ID_PATTERN`. Never value-import `@flash/shared/schemas` and never add `zod` to web.

### 4.5 Web-local ops/error types

`src/api/contracts.ts` owns these web-local interfaces because the shipped API does not export
them from `@flash/shared`:

```ts
type ApiErrorResponse = {
  error: string;
  message: string;
  requestId: string;
  serverTime: string;
  serverTimeMs: number;
};

type SaleMetricsResponse = {
  saleId: string;
  metrics: Record<
    | 'confirmed'
    | 'already_purchased'
    | 'sold_out'
    | 'sale_not_active'
    | 'not_initialized'
    | 'rate_limited'
    | 'invalid_user_id',
    number
  >;
  serverTime: string;
  serverTimeMs: number;
};

type ReadinessResponse = {
  status: 'ok' | 'degraded';
  service: 'api';
  version: string;
  uptimeSeconds: number;
  checks: {
    redis: { ok: boolean; latencyMs: number | null };
    postgres: { ok: boolean; latencyMs: number | null };
    clock: { ok: boolean; offsetMs: number; rttMs: number; ageMs: number };
    sale: { ok: boolean; initialized: boolean; stockKeyPresent: boolean };
    queue: {
      ok: boolean;
      waiting: number;
      active: number;
      delayed: number;
      failed: number;
    };
  };
  requestId: string;
  serverTime: string;
  serverTimeMs: number;
};
```

The readiness decoder must tolerate a missing `requestId`/`serverTime` on a nonconforming failure
by rejecting the body into the generic unavailable state; it must not render raw data.

### 4.6 Defensive decoding and HTTP semantics

All `response.json()` values enter as `unknown`. `src/api/decoders.ts` validates every field the UI
uses: object-ness, literal vocabularies, finite integer millis/counts, nullable fields, and nested
order/check shapes. It is a defensive browser boundary, not a second domain schema. Do not use
`as SomeResponse` directly on JSON.

- A valid purchase envelope is handled by `status` even for non-2xx HTTP responses.
- An `ApiErrorResponse` is permitted for non-purchase routes and unexpected 500 purchase errors.
- Invalid JSON, an invalid shape, fetch rejection, or timeout becomes a typed `ApiClientError` with
  kind `network | timeout | invalid-response | http` and a safe UI message. Never surface raw
  exception text, response bodies, URLs with user IDs, request IDs, or stacks.
- Preserve `Retry-After` as an optional nonnegative integer seconds value, capped at 10 for UI
  countdown purposes. The server response still controls when a user may retry.
- Each request has an AbortSignal supplied by its owner. Sale/ops GET requests additionally use a
  4,000 ms client timeout. A purchase POST is not automatically aborted on an arbitrary short UI
  deadline; it is aborted only on page unmount/navigation. Once dispatched, its outcome may be
  ambiguous.

`createApiClient({ baseUrl, fetchImpl, nowMs })` is the test seam. The production singleton uses
`API_BASE_URL`, `globalThis.fetch`, and `Date.now`.

---

## 5. Identifier contract

`src/lib/user-id.ts` imports the frozen constants from `@flash/shared` and exports:

```ts
normalizeUserId(raw: string): string
validateUserId(raw: string): { ok: true; value: string } | { ok: false; message: string }
```

Normative behavior:

1. Trim leading/trailing whitespace once.
2. Accept 3–64 characters matching `/^[a-zA-Z0-9._@-]+$/`.
3. Do not lowercase, Unicode-normalize, or otherwise rewrite identity.
4. Empty/short/long/invalid-character input receives the same stable user-facing message:
   `Enter 3–64 characters using letters, numbers, ., _, @, or -.`
5. The normalized value is the only value sent or placed in the encoded status path.

Input attributes: `type="text"`, `name="userId"`, `autoComplete="username"`,
`spellCheck={false}`, `minLength={3}`, `maxLength={64}`, and `inputMode="email"`. The UI label is
`Email or username`; it does not imply full RFC email validation.

---

## 6. Server-aligned time and sale presentation state

### 6.1 Offset

`src/lib/time.ts` exports pure functions. For a response whose request began at `sentAtMs`, ended at
`receivedAtMs`, and carries `serverTimeMs`:

```text
midpointMs = sentAtMs + (receivedAtMs - sentAtMs) / 2
offsetMs   = serverTimeMs - midpointMs
serverNow  = Date.now() + offsetMs
```

Store the newest successful offset. Do not average old samples and do not parse ISO timestamps on
the render path. Purchase/status/metrics responses may refresh the offset if they pass decoding.

### 6.2 Derived UI state

Given the last valid sale snapshot and `serverNow`:

```text
serverNow < startsAtMs       => upcoming
serverNow >= endsAtMs        => ended
stockRemaining <= 0          => sold_out
otherwise                    => active
```

The end boundary is exclusive. Time takes precedence over stock at/after end. Before start,
upcoming takes precedence over zero stock because the sale has not opened. This is presentation
only; server purchase outcomes override the display and trigger an immediate status refresh.

### 6.3 Countdown

- Upcoming target: `startsAtMs`, label `Opens in`, hint `Button unlocks automatically.`
- Active target: `endsAtMs`, label `Closes in`, hint `Live — good luck.`
- Sold out: `00:00:00`, label `Allocation`, hint `All available cards are claimed.`
- Ended: `00:00:00`, label `Window`, hint `This drop is closed.`
- Use `Math.max(0, Math.ceil((target - serverNow) / 1000))`, format HH:MM:SS with tabular
  numerals, and allow hours above 23.
- A 250 ms local render tick keeps the transition crisp. It performs no network request.
- The timer has `role="timer"` and an accessible label but is **not** live-announced every second.

### 6.4 Header clock

The prototype's `SYD` label is replaced by `SERVER` because the API clock is UTC/Redis anchored,
not guaranteed Sydney local time. Display server-aligned local `HH:MM:SS` with title
`Server-aligned time`. Hide the clock text below 640 px as in the prototype.

---

## 7. Polling and state ownership

### 7.1 Sale status polling

`useSaleStatus` owns one request generation, one timeout, and at most one in-flight GET.

After a successful response:

- If state is upcoming and `0 < startsAtMs - serverNow <= 10_000`, next delay is exactly 1,000 ms.
- Otherwise base delay is 2,000 ms with uniform ±30% jitter: integer 1,400–2,600 ms.
- Consecutive failure count resets to zero.

After consecutive failure number `n` (first failure is 1):

```text
base = min(10_000, 2_000 * 2^(n - 1))
delay = min(10_000, round(base * (0.7 + rng() * 0.6)))
```

`rng()` is in `[0,1)`. The hard cap is 10,000 ms **after** jitter. Poll immediately on mount and
when Retry is activated. An immediate refresh coalesces with an in-flight request; it never starts
a second request. Abort and invalidate the generation on unmount so StrictMode cannot commit a
stale response or leak a timer.

Keep the last valid snapshot during transient poll failure. Show a stale/unreachable banner but do
not invent a state. With no valid snapshot, show loading placeholders and disable Buy. With a last
valid snapshot, the Buy state continues to derive from server-aligned time; the POST remains the
only truth and may reject. A Retry control requests an immediate refresh.

### 7.2 Ops polling

`useOpsSnapshot` starts metrics and readiness together with `Promise.allSettled`; one failure must
not erase the other's last good value.

- Healthy base: 5,000 ms with uniform ±30% jitter, hard-capped at 6,500 ms.
- Failure backoff per resource: 5,000 → 10,000 → 15,000 ms, each with ±30% jitter and a final
  15,000 ms cap.
- There is only one shared ops timer and one generation. It selects the earliest due resource and
  fetches only resources due at that time.
- No overlapping request for the same resource; 4,000 ms timeout; abort on unmount.
- A sale status Retry also requests due ops resources immediately, coalesced as above.

### 7.3 Visibility

When `document.visibilityState === 'hidden'`, do not start new polls. Keep the countdown local. On
return to visible, request status immediately and due ops resources immediately. Register exactly
one `visibilitychange` listener per hook and remove it on unmount.

### 7.4 Stock meter

- Always display exact text: `{stockRemaining} / {totalStock} remaining`.
- If `totalStock <= 50`, render one segment per unit and label `Supply — each tick is one card`.
- If `totalStock > 50`, render exactly 50 equal segments as a proportional gauge and label
  `Supply — 50-segment allocation gauge`. A segment is active when its represented fraction is
  still available; this is visual approximation only and the exact text is authoritative.
- At ≤20% remaining, active segments use amber; at zero they use red/gone styling. Never use color
  alone: exact text and the status pill carry the state.
- `totalStock === 0` is valid and renders zero remaining without division by zero.
- Announce stock changes in a visually hidden `aria-live="polite"` region, but only after a new
  server response, not on every React render.

---

## 8. Purchase interaction state machine

`App.tsx` owns the normalized identifier and the purchase interaction state; presentational
components receive explicit props. Do not add a global store.

```text
idle
  -> submitting
  -> confirmed | duplicate | sold_out | not_started | ended
     | rate_limited | invalid | unavailable | unknown
```

### 8.1 Submit

1. Prevent default.
2. Validate and focus the input on failure. No fetch.
3. Snapshot the normalized user ID.
4. Set `submitting`; disable input, Buy, and status check; set `aria-busy=true`.
5. Dispatch exactly one POST. Repeated clicks/Enter while submitting are ignored.
6. Decode envelope. Branch on `status`, not HTTP class alone.
7. Apply non-null `stockRemaining` to the presentation snapshot only if it belongs to the current
   sale ID; then request an immediate authoritative sale refresh.
8. Re-enable controls unless a rate-limit retry countdown is active.

There is no automatic POST retry for any reason.

### 8.2 Outcome copy and treatment

Every result uses icon/text plus color, within one persistent `role="status" aria-live="polite"`
feedback region.

| Outcome | Heading | Required meaning/action |
| --- | --- | --- |
| `CONFIRMED` | `Card secured` | `Reserved for {userId}. Persistence may take a few seconds.` Success styling. Set button text `✓ Card secured`; expose Check status. |
| `ALREADY_PURCHASED` | `You already hold a reservation` | `One per customer — check the original reservation below.` Amber styling; never claim a new confirmation. |
| `SOLD_OUT` | `Sold out` | `Supply reached zero before this attempt landed.` Error styling; refresh status. |
| `SALE_NOT_STARTED` | `Not open yet` | `The server has not opened this sale.` Informational styling; refresh status. |
| `SALE_ENDED` | `This drop is closed` | `The sale window has ended.` Neutral/error styling; refresh status. |
| `NOT_INITIALIZED` | `Sale temporarily unavailable` | `The sale is not ready. Try refreshing live status.` No business outcome fabricated. |
| `INVALID_USER_ID` | `Check your identifier` | Show the frozen local validation message and focus input. |
| `RATE_LIMITED` | `Too many attempts` | Show `Try again in Ns.` from capped Retry-After; disable Buy until local countdown expires; no automatic submit. |
| `UPSTREAM_UNAVAILABLE` | `Service temporarily unavailable` | `No purchase result was confirmed. Check status before trying again.` |
| Transport timeout/rejection after dispatch | `Result unknown` | `The request may have reached the sale. Check your reservation before trying again.` This is the I4-safe ambiguous state. |
| Invalid/unexpected response | `We could not verify the result` | Same check-first action; never render raw payload/error. |

Input change after a terminal result clears feedback only when the normalized value differs from
the attempted value. It does not mutate sale/ops state.

### 8.3 Buy button presentation

- No snapshot/loading: `Loading sale…`, disabled.
- Upcoming: `Opens soon`, disabled.
- Active idle: `Secure your card`, enabled if identifier control is not rate-limited.
- Submitting: `Securing…` with an `aria-hidden` spinner; disabled.
- Confirmed for the unchanged identifier: `✓ Card secured`, success styling, disabled until the
  identifier changes.
- Sold out: `Sold out`, disabled.
- Ended: `Sale ended`, disabled.
- During rate-limit countdown: `Try again in Ns`, disabled.

Client disabled state is UX only. It must not be described as I3 enforcement.

---

## 9. Purchase-status check

The inline `PurchaseStatusCheck` uses the same identifier field and does not create a second input.

1. Validate/normalize exactly as purchase. Focus the input on failure.
2. Disable while its GET is in flight and expose busy text `Checking…`.
3. Always use `encodeURIComponent` in the path.
4. Render:

| Response | Copy/meaning |
| --- | --- |
| `purchased: true`, `reserved` | `Reservation found — reserved and waiting for durable persistence.` |
| `purchased: true`, `persisted` | `Reservation found — persisted to the permanent record.` Include formatted `createdAt` when non-null. |
| `purchased: false`, `compensated` | `Reservation released — persistence failed safely and the stock was returned.` If sale is active, add `You may try again.` |
| `purchased: false`, `order: null` | `No reservation found for {userId}.` If active, add `Supply may still be available.` |
| 503/network/invalid response | `Reservation status is temporarily unavailable. Try again.` Never display `No reservation found`; absence is not known. |

`reserved` normally has `createdAt: null`; `persisted`/`compensated` may have a non-null creation
time. Do not poll the per-user endpoint automatically. The buyer explicitly checks again, which
keeps candidate-identifier probing and Postgres load bounded to user action.

---

## 10. Operations ledger

The dark full-width ledger preserves the prototype layout but is read-only.

Header:

- Label `Ops ledger`.
- Badge: `API ready`, `API degraded`, `API unreachable`, or `Checking API`, with icon/dot and text.
- Remove `demo mode`, Scenario, and Reset controls.

Four cells:

1. `Confirmed` → `metrics.confirmed`.
2. `Duplicate 409` → `metrics.already_purchased`.
3. `Sold out 410` → `metrics.sold_out`.
4. `Status poll` → current nominal display: `1s` near start, `2s ±30%` healthy, or
   `backing off ≤10s` after failure.

Below the cells:

- Render sale window in the acquisition console header using the user's locale and explicit
  `local` suffix; accessible `datetime` values use the API ISO strings.
- Preserve protocol line:
  `REDIS LUA · ATOMIC DECIDE → BULLMQ → POSTGRES PERSIST · INVARIANTS I1–I4 ENFORCED`.
- Add a quiet readiness summary derived from checks, e.g. `Redis ready · Postgres ready · Queue 0
  waiting / 0 active / 0 failed`; if a check is unavailable, say unavailable rather than zero.
- Show `Updated {relative seconds}s ago` from the last ops response; no live announcement each
  second.

Metrics/readiness errors retain last good values with a visible `stale` label. Never replace an
unknown count with zero. Initial state uses an em dash, not `0`.

---

## 11. Visual contract

### 11.1 Direction and signature

The direction remains the approved **clean fintech** prototype: precise, trustworthy, restrained.
The single signature is the brushed-titanium founders card with its light sweep and pointer-fine
tilt. Do not add gradients, glass panels, decorative blobs, stock photography, confetti, or a
second signature effect.

The card tilt may write `transform` directly through a ref during pointer movement to avoid React
re-renders. Enable only for `(pointer: fine)` and when reduced motion is false; return to neutral
on pointer leave.

### 11.2 Frozen tokens

Declare these CSS custom properties in `:root` and use them consistently:

| Token | Value |
| --- | --- |
| `--color-ink` | `#0b1526` |
| `--color-ink-2` | `#142138` |
| `--color-slate` | `#4e5b73` |
| `--color-muted` | `#8a94a6` |
| `--color-indigo` | `#4353ff` |
| `--color-indigo-deep` | `#2f3bd4` |
| `--color-indigo-soft` | `#edefff` |
| `--color-hair` | `#e5e8ee` |
| `--color-hair-strong` | `#cbd2dd` |
| `--color-canvas` | `#f6f7f9` |
| `--color-green` | `#0e8a5f` |
| `--color-green-soft` | `#e7f5ef` |
| `--color-amber` | `#96690a` |
| `--color-amber-soft` | `#fbf3dc` |
| `--color-red` | `#b42318` |
| `--color-red-soft` | `#fdecea` |
| `--radius-console` | `16px` |
| `--radius-control` | `12px` |
| `--shadow-console` | `0 1px 2px rgba(11,21,38,.04), 0 12px 40px -18px rgba(11,21,38,.18)` |

Typography must reproduce the prototype roles:

- Display: `Schibsted Grotesk`, system-ui, sans-serif.
- Editorial accent: `Instrument Serif`, Georgia, serif.
- Body/control: `Inter`, system-ui, sans-serif.
- Data: `IBM Plex Mono`, ui-monospace, monospace with tabular numerals.

`index.html` carries the same Google Fonts preconnect/stylesheet as the prototype and changes title
to `Aurora — Founders Edition Flash Sale`. Fonts have robust fallbacks; app functionality and
layout remain usable if the remote font request fails. Do not add font binaries in this phase.

The body preserves the near-white 26 px radial dot grid. All color contrast must meet WCAG AA.

### 11.3 Layout and content

- Outer max width: 1152 px; horizontal padding 20 px, 32 px at ≥640 px.
- Nav: 64 px tall, bottom hairline, Aurora lightning mark, `aurora`, `/ founders drop`,
  server-aligned clock, sale status pill.
- Main: at ≥1024 px, 12 columns with ProductStory 5 and AcquisitionConsole 7; 56 px gap. Below
  1024 px, one column with 40 px gap. Top padding 48 px; bottom 64 px.
- Preserve product headline exactly: `The last card / we'll ever mint / this way.`
- Preserve italic line: `One card. One customer. {totalStock in words is not required};` use the
  exact prototype copy `One card. One customer.` and dynamic inline `{totalStock} ever.`
- Preserve metal card aspect ratio 1.586, max width 400 px, product details $249 AUD / Titanium /
  dynamic numbered range `001–{totalStock padded to at least 3}`.
- Console padding 24 px, 32 px at ≥640 px. Preserve countdown segments, supply meter, form,
  feedback, status-check row, and protocol steps 01–03.
- Protocol copy may replace `A confirmed tick is yours` with `A confirmed reservation is yours`
  for truthful large-stock semantics; otherwise preserve the prototype language.
- Ops ledger remains below main, dark navy, then the prototype footer. Footer technology text
  becomes `React · Vite · accessible by design`; do not claim Tailwind/Motion.

### 11.4 Responsive behavior

- At 390 px viewport: no horizontal overflow; countdown remains one row; its hint column is
  hidden; form and action button stack; product details remain three compact columns; ops cells
  become two columns; footer wraps.
- At 640 px: form becomes input + 190 px button; ops remains responsive.
- At 1024 px: main becomes 5/7 grid.
- Buy/status controls have a minimum 44 px interactive height. No text below 10 px except purely
  decorative card engraving, which is `aria-hidden`.
- Content must remain usable at 200% zoom and with long localized number formatting up to at least
  999,999 stock.

### 11.5 Motion

- Page entrance: one restrained fade/translate sequence, CSS only, ≤500 ms.
- Countdown digit change: ≤280 ms fade/translate.
- Feedback entrance: ≤300 ms.
- Button hover lifts at most 1 px.
- Under `prefers-reduced-motion: reduce`, disable all animation, smooth scroll, light sweep, card
  tilt, and nonessential transition. No content depends on animation.

---

## 12. Accessibility and resilience contract

- Semantic `<nav>`, `<main>`, named sections, headings in order, `<form>`, `<label>`, `<dl>`, and
  `<footer>`.
- One visible `<h1>`. Acquisition console is `<h2>` and Ops ledger is a named region.
- Sale pill always includes readable state text; live state may animate only its decorative dot.
- Input hint and error are connected with stable `aria-describedby` IDs. Invalid input sets
  `aria-invalid=true` and focuses the input.
- Feedback uses `aria-live="polite"`; validation errors use `role="alert"`. Do not use assertive
  live regions for countdown/poll churn.
- Focus-visible ring: 2 px indigo, 2 px offset, on every interactive element. Never remove outline
  without replacement.
- Loading spinner is `aria-hidden`; button text carries the state. `aria-busy` marks the form/check
  region while pending.
- API-unreachable banner has text plus Retry button and does not cover content. It is not a toast
  that disappears automatically.
- Network errors preserve the user's identifier. Never clear it on submit.
- No `dangerouslySetInnerHTML`; the identifier is rendered as React text only.
- No raw backend error/message is inserted unless it came from a valid purchase envelope, and even
  then the frozen UI copy above is preferred. This prevents error leakage and inconsistent voice.
- Axe browser scan must report zero serious or critical violations in upcoming, active, sold-out,
  and ended surfaces.

---

## 13. Test contract and seams

### 13.1 Pure/unit floor

Required Vitest assertions:

- `user-id.spec.ts`: trimming; min/max; every allowed punctuation; Unicode/space/slash/colon
  rejection; no lowercasing.
- `time.spec.ts`: midpoint offset; upcoming/start inclusive/end exclusive derivation; sold-out
  precedence; ceil/pad countdown; hours >23; zero clamp.
- `polling.spec.ts`: exact jitter endpoints with injected RNG; 1s final-ten-second mode;
  exponential sequence; hard 10s cap after jitter; visibility/coalescing helpers.
- `decoders.spec.ts`: every valid shipped sale/purchase/status/metrics/readiness shape; every
  AttemptOutcome; compensated false; null createdAt; unknown literal; negative stock; fractional
  millis; missing nested check; malformed JSON route.
- `client.spec.ts`: exact URLs/method/body; encoded user ID; trailing slash normalization; timeout
  and external abort; purchase never retries; safe `ApiClientError`; Retry-After cap.

### 13.2 React component/integration floor

`App.test.tsx` uses Testing Library, fake timers where appropriate, and an injected/faked client.
It proves at minimum:

1. Loading → upcoming → active UI transition uses server offset and exact half-open boundary.
2. Initial/unreachable banner, persistent last-good data, Retry action, and recovery.
3. Invalid ID focuses input and sends no request.
4. Double submit while pending sends exactly one POST.
5. All nine AttemptOutcome feedback branches are reachable and have non-color text.
6. A rejected POST renders ambiguous `Result unknown`, does not retry, preserves ID, and exposes
   status check (I4 UX regression).
7. Confirmed never appears before a valid 201 CONFIRMED envelope; stock is not optimistically
   decremented.
8. Reserved, persisted, compensated, absent, and unavailable status branches use exact meanings.
9. 500-unit stock renders 50 segments and exact `500 / 500`; 50-unit stock renders 50 per-card
   segments; zero total does not divide by zero.
10. Poll cleanup under StrictMode leaves no pending timers, stale state commit, or duplicate fetch.

Do not assert implementation details such as hook state names. Assert accessible names, visible
meaning, call counts, and server contracts.

### 13.3 Playwright browser floor

`playwright.config.ts`:

- Test dir `./e2e`.
- Chromium only; projects named `desktop-chromium` (1440×1200) and `mobile-chromium` (390×844).
- Base URL `http://127.0.0.1:4173`.
- Web server command `pnpm exec vite --host 127.0.0.1 --port 4173`; `reuseExistingServer: false` in
  CI/default test mode; 30 s startup timeout.
- Trace on first retry, screenshot only on failure, video off.
- `snapshotPathTemplate` resolves exactly to
  `e2e/__screenshots__/{projectName}/{arg}{ext}`.
- One retry in CI, zero locally; forbid `.only` in CI.

`fixtures.ts` exports deterministic API payload builders and a route installer. Browser time is
fixed with Playwright Clock before route installation, so countdown and screenshots do not drift.

`flash-sale.spec.ts` proves:

1. Active page renders header/product/console/protocol/ops/footer with no horizontal overflow in
   both projects.
2. Invalid → submitting → CONFIRMED → reserved → persisted buyer flow, with exactly one POST.
3. Duplicate, sold-out, ended, 429, unreachable, and ambiguous network result states.
4. Poll failure banner and manual recovery without overlapping requests.
5. `@axe-core/playwright` serious/critical scan is clean for upcoming, active, sold-out, and ended.
6. `active-sale.png` matches the committed baseline in both projects with
   `maxDiffPixelRatio: 0.01`; dynamic countdown/relative-time content is deterministic, not masked.

Route mocks are browser-contract tests, not a replacement for the real backend integration suites
already gated in Phases 2/3. They must validate that requests target the exact shipped paths and
that no unexpected request escapes the test.

### 13.4 Generated output ignores

F1 may append exactly these rows to `.gitignore`:

```gitignore
# Playwright output
test-results/
playwright-report/
```

Committed visual baselines under `apps/web/e2e/__screenshots__/**` are not ignored. Updating a
baseline after initial review requires the reviewer to re-open both prototype and app screenshots;
`--update-snapshots` alone is not approval.

---

## 14. Package/config contract

### 14.1 `apps/web/package.json`

Keep existing runtime dependencies unchanged. Add only these development dependencies at the
versions current when this contract was frozen:

```json
"@axe-core/playwright": "^4.12.1",
"@playwright/test": "^1.61.1",
"@testing-library/user-event": "^14.6.1"
```

Add scripts:

```json
"test:e2e": "playwright test",
"test:e2e:update": "playwright test --update-snapshots"
```

Do not add Tailwind, Basecoat, Motion, React Router, query/cache libraries, Zod, an icon package,
or a state store. Use inline SVG for the single lightning mark.

### 14.2 Vite/Vitest/TypeScript

- Preserve existing `@flash/shared` CJS interop (`preserveSymlinks`, `optimizeDeps`,
  `commonjsOptions`). No aliases; `AGENTS.md` forbids them.
- Preserve strict dev `WEB_PORT`; Playwright CLI port override is test-only.
- Vitest remains jsdom and includes `src/**/*.spec.ts` plus `src/**/*.test.tsx`; use explicit
  `restoreMocks: true` and `clearMocks: true` to prevent poll mock leakage.
- `tsconfig.json` includes `src/**/*`, `e2e/**/*`, `vite.config.ts`, `vitest.config.ts`.
- `tsconfig.node.json` includes `vite.config.ts` and `playwright.config.ts`.
- Keep the app ESM. Do not change root/module conventions.
- `pnpm-lock.yaml` changes only as produced by the three approved dev dependencies.

### 14.3 `index.html`

Preserve UTF-8, viewport, `#root`, and module entry. Add the prototype's Google Fonts preconnect
and stylesheet, and set the exact title in §11.2. No CDN script or stylesheet other than fonts.

---

## 15. Verification and Phase 4 gate

Claims are not evidence. Paste command output and record exit codes. No skipped/only tests.

### 15.1 F1 slice evidence

From repo root:

```bash
pnpm install --frozen-lockfile
pnpm --filter @flash/web lint
pnpm --filter @flash/web typecheck
pnpm --filter @flash/web test
pnpm --filter @flash/web build
pnpm exec playwright install chromium
pnpm --filter @flash/web test:e2e
pnpm exec prettier --check apps/web .gitignore
git diff --check
```

Also provide:

```bash
rg -n "dangerouslySetInnerHTML|@flash/shared/schemas'|@flash/shared/schemas\"|setInterval\(.*fetch|fetch\(.*purchase" apps/web/src apps/web/e2e
rg -n "tailwind|basecoat|motion|react-router|zod" apps/web/package.json apps/web/src apps/web/index.html
git diff --name-only phase-3-done...HEAD
```

The first grep may contain type-only shared-schema imports and the intentional client POST call;
review context. It must show no `dangerouslySetInnerHTML`, runtime schema import, interval-driven
fetch, or automatic purchase retry. The second grep must return zero dependency/CDN hits (comments
explaining absence are allowed only if reviewed). The diff path list must be a subset of §2/§3.

### 15.2 Root independent gate

The root orchestrator reruns, not trusts:

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm exec turbo run lint typecheck test build test:integration --force
pnpm --filter @flash/web test:e2e
pnpm audit --audit-level high
node scripts/assert-build-output.mjs apps/api/dist/main.js apps/worker/dist/main.js packages/shared/dist/index.js
test -s apps/web/dist/index.html
docker compose -f infra/docker-compose.yml config -q
git diff --check
```

Required output facts:

- Turbo reports all tasks successful and `Cached: 0 cached`.
- Existing real Redis/Postgres API/worker integration suites remain green and unskipped.
- All Vitest and Playwright tests pass in both viewports.
- Axe reports zero serious/critical violations.
- Both committed screenshot comparisons pass at ≤1% pixel difference.
- Audit has no high/critical finding and `pnpm-workspace.yaml` still has empty `ignoreGhsas`.
- Web build exists and loads without console errors or failed same-app asset requests.

### 15.3 Visual/adversarial review evidence

The reviewer must inspect both 1440×1200 and 390×844 screenshots against
`prototype/index.html`, not only accept snapshot tests. Record pass/fail for:

1. Token/color/type hierarchy and dot-grid canvas.
2. Nav, 5/7 desktop grid, mobile stack, product card, console, protocol strip, ops ledger, footer.
3. Upcoming, active, sold-out, ended, loading, unreachable, confirmed, duplicate, rate-limited,
   reserved, persisted, compensated, and ambiguous-result states.
4. Keyboard-only traversal, visible focus, input error association, live feedback, reduced motion,
   200% zoom, and no mobile overflow.
5. No fake result, optimistic stock decrement, overlapping polls, leaked timer/listener,
   automatic POST retry, stale response overwrite, raw error leak, or unsafe user rendering.

The adversarial reviewer explicitly attempts to break I1-I4 representation: double click/Enter,
response loss after POST, end-boundary flip, stale upcoming response, compensated then reattempt,
and a malformed API payload. Critical findings return to F1. Two consecutive failures on the same
underlying issue escalate to the architect. Maximum three implement/verify iterations.

### 15.4 Gate ritual (root only)

After §15.1–§15.3 are green:

1. Root creates a Conventional Commit, expected subject:
   `feat(web): ship flash sale buyer console`.
2. Root creates annotated tag:
   `git tag -a phase-4-done -m "Phase 4: accessible flash sale frontend"`.
3. Root updates `STATE.md` with Phase 4 evidence and exact Phase 5 actions.
4. Root does not claim CI green. `STATE.md` records the existing owner decision that local uncached
   evidence is authoritative while GitHub Actions billing is unavailable.

F1 and reviewers must not commit, tag, push, or edit `STATE.md`.

---

## 16. Mandatory skill manifest

The frontend implementer must read the complete project-local skill files **before the first UI
edit**, in this order:

1. `.agents/skills/frontend-design/SKILL.md` — mandatory binding PRD rule; first.
2. `.agents/skills/vite/SKILL.md` — Vite/ESM/config discipline.
3. `.agents/skills/vercel-react-best-practices/SKILL.md` — polling/render/bundle discipline.
4. `.agents/skills/vitest/SKILL.md` — deterministic unit/component proof.

The `.claude/skills/*` entries are symlinks to the same project-local content. A runtime with a
Skill loader may load by name; a runtime without one reads the files directly. The implementer
must state that all four were loaded before editing. A brief without this manifest is invalid and
must be reissued.

Skill consequences frozen here:

- `frontend-design`: preserve the prototype's subject-specific titanium-card signature; plan and
  self-critique before code; spend motion in one place; take screenshots; respect reduced motion.
- `vite`: remain TypeScript/ESM and preserve existing Vite CJS interop. The skill's alias example
  does **not** override this repo's absolute no-alias rule.
- `vercel-react-best-practices`: parallelize independent ops fetches, prevent waterfalls and
  duplicate global listeners, use refs for transient 250 ms clock/pointer values where suitable,
  avoid rerendering the whole page each pointer move, and import no broad runtime barrels.
- `vitest`: injected clocks/RNG/fetch, fake-timer cleanup, visible-behavior assertions, and no
  skipped datastore/browser claims.

---

## 17. Copy-ready dispatch brief F1

> **Role:** `frontend-implementer` (general-purpose/Sonnet-mapped implementation tier).
> **Base/branch:** repo `/home/carlomigueldy/dev/bookipi-technical-test`, branch
> `phase-4/frontend`, based on annotated `phase-3-done` at `e7d43d0`.
> **Contract:** read `.claude/contracts/phase-4.md` in full and implement it exactly. It is frozen;
> escalate ambiguity to the root/architect rather than inventing a shared name or editing another
> path.
> **Skills — mandatory before any UI edit, exact order:** read/load
> `.agents/skills/frontend-design/SKILL.md`, `.agents/skills/vite/SKILL.md`,
> `.agents/skills/vercel-react-best-practices/SKILL.md`, and
> `.agents/skills/vitest/SKILL.md`. State completion before editing. The frontend-design load is a
> hard PRD rule.
> **Ownership:** only the F1 existing paths in contract §2 and new paths in §3. You are not alone
> in the codebase. Preserve all edits outside your ownership, do not revert another agent's work,
> and do not touch `.codex/`, `prototype/**`, API/worker/shared/Redis/infra/load/CI, `.env.example`,
> `turbo.json`, `STATE.md`, or the phase contract. Do not commit, tag, push, or open a PR.
> **Outcome:** replace the web scaffold with the production Aurora SPA matching the read-only
> prototype: responsive product story and titanium-card signature, server-time countdown, exact
> stock display, validated buyer flow, all purchase outcomes, explicit reservation checks
> including compensated, API-backed metrics/readiness ops ledger, bounded non-overlapping polling,
> durable error/retry semantics, WCAG AA/reduced-motion behavior, deterministic Vitest and
> Playwright/axe/visual proof. Remove demo scenario/reset behavior.
> **Invariant obligations:** never optimistically decrement stock or fabricate confirmation; one
> POST maximum while pending; client window state is advisory and the Redis Lua boundary remains
> authoritative; never auto-retry POST; a transport failure after dispatch is `Result unknown`
> and directs status check; `compensated` means not purchased and stock returned.
> **Dependencies:** only `@axe-core/playwright@^4.12.1`,
> `@playwright/test@^1.61.1`, and `@testing-library/user-event@^14.6.1` as dev dependencies. No
> Tailwind/Basecoat/Motion/router/Zod/store/query library.
> **Done evidence:** run every command in contract §15.1, paste real output and exit codes, report
> exact test counts, Playwright projects, axe results, screenshot result, changed-path list, and
> any remaining risk. No skipped/only tests. Do not claim completion if any check fails.

---

## 18. ADR summary

| Decision | Alternative rejected | Why |
| --- | --- | --- |
| One vertical frontend slice | Parallel component/hook implementers | Shared interaction state and CSS would create overlapping paths, violating exclusive ownership |
| Polling with jitter/backoff | SSE/WebSockets or fixed `setInterval` | Matches PRD; stateless API; avoids synchronized herd and overlapping requests |
| Midpoint server offset | Trust browser clock or parse ISO each tick | Reduces RTT bias and preserves I3-aligned presentation without making the client an enforcement point |
| No automatic purchase retry | Generic retry helper around POST | A response can be lost after Redis confirmation; automatic retry obscures ambiguity and weakens I4 truthfulness |
| Type-only shared DTO imports + local decoders | Bundle Zod or cast JSON directly | Honors Phase 1's zero-Zod browser contract while treating network data as untrusted |
| API readiness in ops panel | Call liveness or worker port | Readiness contains useful aggregate dependencies; liveness cannot express degraded state; worker port adds CORS/topology coupling |
| Server metrics, not local counters | Increment prototype counters in React | Aggregate truth spans clients; local counters are demo fiction |
| 50-segment proportional meter above 50 units | Render hundreds/thousands of DOM ticks or hard-code 50 | Preserves visual signature and performance while exact text stays truthful |
| Plain CSS and CSS motion | Tailwind/Basecoat/Motion CDN/package | Existing scaffold and prototype tokens are sufficient; smaller, offline-stable production bundle |
| Playwright route-mocked UI smoke plus preserved backend integration | Rebuild a second backend harness inside web | Deterministic UI proof without duplicating already-gated Phase 2/3 correctness harnesses |

---

## 19. Frozen decision index

1. One browser route `/`; no router.
2. One F1 implementation slice; no parallel frontend fan-out.
3. Read-only prototype; demo mutation controls do not ship.
4. Exact five API reads/actions in §4.3; no worker polling or saleId input.
5. `VITE_API_BASE_URL` is the only frontend env var.
6. Shared schemas are type-only in web; defensive local decoders receive `unknown`.
7. Server midpoint offset; exact half-open presentation boundary.
8. Status polling 2s ±30%, 1s final ten seconds, exponential failure cap 10s; no overlap.
9. Ops polling is independent, parallel by resource, and capped at 15s on failure.
10. POST is never retried automatically; response loss is an ambiguous status-check-first state.
11. `compensated` means not purchased and inventory safely returned.
12. Metrics are server aggregates; initial unknown is em dash, never zero.
13. Plain CSS reproduces frozen prototype tokens/layout; titanium card is the one signature.
14. Browser/a11y/visual proof is Playwright Chromium at desktop and mobile with deterministic time.
15. Only the three dev dependencies in §14.1 are added.
16. Frontend-design loads first, followed by Vite, React best practices, and Vitest.
17. Root alone gates, commits, tags, and edits `STATE.md`.

---

## 20. AMENDMENT A1 — ESLint project membership and generation-safe poll cleanup

**Status:** FROZEN corrective amendment after the mandatory §8 escalation at F1 iteration 3.

### 20.1 Escalation finding

F1 reached the three-iteration implementation/verification budget with typecheck green and exactly
two lint failures:

1. `apps/web/playwright.config.ts` is included by `tsconfig.node.json` but not by the nearest
   auto-discovered `tsconfig.json`. The shared ESLint preset uses TypeScript ESLint project service,
   whose configured default-project allow-list covers JavaScript config files only. Consequently,
   lint rejects the TypeScript Playwright config before evaluating it.
2. `useSaleStatus` returns from `finally` when its request generation is stale, violating
   `no-unsafe-finally`.

Both files and `apps/web/tsconfig.json` are already F1-owned. No cross-slice ownership transfer,
dependency, public interface, or invariant redesign is required.

### 20.2 TypeScript/ESLint correction — amendment to §14.2

The frozen §14.2 row for `tsconfig.json` is superseded by this exact include list:

```json
"include": [
  "src/**/*",
  "e2e/**/*",
  "vite.config.ts",
  "vitest.config.ts",
  "playwright.config.ts"
]
```

Keep `playwright.config.ts` in `tsconfig.node.json` as already required. Do not change the shared
ESLint preset, `apps/web/eslint.config.mjs`, `allowDefaultProject`, compiler options, package
dependencies, or any other include. Including the file in the existing web program is sufficient:
the already-included Vite config supplies the Node-aware configuration type graph, and the current
web typecheck remains the proof that the combined program is valid.

### 20.3 `useSaleStatus` correction — implementation authorization

Remove every `return` from `finally`. A bare rewrite to only conditionally schedule is insufficient
unless request ownership is also protected: React StrictMode cleanup/remount can otherwise leave
`inFlight.current` true forever or let an old request clear a newer controller.

Use these exact semantics:

1. In `finally`, compute whether this request still owns the flight:
   `const ownsFlight = controller.current === abort`.
2. Only the owning request may set `inFlight.current = false` and
   `controller.current = undefined`.
3. Only when `ownsFlight && ownGeneration === generation.current` may it clear/replace the poll
   timer and schedule the queued-immediate or computed-delay poll.
4. When the generation is stale, `finally` falls through normally without scheduling; it does not
   return, throw, or overwrite a newer request's refs.
5. Effect cleanup must synchronously:
   - increment the generation;
   - clear the current timer and set its ref to `undefined`;
   - abort the current controller, then set its ref to `undefined`;
   - set `inFlight.current = false` and `queued.current = false`;
   - remove the visibility listener.

This preserves §7.1's single-flight/coalescing contract while preventing both stale scheduling and
the StrictMode remount deadlock. No polling delay, state shape, error meaning, API call, or public
hook return changes.

### 20.4 Invariant effect

- **I1:** unchanged and protected: no extra poll or purchase call is introduced; stock remains
  server-derived.
- **I2:** unchanged: this hook does not submit purchases or derive identity.
- **I3:** unchanged: the Redis `TIME` Lua boundary remains authoritative; this correction only
  keeps advisory status refresh alive and generation-safe.
- **I4:** unchanged and protected: no POST retry is introduced, and stale status work cannot
  overwrite the current generation's truth.

### 20.5 Corrective verification and loop reset

This architect escalation closes the exhausted F1 unit and opens a new **A1 corrective unit**. Its
implementation/verification counter resets to zero, with the normal maximum of three iterations
before another mandatory escalation. Review-failure counting remains independent: two consecutive
adversarial failures on the same underlying issue still escalate.

The implementer runs, at minimum:

```bash
pnpm --filter @flash/web lint
pnpm --filter @flash/web typecheck
pnpm --filter @flash/web test
pnpm --filter @flash/web build
git diff --check
```

Required evidence:

- ESLint reports zero errors/warnings, including `playwright.config.ts` project membership and no
  `no-unsafe-finally` finding.
- Typecheck remains green with `playwright.config.ts` in both required TypeScript program include
  lists.
- Existing poll/StrictMode tests remain green; add or strengthen a regression assertion if the
  current suite does not prove cleanup followed by remount can issue a fresh poll without an old
  generation clearing/scheduling over it.
- No changed path outside F1 ownership and this architect-authored amendment.

### 20.6 Copy-ready A1 correction brief

> **A1 corrective unit after mandatory iteration-3 escalation.** Read Phase 4 contract Amendment
> A1 (§20) before editing. Own only `apps/web/tsconfig.json` and
> `apps/web/src/hooks/useSaleStatus.ts`; you may update an already-owned sale-hook/App spec only if
> needed for the StrictMode remount regression. You are not alone in the codebase: preserve all
> other work and do not touch `.codex/`, the prototype, backend/shared/infra paths, `STATE.md`, or
> the contract. Add `playwright.config.ts` to `tsconfig.json#include` exactly as §20.2 requires;
> keep it in `tsconfig.node.json` and do not change ESLint/default-project configuration. Remove
> the unsafe `finally` return using the controller-identity/generation rules in §20.3, including
> synchronous cleanup ref resets so StrictMode remount cannot deadlock or be clobbered by the old
> request. Do not change polling cadence, API behavior, dependencies, purchase behavior, or hook
> surface. Run and paste the exact §20.5 commands/output. This is a new corrective unit with its
> implementation/verification counter reset to zero; stop and re-escalate after three failed
> corrective iterations.

---

## 21. AMENDMENT A2 — pnpm realpath resolution and executable production bundle proof

**Status:** FROZEN corrective amendment after the browser gate exposed a contract-authored bundle
defect.

### 21.1 Reproduced defect and root cause

The Phase 0 web contract and Phase 4 §14.2 required `resolve.preserveSymlinks: true` so the
`@flash/shared` workspace symlink would retain an ID matched by `/@flash\/shared/`. Under pnpm's
isolated linker that setting applies to **every** dependency, not only the workspace package.

The installed paths prove the conflict:

```text
apps/web/node_modules/@flash/shared -> packages/shared
apps/web/node_modules/react-dom     -> node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom
react-dom's scheduler               -> sibling dependency inside pnpm's real virtual-store graph
```

With symlinks preserved, Vite resolves `react-dom` under the facade
`apps/web/node_modules/react-dom` and fails to reach the virtual-store sibling `scheduler` through
the real package location. Vite exits zero but externalizes the unresolved package; the emitted
artifact contains a browser-invalid bare import equivalent to:

```js
import scheduler from "scheduler";
```

The production bundle is therefore not executable, and Playwright cannot start a working page.
Adding `scheduler` as a direct web dependency would mask the resolver defect, violate §14.1, and
make React's private transitive dependency an application contract. It is rejected.

### 21.2 Frozen resolver correction — supersedes Phase 0 §14 and Phase 4 §14.2

F1 may edit only `apps/web/vite.config.ts` and `apps/web/vitest.config.ts` for this correction.

In `vite.config.ts`:

1. Remove the entire `resolve: { preserveSymlinks: true }` block and its obsolete explanatory
   comment. Do not set `preserveSymlinks` to another value; omission selects Vite's safe default
   `false` and resolves dependencies through their real pnpm store locations.
2. Keep `optimizeDeps.include` exactly `['@flash/shared']`.
3. Replace `build.commonjsOptions.include` with this exact order and regex vocabulary:

```ts
include: [/node_modules/, /packages[\\/]shared[\\/]dist[\\/]/],
```

The first pattern transforms React/ReactDOM and other CommonJS dependencies after realpath
resolution through `node_modules/.pnpm/**`. The second pattern transforms the real workspace CJS
output such as `/repo/packages/shared/dist/index.js`. No alias and no symlink preservation is
needed.

In `vitest.config.ts`, use the identical `build.commonjsOptions.include` array:

```ts
include: [/node_modules/, /packages[\\/]shared[\\/]dist[\\/]/],
```

Keep its `optimizeDeps.include: ['@flash/shared']`. Do not add `resolve.preserveSymlinks`, an alias,
a custom resolver/plugin, a dependency-dedup list, or an absolute machine-specific path.

This amendment explicitly supersedes the earlier `/@flash\/shared/`-only matching rationale. The
cross-platform `[\\/]` separators are load-bearing: Linux and Windows real paths must both match.

### 21.3 Production browser gate — supersedes §13.3 web-server command

F1 may edit `apps/web/playwright.config.ts` and `apps/web/e2e/flash-sale.spec.ts` for the permanent
regression proof. No fixture/API semantics or screenshots change solely because of this amendment.

Replace Playwright's dev-server command with the production build and preview command:

```ts
webServer: {
  command: 'pnpm build && pnpm exec vite preview --host 127.0.0.1 --port 4173 --strictPort',
  url: 'http://127.0.0.1:4173',
  reuseExistingServer: false,
  timeout: 60_000,
},
```

The rest of the frozen Playwright config remains unchanged. `pnpm --filter @flash/web test:e2e`
must now exercise `apps/web/dist`, not Vite's source-mode dev graph. This deliberately repeats the
web build during the browser gate: a production artifact that cannot load is a failed Phase 4
frontend regardless of whether source-mode dev works.

Strengthen the first active-sale browser test:

1. Register `pageerror` and console-error collectors **before** `page.goto('/')`.
2. Keep the existing visible-surface and no-horizontal-overflow assertions.
3. After the page is operational, assert both collected error arrays are empty.

A failed module import must therefore fail explicitly even if a future markup assertion becomes
too weak. Do not suppress, filter, or whitelist `scheduler`, module-resolution, or asset-load
errors.

### 21.4 Dependency and ownership boundary

The A2 corrective unit owns exactly:

```text
apps/web/vite.config.ts
apps/web/vitest.config.ts
apps/web/playwright.config.ts
apps/web/e2e/flash-sale.spec.ts
```

It adds no path and no dependency. In particular, do **not** edit `apps/web/package.json`,
`pnpm-lock.yaml`, `.npmrc`, `pnpm-workspace.yaml`, root tooling, `packages/shared`, or any React
package; do not add `scheduler`. Existing unrelated F1 changes remain preserved.

### 21.5 Invariant effect

- **I1/I2:** unchanged. Resolver behavior does not alter purchase decisions or identity; a working
  bundle still displays only server-confirmed truth.
- **I3:** unchanged. The client remains advisory and the Redis `TIME` Lua boundary remains the
  enforcement point.
- **I4:** protected operationally. A bundle that cannot start cannot provide the mandatory
  ambiguous-result/status-check UX. Production-preview proof ensures the shipped artifact can
  render those states; no POST retry or compensation behavior changes.

### 21.6 Exact verification

From repo root, the A2 implementer runs:

```bash
pnpm --filter @flash/web lint
pnpm --filter @flash/web typecheck
pnpm --filter @flash/web test
pnpm --filter @flash/web build
node --input-type=module -e "import{readdirSync,readFileSync}from'node:fs';const d='apps/web/dist/assets';const bad=readdirSync(d).filter(f=>f.endsWith('.js')).filter(f=>/(?:from\\s*|import\\s*\\()\\s*['\"]scheduler['\"]/.test(readFileSync(d+'/'+f,'utf8')));if(bad.length)throw new Error('bare scheduler import: '+bad.join(','));"
pnpm --filter @flash/web test:e2e
git diff --check
```

And the configuration/source scans:

```bash
if rg -n "preserveSymlinks|/@flash\\\\/shared/" apps/web/vite.config.ts apps/web/vitest.config.ts; then exit 1; fi
rg -n "packages\[\\\\/\]shared\[\\\\/\]dist|node_modules" apps/web/vite.config.ts apps/web/vitest.config.ts
rg -n '"scheduler"|scheduler@' apps/web/package.json pnpm-lock.yaml
git diff --name-only
```

Expected evidence:

- Lint, typecheck, Vitest, and production build are green.
- The artifact assertion exits zero and no emitted JS contains a bare static/dynamic
  `scheduler` import.
- Playwright starts production preview, both viewport projects pass, the active page reports zero
  page/console errors, and existing axe/visual checks remain green.
- The first scan returns no hit; both configs show the real shared-dist and node_modules patterns.
- The dependency scan may show the existing **transitive lockfile** `scheduler@0.23.2`, but
  `apps/web/package.json` has no direct `scheduler` row and the lockfile has no A2 change.
- A2's changed-path subset is exactly §21.4; no `.codex/`, prototype, backend, shared package,
  dependency manifest, lockfile, or root config edit.

### 21.7 Loop status and copy-ready correction brief

This is a contract defect, not another implementation attempt against a valid design. The prior
corrective unit closes at escalation. A new **A2 corrective unit** starts at iteration zero with
the normal maximum of three implement/verify iterations before mandatory re-escalation.
Adversarial review-failure counting remains independent and does not reset.

> **A2 production-bundle corrective unit.** Read Phase 4 contract §21 before editing. Own exactly
> `apps/web/vite.config.ts`, `apps/web/vitest.config.ts`, `apps/web/playwright.config.ts`, and
> `apps/web/e2e/flash-sale.spec.ts`. You are not alone in the codebase: preserve all other work and
> do not touch `.codex/`, prototype/backend/shared/infra paths, package manifests, lockfile, root
> config, `STATE.md`, or the contract. Remove `preserveSymlinks` entirely. Keep
> `optimizeDeps.include: ['@flash/shared']`; set both CommonJS include arrays exactly to
> `[/node_modules/, /packages[\\/]shared[\\/]dist[\\/]/]`. Do not add aliases, resolver plugins,
> dedupe settings, absolute paths, or `scheduler`. Change Playwright to build then serve Vite
> production preview on 127.0.0.1:4173 with a 60s startup budget, and make the first browser test
> fail on any page or console error. Run every §21.6 command and paste real output, including the
> artifact scan and both Playwright projects. This new A2 unit begins at iteration zero; stop and
> re-escalate after three failed corrective iterations.

---

## 22. AMENDMENT A3 — WCAG AA text tokens and intentional visual-baseline refresh

**Status:** FROZEN corrective amendment after mandatory A2 iteration-3 escalation.

### 22.1 Gate evidence and exact violation set

A2 corrected the resolver, production bundle, and browser runtime. Lint, typecheck, 43 Vitest
tests, production build, the bare-scheduler artifact assertion, and the first four responsive/buyer
Playwright cases are green. Both active-sale visual baselines were generated.

The remaining eight Playwright failures are the same axe `color-contrast` violation across four
sale states and two viewports. After animation-opacity timing was removed from consideration, axe
identified only these genuine pairs:

| Text/selector | Foreground | Background | Rendered size | Measured | Required |
| --- | --- | --- | --- | --- | --- |
| Active `Live now` pill, `.pill.active` | `#0e8a5f` | `#e7f5ef` | 11 px normal | 3.88:1 | 4.5:1 |
| Window wrapper and its two `<time>` nodes, `.window` | `#8a94a6` | `#ffffff` | 10 px normal | 3.05:1 | 4.5:1 |
| Identifier format hint, `#user-id-hint` | `#8a94a6` | `#ffffff` | 10.5 px normal | 3.05:1 | 4.5:1 |

Upcoming, sold-out, and ended do not add another failing color pair; they repeat the window/hint
nodes. Active adds the green pill. The small dark-ledger colors are **not** violations and must not
be churned speculatively:

| Existing ops use | Pair | Ratio |
| --- | --- | --- |
| `.oplabel`, `.ops-grid span` | `#8290aa` on `#0f1b30` | 5.34:1 |
| `.ops-grid strong` | `#8fa0c4` on `#0f1b30` | 6.55:1 |
| `.ops-badge` | `#aab4c8` on `#0b1526` | 8.26:1 |
| `.protocol-line`, `.readiness-summary` | `#7786a2` on `#0b1526` | 4.97:1 |

The frozen prototype tokens in §11.2 were visually faithful but did not satisfy §12's binding WCAG
AA requirement at the implemented small-text sizes. Accessibility wins; this amendment records
the deliberate, minimal palette refinement rather than weakening the test.

### 22.2 AA token amendment — supersedes two §11.2 rows

In `apps/web/src/index.css`, change exactly these root tokens:

```css
--color-muted: #667085;
--color-green: #087452;
```

These values are frozen:

- `#667085` on white is **4.97:1** and on canvas `#f6f7f9` is **4.64:1**. It replaces
  `#8a94a6` for visible muted text including brand suffix, server clock, product qualifier, window
  and `<time>` descendants, identifier hint, and footer.
- `#087452` on green-soft `#e7f5ef` is **5.15:1**. White on `#087452` is **5.78:1**, so the same
  token remains valid for the confirmed button background.

All other §11.2 tokens remain unchanged. Do not add a second text-only alias for either old color,
hard-code a selector-specific near-duplicate, or retain `#8a94a6` / `#0e8a5f` elsewhere in authored
web CSS.

One additional usage is frozen for readability beyond axe's disabled-control exemption:

```css
.buy-button:disabled {
  color: var(--color-slate);
  /* existing background/shadow declarations unchanged */
}
```

`--color-slate: #4e5b73` on the disabled `#e5e8ee` background is 5.58:1. Do not change font size,
font weight, background, border, opacity, or layout to manufacture a pass. The ops colors listed in
§22.1 remain byte-for-byte unchanged.

### 22.3 Ownership and forbidden work

The A3 corrective unit owns exactly:

```text
apps/web/src/index.css
apps/web/e2e/flash-sale.spec.ts
apps/web/e2e/__screenshots__/desktop-chromium/active-sale.png
apps/web/e2e/__screenshots__/mobile-chromium/active-sale.png
```

`flash-sale.spec.ts` may change only if needed to make axe timing deterministic after the existing
entrance animation completes; no selector, rule, tag set, state, or viewport may be removed. If the
current deterministic timing already avoids opacity false positives, leave the test source
unchanged.

Do not edit components, hooks, API code, Vite/Playwright config, package manifests, lockfile,
backend/shared/infra, root tooling, prototype, `.codex/`, `STATE.md`, or this contract. Add no
dependency. Do not:

- call `disableRules('color-contrast')` or exclude/include only selected DOM subtrees;
- filter `color-contrast` out of axe results;
- lower the gate from serious/critical zero;
- hide, make transparent, enlarge, embolden, or mark visible text `aria-hidden` merely to pass;
- change screenshot tolerance or mask the corrected text;
- change the already-passing ops colors without a new axe finding.

### 22.4 Test and visual proof

The existing four-state axe loop is the required functional regression: upcoming, active,
sold-out, and ended, in both desktop and mobile projects. Each scan continues using WCAG 2 A/AA
tags and must return zero serious or critical violations.

Because the active screenshot contains both corrected token classes, A3 authorizes one intentional
baseline refresh. The implementer must:

1. Apply the exact CSS changes.
2. Run Playwright with `--update-snapshots` once to write both existing `active-sale.png` paths.
3. Re-run Playwright normally; a normal comparison, not update mode, is the gate evidence.
4. Provide the updated desktop/mobile screenshots to the reviewer for visual comparison against
   `prototype/index.html`. The darker muted/green text is expected; layout, type scale, spacing,
   content, backgrounds, and signature card must remain unchanged.

No new snapshot path is created.

### 22.5 Exact verification

From repo root:

```bash
pnpm --filter @flash/web lint
pnpm --filter @flash/web typecheck
pnpm --filter @flash/web test
pnpm --filter @flash/web build
pnpm --filter @flash/web test:e2e:update
pnpm --filter @flash/web test:e2e
git diff --check
```

Source/token scans:

```bash
rg -n -- "--color-muted: #667085|--color-green: #087452|buy-button:disabled|color: var\(--color-slate\)" apps/web/src/index.css
if rg -n "#8a94a6|#0e8a5f|disableRules|color-contrast.*filter|\.exclude\(" apps/web/src apps/web/e2e; then exit 1; fi
rg -n "#8290aa|#8fa0c4|#aab4c8|#7786a2" apps/web/src/index.css
git diff --name-only
```

Required evidence:

- Lint/typecheck, all 43-or-more Vitest tests, and production build are green.
- Snapshot update writes exactly the two existing A3-owned PNGs; the subsequent normal run passes
  all 12 Playwright tests across both projects.
- All eight state/viewport axe scans report zero serious/critical violations, with no rule disable,
  DOM exclusion, result filter, opacity workaround, or state/viewport removal.
- First scan shows the exact new tokens and disabled-button slate usage. Old failing colors are
  absent from authored web source/tests. Passing ops colors remain present and unchanged.
- Changed-path subset for A3 is exactly §22.3; no dependency, configuration, component, contract,
  prototype, or root change.
- Reviewer records that the only intentional screenshot differences are the AA-safe muted and
  active-green text colors.

### 22.6 Invariant effect

- **I1/I2/I3:** unchanged. This is a presentation-token correction and creates no request, stock,
  identity, or window behavior.
- **I4:** unchanged semantically and improved operationally: status and ambiguous-result guidance
  remain readable to low-vision buyers; no confirmation, retry, persistence, or compensation logic
  changes.

### 22.7 Loop status and copy-ready A3 brief

A2 exhausted its three-iteration budget and is closed by this architect escalation. A new **A3
contrast corrective unit** begins at iteration zero with the normal maximum of three
implement/verify iterations before mandatory re-escalation. Adversarial same-issue failure counting
remains independent and does not reset.

> **A3 WCAG-AA contrast corrective unit.** Read Phase 4 contract §22 before editing. Own exactly
> `apps/web/src/index.css`, `apps/web/e2e/flash-sale.spec.ts`, and the two existing desktop/mobile
> `active-sale.png` baselines. You are not alone in the codebase: preserve all other work. Change
> only `--color-muted` to `#667085`, `--color-green` to `#087452`, and disabled Buy text to
> `var(--color-slate)` while preserving its other declarations. Do not change the already-passing
> ops colors. Do not weaken axe with rule disables, exclusions, filtering, opacity, hidden text,
> typography changes, fewer states/viewports, masks, or tolerance changes. Leave the e2e source
> unchanged unless a deterministic wait for the existing entrance animation is still required;
> never remove coverage. Run snapshot update once, then the normal 12-test Playwright gate, plus
> every §22.5 check. Paste real counts/output and provide both updated images for reviewer
> comparison. This A3 unit starts at iteration zero; stop and re-escalate after three failed
> corrective iterations.

---

## 23. AMENDMENT A4 — mandatory behavioral-proof completion

**Status:** FROZEN corrective amendment after the independent Phase 4 gate found missing tests.

### 23.1 Gate finding and scope rule

The A3 implementation commands are green, but the independent gate is **RED** because the current
suite does not prove several behaviors already required by this contract. This is a coverage
omission, not evidence of a production defect. A4 is therefore a **test-only** corrective unit.

The implementer must not edit production source merely to create a convenient test seam. If a
required assertion fails against production behavior, stop, preserve the failing test and command
output, and escalate the concrete defect to the architect. Production remediation, if warranted,
will receive a separately owned and versioned amendment.

A4 must retain every passing A3 proof. In particular, it must retain the four-state axe scan in
both Playwright projects (**8 axe scans**) and the active-sale visual comparison in both projects
(**2 visual comparisons**). It must not update, rename, mask, or remove either baseline:

```text
fe0720268a15d3fc484de3e5a2ca623e12c4d6b201d2e057b50bb15782ff67a3  apps/web/e2e/__screenshots__/desktop-chromium/active-sale.png
4dfabc79bc8c116acacbfe55f6610447382cd5ffddfcffd52148c95eb5e8f9ee  apps/web/e2e/__screenshots__/mobile-chromium/active-sale.png
```

### 23.2 Exclusive ownership and forbidden work

The A4 corrective unit owns exactly:

```text
apps/web/src/App.test.tsx
apps/web/src/api/client.spec.ts
apps/web/src/api/decoders.spec.ts
apps/web/e2e/fixtures.ts
apps/web/e2e/flash-sale.spec.ts
```

No other path may change. Specifically, do not edit `App.tsx`, hooks, components, client or decoder
production modules, CSS, configs, package manifests, lockfile, screenshots, backend/shared/infra,
root tooling, prototype, `.codex/`, `STATE.md`, or this contract. Add no dependency and do not add
coverage instrumentation. Existing test helpers may be refactored only inside the five owned test
paths and only where needed to make the following scenarios deterministic.

### 23.3 Deterministic browser fixture contract

Extend `installApi` in `apps/web/e2e/fixtures.ts` with test-only controls (the exact local type names
are owned by that file) that can deterministically:

- hold and explicitly release one purchase response;
- select the purchase HTTP status, valid response envelope, and optional `Retry-After` header, or
  abort the transport without an HTTP response;
- return a sequenced purchase-status response, including `reserved` followed by `persisted` with a
  non-null `createdAt`;
- make a scheduled sale-status request fail, hold a later recovery request, release it with changed
  stock, and expose sale-status request count, current in-flight count, and maximum in-flight count.

Do not introduce wall-clock sleeps to manufacture request overlap. Use Playwright's controlled
clock where countdown/poll time advances are needed and explicit deferred route responses for
in-flight assertions. Every deferred route must be released or aborted in test cleanup.

### 23.4 Browser assertions — exactly 13 definitions per project

`apps/web/e2e/flash-sale.spec.ts` must contain exactly **13 Playwright test definitions**. With the
existing desktop and mobile projects, `pnpm --filter @flash/web exec playwright test --list` must report
exactly **26 tests in 2 projects**. Preserve the current six definitions, including all axe and
visual assertions, and add the seven definitions below. The existing buyer-flow definition is
expanded as specified rather than duplicated.

#### Expanded buyer flow: submitting, reserved, and persisted

- Hold the valid purchase response. While it is held, assert the Buy control reads `Securing…`, the
  identifier and Check controls are disabled, and a repeated click/Enter produces no second POST.
- Release a valid `CONFIRMED` response and assert `Card secured` is rendered only after release.
- First Check returns `reserved` and renders exactly
  `Reservation found — reserved and waiting for durable persistence.`
- Second Check returns `persisted` with non-null `createdAt` and renders
  `Reservation found — persisted to the permanent record.` plus its persisted timestamp.
- The complete flow issues exactly one purchase POST.

#### Seven added browser definitions

Each purchase-outcome definition starts from a valid active sale, submits one valid identifier,
asserts exactly one purchase POST, and asserts the exact user-visible heading/state:

1. `409` + valid `ALREADY_PURCHASED`: `You already hold a reservation`; no automatic POST retry.
2. `410` + valid `SOLD_OUT`: `Sold out`; remaining stock is zero and Buy remains disabled.
3. `403` + valid `SALE_ENDED`, followed by a sale-status refresh whose state is `ended`: feedback
   heading `This drop is closed`, Buy text `Sale ended`, and Buy remains disabled.
4. `429` + valid `RATE_LIMITED` + `Retry-After: 2`: `Too many attempts`, `Try again in 2s`,
   disabled Buy; controlled-clock advance proves the countdown completes without another POST.
5. `503` + a valid `UPSTREAM_UNAVAILABLE` **purchase-response** envelope: `Service temporarily
   unavailable`; no automatic POST retry. Do not substitute the distinct generic API-error shape.
6. Transport-aborted purchase with no HTTP response: `Result unknown`; the typed identifier remains
   present, Check is enabled, and controlled-clock advance proves no automatic POST retry.
7. Poll recovery/no-overlap: begin with a successful active response and visible last-good stock;
   make the next scheduled sale-status GET fail and assert that the last-good sale/stock remains
   visible with the unavailable banner. Start manual Retry, hold its recovery GET, invoke Retry
   again, and assert maximum sale-status requests in flight is exactly `1`. Release recovery with a
   visibly different stock value; assert the new exact stock and disappearance of the banner.

The structured `503` case tests a decoded, explicit purchase outcome; the transport-aborted case
tests an ambiguous submission. Do not collapse them into one generic failure test.

### 23.5 App component assertions

Add these deterministic React/Vitest proofs to `apps/web/src/App.test.tsx`:

1. **Half-open window transitions:** initial loading, then upcoming at `now < startsAt`, active at
   `now === startsAt`, still active at `now === endsAt - 1ms`, and ended at `now === endsAt`.
   Assert corresponding pill/button state, not merely helper return values.
2. **Last-good recovery:** after a successful active response, a poll failure retains the prior
   sale and stock while showing unavailable state; repeated Retry while the recovery request is
   pending does not overlap; successful recovery replaces stock and clears unavailable state.
3. **All purchase-status branches:** table-drive `reserved`, `persisted`, `compensated`, `null`
   order/not purchased, and status-request failure. Assert the exact branch copy. For compensated
   during an active sale, include `You may try again.`; for absent, include the identifier; for
   failure, assert `Reservation status is temporarily unavailable. Try again.`
4. **Stock-meter edges:** a total stock of `50` renders exactly 50 segments, and `totalStock: 0,
   remainingStock: 0` renders zero segments plus `0 / 0 remaining` without division/ARIA errors.

Use fake timers or deferred promises with explicit cleanup. Do not weaken the existing assertion
that a 500-total response is represented by 50 proportional segments.

### 23.6 API client assertions

Add these proofs to `apps/web/src/api/client.spec.ts`, each asserting the request count as well as
the outcome:

- A GET whose mocked fetch waits for abort reaches the frozen 4,000 ms timeout, aborts its signal,
  rejects as `ApiClientError` kind `timeout`, and performs exactly one fetch.
- An external `AbortController` signal is propagated; aborting it aborts the fetch, returns the safe
  non-timeout/network error contract, and performs exactly one fetch.
- A purchase transport rejection is never retried, including after advancing timers; one POST only.
- Table-drive `Retry-After` parsing on valid `RATE_LIMITED` purchase envelopes: `2 -> 2`, `99 -> 10`,
  `-5 -> 0`, and non-integer text -> `undefined`.
- Invalid JSON from a response rejects as `ApiClientError` kind `invalid-response`.
- Valid JSON with a malformed endpoint payload rejects as `ApiClientError` kind
  `invalid-response`.

No client test may rely on real network or real elapsed time.

### 23.7 Decoder rejection matrices

Keep every current acceptance test and add table-driven rejection matrices in
`apps/web/src/api/decoders.spec.ts`. Each row must identify the rejected field/reason and assert the
decoder throws `ApiClientError` kind `invalid-response`. Minimum rows:

| Decoder | Required independent invalid rows |
| --- | --- |
| Sale status | non-object; unknown state; invalid ISO time; fractional `serverTimeMs`; negative `totalStock`; negative `remainingStock`; `remainingStock > totalStock` |
| Purchase response | non-object; unknown outcome; negative stock; fractional stock; invalid ISO time; fractional `serverTimeMs`; non-string optional message |
| Purchase status | unknown order status; `reserved` with `purchased:false`; `persisted` with `purchased:false`; `compensated` with `purchased:true`; null order with `purchased:true`; invalid non-null `createdAt` |
| Sale metrics | missing metric field; negative metric; fractional metric; invalid server time pair |
| Readiness | wrong top-level status/service; negative uptime; missing request ID; invalid latency; invalid Redis clock; negative queue count; missing nested check |
| API error | non-object; missing/invalid required string; invalid ISO `serverTime`; fractional `serverTimeMs` |

This is a semantic matrix: do not satisfy it with one generic malformed object applied to every
decoder. Existing positive acceptance of every purchase outcome and all ops DTOs remains required.

### 23.8 Count and coverage evidence

The pre-A4 unit suite contains 43 Vitest cases. With the required component/client cases and every
matrix row represented as its own `it.each` case, A4 must report **at least 97 passing Vitest
cases**. This is a case-count floor, not a substitute for the named assertions in §§23.5–23.7.
Do not split trivial assertions solely to inflate the number. If Vitest's reporter groups a
parameterized table differently, the implementer must still provide the verbose test-name output
showing every named matrix row and every mandatory scenario.

The browser gate must report exactly **26 passing tests in 2 projects**, with the retained subset
still accounting for 8 axe scans and 2 visual comparisons. No skipped, todo, flaky-retried, or
conditionally omitted mandatory case counts as coverage.

### 23.9 Invariant effect

- **I1 — no oversell:** production enforcement remains the atomic Redis Lua decision. A4 adds no
  decision logic; sold-out and exact stock rendering tests ensure the browser does not contradict
  authoritative server state.
- **I2 — one per user:** Redis membership and Postgres uniqueness remain unchanged. The duplicate
  browser proof verifies `ALREADY_PURCHASED` is presented without a client retry or second POST.
- **I3 — half-open window:** API/Lua enforcement remains authoritative. Component boundary proofs
  explicitly cover `[startsAt, endsAt)`, while upcoming/ended controls remain advisory and disabled.
- **I4 — no lost confirmations:** BullMQ persistence/compensation remains authoritative. Reserved,
  persisted, compensated, unavailable, and ambiguous-result proofs preserve the status-check path;
  no POST is automatically retried and no client behavior fabricates confirmation.

### 23.10 Exact verification

From repo root, run:

```bash
pnpm --filter @flash/web lint
pnpm --filter @flash/web typecheck
pnpm --filter @flash/web exec vitest run --reporter=verbose
pnpm --filter @flash/web build
pnpm --filter @flash/web exec playwright test --list
pnpm --filter @flash/web test:e2e
sha256sum apps/web/e2e/__screenshots__/*/active-sale.png
git diff --check
git diff --name-only
```

Required evidence:

- Lint, typecheck, production build, and all tests are green.
- Vitest reports at least 97 passed cases and verbose output names every §23.5–§23.7 scenario and
  decoder row.
- Playwright list and run report exactly 26 tests across desktop/mobile, with no skip/todo and no
  retry needed to pass; retained proofs still include 8 axe scans and 2 visual comparisons.
- The two screenshot hashes exactly match §23.1.
- The changed-path subset is exactly §23.2. No production, dependency, config, screenshot,
  prototype, contract, `.codex/`, or root path appears in the A4 implementation diff.

After slice verification, run the normal Phase 4 root gate from §15.2 and provide its actual output.
A4 does not replace any baseline or A3 accessibility/build requirement.

### 23.11 Loop reset and copy-ready A4 brief

The independent gate found a frozen-contract coverage omission after the prior implementation unit
was green. That prior unit closes; this new **A4 behavioral-proof unit begins at iteration zero**
with the normal maximum of three implement/verify iterations before mandatory re-escalation.
Adversarial same-underlying-issue failure counting is independent and does not reset.

> **A4 behavioral-proof corrective unit.** Read Phase 4 contract §23 before editing. Own exactly
> `apps/web/src/App.test.tsx`, `apps/web/src/api/client.spec.ts`,
> `apps/web/src/api/decoders.spec.ts`, `apps/web/e2e/fixtures.ts`, and
> `apps/web/e2e/flash-sale.spec.ts`. You are not alone in the codebase: preserve every other change
> and do not touch production source, dependencies, configs, screenshots, prototype, `.codex/`,
> `STATE.md`, or the contract. Implement every named component/client/decoder assertion and the
> seven new browser definitions; expand the existing buyer flow for held submitting then reserved
> and persisted stages. Keep the existing 8 axe scans and 2 visual comparisons unchanged. The
> final evidence floor is at least 97 passing Vitest cases and exactly 26 passing Playwright tests
> in 2 projects, with the two §23.1 screenshot hashes unchanged. If a test reveals a production
> defect, stop and escalate with the minimal failing proof; do not edit production code. Run every
> §23.10 command plus the §15.2 root gate and paste real output. This A4 unit starts at iteration
> zero; stop and re-escalate after three failed corrective iterations.

---

## 24. AMENDMENT A5 — confirmation authenticity and async ownership

**Authority:** ARCHITECT · **Version:** A5 · **Date:** 2026-07-23 · **Status:** FROZEN

**Amends:** §§4.6, 7.2, 8.1–8.2, 9, 13, 15, and 23. A1–A4 remain binding except where A5
explicitly supersedes them.

### 24.1 Adversarial pass-1 findings

The first post-A4 adversarial review rejects the Phase 4 gate for five implementation defects and
one browser-proof defect:

1. The purchase client accepts a structurally valid `CONFIRMED` body on any HTTP status. This can
   render `Card secured` without the API's frozen `201 CONFIRMED` protocol pair.
2. `useOpsSnapshot` cleanup aborts requests but leaves `running` and `controller` owned by the old
   generation. Its per-resource success/failure handlers mutate refs and React state before their
   only generation check. StrictMode remount and late settlement can therefore suppress a fresh
   poll or commit stale ops state.
3. Purchase-status requests have no owned abort controller or generation/identifier correlation.
   A lookup for identifier A can settle after the editable input changes to B and display A's
   result under B.
4. `Retry-After` uses `parseInt`, accepting partial strings such as `2junk` or `2.5`.
5. Every `ApiClientError`, including a decoded-but-invalid response, is labeled `Result unknown`.
   That phrase is reserved for a transport failure where dispatch outcome is genuinely ambiguous.
6. Axe scenarios wait only for a generic heading, so a named upcoming/sold-out/ended scan can run
   against the loading or wrong sale state and still pass.

These are design-level ownership/protocol defects. A5 authorizes the minimum production changes
and mandatory regressions below. It does not change API, Redis, queue, database, CSS, visual, or
accessibility semantics.

### 24.2 Three exclusive corrective slices and merge order

| Slice | Exclusive paths | Responsibility |
| --- | --- | --- |
| **A5-P — purchase protocol** | `apps/web/src/api/client.ts`; `apps/web/src/api/client.spec.ts` | Exact `201 CONFIRMED` acceptance and strict decimal `Retry-After` parsing |
| **A5-L — lifecycle and lookup ownership** | `apps/web/src/App.tsx`; `apps/web/src/App.test.tsx`; `apps/web/src/hooks/useOpsSnapshot.ts`; `apps/web/src/hooks/useOpsSnapshot.spec.tsx` (new) | Error taxonomy, status correlation/cancellation, generation-safe ops polling |
| **A5-E — browser proof** | `apps/web/e2e/fixtures.ts`; `apps/web/e2e/flash-sale.spec.ts` | Non-201 confirmation rejection and intended-state axe preconditions |

No path overlaps. Merge and verify in strict order **A5-P → A5-L → A5-E**; A5-E runs only after
the first two slices are present because it proves their composed browser behavior. Each
frontend-implementer loads `frontend-design`, `vite`, `vitest`, and
`vercel-react-best-practices` before editing. Agents are not alone in the worktree and must
preserve every path outside their slice.

Forbidden throughout A5: package/lock changes; configs; CSS; screenshot updates; components;
`useSaleStatus.ts`; decoders/contracts; backend/shared/worker/infra/load; prototype; root tooling;
`.codex/`; `STATE.md`; and this contract. Add no dependency and create no test-only branch in
production code.

### 24.3 A5-P — exact confirmation protocol

The web may enter the `confirmed` interaction and render `Card secured` only when both conditions
hold for the same response:

```text
HTTP status === 201
decoded PurchaseResponse.status === 'CONFIRMED'
```

`request()` already has the `Response` and decoded purchase envelope and remains the enforcement
point. For a valid `CONFIRMED` envelope on any status other than 201, throw `ApiClientError` with
kind `invalid-response`; return no `Timed<PurchaseResponse>`, apply no stock snapshot, request no
refresh, and expose no decoded confirmation to `App`. A malformed `201` body remains
`invalid-response`. A5 does not alter the existing decoded handling of non-confirmed purchase
outcomes or their HTTP statuses.

This check must use `response.status`, not `response.ok`, and compare it with the existing frozen
`PURCHASE_OUTCOME_HTTP_STATUS.CONFIRMED` value import from `@flash/shared` (value `201`). `200`,
`202`, and other 2xx statuses are not the confirmation protocol. Every client response mock gains
an explicit numeric `status`; do not make a missing status accidentally behave like 201.

#### Strict `Retry-After`

After the Fetch `Headers` implementation's normal header-value normalization, accept the
`Retry-After` value only when it matches ASCII decimal digits in full:

```text
/^[0-9]+$/
```

Convert only a `Number.isSafeInteger` result. Clamp a valid value to the existing inclusive
`0..10` browser countdown bound. Missing, empty, signed, fractional, exponent, hexadecimal,
partially numeric, non-finite, or unsafe-integer text yields `undefined`; never use `parseInt` or
another prefix parser. Leading-zero digit strings are valid decimal seconds.

#### A5-P regression matrix

Keep every A4 client test and prove:

- `201` plus valid `CONFIRMED` resolves once and remains the positive control.
- Valid `CONFIRMED` on each of `200`, `202`, `400`, `409`, and `500` independently rejects as
  `invalid-response`; each row performs one POST and returns no data.
- Retry-After valid rows: `0 -> 0`, `2 -> 2`, `99 -> 10`, `00 -> 0`.
- Retry-After invalid rows: `-5`, `+2`, `2.5`, `2junk`, `1e2`, and
  `999999999999999999999999999999` all produce `undefined`.

### 24.4 A5-L — ops generation ownership

`useOpsSnapshot` keeps one active generation and at most one owned poll. Its effect lifecycle is
frozen as follows:

1. Effect start increments `generation` and starts a fresh forced poll.
2. Poll captures `ownGeneration`, creates one controller, sets `running=true`, and records that
   controller as owner.
3. Every metrics/readiness success and catch handler checks, **before `Date.now`, RNG, ref mutation,
   or React state mutation**, that `ownGeneration === generation.current` and the owned signal is
   not aborted. A stale/aborted handler returns without changing `refs`, `metrics`, `readiness`,
   failure counters, due times, or timers.
4. Finalization may clear `running`/`controller` and schedule the next timer only when the
   controller is still the current owner and the generation still matches. Clear the controller
   reference after a current poll settles.
5. Cleanup first increments `generation`, then clears and undefines the timer, aborts the owned
   controller, sets `controller=undefined`, sets `running=false`, and removes the visibility
   listener. This reset makes the StrictMode remount's forced poll eligible immediately.
6. `refresh()` clears and undefines the current timer; if a poll owns the flight it remains
   serialized rather than starting an overlapping request.

No stale generation may commit either the success or failure path. Do not silence React warnings
or use an `isMounted` boolean as a second competing ownership model.

Create `useOpsSnapshot.spec.tsx` using deterministic deferred promises/fake timers. It must prove
three independent cases:

- StrictMode stale **success**: first-generation metrics/readiness requests are held, the cleanup
  aborts their signals, the second generation starts fresh requests, and late old successes cannot
  overwrite fresh values/updated times or schedule a stale timer.
- StrictMode stale **failure**: late old rejections cannot mark fresh resources stale, increment
  failure counts, move due times, or suppress the fresh generation.
- Unmount/serialization: unmount aborts the current signals and late settlement commits nothing;
  repeated refresh while a request is held never exceeds one metrics and one readiness request for
  the single owned poll and leaves no timer/listener after cleanup.

### 24.5 A5-L — identifier-correlated status lookup

The identifier input remains editable during a status lookup. Correctness is provided by explicit
ownership and correlation, not by disabling the field.

`App` owns a status-lookup generation ref, an `AbortController` ref, and the current normalized
identifier ref. The rendered status result is stored with its normalized requested identifier:

```ts
type CorrelatedStatusResult = { userId: string; copy: string };
```

Required lifecycle:

1. On each valid lookup, increment the status generation, abort the prior controller, create and
   own a new controller, capture the normalized requested identifier and generation, clear the
   old result, set busy, and pass the signal to `getPurchaseStatus`.
2. Before every async success, failure, result, busy, or controller commit, require all of:
   generation still matches; controller is still owner; signal is not aborted; current normalized
   input still equals the requested identifier.
3. A successful envelope is accepted only when its normalized `data.userId` equals the requested
   identifier. A mismatch uses the correlated safe failure copy; it never renders the returned
   identity or order state.
4. When an input edit changes the normalized identifier, immediately increment the generation,
   abort and clear the controller, clear the correlated result, and clear busy. A raw edit whose
   normalized value is unchanged need not cancel.
5. Render a correlated result only while its stored identifier equals the current normalized
   input. This is defense in depth even after the async ownership checks.
6. Component cleanup increments the generation, aborts and clears both the existing purchase
   controller and status controller, and permits no later state commit.

The safe failed-lookup copy remains exactly
`Reservation status is temporarily unavailable. Try again.` Existing reserved, persisted,
compensated, and absent copy remains unchanged.

Add three independent App regressions:

- Hold lookup A, edit to normalized B, assert A is aborted and all prior status content clears;
  resolve A anyway, then run B and prove only B-correlated copy appears.
- Start A, invalidate it, start B, settle B first and A last; B remains visible and the late A
  success/failure changes neither result nor busy state.
- A response whose `data.userId` does not equal the requested identifier renders only the exact
  safe failure copy; unmount aborts an owned request and late settlement causes no state update or
  React unmounted-update warning.

### 24.6 A5-L — purchase error taxonomy

The purchase catch branch maps by `ApiClientError.kind`:

| Failure | Heading | Interaction meaning |
| --- | --- | --- |
| `network` or `timeout` | `Result unknown` | Transport failed after dispatch; request may have reached the API |
| `invalid-response` | `We could not verify the result` | A response arrived or was decoded incorrectly; never claim confirmation |
| `http` | `We could not verify the result` | Server answered without a valid purchase outcome; never claim confirmation |
| Non-`ApiClientError` unexpected failure | `We could not verify the result` | Safe fallback; no raw error |

Only `network` and `timeout` may use `Result unknown`. All rows keep the existing check-first body,
preserve the attempted identifier, expose status Check, and issue no automatic POST retry. In
particular, the A5-P non-201 `CONFIRMED` rejection must render exactly
`We could not verify the result` and must never render `Card secured` or the confirmed Buy state.

Replace/expand the existing App rejection test into five named cases: network, timeout,
invalid-response, http, and unexpected `Error`. Assert exact heading, one POST, enabled Check, and
absence of `Card secured` in every non-success case.

### 24.7 A5-E — browser protocol and axe state proof

Add exactly one Playwright test definition:

- Configure a structurally valid `CONFIRMED` purchase envelope on HTTP `200`. Submit once and
  assert `We could not verify the result`, enabled Check, preserved identifier, exactly one POST,
  no `Card secured` feedback, and no `✓ Card secured` button before or after controlled-clock
  advance. The existing held `201 CONFIRMED` flow remains the positive browser control.

Before each existing axe call, assert its intended state using this exact matrix:

| Named axe scenario | Required visible preconditions before `analyze()` |
| --- | --- |
| `upcoming` | pill `Upcoming`; disabled Buy `Opens soon` |
| `active` | pill `Live now`; enabled Buy `Secure your card` |
| `sold_out` | pill `Sold out`; disabled Buy `Sold out`; `0 / 500 remaining` |
| `ended` | pill `Ended`; disabled Buy `Sale ended` |

The generic Acquisition-console heading is not a state precondition and cannot replace these
assertions. Retain the same WCAG tags, serious/critical filter, both viewports, 8 axe scans, two
visual comparisons, and frozen A3 screenshot hashes. Do not add waits, weaken axe, or update a
snapshot.

### 24.8 Expected counts and verification

The verified pre-A5 baseline is **100 passing Vitest cases in 6 files** and **26 Playwright tests
in 2 projects**. A5's named matrices require at least **121 passing Vitest cases in 7 files** and
exactly **28 Playwright tests in 2 projects**. Parameterized rows count independently. Counts do
not replace the named semantic assertions; no skip, todo, conditional omission, or retry-to-pass
counts as evidence.

After each slice, run its focused checks:

```bash
# A5-P
pnpm --filter @flash/web exec vitest run src/api/client.spec.ts --reporter=verbose
pnpm --filter @flash/web lint
pnpm --filter @flash/web typecheck

# A5-L, after A5-P is present
pnpm --filter @flash/web exec vitest run src/App.test.tsx src/hooks/useOpsSnapshot.spec.tsx --reporter=verbose
pnpm --filter @flash/web lint
pnpm --filter @flash/web typecheck

# A5-E, after A5-P and A5-L are present
pnpm --filter @flash/web exec playwright test --list
pnpm --filter @flash/web test:e2e
sha256sum apps/web/e2e/__screenshots__/*/active-sale.png
```

Then run the combined corrective gate:

```bash
pnpm --filter @flash/web lint
pnpm --filter @flash/web typecheck
pnpm --filter @flash/web exec vitest run --reporter=verbose
pnpm --filter @flash/web build
pnpm --filter @flash/web exec playwright test --list
pnpm --filter @flash/web test:e2e
sha256sum apps/web/e2e/__screenshots__/*/active-sale.png
pnpm exec prettier --check apps/web .gitignore .claude/contracts/phase-4.md
git diff --check
git diff --name-only
```

Required combined evidence:

- At least 121 Vitest cases pass in 7 files, including every §24.3–§24.6 row.
- Playwright lists and passes exactly 28 tests in two projects; the `201 CONFIRMED` positive and
  `200 CONFIRMED` negative controls both pass; all eight axe calls first prove their named state.
- Screenshot hashes remain exactly:

  ```text
  fe0720268a15d3fc484de3e5a2ca623e12c4d6b201d2e057b50bb15782ff67a3  apps/web/e2e/__screenshots__/desktop-chromium/active-sale.png
  4dfabc79bc8c116acacbfe55f6610447382cd5ffddfcffd52148c95eb5e8f9ee  apps/web/e2e/__screenshots__/mobile-chromium/active-sale.png
  ```

- The A5 implementation diff is a subset of §24.2's paths and contains no dependency, config,
  component, CSS, screenshot, decoder, sale-poll, backend/shared, prototype, contract, `.codex/`,
  or root change.
- The complete §15.2 root independent gate passes after the corrective gate. A5 replaces no prior
  baseline, axe, visual, accessibility, or adversarial requirement.

### 24.9 Invariant effect

- **I1 — no oversell:** Redis Lua remains the stock enforcement point. A5 prevents an invalid HTTP
  protocol pair from being represented as a browser confirmation or applied as confirmed stock.
- **I2 — one per user:** Redis membership and Postgres uniqueness remain authoritative. Status
  results are now bound to the normalized identifier that requested them, so one user's result is
  never presented as another's.
- **I3 — half-open window:** API/Lua window enforcement and A4 boundary proofs are unchanged. Axe
  tests now prove they scan the intended upcoming/active/sold-out/ended state rather than loading.
- **I4 — no lost confirmations:** BullMQ persistence and compensation remain authoritative. Only
  the exact `201 CONFIRMED` pair may claim success; ambiguous transport failures remain check-first,
  invalid responses never fabricate success, and status checks cannot be lost or misattributed by
  stale async settlement.

### 24.10 Loop accounting and copy-ready briefs

Adversarial review pass 1 is rejected on the findings in §24.1. A5 is a new architect-authored
corrective design, so its **implement→verify loop begins at iteration zero** with a maximum of three
iterations per slice. The adversarial same-underlying-issue counter does **not** reset: another
rejection on any unchanged §24.1 issue is the second consecutive review failure and escalates
immediately under AGENTS.md §8.

> **A5-P purchase-protocol slice.** Read Phase 4 §24.2–§24.3 and §24.8. Own only
> `apps/web/src/api/client.ts` and `apps/web/src/api/client.spec.ts`. You are not alone in the
> worktree; preserve every other path. Enforce exact `201 + valid CONFIRMED`, reject valid
> CONFIRMED bodies on every other HTTP status as `invalid-response`, and replace prefix
> Retry-After parsing with the frozen full decimal/safe-integer grammar. Load the §24.2 skills.
> Run the A5-P focused commands and paste verbose matrix output. Do not edit App, hooks, e2e,
> decoders, dependencies, config, screenshots, or contract. Start at iteration zero and stop after
> three failed implement/verify iterations.

> **A5-L lifecycle/correlation slice.** Start only after A5-P is present. Read Phase 4
> §24.2 and §§24.4–24.6. Own only `apps/web/src/App.tsx`, `apps/web/src/App.test.tsx`,
> `apps/web/src/hooks/useOpsSnapshot.ts`, and new
> `apps/web/src/hooks/useOpsSnapshot.spec.tsx`. Preserve every other path. Make every ops
> success/failure commit generation-safe and fully reset timer/controller/running on cleanup;
> implement editable-input status lookup with generation, AbortController, normalized-ID
> correlation, cleanup, and response-ID validation; reserve `Result unknown` for network/timeout
> and map invalid/http/unexpected to exact `We could not verify the result`. Load the §24.2 skills.
> Run the A5-L focused commands with verbose output. Do not edit client, e2e, components, configs,
> CSS, dependencies, screenshots, or contract. Start at iteration zero and stop after three failed
> implement/verify iterations.

> **A5-E browser-proof slice.** Start only after A5-P and A5-L are present. Read Phase 4 §24.2,
> §24.7, and §24.8. Own only `apps/web/e2e/fixtures.ts` and
> `apps/web/e2e/flash-sale.spec.ts`. Preserve every other path. Add the HTTP-200 valid-CONFIRMED
> negative test while retaining the HTTP-201 positive flow; add exact intended-state preconditions
> before every existing axe scan. Keep 8 axe scans, 2 visual comparisons, and both screenshot
> hashes unchanged. Load the §24.2 skills. Run A5-E focused and combined commands; expected gate is
> at least 121 Vitest cases and exactly 28 Playwright tests. Do not update snapshots or edit
> production, dependencies, config, CSS, or contract. Start at iteration zero and stop after three
> failed implement/verify iterations.

---

## 25. CLARIFICATION A5.1 — TSX spec discovery

**Authority:** ARCHITECT · **Version:** A5.1 · **Date:** 2026-07-23 · **Status:** FROZEN

**Clarifies:** §§24.2, 24.4, 24.8, and 24.10. All A5 behavior and count requirements remain
unchanged.

### 25.1 Contract mismatch and decision

The required new `apps/web/src/hooks/useOpsSnapshot.spec.tsx` passes all 3 tests when selected by a
temporary Vitest configuration, and the current A5-L implementation separately has 31/31 App tests,
lint, and typecheck green. The repository configuration nevertheless discovers only
`src/**/*.spec.ts` and `src/**/*.test.tsx`; therefore the exact frozen A5-L command cannot select
the required `.spec.tsx` file.

Keep the frozen filename. The generic project convention is amended to discover TSX specs rather
than renaming one file as a special case. In `apps/web/vitest.config.ts`, change only `test.include`
to exactly:

```ts
include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx', 'src/**/*.test.tsx'],
```

Order is frozen. Do not replace the explicit list with a brace/glob expansion, broaden discovery
outside `src`, or change any other Vitest setting. This addition is test discovery only; it changes
no runtime bundle or application behavior.

### 25.2 Ownership amendment

A5-L ownership is amended to exactly:

```text
apps/web/src/App.tsx
apps/web/src/App.test.tsx
apps/web/src/hooks/useOpsSnapshot.ts
apps/web/src/hooks/useOpsSnapshot.spec.tsx
apps/web/vitest.config.ts
```

This supersedes the A5-L row and brief in §§24.2 and 24.10 only for the added config path. A5-P and
A5-E ownership remain unchanged and non-overlapping. The A5-L implementer may make only the exact
`test.include` edit above in `vitest.config.ts`; existing React plugin, environment, globals,
CommonJS/optimize-deps settings, mock restoration, and all other config bytes remain unchanged.

The §24.2/§24.10 prohibition on config edits remains binding for A5-P and A5-E and for every config
path other than this one narrowly authorized row.

### 25.3 Corrected verification and expected evidence

Do not use a temporary config, CLI include override, renamed copy, symlink, or direct test-file
workaround. From repo root, the repository's normal config must discover and run the hook spec:

```bash
pnpm --filter @flash/web exec vitest run src/App.test.tsx src/hooks/useOpsSnapshot.spec.tsx --reporter=verbose
pnpm --filter @flash/web exec vitest run --reporter=verbose
pnpm --filter @flash/web lint
pnpm --filter @flash/web typecheck
pnpm --filter @flash/web build
pnpm exec prettier --check apps/web/vitest.config.ts apps/web/src/hooks/useOpsSnapshot.spec.tsx .claude/contracts/phase-4.md
git diff --check
git diff --name-only
```

Required evidence:

- The focused command discovers exactly the named App and hook files and passes **34 tests total**:
  31 App tests plus 3 `useOpsSnapshot` tests.
- The unfiltered command discovers **7 test files** including
  `src/hooks/useOpsSnapshot.spec.tsx` and retains the A5 floor of at least **121 passing tests**.
- Lint, typecheck, build, Prettier, and diff checks pass.
- The only A5.1 production/config edit is the exact `test.include` addition in
  `apps/web/vitest.config.ts`; no A5-L application/test behavior is weakened or skipped.
- After this focused correction, continue A5-E and the unchanged combined §24.8 and root §15.2
  gates.

### 25.4 Invariants and loop status

- **I1–I4:** unchanged. A5.1 only makes the already-required async ownership regression executable
  through the repository's normal Vitest configuration. The underlying A5 protections remain the
  enforcement/proof mechanisms described in §24.9.

The failure is a frozen-contract discovery omission, not a failed logic iteration: the required
hook tests pass 3/3 under the temporary diagnostic config, and App/lint/typecheck are green. Close
that diagnostic attempt. A new **A5.1 discovery corrective unit starts at implement/verify
iteration zero**, with the normal maximum of three iterations. The adversarial pass-1
same-underlying-issue counter does not reset. If the corrected normal-config command exposes a
logic failure, return it to A5-L as iteration 1; do not hide it with another config override.

> **A5.1 TSX-spec discovery correction.** Read Phase 4 §25 before editing. Continue as the A5-L
> implementer and load `frontend-design`, `vite`, `vitest`, and
> `vercel-react-best-practices`. A5-L ownership now includes exactly
> `apps/web/vitest.config.ts` in addition to its four §24.2 paths. In that config, add only
> `src/**/*.spec.tsx` between the existing `src/**/*.spec.ts` and `src/**/*.test.tsx` include rows;
> change no other setting or path. Do not rename the hook spec or use a temporary config/CLI
> workaround. Run every §25.3 command: focused evidence must be 31 App + 3 hook = 34 tests, and the
> normal suite must discover 7 files and at least 121 tests. Preserve all unrelated work and do not
> edit client, e2e, components, CSS, dependencies, lockfile, screenshots, prototype, backend/shared,
> `.codex/`, `STATE.md`, or the contract. This discovery unit starts at iteration zero; if normal
> discovery reveals a logic failure, report it as A5-L iteration 1.
