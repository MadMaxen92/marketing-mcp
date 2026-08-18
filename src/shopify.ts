import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

export const SHOPIFY_API_VERSION = '2026-07';
const SHOPIFY_WRITE_CONFIRMATION_TTL_MS = 10 * 60 * 1000;

type ShopifyCredentials = {
  shop: string;
  clientId: string;
  clientSecret: string;
};

type ShopifyProductDescription = {
  id: string;
  title: string;
  handle: string;
  status: string;
  descriptionHtml: string;
  updatedAt: string;
};

type ShopifyProductDescriptionConfirmation = {
  version: 1;
  shop: string;
  productId: string;
  expectedUpdatedAt: string;
  currentDescriptionHash: string;
  proposedDescriptionHash: string;
  confirmationCode: string;
  expiresAt: string;
};

export type ShopifyCollection = {
  id: string;
  title: string;
  handle: string;
  descriptionHtml: string;
  updatedAt: string;
  sortOrder: string;
  templateSuffix?: string | null;
  productsCount: { count: number };
  seo: { title?: string | null; description?: string | null };
  image?: {
    id?: string | null;
    altText?: string | null;
    url: string;
    width?: number | null;
    height?: number | null;
  } | null;
  ruleSet?: {
    appliedDisjunctively: boolean;
    rules: Array<{ column: string; relation: string; condition: string }>;
  } | null;
};

type ShopifyCollectionUpdateInput = {
  title?: string;
  descriptionHtml?: string;
  handle?: string;
  redirectNewHandle?: boolean;
  sortOrder?: string;
  seo?: { title: string; description: string };
};

type ShopifyCollectionUpdateConfirmation = {
  version: 1;
  kind: 'collection_update';
  shop: string;
  collectionId: string;
  expectedUpdatedAt: string;
  currentStateHash: string;
  proposedInputHash: string;
  confirmationCode: string;
  expiresAt: string;
};

type ShopifyCollectionProductsConfirmation = {
  version: 1;
  kind: 'collection_products';
  shop: string;
  collectionId: string;
  expectedUpdatedAt: string;
  action: 'ADD' | 'REMOVE';
  productIdsHash: string;
  confirmationCode: string;
  expiresAt: string;
};

type ShopifyCollectionPublicationConfirmation = {
  version: 1;
  kind: 'collection_publications';
  shop: string;
  collectionId: string;
  expectedUpdatedAt: string;
  action: 'PUBLISH' | 'UNPUBLISH';
  publicationIdsHash: string;
  currentStateHash: string;
  publishDate?: string;
  confirmationCode: string;
  expiresAt: string;
};

type ShopifyPublication = {
  id: string;
  name: string;
  autoPublish: boolean;
  supportsFuturePublishing: boolean;
};

type Money = {
  amount: string;
  currencyCode: string;
};

type MoneyBag = {
  shopMoney: Money;
  presentmentMoney: Money;
};

type ShopifyFulfillment = {
  id: string;
  name: string;
  status: string;
  displayStatus?: string | null;
  createdAt: string;
  inTransitAt?: string | null;
  deliveredAt?: string | null;
  estimatedDeliveryAt?: string | null;
  requiresShipping: boolean;
  trackingInfo: Array<{ company?: string | null }>;
  events: {
    nodes: Array<{
      status: string;
      happenedAt: string;
      estimatedDeliveryAt?: string | null;
    }>;
    pageInfo: { hasNextPage: boolean };
  };
  fulfillmentLineItems: {
    nodes: Array<{
      quantity?: number | null;
      lineItem: { id: string; name: string; sku?: string | null };
    }>;
    pageInfo: { hasNextPage: boolean };
  };
};

export type ShopifyOrderDetail = {
  id: string;
  name: string;
  createdAt: string;
  processedAt?: string | null;
  cancelledAt?: string | null;
  test: boolean;
  displayFinancialStatus?: string | null;
  displayFulfillmentStatus?: string | null;
  shippingAddress?: { country?: string | null; countryCodeV2?: string | null } | null;
  currentSubtotalPriceSet: MoneyBag;
  currentShippingPriceSet: MoneyBag;
  currentTotalTaxSet: MoneyBag;
  currentTotalPriceSet: MoneyBag;
  shippingLines: {
    nodes: Array<{
      title: string;
      code?: string | null;
      currentDiscountedPriceSet: MoneyBag;
    }>;
    pageInfo: { hasNextPage: boolean };
  };
  lineItems: {
    nodes: Array<{
      id: string;
      name: string;
      title: string;
      variantTitle?: string | null;
      sku?: string | null;
      quantity: number;
      currentQuantity: number;
      requiresShipping: boolean;
      originalUnitPriceSet: MoneyBag;
      originalTotalSet: MoneyBag;
      priceAfterAllDiscountsBeforeTaxesSet: MoneyBag;
      totalDiscountSet: MoneyBag;
    }>;
    pageInfo: { hasNextPage: boolean };
  };
  fulfillments: ShopifyFulfillment[];
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

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function signConfirmation(payload: ShopifyProductDescriptionConfirmation): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', config.ADMIN_TOKEN).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifyConfirmation(token: string): ShopifyProductDescriptionConfirmation {
  const [encoded, signature, extra] = token.split('.');
  if (!encoded || !signature || extra) throw new Error('Invalid Shopify confirmation token. Create a new preview.');
  const expected = createHmac('sha256', config.ADMIN_TOKEN).update(encoded).digest();
  let received: Buffer;
  try {
    received = Buffer.from(signature, 'base64url');
  } catch {
    throw new Error('Invalid Shopify confirmation token. Create a new preview.');
  }
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new Error('Invalid Shopify confirmation token. Create a new preview.');
  }

  let payload: ShopifyProductDescriptionConfirmation;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid Shopify confirmation token. Create a new preview.');
  }
  if (
    payload.version !== 1
    || typeof payload.shop !== 'string'
    || typeof payload.productId !== 'string'
    || typeof payload.expectedUpdatedAt !== 'string'
    || !/^[a-f0-9]{64}$/.test(payload.currentDescriptionHash)
    || !/^[a-f0-9]{64}$/.test(payload.proposedDescriptionHash)
    || !/^SHOPIFY-[A-F0-9]{8}$/.test(payload.confirmationCode)
    || typeof payload.expiresAt !== 'string'
    || !Number.isFinite(Date.parse(payload.expiresAt))
  ) {
    throw new Error('Invalid Shopify confirmation token. Create a new preview.');
  }
  if (Date.parse(payload.expiresAt) <= Date.now()) {
    throw new Error('Shopify confirmation expired. Create a new preview.');
  }
  return payload;
}

