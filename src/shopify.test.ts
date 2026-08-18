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
  applyShopifyCollectionProductsUpdate,
  applyShopifyCollectionPublicationUpdate,
  applyShopifyCollectionUpdate,
  applyShopifyProductDescriptionUpdate,
  buildShopifyOrdersSearchQuery,
  getShopifyShopOverview,
  listShopifyCollections,
  listShopifyMetaobjectDefinitions,
  listShopifyMetaobjects,
  listShopifyPublications,
  previewShopifyCollectionProductsUpdate,
  previewShopifyCollectionPublicationUpdate,
  previewShopifyCollectionUpdate,
  previewShopifyProductDescriptionUpdate,
  shopifyDescriptionTextToHtml,
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

test('converts product description text to safe minimal HTML', () => {
  assert.equal(
    shopifyDescriptionTextToHtml('First & <script>alert(1)</script>\nline two\n\nSecond'),
    '<p>First &amp; &lt;script&gt;alert(1)&lt;/script&gt;<br>line two</p><p>Second</p>',
  );
  assert.equal(shopifyDescriptionTextToHtml('   '), '');
});

test('requires an exact short-lived preview before updating only descriptionHtml', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  context.mock.method(console, 'info', () => undefined);

  const productId = 'gid://shopify/Product/123';
  const currentProduct = {
    id: productId,
    title: 'Mambo Board',
    handle: 'mambo-board',
    status: 'ACTIVE',
    descriptionHtml: '<p>Old description</p>',
    updatedAt: '2026-08-17T08:00:00Z',
  };
  let graphqlRequestNumber = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith('/admin/oauth/access_token')) {
      return new Response(JSON.stringify({
        access_token: 'write-token',
        scope: 'read_orders,read_products,write_products',
        expires_in: 86399,
      }), { status: 200 });
    }

    graphqlRequestNumber += 1;
    const request = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, any>;
    };
    if (request.query.includes('mutation ShopifyProductDescriptionUpdate')) {
      assert.deepEqual(request.variables.product, {
        id: productId,
        descriptionHtml: '<p>New &amp; safe<br>description</p>',
      });
      assert.deepEqual(Object.keys(request.variables.product).sort(), ['descriptionHtml', 'id']);
      return new Response(JSON.stringify({
        data: {
          productUpdate: {
            product: {
              ...currentProduct,
              descriptionHtml: request.variables.product.descriptionHtml,
              updatedAt: '2026-08-17T09:00:00Z',
            },
            userErrors: [],
          },
        },
      }), { status: 200 });
    }

    assert.equal(request.variables.id, productId);
    return new Response(JSON.stringify({
      data: {
        node: currentProduct,
        currentAppInstallation: {
          accessScopes: [{ handle: 'read_products' }, { handle: 'write_products' }],
        },
      },
    }), { status: 200 });
  };

  const preview = await previewShopifyProductDescriptionUpdate({
    productId,
    descriptionText: 'New & safe\ndescription',
  });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.change.currentDescriptionHtml, '<p>Old description</p>');
  assert.equal(preview.change.proposedDescriptionHtml, '<p>New &amp; safe<br>description</p>');
  assert.match(preview.safety.confirmationCode, /^SHOPIFY-[A-F0-9]{8}$/);
  assert.deepEqual(preview.safety.touchesOnly, ['descriptionHtml']);

  await assert.rejects(
    () => applyShopifyProductDescriptionUpdate({
      productId,
      descriptionText: 'Altered description',
      confirmationCode: preview.safety.confirmationCode,
      confirmationToken: preview.confirmationToken,
    }),
    /does not match/,
  );

  currentProduct.updatedAt = '2026-08-17T08:30:00Z';
  await assert.rejects(
    () => applyShopifyProductDescriptionUpdate({
      productId,
      descriptionText: 'New & safe\ndescription',
      confirmationCode: preview.safety.confirmationCode,
      confirmationToken: preview.confirmationToken,
    }),
    /changed after the preview/,
  );
  currentProduct.updatedAt = '2026-08-17T08:00:00Z';

  const applied = await applyShopifyProductDescriptionUpdate({
    productId,
    descriptionText: 'New & safe\ndescription',
    confirmationCode: preview.safety.confirmationCode,
    confirmationToken: preview.confirmationToken,
  });
  assert.equal(applied.applied, true);
  assert.deepEqual(applied.changedFields, ['descriptionHtml']);
  assert.equal(applied.product.descriptionHtml, '<p>New &amp; safe<br>description</p>');
  assert.equal(applied.recoverySnapshot.previousDescriptionHtml, '<p>Old description</p>');
  assert.equal(graphqlRequestNumber, 4);
});

