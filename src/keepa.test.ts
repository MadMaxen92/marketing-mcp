import assert from 'node:assert/strict';
import test from 'node:test';

const key = 'test-keepa-api-key';
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
  KEEPA_API_KEY: key,
});

const { getKeepaUkProduct } = await import('./keepa.js');

test('looks up a single UK ASIN and decodes Keepa prices, missing fields and variation data', async t => {
  const asin = 'B0GTRNN6FL';
  const now = 8_100_000;
  const current = Array<number>(19).fill(-1);
  current[1] = 18_900;
  current[3] = 15_120;
  current[11] = 1;
  current[16] = 45;
  current[17] = 7;
  current[18] = 19_399;
  const csv = Array<number[] | null>(19).fill(null);
  csv[1] = [now - 60, 18_900, now, -1];
  csv[18] = [now - 60, 18_900, 499, now, -1, -1];

  const request = t.mock.method(globalThis, 'fetch', async (input: URL, init?: RequestInit) => {
    assert.equal(input.origin + input.pathname, 'https://api.keepa.com/product');
    assert.equal(input.searchParams.get('key'), key);
    assert.equal(input.searchParams.get('asin'), asin);
    assert.equal(input.searchParams.get('domain'), '2');
    assert.equal(input.searchParams.get('days'), '90');
    assert.equal(input.searchParams.get('history'), '1');
    assert.equal(input.searchParams.get('buybox'), '1');
    assert.equal(input.searchParams.get('rating'), '1');
    assert.equal(input.searchParams.has('offers'), false);
    assert.equal(init?.redirect, 'error');
    return Response.json({
      tokensLeft: 100, tokensConsumed: 4, refillIn: 5000, refillRate: 5,
      products: [{
        asin, domainId: 2, productType: 0, color: 'Desert Sand', parentAsin: 'B0EXAMPLE0',
        variations: [{ asin, attributes: [{ dimension: 'Color', value: 'Desert Sand' }] }],
        lastUpdate: now, salesRankReference: 123, categoryTree: [{ catId: 123, name: 'Baby' }],
        monthlySold: 0, csv,
        stats: { current, buyBoxPrice: 18_900, buyBoxShipping: 499, buyBoxSellerId: 'SELLER', lastBuyBoxUpdate: now },
      }],
    });
  });

  const result = await getKeepaUkProduct({ asin: asin.toLowerCase(), includeBuyBox: true, includeRatings: true, includeHistory: true });
  assert.equal(request.mock.callCount(), 1);
  assert.ok(result.found);
  assert.equal(result.parentAsin, 'B0EXAMPLE0');
  assert.equal(result.colour, 'Desert Sand');
  assert.equal(result.variations?.[0]?.attributes?.[0]?.value, 'Desert Sand');
  assert.equal(result.pricesGbp.amazon.latest, null);
  assert.equal(result.pricesGbp.marketplaceNew.latest, 189);
  assert.equal(result.pricesGbp.buyBoxWithShipping.latest, 193.99);
  assert.equal(result.buyBox?.priceGbp, 193.99);
  assert.equal(result.ratings?.stars, 4.5);
  assert.equal(result.ratings?.ratingCount, 7);
  assert.equal(result.salesRank.categoryName, 'Baby');
  assert.equal(result.boughtPastMonthMinimum, null);
  assert.equal(result.priceChanges90Days?.buyBoxWithShipping[0]?.priceGbp, 193.99);
  assert.equal(result.priceChanges90Days?.buyBoxWithShipping[1]?.priceGbp, null);
  assert.equal(result.lastProductUpdate, new Date(Date.UTC(2011, 0, 1) + now * 60_000).toISOString());
  assert.equal(result.usage.tokensConsumed, 4);
});

test('rejects invalid input before fetching and omits the key from provider errors', async t => {
  const request = t.mock.method(globalThis, 'fetch', async () => new Response(key, { status: 402 }));
  await assert.rejects(getKeepaUkProduct({ asin: 'bad' }));
  assert.equal(request.mock.callCount(), 0);
  await assert.rejects(getKeepaUkProduct({ asin: 'B0GTRNN6FL' }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /denied access/);
    assert.ok(!error.message.includes(key));
    return true;
  });
});