function signCollectionConfirmation(
  payload: ShopifyCollectionUpdateConfirmation
    | ShopifyCollectionProductsConfirmation
    | ShopifyCollectionPublicationConfirmation,
): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', config.ADMIN_TOKEN).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifyCollectionConfirmation(
  token: string,
): ShopifyCollectionUpdateConfirmation
  | ShopifyCollectionProductsConfirmation
  | ShopifyCollectionPublicationConfirmation {
  const [encoded, signature, extra] = token.split('.');
  if (!encoded || !signature || extra) throw new Error('Invalid Shopify collection confirmation token. Create a new preview.');
  const expected = createHmac('sha256', config.ADMIN_TOKEN).update(encoded).digest();
  let received: Buffer;
  try {
    received = Buffer.from(signature, 'base64url');
  } catch {
    throw new Error('Invalid Shopify collection confirmation token. Create a new preview.');
  }
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new Error('Invalid Shopify collection confirmation token. Create a new preview.');
  }

  let payload: ShopifyCollectionUpdateConfirmation
    | ShopifyCollectionProductsConfirmation
    | ShopifyCollectionPublicationConfirmation;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid Shopify collection confirmation token. Create a new preview.');
  }
  const commonValid = payload.version === 1
    && typeof payload.shop === 'string'
    && typeof payload.collectionId === 'string'
    && typeof payload.expectedUpdatedAt === 'string'
    && /^SHOPIFY-[A-F0-9]{8}$/.test(payload.confirmationCode)
    && typeof payload.expiresAt === 'string'
    && Number.isFinite(Date.parse(payload.expiresAt));
  const kindValid = payload.kind === 'collection_update'
    ? /^[a-f0-9]{64}$/.test(payload.currentStateHash)
      && /^[a-f0-9]{64}$/.test(payload.proposedInputHash)
    : payload.kind === 'collection_products'
      ? (payload.action === 'ADD' || payload.action === 'REMOVE')
        && /^[a-f0-9]{64}$/.test(payload.productIdsHash)
      : payload.kind === 'collection_publications'
        && (payload.action === 'PUBLISH' || payload.action === 'UNPUBLISH')
        && /^[a-f0-9]{64}$/.test(payload.publicationIdsHash)
        && /^[a-f0-9]{64}$/.test(payload.currentStateHash)
        && (payload.publishDate === undefined || Number.isFinite(Date.parse(payload.publishDate)));
  if (!commonValid || !kindValid) {
    throw new Error('Invalid Shopify collection confirmation token. Create a new preview.');
  }
  if (Date.parse(payload.expiresAt) <= Date.now()) {
    throw new Error('Shopify collection confirmation expired. Create a new preview.');
  }
  return payload;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function shopifyDescriptionTextToHtml(descriptionText: string): string {
  const normalized = descriptionText.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return '';
  return normalized
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll('\n', '<br>')}</p>`)
    .join('');
}

async function getShopifyProductDescription(productId: string): Promise<{
  product: ShopifyProductDescription;
  accessScopes: string[];
}> {
  const data = await shopifyGraphql<{
    node?: ShopifyProductDescription | null;
    currentAppInstallation: { accessScopes: Array<{ handle: string }> };
  }>(`query ShopifyProductDescription($id: ID!) {
    node(id: $id) {
      ... on Product {
        id
        title
        handle
        status
        descriptionHtml
        updatedAt
      }
    }
    currentAppInstallation { accessScopes { handle } }
  }`, { id: productId });
  if (!data.node?.id || !data.node.id.startsWith('gid://shopify/Product/')) {
    throw new Error(`Shopify product not found: ${productId}`);
  }
  const accessScopes = data.currentAppInstallation.accessScopes.map(({ handle }) => handle).sort();
  if (!accessScopes.includes('write_products')) {
    throw new Error('Shopify write_products is not granted to the installed app.');
  }
  return { product: data.node, accessScopes };
}

function assertIsoDate(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${label} must be a valid YYYY-MM-DD date.`);
  }
}

function moneyBag(value: MoneyBag): { shopMoney: { amount: number; currencyCode: string }; presentmentMoney: { amount: number; currencyCode: string } } {
  return {
    shopMoney: { amount: Number(value.shopMoney.amount), currencyCode: value.shopMoney.currencyCode },
    presentmentMoney: {
      amount: Number(value.presentmentMoney.amount),
      currencyCode: value.presentmentMoney.currencyCode,
    },
  };
}

function earliest(values: Array<string | null | undefined>): string | undefined {
  return values.filter((value): value is string => !!value).sort()[0];
}

function latest(values: Array<string | null | undefined>): string | undefined {
  return values.filter((value): value is string => !!value).sort().at(-1);
}

function hoursBetween(start: string | undefined, end: string | undefined): number | undefined {
  if (!start || !end) return undefined;
  return Number(((Date.parse(end) - Date.parse(start)) / 3_600_000).toFixed(2));
}

