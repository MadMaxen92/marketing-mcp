import { config } from './config.js';

export const SHOPIFY_API_VERSION = '2026-07';

type ShopifyCredentials = {
  shop: string;
  clientId: string;
  clientSecret: string;
};

type Money = {
  amount: string;
  currencyCode: string;
};

export type ShopifyOrder = {
  id: string;
  name: string;
  createdAt: string;
  processedAt?: string | null;
  cancelledAt?: string | null;
  test: boolean;
  displayFinancialStatus?: string | null;
  displayFulfillmentStatus?: string | null;
  currentTotalPriceSet: { shopMoney: Money };
  currentSubtotalPriceSet: { shopMoney: Money };
};

let cachedAccessToken: string | undefined;
let cachedAccessTokenExpiresAt = 0;

function getCredentials(): ShopifyCredentials {
  if (!config.SHOPIFY_SHOP || !config.SHOPIFY_CLIENT_ID || !config.SHOPIFY_CLIENT_SECRET) {
    throw new Error(
      'Shopify is not configured. Set SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, and SHOPIFY_CLIENT_SECRET.',
    );
  }
  return {
    shop: config.SHOPIFY_SHOP,
    clientId: config.SHOPIFY_CLIENT_ID,
    clientSecret: config.SHOPIFY_CLIENT_SECRET,
  };
}

async function readJson(response: Response): Promise<any> {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

async function getAccessToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh && cachedAccessToken && cachedAccessTokenExpiresAt > Date.now() + 60_000) {
    return cachedAccessToken;
  }

  const credentials = getCredentials();
  const response = await fetch(`https://${credentials.shop}.myshopify.com/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    }),
  });
  const body = await readJson(response) as {
    access_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!response.ok || !body.access_token || !body.expires_in) {
    throw new Error(`Shopify token request failed ${response.status}: ${JSON.stringify(body)}`);
  }

  cachedAccessToken = body.access_token;
  cachedAccessTokenExpiresAt = Date.now() + body.expires_in * 1000;
  return cachedAccessToken;
}

async function shopifyGraphql<T>(query: string, variables: Record<string, unknown> = {}, retry = true): Promise<T> {
  const { shop } = getCredentials();
  const response = await fetch(`https://${shop}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-shopify-access-token': await getAccessToken(),
    },
    body: JSON.stringify({ query, variables }),
  });

  if (response.status === 401 && retry) {
    cachedAccessToken = undefined;
    cachedAccessTokenExpiresAt = 0;
    await getAccessToken(true);
    return shopifyGraphql<T>(query, variables, false);
  }

  const body = await readJson(response) as { data?: T; errors?: unknown[] };
  if (!response.ok) throw new Error(`Shopify Admin API error ${response.status}: ${JSON.stringify(body)}`);
  if (body.errors?.length) throw new Error(`Shopify GraphQL error: ${JSON.stringify(body.errors)}`);
  if (!body.data) throw new Error('Shopify GraphQL response did not contain data.');
  return body.data;
}