test('lists Shopify collections and guards metadata and manual product membership writes', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  context.mock.method(console, 'info', () => undefined);

  const collectionId = 'gid://shopify/Collection/456';
  const productId = 'gid://shopify/Product/789';
  const collection = {
    id: collectionId,
    title: 'Sale',
    handle: 'sale',
    descriptionHtml: '<p>Current sale</p>',
    updatedAt: '2026-08-18T08:00:00Z',
    sortOrder: 'MANUAL',
    templateSuffix: null,
    productsCount: { count: 14 },
    seo: { title: 'Sale', description: 'Current offers' },
    image: null,
    ruleSet: null,
  };
  const requests: Array<{ query: string; variables: Record<string, any> }> = [];
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, any>;
    };
    requests.push(request);
    if (request.query.includes('query ShopifyCollections(')) {
      assert.equal(request.variables.first, 250);
      return new Response(JSON.stringify({
        data: {
          collections: {
            nodes: [collection],
            pageInfo: { hasNextPage: false, endCursor: 'last' },
          },
        },
      }), { status: 200 });
    }
    if (request.query.includes('query ShopifyCollectionForWrite')) {
      return new Response(JSON.stringify({
        data: {
          node: collection,
          currentAppInstallation: {
            accessScopes: [{ handle: 'read_products' }, { handle: 'write_products' }],
          },
        },
      }), { status: 200 });
    }
    if (request.query.includes('mutation ShopifyCollectionUpdate')) {
      assert.deepEqual(request.variables.collection, {
        id: collectionId,
        descriptionHtml: '<p>Fresh offers</p>',
        seo: { title: 'Mambo Sale', description: 'Current offers' },
      });
      return new Response(JSON.stringify({
        data: {
          collectionUpdate: {
            collection: {
              ...collection,
              ...request.variables.collection,
              updatedAt: '2026-08-18T09:00:00Z',
            },
            userErrors: [],
          },
        },
      }), { status: 200 });
    }
    if (request.query.includes('query ShopifyProductsByIds')) {
      return new Response(JSON.stringify({
        data: {
          nodes: [{ id: productId, title: 'Mambo Tee', handle: 'mambo-tee', status: 'ACTIVE' }],
        },
      }), { status: 200 });
    }
    if (request.query.includes('mutation ShopifyCollectionAddProducts')) {
      assert.deepEqual(request.variables, { id: collectionId, productIds: [productId] });
      return new Response(JSON.stringify({
        data: {
          collectionAddProducts: {
            collection: { id: collectionId, title: 'Sale', updatedAt: '2026-08-18T09:05:00Z', productsCount: { count: 15 } },
            userErrors: [],
          },
        },
      }), { status: 200 });
    }
    throw new Error(`Unexpected Shopify test query: ${request.query}`);
  };

  const listed = await listShopifyCollections({ limit: 250 });
  assert.equal(listed.collections.length, 1);
  assert.equal(listed.collections[0].collectionType, 'MANUAL');
  assert.equal(listed.collections[0].productsCount.count, 14);

  const metadataPreview = await previewShopifyCollectionUpdate({
    collectionId,
    descriptionText: 'Fresh offers',
    seoTitle: 'Mambo Sale',
  });
  assert.equal(metadataPreview.dryRun, true);
  assert.deepEqual(metadataPreview.safety.touchesOnly, ['descriptionHtml', 'seo']);
  await assert.rejects(
    () => applyShopifyCollectionUpdate({
      collectionId,
      descriptionText: 'Changed after preview',
      seoTitle: 'Mambo Sale',
      confirmationCode: metadataPreview.safety.confirmationCode,
      confirmationToken: metadataPreview.confirmationToken,
    }),
    /does not match/,
  );
  const metadataApplied = await applyShopifyCollectionUpdate({
    collectionId,
    descriptionText: 'Fresh offers',
    seoTitle: 'Mambo Sale',
    confirmationCode: metadataPreview.safety.confirmationCode,
    confirmationToken: metadataPreview.confirmationToken,
  });
  assert.equal(metadataApplied.applied, true);
  assert.deepEqual(metadataApplied.changedFields, ['descriptionHtml', 'seo']);

  const membershipPreview = await previewShopifyCollectionProductsUpdate({
    collectionId,
    action: 'ADD',
    productIds: [productId, productId],
  });
  assert.equal(membershipPreview.change.products.length, 1);
  const membershipApplied = await applyShopifyCollectionProductsUpdate({
    collectionId,
    action: 'ADD',
    productIds: [productId],
    confirmationCode: membershipPreview.safety.confirmationCode,
    confirmationToken: membershipPreview.confirmationToken,
  });
  assert.equal(membershipApplied.applied, true);
  assert.deepEqual(membershipApplied.productIds, [productId]);
  assert.equal(requests.filter(({ query }) => query.includes('mutation ShopifyCollectionUpdate')).length, 1);
  assert.equal(requests.filter(({ query }) => query.includes('mutation ShopifyCollectionAddProducts')).length, 1);
});