export function summarizeShopifyOrderDetail(order: ShopifyOrderDetail): any {
  const shippingFulfillments = order.fulfillments.filter((fulfillment) =>
    fulfillment.requiresShipping && fulfillment.status !== 'CANCELLED',
  );
  const fulfillmentCreatedAt = earliest(shippingFulfillments.map(({ createdAt }) => createdAt));
  const carrierInTransitAt = earliest(shippingFulfillments.map(({ inTransitAt }) => inTransitAt));
  const firstShippedAt = earliest(
    shippingFulfillments.map(({ createdAt, inTransitAt }) => inTransitAt ?? createdAt),
  );
  const fullyDeliveredAt = shippingFulfillments.length > 0
    && shippingFulfillments.every(({ deliveredAt }) => !!deliveredAt)
    ? latest(shippingFulfillments.map(({ deliveredAt }) => deliveredAt))
    : undefined;

  return {
    id: order.id,
    orderName: order.name,
    orderedAt: order.createdAt,
    processedAt: order.processedAt,
    cancelledAt: order.cancelledAt,
    test: order.test,
    financialStatus: order.displayFinancialStatus,
    fulfillmentStatus: order.displayFulfillmentStatus,
    destination: {
      country: order.shippingAddress?.country,
      countryCode: order.shippingAddress?.countryCodeV2,
    },
    customerCosts: {
      products: moneyBag(order.currentSubtotalPriceSet),
      shipping: moneyBag(order.currentShippingPriceSet),
      tax: moneyBag(order.currentTotalTaxSet),
      total: moneyBag(order.currentTotalPriceSet),
    },
    shippingMethods: order.shippingLines.nodes.map((line) => ({
      title: line.title,
      code: line.code,
      currentPrice: moneyBag(line.currentDiscountedPriceSet),
    })),
    products: order.lineItems.nodes.map((item) => ({
      lineItemId: item.id,
      name: item.name,
      title: item.title,
      variantTitle: item.variantTitle,
      sku: item.sku,
      quantityOrdered: item.quantity,
      currentQuantity: item.currentQuantity,
      requiresShipping: item.requiresShipping,
      originalUnitPrice: moneyBag(item.originalUnitPriceSet),
      originalTotal: moneyBag(item.originalTotalSet),
      productCostAfterAllDiscountsBeforeTax: moneyBag(item.priceAfterAllDiscountsBeforeTaxesSet),
      lineDiscount: moneyBag(item.totalDiscountSet),
    })),
    deliveryTimeline: {
      fulfillmentCreatedAt,
      carrierInTransitAt,
      firstShippedAt,
      fullyDeliveredAt,
      orderToFulfillmentHours: hoursBetween(order.createdAt, fulfillmentCreatedAt),
      orderToFirstShipmentHours: hoursBetween(order.createdAt, firstShippedAt),
      firstShipmentToFullDeliveryHours: hoursBetween(firstShippedAt, fullyDeliveredAt),
      orderToFullDeliveryHours: hoursBetween(order.createdAt, fullyDeliveredAt),
      complete: !!fullyDeliveredAt,
    },
    fulfillments: order.fulfillments.map((fulfillment) => ({
      id: fulfillment.id,
      name: fulfillment.name,
      status: fulfillment.status,
      displayStatus: fulfillment.displayStatus,
      createdAt: fulfillment.createdAt,
      inTransitAt: fulfillment.inTransitAt,
      deliveredAt: fulfillment.deliveredAt,
      estimatedDeliveryAt: fulfillment.estimatedDeliveryAt,
      requiresShipping: fulfillment.requiresShipping,
      carrierCompanies: [...new Set(fulfillment.trackingInfo.map(({ company }) => company).filter(Boolean))],
      lineItems: fulfillment.fulfillmentLineItems.nodes.map(({ quantity, lineItem }) => ({
        lineItemId: lineItem.id,
        name: lineItem.name,
        sku: lineItem.sku,
        quantity,
      })),
      events: fulfillment.events.nodes,
      eventsTruncated: fulfillment.events.pageInfo.hasNextPage,
      lineItemsTruncated: fulfillment.fulfillmentLineItems.pageInfo.hasNextPage,
    })),
    dataCompleteness: {
      lineItemsTruncated: order.lineItems.pageInfo.hasNextPage,
      shippingLinesTruncated: order.shippingLines.pageInfo.hasNextPage,
    },
  };
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

function collectionState(collection: ShopifyCollection): Record<string, unknown> {
  return {
    title: collection.title,
    descriptionHtml: collection.descriptionHtml,
    handle: collection.handle,
    sortOrder: collection.sortOrder,
    seo: {
      title: collection.seo.title ?? '',
      description: collection.seo.description ?? '',
    },
  };
}

async function getShopifyCollectionForWrite(collectionId: string): Promise<{
  collection: ShopifyCollection;
  accessScopes: string[];
}> {
  const data = await shopifyGraphql<{
    node?: ShopifyCollection | null;
    currentAppInstallation: { accessScopes: Array<{ handle: string }> };
  }>(`query ShopifyCollectionForWrite($id: ID!) {
    node(id: $id) {
      ... on Collection {
        id
        title
        handle
        descriptionHtml
        updatedAt
        sortOrder
        templateSuffix
        productsCount { count }
        seo { title description }
        image { id altText url width height }
        ruleSet {
          appliedDisjunctively
          rules { column relation condition }
        }
      }
    }
    currentAppInstallation { accessScopes { handle } }
  }`, { id: collectionId });
  if (!data.node?.id || !data.node.id.startsWith('gid://shopify/Collection/')) {
    throw new Error(`Shopify collection not found: ${collectionId}`);
  }
  const accessScopes = data.currentAppInstallation.accessScopes.map(({ handle }) => handle).sort();
  if (!accessScopes.includes('write_products')) {
    throw new Error('Shopify write_products is not granted to the installed app.');
  }
  return { collection: data.node, accessScopes };
}

export async function listShopifyCollections(input: {
  query?: string;
  limit?: number;
  pageToken?: string;
}): Promise<any> {
  const first = Math.min(Math.max(input.limit ?? 100, 1), 250);
  const data = await shopifyGraphql<{
    collections: {
      nodes: ShopifyCollection[];
      pageInfo: { hasNextPage: boolean; endCursor?: string };
    };
  }>(`query ShopifyCollections($first: Int!, $after: String, $query: String) {
    collections(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) {
      nodes {
        id
        title
        handle
        descriptionHtml
        updatedAt
        sortOrder
        templateSuffix
        productsCount { count }
        seo { title description }
        image { id altText url width height }
        ruleSet {
          appliedDisjunctively
          rules { column relation condition }
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
    collections: data.collections.nodes.map((collection) => ({
      ...collection,
      collectionType: collection.ruleSet ? 'AUTOMATED' : 'MANUAL',
    })),
    nextPageToken: data.collections.pageInfo.hasNextPage ? data.collections.pageInfo.endCursor : undefined,
  };
}

export async function listShopifyPublications(input: {
  limit?: number;
  pageToken?: string;
}): Promise<any> {
  const first = Math.min(Math.max(input.limit ?? 100, 1), 250);
  const data = await shopifyGraphql<{
    publications: {
      nodes: ShopifyPublication[];
      pageInfo: { hasNextPage: boolean; endCursor?: string };
    };
  }>(`query ShopifyPublications($first: Int!, $after: String) {
    publications(first: $first, after: $after) {
      nodes { id name autoPublish supportsFuturePublishing }
      pageInfo { hasNextPage endCursor }
    }
  }`, { first, after: input.pageToken });
  return {
    apiVersion: SHOPIFY_API_VERSION,
    shop: getCredentials().shop,
    publications: data.publications.nodes,
    nextPageToken: data.publications.pageInfo.hasNextPage
      ? data.publications.pageInfo.endCursor
      : undefined,
  };
}

async function getShopifyCollectionPublicationState(collectionId: string): Promise<{
  collection: { id: string; title: string; handle: string; updatedAt: string };
  resourcePublications: Array<{
    isPublished: boolean;
    publishDate?: string | null;
    publication: ShopifyPublication;
  }>;
  accessScopes: string[];
}> {
  const data = await shopifyGraphql<{
    node?: {
      id: string;
      title: string;
      handle: string;
      updatedAt: string;
      resourcePublicationsV2: {
        nodes: Array<{
          isPublished: boolean;
          publishDate?: string | null;
          publication: ShopifyPublication;
        }>;
        pageInfo: { hasNextPage: boolean };
      };
    } | null;
    currentAppInstallation: { accessScopes: Array<{ handle: string }> };
  }>(`query ShopifyCollectionPublicationState($id: ID!) {
    node(id: $id) {
      ... on Collection {
        id title handle updatedAt
        resourcePublicationsV2(first: 100, onlyPublished: false) {
          nodes {
            isPublished
            publishDate
            publication { id name autoPublish supportsFuturePublishing }
          }
          pageInfo { hasNextPage }
        }
      }
    }
    currentAppInstallation { accessScopes { handle } }
  }`, { id: collectionId });
  if (!data.node?.id?.startsWith('gid://shopify/Collection/')) {
    throw new Error(`Shopify collection not found: ${collectionId}`);
  }
  if (data.node.resourcePublicationsV2.pageInfo.hasNextPage) {
    throw new Error('Shopify returned more than 100 publication states for this collection. Narrow the integration before writing.');
  }
  return {
    collection: data.node,
    resourcePublications: data.node.resourcePublicationsV2.nodes,
    accessScopes: data.currentAppInstallation.accessScopes.map(({ handle }) => handle).sort(),
  };
}

export async function getShopifyCollectionPublicationStatus(input: {
  collectionId: string;
}): Promise<any> {
  const state = await getShopifyCollectionPublicationState(input.collectionId);
  return {
    apiVersion: SHOPIFY_API_VERSION,
    shop: getCredentials().shop,
    collection: state.collection,
    publications: state.resourcePublications,
    accessScopes: state.accessScopes.filter((scope) => scope.includes('publication')),
  };
}

async function getShopifyPublicationsByIds(publicationIds: string[]): Promise<ShopifyPublication[]> {
  const data = await shopifyGraphql<{ nodes: Array<ShopifyPublication | null> }>(`query ShopifyPublicationsByIds($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Publication { id name autoPublish supportsFuturePublishing }
    }
  }`, { ids: publicationIds });
  const publications = data.nodes.filter(
    (node): node is ShopifyPublication => !!node?.id?.startsWith('gid://shopify/Publication/'),
  );
  if (publications.length !== publicationIds.length) {
    const found = new Set(publications.map(({ id }) => id));
    throw new Error(`Shopify publications not found: ${publicationIds.filter((id) => !found.has(id)).join(', ')}`);
  }
  return publications;
}

function selectedPublicationState(
  publicationIds: string[],
  resourcePublications: Array<{
    isPublished: boolean;
    publishDate?: string | null;
    publication: ShopifyPublication;
  }>,
): Array<{ publicationId: string; isPublished: boolean; publishDate?: string | null }> {
  const byId = new Map(resourcePublications.map((item) => [item.publication.id, item]));
  return publicationIds.map((publicationId) => ({
    publicationId,
    isPublished: byId.get(publicationId)?.isPublished ?? false,
    publishDate: byId.get(publicationId)?.publishDate,
  }));
}

export async function previewShopifyCollectionPublicationUpdate(input: {
  collectionId: string;
  action: 'PUBLISH' | 'UNPUBLISH';
  publicationIds: string[];
  publishDate?: string;
}): Promise<any> {
  if (input.action === 'UNPUBLISH' && input.publishDate !== undefined) {
    throw new Error('publishDate can only be used with the PUBLISH action.');
  }
  const publicationIds = [...new Set(input.publicationIds)].sort();
  const publishDate = input.publishDate === undefined ? undefined : new Date(input.publishDate).toISOString();
  const state = await getShopifyCollectionPublicationState(input.collectionId);
  if (!state.accessScopes.includes('write_publications')) {
    throw new Error('Shopify write_publications is not granted to the installed app.');
  }
  const publications = await getShopifyPublicationsByIds(publicationIds);
  if (publishDate && Date.parse(publishDate) > Date.now()) {
    const unsupported = publications.filter(({ supportsFuturePublishing }) => !supportsFuturePublishing);
    if (unsupported.length) {
      throw new Error(`Scheduled publishing is not supported by: ${unsupported.map(({ name }) => name).join(', ')}`);
    }
  }
  const currentState = selectedPublicationState(publicationIds, state.resourcePublications);
  const confirmationCode = `SHOPIFY-${randomBytes(4).toString('hex').toUpperCase()}`;
  const expiresAt = new Date(Date.now() + SHOPIFY_WRITE_CONFIRMATION_TTL_MS).toISOString();
  const confirmation: ShopifyCollectionPublicationConfirmation = {
    version: 1,
    kind: 'collection_publications',
    shop: getCredentials().shop,
    collectionId: input.collectionId,
    expectedUpdatedAt: state.collection.updatedAt,
    action: input.action,
    publicationIdsHash: sha256(JSON.stringify(publicationIds)),
    currentStateHash: sha256(JSON.stringify(currentState)),
    publishDate,
    confirmationCode,
    expiresAt,
  };
  return {
    dryRun: true,
    apiVersion: SHOPIFY_API_VERSION,
    shop: getCredentials().shop,
    collection: state.collection,
    change: { action: input.action, publishDate, publications, currentState },
    safety: {
      accessScopes: state.accessScopes.filter((scope) => scope.includes('publication')),
      confirmationCode,
      expiresAt,
      instruction: `Show this preview to the user. Apply it only after the user explicitly replies with ${confirmationCode}.`,
    },
    confirmationToken: signCollectionConfirmation(confirmation),
  };
}

export async function applyShopifyCollectionPublicationUpdate(input: {
  collectionId: string;
  action: 'PUBLISH' | 'UNPUBLISH';
  publicationIds: string[];
  publishDate?: string;
  confirmationCode: string;
  confirmationToken: string;
}): Promise<any> {
  const confirmation = verifyCollectionConfirmation(input.confirmationToken);
  if (confirmation.kind !== 'collection_publications') {
    throw new Error('This Shopify confirmation is not for a collection publication update. Create a new preview.');
  }
  if (input.action === 'UNPUBLISH' && input.publishDate !== undefined) {
    throw new Error('publishDate can only be used with the PUBLISH action.');
  }
  const publicationIds = [...new Set(input.publicationIds)].sort();
  const publishDate = input.publishDate === undefined ? undefined : new Date(input.publishDate).toISOString();
  const state = await getShopifyCollectionPublicationState(input.collectionId);
  const currentState = selectedPublicationState(publicationIds, state.resourcePublications);
  const { shop } = getCredentials();
  if (
    confirmation.shop !== shop
    || confirmation.collectionId !== input.collectionId
    || confirmation.confirmationCode !== input.confirmationCode
    || confirmation.action !== input.action
    || confirmation.publicationIdsHash !== sha256(JSON.stringify(publicationIds))
    || confirmation.publishDate !== publishDate
  ) {
    throw new Error('Shopify confirmation does not match this collection publication update. Create a new preview.');
  }
  if (confirmation.currentStateHash !== sha256(JSON.stringify(currentState))) {
    throw new Error('The Shopify collection publication state changed after the preview. Review it and create a new preview.');
  }

  const publicationInput = publicationIds.map((publicationId) => ({ publicationId, publishDate }));
  const mutationName = input.action === 'PUBLISH' ? 'publishablePublish' : 'publishableUnpublish';
  const mutation = input.action === 'PUBLISH'
    ? `mutation ShopifyCollectionPublish($id: ID!, $input: [PublicationInput!]!) {
        publishablePublish(id: $id, input: $input) {
          publishable { resourcePublicationsV2(first: 100, onlyPublished: false) { nodes { isPublished publishDate publication { id name } } } }
          userErrors { field message }
        }
      }`
    : `mutation ShopifyCollectionUnpublish($id: ID!, $input: [PublicationInput!]!) {
        publishableUnpublish(id: $id, input: $input) {
          publishable { resourcePublicationsV2(first: 100, onlyPublished: false) { nodes { isPublished publishDate publication { id name } } } }
          userErrors { field message }
        }
      }`;
  const data = await shopifyGraphql<Record<string, {
    publishable?: any;
    userErrors: Array<{ field?: string[] | null; message: string }>;
  }>>(mutation, { id: input.collectionId, input: publicationInput });
  const result = data[mutationName];
  if (!result) throw new Error(`Shopify did not return ${mutationName}.`);
  if (result.userErrors.length) {
    throw new Error(`Shopify rejected the collection publication update: ${JSON.stringify(result.userErrors)}`);
  }
  console.info(JSON.stringify({
    event: 'shopify_collection_publications_updated',
    shop,
    collectionId: input.collectionId,
    action: input.action,
    publicationIds,
    publishDate,
  }));
  return {
    applied: true,
    apiVersion: SHOPIFY_API_VERSION,
    shop,
    collectionId: input.collectionId,
    action: input.action,
    publicationIds,
    publishDate,
    publicationState: result.publishable?.resourcePublicationsV2?.nodes ?? [],
  };
}

export async function listShopifyMetaobjectDefinitions(input: {
  limit?: number;
  pageToken?: string;
}): Promise<any> {
  const first = Math.min(Math.max(input.limit ?? 100, 1), 250);
  const data = await shopifyGraphql<{
    metaobjectDefinitions: {
      nodes: any[];
      pageInfo: { hasNextPage: boolean; endCursor?: string };
    };
  }>(`query ShopifyMetaobjectDefinitions($first: Int!, $after: String) {
    metaobjectDefinitions(first: $first, after: $after) {
      nodes {
        id name type description displayNameKey
        fieldDefinitions {
          key name description required
          type { name }
          validations { name value }
        }
        access { admin storefront }
        capabilities { publishable { enabled } translatable { enabled } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`, { first, after: input.pageToken });
  return {
    apiVersion: SHOPIFY_API_VERSION,
    shop: getCredentials().shop,
    definitions: data.metaobjectDefinitions.nodes,
    nextPageToken: data.metaobjectDefinitions.pageInfo.hasNextPage
      ? data.metaobjectDefinitions.pageInfo.endCursor
      : undefined,
  };
}

export async function listShopifyMetaobjects(input: {
  type: string;
  query?: string;
  limit?: number;
  pageToken?: string;
}): Promise<any> {
  const first = Math.min(Math.max(input.limit ?? 100, 1), 250);
  const data = await shopifyGraphql<{
    metaobjects: {
      nodes: any[];
      pageInfo: { hasNextPage: boolean; endCursor?: string };
    };
  }>(`query ShopifyMetaobjects($type: String!, $first: Int!, $after: String, $query: String) {
    metaobjects(type: $type, first: $first, after: $after, query: $query, sortKey: "updated_at", reverse: true) {
      nodes {
        id type handle displayName updatedAt
        fields { key type value }
        capabilities { publishable { status } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`, { type: input.type, first, after: input.pageToken, query: input.query });
  return {
    apiVersion: SHOPIFY_API_VERSION,
    shop: getCredentials().shop,
    type: input.type,
    metaobjects: data.metaobjects.nodes,
    nextPageToken: data.metaobjects.pageInfo.hasNextPage
      ? data.metaobjects.pageInfo.endCursor
      : undefined,
  };
}

export async function getShopifyMetaobject(input: { metaobjectId: string }): Promise<any> {
  const data = await shopifyGraphql<{ node?: any | null }>(`query ShopifyMetaobject($id: ID!) {
    node(id: $id) {
      ... on Metaobject {
        id type handle displayName updatedAt
        fields { key type value }
        capabilities { publishable { status } }
      }
    }
  }`, { id: input.metaobjectId });
  if (!data.node?.id?.startsWith('gid://shopify/Metaobject/')) {
    throw new Error(`Shopify metaobject not found: ${input.metaobjectId}`);
  }
  return {
    apiVersion: SHOPIFY_API_VERSION,
    shop: getCredentials().shop,
    metaobject: data.node,
  };
}

export async function getShopifyCollection(input: {
  collectionId: string;
  productLimit?: number;
  productPageToken?: string;
}): Promise<any> {
  const first = Math.min(Math.max(input.productLimit ?? 100, 1), 250);
  const data = await shopifyGraphql<{
    node?: (ShopifyCollection & {
      products: {
        nodes: any[];
        pageInfo: { hasNextPage: boolean; endCursor?: string };
      };
    }) | null;
  }>(`query ShopifyCollection($id: ID!, $first: Int!, $after: String) {
    node(id: $id) {
      ... on Collection {
        id
        title
        handle
        descriptionHtml
        updatedAt
        sortOrder
        templateSuffix
        productsCount { count }
        seo { title description }
        image { id altText url width height }
        ruleSet {
          appliedDisjunctively
          rules { column relation condition }
        }
        products(first: $first, after: $after) {
          nodes { id title handle status vendor productType totalInventory updatedAt }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }`, {
    id: input.collectionId,
    first,
    after: input.productPageToken,
  });
  if (!data.node?.id || !data.node.id.startsWith('gid://shopify/Collection/')) {
    throw new Error(`Shopify collection not found: ${input.collectionId}`);
  }
  return {
    apiVersion: SHOPIFY_API_VERSION,
    shop: getCredentials().shop,
    collection: {
      ...data.node,
      collectionType: data.node.ruleSet ? 'AUTOMATED' : 'MANUAL',
      products: data.node.products.nodes,
      nextProductPageToken: data.node.products.pageInfo.hasNextPage
        ? data.node.products.pageInfo.endCursor
        : undefined,
    },
  };
}

function buildCollectionUpdateInput(input: {
  title?: string;
  descriptionText?: string;
  handle?: string;
  sortOrder?: string;
  seoTitle?: string;
  seoDescription?: string;
}, current: ShopifyCollection): ShopifyCollectionUpdateInput {
  const update: ShopifyCollectionUpdateInput = {};
  if (input.title !== undefined) update.title = input.title.trim();
  if (input.descriptionText !== undefined) {
    update.descriptionHtml = shopifyDescriptionTextToHtml(input.descriptionText);
  }
  if (input.handle !== undefined) {
    update.handle = input.handle.trim();
    update.redirectNewHandle = true;
  }
  if (input.sortOrder !== undefined) update.sortOrder = input.sortOrder;
  if (input.seoTitle !== undefined || input.seoDescription !== undefined) {
    update.seo = {
      title: input.seoTitle ?? current.seo.title ?? '',
      description: input.seoDescription ?? current.seo.description ?? '',
    };
  }
  if (!Object.keys(update).length) throw new Error('Specify at least one Shopify collection field to update.');
  return update;
}

export async function previewShopifyCollectionUpdate(input: {
  collectionId: string;
  title?: string;
  descriptionText?: string;
  handle?: string;
  sortOrder?: string;
  seoTitle?: string;
  seoDescription?: string;
}): Promise<any> {
  const { collection, accessScopes } = await getShopifyCollectionForWrite(input.collectionId);
  const proposedInput = buildCollectionUpdateInput(input, collection);
  const confirmationCode = `SHOPIFY-${randomBytes(4).toString('hex').toUpperCase()}`;
  const expiresAt = new Date(Date.now() + SHOPIFY_WRITE_CONFIRMATION_TTL_MS).toISOString();
  const confirmation: ShopifyCollectionUpdateConfirmation = {
    version: 1,
    kind: 'collection_update',
    shop: getCredentials().shop,
    collectionId: collection.id,
    expectedUpdatedAt: collection.updatedAt,
    currentStateHash: sha256(JSON.stringify(collectionState(collection))),
    proposedInputHash: sha256(JSON.stringify(proposedInput)),
    confirmationCode,
    expiresAt,
  };
  return {
    dryRun: true,
    apiVersion: SHOPIFY_API_VERSION,
    shop: getCredentials().shop,
    collection: {
      id: collection.id,
      title: collection.title,
      handle: collection.handle,
      collectionType: collection.ruleSet ? 'AUTOMATED' : 'MANUAL',
      updatedAt: collection.updatedAt,
    },
    change: {
      current: collectionState(collection),
      proposedFields: proposedInput,
    },
    safety: {
      accessScopes,
      touchesOnly: Object.keys(proposedInput),
      confirmationCode,
      expiresAt,
      instruction: `Show this preview to the user. Apply it only after the user explicitly replies with ${confirmationCode}.`,
    },
    confirmationToken: signCollectionConfirmation(confirmation),
  };
}

export async function applyShopifyCollectionUpdate(input: {
  collectionId: string;
  title?: string;
  descriptionText?: string;
  handle?: string;
  sortOrder?: string;
  seoTitle?: string;
  seoDescription?: string;
  confirmationCode: string;
  confirmationToken: string;
}): Promise<any> {
  const confirmation = verifyCollectionConfirmation(input.confirmationToken);
  if (confirmation.kind !== 'collection_update') {
    throw new Error('This Shopify confirmation is not for a collection metadata update. Create a new preview.');
  }
  const { collection } = await getShopifyCollectionForWrite(input.collectionId);
  const proposedInput = buildCollectionUpdateInput(input, collection);
  const { shop } = getCredentials();
  if (
    confirmation.shop !== shop
    || confirmation.collectionId !== input.collectionId
    || confirmation.confirmationCode !== input.confirmationCode
    || confirmation.proposedInputHash !== sha256(JSON.stringify(proposedInput))
  ) {
    throw new Error('Shopify confirmation does not match this collection update. Create a new preview.');
  }
  if (
    collection.updatedAt !== confirmation.expectedUpdatedAt
    || sha256(JSON.stringify(collectionState(collection))) !== confirmation.currentStateHash
  ) {
    throw new Error('The Shopify collection changed after the preview. Review it and create a new preview.');
  }

  const data = await shopifyGraphql<{
    collectionUpdate: {
      collection?: ShopifyCollection | null;
      userErrors: Array<{ field?: string[] | null; message: string }>;
    };
  }>(`mutation ShopifyCollectionUpdate($collection: CollectionUpdateInput!) {
    collectionUpdate(collection: $collection) {
      collection {
        id title handle descriptionHtml updatedAt sortOrder templateSuffix
        productsCount { count }
        seo { title description }
        image { id altText url width height }
        ruleSet { appliedDisjunctively rules { column relation condition } }
      }
      userErrors { field message }
    }
  }`, { collection: { id: input.collectionId, ...proposedInput } });
  if (data.collectionUpdate.userErrors.length) {
    throw new Error(`Shopify rejected the collection update: ${JSON.stringify(data.collectionUpdate.userErrors)}`);
  }
  if (!data.collectionUpdate.collection) throw new Error('Shopify did not return the updated collection.');

  console.info(JSON.stringify({
    event: 'shopify_collection_updated',
    shop,
    collectionId: input.collectionId,
    changedFields: Object.keys(proposedInput),
    updatedAt: data.collectionUpdate.collection.updatedAt,
  }));
  return {
    applied: true,
    apiVersion: SHOPIFY_API_VERSION,
    shop,
    changedFields: Object.keys(proposedInput),
    collection: data.collectionUpdate.collection,
    recoverySnapshot: collectionState(collection),
  };
}

async function getShopifyProductsByIds(productIds: string[]): Promise<any[]> {
  const data = await shopifyGraphql<{ nodes: Array<any | null> }>(`query ShopifyProductsByIds($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product { id title handle status updatedAt }
    }
  }`, { ids: productIds });
  const products = data.nodes.filter((node): node is any => !!node?.id?.startsWith('gid://shopify/Product/'));
  if (products.length !== productIds.length) {
    const found = new Set(products.map(({ id }) => id));
    throw new Error(`Shopify products not found: ${productIds.filter((id) => !found.has(id)).join(', ')}`);
  }
  return products;
}

export async function previewShopifyCollectionProductsUpdate(input: {
  collectionId: string;
  action: 'ADD' | 'REMOVE';
  productIds: string[];
}): Promise<any> {
  const productIds = [...new Set(input.productIds)].sort();
  const { collection, accessScopes } = await getShopifyCollectionForWrite(input.collectionId);
  if (collection.ruleSet) {
    throw new Error('Products in an automated Shopify collection are controlled by its rules and cannot be added or removed manually.');
  }
  const products = await getShopifyProductsByIds(productIds);
  const confirmationCode = `SHOPIFY-${randomBytes(4).toString('hex').toUpperCase()}`;
  const expiresAt = new Date(Date.now() + SHOPIFY_WRITE_CONFIRMATION_TTL_MS).toISOString();
  const confirmation: ShopifyCollectionProductsConfirmation = {
    version: 1,
    kind: 'collection_products',
    shop: getCredentials().shop,
    collectionId: collection.id,
    expectedUpdatedAt: collection.updatedAt,
    action: input.action,
    productIdsHash: sha256(JSON.stringify(productIds)),
    confirmationCode,
    expiresAt,
  };
  return {
    dryRun: true,
    apiVersion: SHOPIFY_API_VERSION,
    shop: getCredentials().shop,
    collection: {
      id: collection.id,
      title: collection.title,
      handle: collection.handle,
      productCount: collection.productsCount.count,
      updatedAt: collection.updatedAt,
    },
    change: { action: input.action, products },
    safety: {
      accessScopes,
      confirmationCode,
      expiresAt,
      instruction: `Show this preview to the user. Apply it only after the user explicitly replies with ${confirmationCode}.`,
    },
    confirmationToken: signCollectionConfirmation(confirmation),
  };
}

export async function applyShopifyCollectionProductsUpdate(input: {
  collectionId: string;
  action: 'ADD' | 'REMOVE';
  productIds: string[];
  confirmationCode: string;
  confirmationToken: string;
}): Promise<any> {
  const confirmation = verifyCollectionConfirmation(input.confirmationToken);
  if (confirmation.kind !== 'collection_products') {
    throw new Error('This Shopify confirmation is not for a collection product update. Create a new preview.');
  }
  const productIds = [...new Set(input.productIds)].sort();
  const { collection } = await getShopifyCollectionForWrite(input.collectionId);
  const { shop } = getCredentials();
  if (collection.ruleSet) {
    throw new Error('Products in an automated Shopify collection are controlled by its rules and cannot be added or removed manually.');
  }
  if (
    confirmation.shop !== shop
    || confirmation.collectionId !== input.collectionId
    || confirmation.confirmationCode !== input.confirmationCode
    || confirmation.action !== input.action
    || confirmation.productIdsHash !== sha256(JSON.stringify(productIds))
  ) {
    throw new Error('Shopify confirmation does not match this collection product update. Create a new preview.');
  }
  if (collection.updatedAt !== confirmation.expectedUpdatedAt) {
    throw new Error('The Shopify collection changed after the preview. Review it and create a new preview.');
  }

  const adding = input.action === 'ADD';
  let mutationResult: {
    collection?: { id: string; title: string; updatedAt: string; productsCount: { count: number } } | null;
    job?: { id: string; done: boolean } | null;
    userErrors: Array<{ field?: string[] | null; message: string }>;
  };
  if (adding) {
    const data = await shopifyGraphql<{
      collectionAddProducts: {
        collection?: { id: string; title: string; updatedAt: string; productsCount: { count: number } } | null;
        userErrors: Array<{ field?: string[] | null; message: string }>;
      };
    }>(`mutation ShopifyCollectionAddProducts($id: ID!, $productIds: [ID!]!) {
      collectionAddProducts(id: $id, productIds: $productIds) {
        collection { id title updatedAt productsCount { count } }
        userErrors { field message }
      }
    }`, { id: input.collectionId, productIds });
    mutationResult = data.collectionAddProducts;
  } else {
    const data = await shopifyGraphql<{
      collectionRemoveProducts: {
        job?: { id: string; done: boolean } | null;
        userErrors: Array<{ field?: string[] | null; message: string }>;
      };
    }>(`mutation ShopifyCollectionRemoveProducts($id: ID!, $productIds: [ID!]!) {
      collectionRemoveProducts(id: $id, productIds: $productIds) {
        job { id done }
        userErrors { field message }
      }
    }`, { id: input.collectionId, productIds });
    mutationResult = data.collectionRemoveProducts;
  }
  if (mutationResult.userErrors.length) {
    throw new Error(`Shopify rejected the collection product update: ${JSON.stringify(mutationResult.userErrors)}`);
  }

  console.info(JSON.stringify({
    event: 'shopify_collection_products_updated',
    shop,
    collectionId: input.collectionId,
    action: input.action,
    productIds,
  }));
  return {
    applied: true,
    apiVersion: SHOPIFY_API_VERSION,
    shop,
    collectionId: input.collectionId,
    action: input.action,
    productIds,
    result: mutationResult,
  };
}

export async function previewShopifyProductDescriptionUpdate(input: {
  productId: string;
  descriptionText: string;
}): Promise<any> {
  const { product, accessScopes } = await getShopifyProductDescription(input.productId);
  const proposedDescriptionHtml = shopifyDescriptionTextToHtml(input.descriptionText);
  const confirmationCode = `SHOPIFY-${randomBytes(4).toString('hex').toUpperCase()}`;
  const expiresAt = new Date(Date.now() + SHOPIFY_WRITE_CONFIRMATION_TTL_MS).toISOString();
  const confirmation: ShopifyProductDescriptionConfirmation = {
    version: 1,
    shop: getCredentials().shop,
    productId: product.id,
    expectedUpdatedAt: product.updatedAt,
    currentDescriptionHash: sha256(product.descriptionHtml),
    proposedDescriptionHash: sha256(proposedDescriptionHtml),
    confirmationCode,
    expiresAt,
  };

  return {
    dryRun: true,
    apiVersion: SHOPIFY_API_VERSION,
    shop: getCredentials().shop,
    product: {
      id: product.id,
      title: product.title,
      handle: product.handle,
      status: product.status,
      updatedAt: product.updatedAt,
    },
    change: {
      field: 'descriptionHtml',
      currentDescriptionHtml: product.descriptionHtml,
      proposedDescriptionHtml,
      currentCharacterCount: product.descriptionHtml.length,
      proposedCharacterCount: proposedDescriptionHtml.length,
    },
    safety: {
      accessScopes,
      touchesOnly: ['descriptionHtml'],
      confirmationCode,
      expiresAt,
      instruction: `Show this preview to the user. Apply it only after the user explicitly replies with ${confirmationCode}.`,
    },
    confirmationToken: signConfirmation(confirmation),
  };
}

export async function applyShopifyProductDescriptionUpdate(input: {
  productId: string;
  descriptionText: string;
  confirmationCode: string;
  confirmationToken: string;
}): Promise<any> {
  const confirmation = verifyConfirmation(input.confirmationToken);
  const proposedDescriptionHtml = shopifyDescriptionTextToHtml(input.descriptionText);
  const { shop } = getCredentials();
  if (
    confirmation.shop !== shop
    || confirmation.productId !== input.productId
    || confirmation.confirmationCode !== input.confirmationCode
    || confirmation.proposedDescriptionHash !== sha256(proposedDescriptionHtml)
  ) {
    throw new Error('Shopify confirmation does not match this product and description. Create a new preview.');
  }

  const { product } = await getShopifyProductDescription(input.productId);
  if (
    product.updatedAt !== confirmation.expectedUpdatedAt
    || sha256(product.descriptionHtml) !== confirmation.currentDescriptionHash
  ) {
    throw new Error('The Shopify product changed after the preview. Review the latest product and create a new preview.');
  }

  const data = await shopifyGraphql<{
    productUpdate: {
      product?: ShopifyProductDescription | null;
      userErrors: Array<{ field?: string[] | null; message: string }>;
    };
  }>(`mutation ShopifyProductDescriptionUpdate($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product { id title handle status descriptionHtml updatedAt }
      userErrors { field message }
    }
  }`, {
    product: {
      id: input.productId,
      descriptionHtml: proposedDescriptionHtml,
    },
  });
  if (data.productUpdate.userErrors.length) {
    throw new Error(`Shopify rejected the product update: ${JSON.stringify(data.productUpdate.userErrors)}`);
  }
  if (!data.productUpdate.product) throw new Error('Shopify did not return the updated product.');

  console.info(JSON.stringify({
    event: 'shopify_product_description_updated',
    shop,
    productId: input.productId,
    previousDescriptionHash: confirmation.currentDescriptionHash,
    newDescriptionHash: confirmation.proposedDescriptionHash,
    updatedAt: data.productUpdate.product.updatedAt,
  }));

  return {
    applied: true,
    apiVersion: SHOPIFY_API_VERSION,
    shop,
    product: data.productUpdate.product,
    changedFields: ['descriptionHtml'],
    recoverySnapshot: {
      previousDescriptionHtml: product.descriptionHtml,
      instruction: 'Keep this snapshot for reference. Rich HTML must be restored manually in Shopify Admin; the guarded write tool accepts plain text only.',
    },
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

export async function listShopifyOrderDeliveryDetails(input: {
  startDate: string;
  endDate: string;
  includeCancelled?: boolean;
  includeTest?: boolean;
  limit?: number;
  pageToken?: string;
}): Promise<any> {
  const searchQuery = buildShopifyOrdersSearchQuery(input);
  const first = Math.min(Math.max(input.limit ?? 50, 1), 250);
  const data = await shopifyGraphql<{
    orders: {
      nodes: ShopifyOrderDetail[];
      pageInfo: { hasNextPage: boolean; endCursor?: string };
    };
  }>(`query ShopifyOrderDeliveryDetails($first: Int!, $after: String, $query: String!) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
      nodes {
        id
        name
        createdAt
        processedAt
        cancelledAt
        test
        displayFinancialStatus
        displayFulfillmentStatus
        shippingAddress { country countryCodeV2 }
        currentSubtotalPriceSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
        currentShippingPriceSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
        currentTotalTaxSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
        currentTotalPriceSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
        shippingLines(first: 20) {
          nodes {
            title
            code
            currentDiscountedPriceSet {
              shopMoney { amount currencyCode }
              presentmentMoney { amount currencyCode }
            }
          }
          pageInfo { hasNextPage }
        }
        lineItems(first: 100) {
          nodes {
            id
            name
            title
            variantTitle
            sku
            quantity
            currentQuantity
            requiresShipping
            originalUnitPriceSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
            originalTotalSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
            priceAfterAllDiscountsBeforeTaxesSet {
              shopMoney { amount currencyCode }
              presentmentMoney { amount currencyCode }
            }
            totalDiscountSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
          }
          pageInfo { hasNextPage }
        }
        fulfillments {
          id
          name
          status
          displayStatus
          createdAt
          inTransitAt
          deliveredAt
          estimatedDeliveryAt
          requiresShipping
          trackingInfo(first: 10) { company }
          events(first: 50, sortKey: HAPPENED_AT) {
            nodes { status happenedAt estimatedDeliveryAt }
            pageInfo { hasNextPage }
          }
          fulfillmentLineItems(first: 100) {
            nodes { quantity lineItem { id name sku } }
            pageInfo { hasNextPage }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`, { first, after: input.pageToken, query: searchQuery });

  const includedOrders = data.orders.nodes.filter((order) => input.includeCancelled || !order.cancelledAt);
  return {
    apiVersion: SHOPIFY_API_VERSION,
    shop: getCredentials().shop,
    startDate: input.startDate,
    endDate: input.endDate,
    includeCancelled: input.includeCancelled ?? false,
    includeTest: input.includeTest ?? false,
    returnedOrders: includedOrders.length,
    excludedCancelledOrders: data.orders.nodes.length - includedOrders.length,
    nextPageToken: data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : undefined,
    orders: includedOrders.map(summarizeShopifyOrderDetail),
  };
}
