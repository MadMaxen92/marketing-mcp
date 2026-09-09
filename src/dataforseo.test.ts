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
  DATAFORSEO_LOGIN: 'api@example.com',
  DATAFORSEO_PASSWORD: 'dataforseo-password',
});

const {
  DataForSeoApiError,
  getDataForSeoAccountStatus,
  getDataForSeoKeywordIdeas,
  getDataForSeoKeywordSearchVolume,
  getDataForSeoOrganicSerp,
  getDataForSeoRankedKeywords,
  listDataForSeoLocations,
} = await import('./dataforseo.js');

const expectedAuthorization = `Basic ${Buffer.from('api@example.com:dataforseo-password').toString('base64')}`;

function response(result: unknown, cost = 0, statusCode = 20_000, statusMessage = 'Ok.'): Response {
  return new Response(JSON.stringify({
    version: '0.1.test',
    status_code: 20_000,
    status_message: 'Ok.',
    tasks_count: 1,
    tasks_error: statusCode === 20_000 ? 0 : 1,
    tasks: [{
      id: 'task-123',
      status_code: statusCode,
      status_message: statusMessage,
      time: '0.100 sec.',
      cost,
      result: [result],
    }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function responseWithTaskResult(result: unknown[], cost = 0): Response {
  return new Response(JSON.stringify({
    version: '0.1.test',
    status_code: 20_000,
    status_message: 'Ok.',
    tasks_count: 1,
    tasks_error: 0,
    tasks: [{
      id: 'task-123',
      status_code: 20_000,
      status_message: 'Ok.',
      time: '0.100 sec.',
      cost,
      result,
    }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('checks DataForSEO account status without exposing the password', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://api.dataforseo.com/v3/appendix/user_data');
    assert.equal(new Headers(init?.headers).get('authorization'), expectedAuthorization);
    return response({
      login: 'api@example.com',
      money: { balance: 42.5, total: 100, currency: 'USD' },
      rate_limit_per_minute: 2000,
    });
  };

  const result = await getDataForSeoAccountStatus();
  assert.deepEqual(result.account, {
    login: 'api@example.com',
    balance: 42.5,
    total: 100,
    currency: 'USD',
    rateLimitPerMinute: 2000,
  });
  assert.equal(JSON.stringify(result).includes('dataforseo-password'), false);
});

test('filters free DataForSEO locations and languages', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => responseWithTaskResult([
    {
      location_code: 2826,
      location_name: 'United Kingdom',
      country_iso_code: 'GB',
      available_languages: [{ language_code: 'en', language_name: 'English' }],
    },
    {
      location_code: 2276,
      location_name: 'Germany',
      country_iso_code: 'DE',
      available_languages: [{ language_code: 'de', language_name: 'German' }],
    },
  ]);

  const result = await listDataForSeoLocations({ countryIsoCode: 'gb', languageCode: 'EN' });
  assert.equal(result.count, 1);
  assert.equal(result.locations[0].location_code, 2826);
  assert.equal(result.costUsd, 0);
});

test('batches a paid Google Ads keyword volume request and returns cost', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live');
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), [{
      keywords: ['baby carrier', 'travel stroller'],
      location_code: 2826,
      language_code: 'en',
      date_from: '2026-01-01',
      date_to: '2026-08-01',
      search_partners: false,
    }]);
    return responseWithTaskResult([{ keyword: 'baby carrier', search_volume: 12_100 }], 0.075);
  };

  const result = await getDataForSeoKeywordSearchVolume({
    keywords: ['baby carrier', 'travel stroller'],
    locationCode: 2826,
    languageCode: 'en',
    dateFrom: '2026-01-01',
    dateTo: '2026-08-01',
  });
  assert.equal(result.count, 1);
  assert.equal(result.costUsd, 0.075);
});

test('builds capped keyword ideas and ranked-keyword requests', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const requests: Array<{ url: string; body: any }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body))[0] });
    return response({ total_count: 250, items: [{ keyword_data: { keyword: 'example' } }] }, 0.011);
  };

  const ideas = await getDataForSeoKeywordIdeas({
    keywords: ['high chair'],
    locationName: 'Germany',
    languageCode: 'de',
    limit: 25,
    minSearchVolume: 100,
  });
  const ranked = await getDataForSeoRankedKeywords({
    target: 'example.com',
    locationCode: 2276,
    languageName: 'German',
    limit: 10,
    minSearchVolume: 50,
    maxOrganicRank: 20,
  });

  assert.equal(ideas.returnedCount, 1);
  assert.equal(ideas.totalCount, 250);
  assert.equal(ranked.returnedCount, 1);
  assert.deepEqual(requests[0], {
    url: 'https://api.dataforseo.com/v3/dataforseo_labs/google/keyword_ideas/live',
    body: {
      keywords: ['high chair'],
      location_name: 'Germany',
      language_code: 'de',
      include_serp_info: false,
      limit: 25,
      offset: 0,
      order_by: ['keyword_info.search_volume,desc'],
      filters: [['keyword_info.search_volume', '>=', 100]],
    },
  });
  assert.deepEqual(requests[1]!.body.filters, [
    ['keyword_data.keyword_info.search_volume', '>=', 50],
    'and',
    ['ranked_serp_element.serp_item.rank_group', '<=', 20],
  ]);
});

test('sets device-specific live SERP options and rejects invalid targeting', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_input, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)), [{
      keyword: 'best high chair',
      location_name: 'United Kingdom',
      language_code: 'en',
      device: 'mobile',
      os: 'android',
      depth: 10,
      calculate_rectangles: false,
    }]);
    return response({ location_code: 2826, items_count: 1, items: [{ type: 'organic', rank_group: 1 }] }, 0.002);
  };

  const result = await getDataForSeoOrganicSerp({
    keyword: 'best high chair',
    locationName: 'United Kingdom',
    languageCode: 'en',
    device: 'mobile',
    depth: 10,
  });
  assert.equal(result.device, 'mobile');
  assert.equal(result.returnedCount, 1);

  await assert.rejects(
    getDataForSeoKeywordIdeas({
      keywords: ['duplicate', 'DUPLICATE'],
      locationCode: 2826,
    }),
    /duplicates/,
  );
  await assert.rejects(
    getDataForSeoOrganicSerp({
      keyword: 'test',
      locationCode: 2826,
      locationName: 'United Kingdom',
    }),
    /either locationCode or locationName/,
  );
});

test('surfaces DataForSEO task errors without leaking credentials', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => response({}, 0, 40_201, 'Insufficient funds');

  await assert.rejects(
    getDataForSeoKeywordSearchVolume({ keywords: ['test'] }),
    (error: unknown) => {
      assert.ok(error instanceof DataForSeoApiError);
      assert.equal(error.apiStatusCode, 40_201);
      assert.match(error.message, /Insufficient funds/);
      assert.equal(error.message.includes('dataforseo-password'), false);
      return true;
    },
  );
});
