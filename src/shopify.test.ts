import assert from 'node:assert/strict';
import test from 'node:test';

Object.assign(process.env, {
  PUBLIC_BASE_URL: 'https://example.com',
  MCP_BEARER_TOKEN: 'm'.repeat(32),
  ADMIN_TOKEN: 'a'.repeat(32),
  TOKEN_ENCRYPTION_KEY: '0'.repeat(64),
  GOOGLE_CLIENT_ID: 'test-client',
  GOOGLE_CLIENT_SECRET: 'test-secret',
  GOOGLE_REDIRECT_URI: 'https://example.com/oauth/google/callback',
  GOOGLE_ADS_DEVELOPER_TOKEN: 'developer-token',
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: '1234567890',
  CHATGPT_OAUTH_CLIENT_ID: 'chatgpt-client-id-123',
  CHATGPT_OAUTH_CLIENT_SECRET: 's'.repeat(32),
  CHATGPT_OAUTH_REDIRECT_URI: 'https://chatgpt.com/connector/oauth/test',
  SHOPIFY_SHOP: 'mambo-test',
  SHOPIFY_CLIENT_ID: 'shopify-client-id',
  SHOPIFY_CLIENT_SECRET: 'shopify-client-secret',
});

const {
  buildShopifyOrdersSearchQuery,
  getShopifyShopOverview,
  summarizeShopifyOrderDetail,
  summarizeShopifyOrders,
} = await import('./shopify.js');

const money = (amount: string, currencyCode = 'GBP') => ({
  shopMoney: { amount, currencyCode },
  presentmentMoney: { amount, currencyCode },
});

test('builds a bounded Shopify order search without test orders', () => {
  assert.equal(
    buildShopifyOrdersSearchQuery({ startDate: '2026-07-01', endDate: '2026-07-31' }),
    "status:any created_at:>='2026-07-01T00:00:00Z' created_at:<='2026-07-31T23:59:59Z' test:false",
  );
  assert.throws(
    () => buildShopifyOrdersSearchQuery({ startDate: '2026-08-01', endDate: '2026-07-31' }),
    /must not be after/,
  );
});

test('summarizes current order value and excludes cancelled orders by default', () => {
  const orders = [
    {
      id: 'gid://shopify/Order/1',
      name: '#1001',
      createdAt: '2026-07-10T10:00:00Z',
      cancelledAt: null,
      test: false,
      displayFinancialStatus: 'PAID',
      displayFulfillmentStatus: 'FULFILLED',
      currentTotalPriceSet: { shopMoney: { amount: '120.50', currencyCode: 'GBP' } },
      currentSubtotalPriceSet: { shopMoney: { amount: '100.00', currencyCode: 'GBP' } },
    },
    {
      id: 'gid://shopify/Order/2',
      name: '#1002',
      createdAt: '2026-07-10T12:00:00Z',
      cancelledAt: '2026-07-11T12:00:00Z',
      test: false,
      displayFinancialStatus: 'VOIDED',
      displayFulfillmentStatus: 'UNFULFILLED',
      currentTotalPriceSet: { shopMoney: { amount: '10.00', currencyCode: 'GBP' } },
      currentSubtotalPriceSet: { shopMoney: { amount: '10.00', currencyCode: 'GBP' } },
    },
  ];

  assert.deepEqual(summarizeShopifyOrders(orders), {
    currency: 'GBP',
    orderCount: 1,
    revenue: 120.5,
    subtotal: 100,
    averageOrderValue: 120.5,
    excludedCancelledOrders: 1,
    financialStatuses: { PAID: 1 },
    fulfillmentStatuses: { FULFILLED: 1 },
    daily: [{ date: '2026-07-10', orders: 1, revenue: 120.5, subtotal: 100 }],
  });
});

