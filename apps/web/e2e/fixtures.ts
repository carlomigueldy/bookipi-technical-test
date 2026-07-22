import { test as base, expect, type Page, type Route } from '@playwright/test';

export const FIXED_NOW = Date.UTC(2026, 6, 23, 4, 0, 0);
type SaleState = 'upcoming' | 'active' | 'sold_out' | 'ended';
type PurchaseOutcome =
  | 'CONFIRMED'
  | 'ALREADY_PURCHASED'
  | 'SOLD_OUT'
  | 'SALE_NOT_STARTED'
  | 'SALE_ENDED'
  | 'NOT_INITIALIZED'
  | 'INVALID_USER_ID'
  | 'RATE_LIMITED'
  | 'UPSTREAM_UNAVAILABLE';
type OrderStatus = 'reserved' | 'persisted' | 'compensated';
type PurchaseStatusStep = {
  purchased: boolean;
  order: { status: OrderStatus; createdAt: string | null } | null;
};
type PurchasePlan = {
  httpStatus?: number;
  outcome?: PurchaseOutcome;
  stockRemaining?: number | null;
  retryAfter?: string;
  abort?: boolean;
  hold?: boolean;
  saleStateAfterPurchase?: SaleState;
};
type InstallOptions = {
  purchase?: PurchasePlan;
  purchaseStatuses?: PurchaseStatusStep[];
};
type DeferredAction = 'release' | 'abort';

export const sale = (status: SaleState = 'active', stock?: number) => {
  const startsAtMs = status === 'upcoming' ? FIXED_NOW + 60_000 : FIXED_NOW - 60_000;
  const endsAtMs = status === 'ended' ? FIXED_NOW : FIXED_NOW + 600_000;
  const stockRemaining = stock ?? (status === 'sold_out' ? 0 : 500);
  return {
    saleId: 'aurora-founders',
    name: 'Aurora Founders Edition',
    status,
    startsAt: new Date(startsAtMs).toISOString(),
    endsAt: new Date(endsAtMs).toISOString(),
    startsAtMs,
    endsAtMs,
    totalStock: 500,
    stockRemaining,
    serverTime: new Date(FIXED_NOW).toISOString(),
    serverTimeMs: FIXED_NOW,
  };
};
export const metrics = {
  saleId: 'aurora-founders',
  metrics: {
    confirmed: 42,
    already_purchased: 8,
    sold_out: 3,
    sale_not_active: 4,
    not_initialized: 0,
    rate_limited: 2,
    invalid_user_id: 1,
  },
  serverTime: new Date(FIXED_NOW).toISOString(),
  serverTimeMs: FIXED_NOW,
};
export const readiness = {
  status: 'ok',
  service: 'api',
  version: '0.0.0',
  uptimeSeconds: 120,
  checks: {
    redis: { ok: true, latencyMs: 1 },
    postgres: { ok: true, latencyMs: 2 },
    clock: { ok: true, offsetMs: 0, rttMs: 1, ageMs: 1 },
    sale: { ok: true, initialized: true, stockKeyPresent: true },
    queue: { ok: true, waiting: 0, active: 0, delayed: 0, failed: 0 },
  },
  requestId: 'e2e',
  serverTime: new Date(FIXED_NOW).toISOString(),
  serverTimeMs: FIXED_NOW,
};

const apiError = {
  error: 'UPSTREAM_UNAVAILABLE',
  message: 'Temporarily unavailable',
  requestId: 'e2e',
  serverTime: new Date(FIXED_NOW).toISOString(),
  serverTimeMs: FIXED_NOW,
};