function assertIsoDate(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${label} must be a valid YYYY-MM-DD date.`);
  }
}

export function buildShopifyOrdersSearchQuery(input: {
  startDate: string;
  endDate: string;
  includeTest?: boolean;
}): string {
  assertIsoDate(input.startDate, 'startDate');
  assertIsoDate(input.endDate, 'endDate');
  if (input.startDate > input.endDate) throw new Error('startDate must not be after endDate.');
  return [
    'status:any',
    `created_at:>='${input.startDate}T00:00:00Z'`,
    `created_at:<='${input.endDate}T23:59:59Z'`,
    ...(input.includeTest ? [] : ['test:false']),
  ].join(' ');
}

export function summarizeShopifyOrders(orders: ShopifyOrder[], includeCancelled = false): any {
  const included = orders.filter((order) => includeCancelled || !order.cancelledAt);
  const currencies = new Set(included.map((order) => order.currentTotalPriceSet.shopMoney.currencyCode));
  if (currencies.size > 1) throw new Error('Shopify returned multiple shop currencies for one sales overview.');

  const daily = new Map<string, { date: string; orders: number; revenue: number; subtotal: number }>();
  const financialStatuses: Record<string, number> = {};
  const fulfillmentStatuses: Record<string, number> = {};
  let revenue = 0;
  let subtotal = 0;

  for (const order of included) {
    const date = order.createdAt.slice(0, 10);
    const orderRevenue = Number(order.currentTotalPriceSet.shopMoney.amount);
    const orderSubtotal = Number(order.currentSubtotalPriceSet.shopMoney.amount);
    revenue += orderRevenue;
    subtotal += orderSubtotal;
    const row = daily.get(date) ?? { date, orders: 0, revenue: 0, subtotal: 0 };
    row.orders += 1;
    row.revenue += orderRevenue;
    row.subtotal += orderSubtotal;
    daily.set(date, row);
    const financial = order.displayFinancialStatus ?? 'UNSPECIFIED';
    const fulfillment = order.displayFulfillmentStatus ?? 'UNSPECIFIED';
    financialStatuses[financial] = (financialStatuses[financial] ?? 0) + 1;
    fulfillmentStatuses[fulfillment] = (fulfillmentStatuses[fulfillment] ?? 0) + 1;
  }

  const roundedRevenue = Number(revenue.toFixed(2));
  const roundedSubtotal = Number(subtotal.toFixed(2));
  return {
    currency: currencies.values().next().value,
    orderCount: included.length,
    revenue: roundedRevenue,
    subtotal: roundedSubtotal,
    averageOrderValue: included.length ? Number((revenue / included.length).toFixed(2)) : 0,
    excludedCancelledOrders: orders.length - included.length,
    financialStatuses,
    fulfillmentStatuses,
    daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)).map((row) => ({
      ...row,
      revenue: Number(row.revenue.toFixed(2)),
      subtotal: Number(row.subtotal.toFixed(2)),
    })),
  };
}

export async function getShopifyShopOverview(): Promise<any> {
  const data = await shopifyGraphql<{
    shop: any;
    currentAppInstallation: { accessScopes: Array<{ handle: string }> };
  }>(`query ShopifyShopOverview {
    shop {
      id
      name
      myshopifyDomain
      url
      currencyCode
      ianaTimezone
      timezoneAbbreviation
      primaryDomain { host url }
    }
    currentAppInstallation { accessScopes { handle } }
  }`);
  return {
    apiVersion: SHOPIFY_API_VERSION,
    shop: data.shop,
    accessScopes: data.currentAppInstallation.accessScopes.map(({ handle }) => handle).sort(),
  };
}

export async function listShopifyProducts(input: {
  query?: string;
  limit?: number;
  pageToken?: string;
}): Promise<any> {
  const first = Math.min(Math.max(input.limit ?? 100, 1), 250);
  const data = await shopifyGraphql<{
    products: {
      nodes: any[];
      pageInfo: { hasNextPage: boolean; endCursor?: string };
    };
  }>(`query ShopifyProducts($first: Int!, $after: String, $query: String) {
    products(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) {
      nodes {
        id
        title
        handle
        status
        vendor
        productType
        totalInventory
        tracksInventory
        createdAt
        updatedAt
        publishedAt
        variants(first: 20) {
          nodes { id title sku price compareAtPrice inventoryQuantity }
          pageInfo { hasNextPage endCursor }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`, {
    first,
    after: input.pageToken,
    query: input.query,
  });
  return {
    apiVersion: SHOPIFY_API_VERSION,
    shop: getCredentials().shop,
    products: data.products.nodes,
    nextPageToken: data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : undefined,
  };
}

export async function getShopifySalesOverview(input: {
  startDate: string;
  endDate: string;
  includeCancelled?: boolean;
  includeTest?: boolean;
  maxOrders?: number;
}): Promise<any> {
  const searchQuery = buildShopifyOrdersSearchQuery(input);
  const maxOrders = Math.min(Math.max(input.maxOrders ?? 1000, 1), 5000);
  const orders: ShopifyOrder[] = [];
  let cursor: string | undefined;
  let hasNextPage = false;

  do {
    const first = Math.min(250, maxOrders - orders.length);
    const data = await shopifyGraphql<{
      orders: {
        nodes: ShopifyOrder[];
        pageInfo: { hasNextPage: boolean; endCursor?: string };
      };
    }>(`query ShopifySalesOverview($first: Int!, $after: String, $query: String!) {
      orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
        nodes {
          id
          name
          createdAt
          processedAt
          cancelledAt
          test
          displayFinancialStatus
          displayFulfillmentStatus
          currentTotalPriceSet { shopMoney { amount currencyCode } }
          currentSubtotalPriceSet { shopMoney { amount currencyCode } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }`, { first, after: cursor, query: searchQuery });
    orders.push(...data.orders.nodes);
    hasNextPage = data.orders.pageInfo.hasNextPage;
    cursor = data.orders.pageInfo.endCursor;
  } while (hasNextPage && cursor && orders.length < maxOrders);

  return {
    apiVersion: SHOPIFY_API_VERSION,
    shop: getCredentials().shop,
    startDate: input.startDate,
    endDate: input.endDate,
    includeCancelled: input.includeCancelled ?? false,
    includeTest: input.includeTest ?? false,
    scannedOrders: orders.length,
    truncated: hasNextPage,
    nextPageToken: hasNextPage ? cursor : undefined,
    ...summarizeShopifyOrders(orders, input.includeCancelled),
  };
}