test('returns country, product and shipping costs, and complete delivery durations without customer identity', () => {
  const result = summarizeShopifyOrderDetail({
    id: 'gid://shopify/Order/1001',
    name: '#1001',
    createdAt: '2026-08-01T08:00:00Z',
    processedAt: '2026-08-01T08:05:00Z',
    cancelledAt: null,
    test: false,
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'FULFILLED',
    shippingAddress: { country: 'Germany', countryCodeV2: 'DE' },
    currentSubtotalPriceSet: money('100.00'),
    currentShippingPriceSet: money('8.00'),
    currentTotalTaxSet: money('18.00'),
    currentTotalPriceSet: money('108.00'),
    shippingLines: {
      nodes: [{ title: 'Standard', code: 'STANDARD', currentDiscountedPriceSet: money('8.00') }],
      pageInfo: { hasNextPage: false },
    },
    lineItems: {
      nodes: [{
        id: 'gid://shopify/LineItem/1',
        name: 'Surfboard / Blue',
        title: 'Surfboard',
        variantTitle: 'Blue',
        sku: 'SURF-BLUE',
        quantity: 1,
        currentQuantity: 1,
        requiresShipping: true,
        originalUnitPriceSet: money('110.00'),
        originalTotalSet: money('110.00'),
        priceAfterAllDiscountsBeforeTaxesSet: money('100.00'),
        totalDiscountSet: money('10.00'),
      }],
      pageInfo: { hasNextPage: false },
    },
    fulfillments: [{
      id: 'gid://shopify/Fulfillment/1',
      name: '#1001.1',
      status: 'SUCCESS',
      displayStatus: 'DELIVERED',
      createdAt: '2026-08-02T08:00:00Z',
      inTransitAt: '2026-08-02T20:00:00Z',
      deliveredAt: '2026-08-05T20:00:00Z',
      estimatedDeliveryAt: '2026-08-06T20:00:00Z',
      requiresShipping: true,
      trackingInfo: [{ company: 'Test Carrier' }],
      events: {
        nodes: [{ status: 'DELIVERED', happenedAt: '2026-08-05T20:00:00Z' }],
        pageInfo: { hasNextPage: false },
      },
      fulfillmentLineItems: {
        nodes: [{
          quantity: 1,
          lineItem: { id: 'gid://shopify/LineItem/1', name: 'Surfboard / Blue', sku: 'SURF-BLUE' },
        }],
        pageInfo: { hasNextPage: false },
      },
    }],
  });

  assert.deepEqual(result.destination, { country: 'Germany', countryCode: 'DE' });
  assert.equal(result.customerCosts.products.presentmentMoney.amount, 100);
  assert.equal(result.customerCosts.shipping.presentmentMoney.amount, 8);
  assert.equal(result.products[0].sku, 'SURF-BLUE');
  assert.equal(result.products[0].productCostAfterAllDiscountsBeforeTax.shopMoney.amount, 100);
  assert.deepEqual(result.deliveryTimeline, {
    fulfillmentCreatedAt: '2026-08-02T08:00:00Z',
    carrierInTransitAt: '2026-08-02T20:00:00Z',
    firstShippedAt: '2026-08-02T20:00:00Z',
    fullyDeliveredAt: '2026-08-05T20:00:00Z',
    orderToFulfillmentHours: 24,
    orderToFirstShipmentHours: 36,
    firstShipmentToFullDeliveryHours: 72,
    orderToFullDeliveryHours: 108,
    complete: true,
  });
  assert.equal(JSON.stringify(result).includes('trackingNumber'), false);
  assert.equal(JSON.stringify(result).includes('address1'), false);
});

test('exchanges client credentials and verifies the granted read-only scopes', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  let requestNumber = 0;
  globalThis.fetch = async (input, init) => {
    requestNumber += 1;
    if (requestNumber === 1) {
      assert.equal(String(input), 'https://mambo-test.myshopify.com/admin/oauth/access_token');
      assert.equal(init?.method, 'POST');
      assert.match(String(init?.body), /grant_type=client_credentials/);
      return new Response(JSON.stringify({
        access_token: 'short-lived-token',
        scope: 'read_orders,read_products',
        expires_in: 86399,
      }), { status: 200 });
    }

    assert.equal(
      String(input),
      'https://mambo-test.myshopify.com/admin/api/2026-07/graphql.json',
    );
    assert.equal(new Headers(init?.headers).get('x-shopify-access-token'), 'short-lived-token');
    return new Response(JSON.stringify({
      data: {
        shop: {
          id: 'gid://shopify/Shop/1',
          name: 'Mambo',
          myshopifyDomain: 'mambo-test.myshopify.com',
          currencyCode: 'GBP',
        },
        currentAppInstallation: {
          accessScopes: [{ handle: 'read_products' }, { handle: 'read_orders' }],
        },
      },
    }), { status: 200 });
  };

  const overview = await getShopifyShopOverview();
  assert.equal(overview.apiVersion, '2026-07');
  assert.equal(overview.shop.name, 'Mambo');
  assert.deepEqual(overview.accessScopes, ['read_orders', 'read_products']);
  assert.equal(requestNumber, 2);
});