export async function installApi(
  page: Page,
  initialState: SaleState = 'active',
  options: InstallOptions = {},
) {
  await page.clock.install({ time: FIXED_NOW });
  let state = initialState;
  let visibleStock: number | undefined;
  let purchasePlan: PurchasePlan = options.purchase ?? {};
  const purchaseStatuses = [...(options.purchaseStatuses ?? [])];
  let statusIndex = 0;
  let failNextSale = false;
  let holdNextSale = false;
  let heldSaleRoute: Route | null = null;
  let heldSaleStock = 500;
  let heldPurchaseRoute: Route | null = null;
  let purchaseAction: ((action: DeferredAction) => void) | null = null;
  let saleStatusRequests = 0;
  let saleStatusInFlight = 0;
  let maximumSaleStatusInFlight = 0;
  let purchasePosts = 0;

  const completePurchase = async (route: Route, plan: PurchasePlan) => {
    if (plan.abort) return route.abort('failed');
    if (plan.saleStateAfterPurchase) state = plan.saleStateAfterPurchase;
    const body = {
      status: plan.outcome ?? 'CONFIRMED',
      userId: 'mia@example.com',
      saleId: 'aurora-founders',
      stockRemaining: plan.stockRemaining === undefined ? 499 : plan.stockRemaining,
      serverTime: new Date(FIXED_NOW).toISOString(),
      serverTimeMs: FIXED_NOW,
    };
    return route.fulfill({
      status: plan.httpStatus ?? 201,
      headers: {
        'content-type': 'application/json',
        'access-control-expose-headers': 'Retry-After',
        ...(plan.retryAfter ? { 'retry-after': plan.retryAfter } : {}),
      },
      body: JSON.stringify(body),
    });
  };

  page.on('close', () => {
    purchaseAction?.('abort');
    if (heldSaleRoute) void heldSaleRoute.abort('failed');
  });
  await page.route('http://localhost:3000/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/sale/status') {
      saleStatusRequests += 1;
      saleStatusInFlight += 1;
      maximumSaleStatusInFlight = Math.max(maximumSaleStatusInFlight, saleStatusInFlight);
      if (failNextSale) {
        failNextSale = false;
        saleStatusInFlight -= 1;
        return route.fulfill({ status: 503, json: apiError });
      }
      if (holdNextSale) {
        holdNextSale = false;
        heldSaleRoute = route;
        return;
      }
      saleStatusInFlight -= 1;
      return route.fulfill({ json: sale(state, visibleStock) });
    }
    if (url.pathname === '/api/sale/metrics') return route.fulfill({ json: metrics });
    if (url.pathname === '/api/health/ready') return route.fulfill({ json: readiness });
    if (url.pathname === '/api/purchase' && route.request().method() === 'POST') {
      purchasePosts += 1;
      const plan = { ...purchasePlan };
      if (plan.hold) {
        heldPurchaseRoute = route;
        await new Promise<DeferredAction>((resolve) => {
          purchaseAction = resolve;
        }).then(async (action) => {
          purchaseAction = null;
          heldPurchaseRoute = null;
          if (action === 'abort') await route.abort('failed');
          else await completePurchase(route, plan);
        });
        return;
      }
      return completePurchase(route, plan);
    }
    if (url.pathname.startsWith('/api/purchase/')) {
      const step = purchaseStatuses[Math.min(statusIndex, purchaseStatuses.length - 1)] ?? {
        purchased: true,
        order: { status: 'reserved' as const, createdAt: null },
      };
      statusIndex += 1;
      return route.fulfill({
        json: {
          userId: decodeURIComponent(url.pathname.split('/').at(-1) ?? ''),
          saleId: 'aurora-founders',
          ...step,
          serverTime: new Date(FIXED_NOW).toISOString(),
          serverTimeMs: FIXED_NOW,
        },
      });
    }
    return route.abort('blockedbyclient');
  });

  return {
    setStatus(next: SaleState, stock?: number) {
      state = next;
      visibleStock = stock;
    },
    setPurchase(next: PurchasePlan) {
      purchasePlan = next;
    },
    releasePurchase() {
      if (!heldPurchaseRoute || !purchaseAction) throw new Error('No purchase response is held');
      purchaseAction('release');
    },
    abortPurchase() {
      if (!heldPurchaseRoute || !purchaseAction) throw new Error('No purchase response is held');
      purchaseAction('abort');
    },
    failNextSaleStatus() {
      failNextSale = true;
    },
    holdNextSaleStatus(stock: number) {
      holdNextSale = true;
      heldSaleStock = stock;
    },
    async releaseSaleStatus() {
      if (!heldSaleRoute) throw new Error('No sale-status response is held');
      const route = heldSaleRoute;
      heldSaleRoute = null;
      saleStatusInFlight -= 1;
      visibleStock = heldSaleStock;
      await route.fulfill({ json: sale(state, visibleStock) });
    },
    counts() {
      return {
        purchasePosts,
        saleStatusRequests,
        saleStatusInFlight,
        maximumSaleStatusInFlight,
      };
    },
  };
}

export const test = base;
export { expect };