test('reads publications and metaobjects and guards collection unpublishing', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  context.mock.method(console, 'info', () => undefined);

  const collectionId = 'gid://shopify/Collection/456';
  const publicationId = 'gid://shopify/Publication/321';
  const publication = {
    id: publicationId,
    name: 'Online Store',
    autoPublish: false,
    supportsFuturePublishing: true,
  };
  const collection = {
    id: collectionId,
    title: 'Sale',
    handle: 'sale',
    updatedAt: '2026-08-18T08:00:00Z',
    resourcePublicationsV2: {
      nodes: [{ isPublished: true, publishDate: '2026-08-01T08:00:00Z', publication }],
      pageInfo: { hasNextPage: false },
    },
  };
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, any>;
    };
    if (request.query.includes('query ShopifyPublications(')) {
      return new Response(JSON.stringify({
        data: { publications: { nodes: [publication], pageInfo: { hasNextPage: false } } },
      }), { status: 200 });
    }
    if (request.query.includes('query ShopifyCollectionPublicationState')) {
      return new Response(JSON.stringify({
        data: {
          node: collection,
          currentAppInstallation: {
            accessScopes: [{ handle: 'read_publications' }, { handle: 'write_publications' }],
          },
        },
      }), { status: 200 });
    }
    if (request.query.includes('query ShopifyPublicationsByIds')) {
      return new Response(JSON.stringify({ data: { nodes: [publication] } }), { status: 200 });
    }
    if (request.query.includes('mutation ShopifyCollectionUnpublish')) {
      assert.deepEqual(request.variables, {
        id: collectionId,
        input: [{ publicationId }],
      });
      return new Response(JSON.stringify({
        data: {
          publishableUnpublish: {
            publishable: { resourcePublicationsV2: { nodes: [] } },
            userErrors: [],
          },
        },
      }), { status: 200 });
    }
    if (request.query.includes('query ShopifyMetaobjectDefinitions')) {
      return new Response(JSON.stringify({
        data: {
          metaobjectDefinitions: {
            nodes: [{
              id: 'gid://shopify/MetaobjectDefinition/1',
              name: 'Drop',
              type: 'drop',
              fieldDefinitions: [{ key: 'name', name: 'Name', required: true, type: { name: 'single_line_text_field' }, validations: [] }],
              access: { admin: 'MERCHANT_READ_WRITE', storefront: 'PUBLIC_READ' },
              capabilities: { publishable: { enabled: true }, translatable: { enabled: false } },
            }],
            pageInfo: { hasNextPage: false },
          },
        },
      }), { status: 200 });
    }
    if (request.query.includes('query ShopifyMetaobjects(')) {
      return new Response(JSON.stringify({
        data: {
          metaobjects: {
            nodes: [{
              id: 'gid://shopify/Metaobject/1',
              type: 'drop',
              handle: 'summer-2026',
              displayName: 'Summer 2026',
              updatedAt: '2026-08-18T08:00:00Z',
              fields: [{ key: 'name', type: 'single_line_text_field', value: 'Summer 2026' }],
              capabilities: { publishable: { status: 'ACTIVE' } },
            }],
            pageInfo: { hasNextPage: false },
          },
        },
      }), { status: 200 });
    }
    throw new Error(`Unexpected Shopify test query: ${request.query}`);
  };

  const publications = await listShopifyPublications({ limit: 100 });
  assert.equal(publications.publications[0].name, 'Online Store');

  const preview = await previewShopifyCollectionPublicationUpdate({
    collectionId,
    action: 'UNPUBLISH',
    publicationIds: [publicationId],
  });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.change.currentState[0].isPublished, true);
  const applied = await applyShopifyCollectionPublicationUpdate({
    collectionId,
    action: 'UNPUBLISH',
    publicationIds: [publicationId],
    confirmationCode: preview.safety.confirmationCode,
    confirmationToken: preview.confirmationToken,
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.action, 'UNPUBLISH');

  const definitions = await listShopifyMetaobjectDefinitions({ limit: 100 });
  assert.equal(definitions.definitions[0].type, 'drop');
  const metaobjects = await listShopifyMetaobjects({ type: 'drop', limit: 100 });
  assert.equal(metaobjects.metaobjects[0].handle, 'summer-2026');
});
