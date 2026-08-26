import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const testDirectory = await mkdtemp(join(tmpdir(), 'marketing-mcp-search-console-'));

Object.assign(process.env, {
  PUBLIC_BASE_URL: 'https://example.com',
  MCP_BEARER_TOKEN: 'm'.repeat(32),
  ADMIN_TOKEN: 'a'.repeat(32),
  TOKEN_ENCRYPTION_KEY: '0'.repeat(64),
  TOKEN_STORE_PATH: join(testDirectory, 'connections.enc'),
  GOOGLE_CLIENT_ID: 'test-client',
  GOOGLE_CLIENT_SECRET: 'test-secret',
  GOOGLE_REDIRECT_URI: 'https://example.com/oauth/google/callback',
  GOOGLE_ADS_DEVELOPER_TOKEN: 'developer-token',
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: '1234567890',
  CHATGPT_OAUTH_CLIENT_ID: 'chatgpt-client-id-123',
  CHATGPT_OAUTH_CLIENT_SECRET: 's'.repeat(32),
  CHATGPT_OAUTH_REDIRECT_URI: 'https://chatgpt.com/connector/oauth/test',
});

const {
  beginGoogleOAuth,
  finishGoogleOAuth,
  getMissingGoogleApiScopes,
  GOOGLE_OAUTH_SCOPES,
  GOOGLE_REQUIRED_API_SCOPES,
} = await import('./google.js');
const {
  buildSearchAnalyticsRequest,
  getSearchConsolePerformance,
  listSearchConsoleSites,
  normalizeSearchConsoleSiteUrl,
  SearchConsoleApiError,
} = await import('./search-console.js');
const { upsertConnection } = await import('./token-store.js');

const accessToken = 'search-console-access-token';
await upsertConnection({
  id: 'search-console-connection',
  email: 'owner@example.com',
  refreshToken: 'not-used',
  accessToken,
  accessTokenExpiresAt: Date.now() + 60 * 60_000,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

after(async () => {
  await rm(testDirectory, { recursive: true, force: true });
});

test('Google OAuth requests the Search Console read-only scope', () => {
  assert.ok(GOOGLE_OAUTH_SCOPES.includes('https://www.googleapis.com/auth/webmasters.readonly'));
  assert.deepEqual(getMissingGoogleApiScopes(GOOGLE_REQUIRED_API_SCOPES.join(' ')), []);
  assert.deepEqual(
    getMissingGoogleApiScopes(GOOGLE_REQUIRED_API_SCOPES.filter((scope) => !scope.endsWith('/webmasters.readonly')).join(' ')),
    ['https://www.googleapis.com/auth/webmasters.readonly'],
  );

  let redirectUrl = '';
  beginGoogleOAuth(
    { query: { admin_token: 'a'.repeat(32) } } as any,
    { redirect: (value: string) => { redirectUrl = value; } } as any,
  );
  const authorizationUrl = new URL(redirectUrl);
  assert.equal(authorizationUrl.searchParams.get('include_granted_scopes'), 'true');
  assert.ok(
    authorizationUrl.searchParams.get('scope')?.split(' ')
      .includes('https://www.googleapis.com/auth/webmasters.readonly'),
  );
});

test('Google OAuth rejects a partial API-scope grant before saving it', async (context) => {
  let redirectUrl = '';
  beginGoogleOAuth(
    { query: { admin_token: 'a'.repeat(32) } } as any,
    { redirect: (value: string) => { redirectUrl = value; } } as any,
  );
  const state = new URL(redirectUrl).searchParams.get('state');
  assert.ok(state);

  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  let fetchCount = 0;
  globalThis.fetch = async (input) => {
    fetchCount += 1;
    assert.equal(String(input), 'https://oauth2.googleapis.com/token');
    return new Response(JSON.stringify({
      access_token: 'partial-access-token',
      expires_in: 3600,
      refresh_token: 'partial-refresh-token',
      scope: GOOGLE_REQUIRED_API_SCOPES.filter((scope) => !scope.endsWith('/webmasters.readonly')).join(' '),
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  let statusCode = 200;
  let responseBody = '';
  const response: any = {
    status(value: number) {
      statusCode = value;
      return response;
    },
    type() {
      return response;
    },
    send(value: string) {
      responseBody = value;
      return response;
    },
  };

  await finishGoogleOAuth({ query: { code: 'test-code', state } } as any, response);

  assert.equal(fetchCount, 1);
  assert.equal(statusCode, 400);
  assert.match(responseBody, /No connection was saved/);
  assert.match(responseBody, /webmasters\.readonly/);
});

test('lists verified Search Console sites with connection metadata', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://www.googleapis.com/webmasters/v3/sites');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${accessToken}`);
    return new Response(JSON.stringify({
      siteEntry: [
        { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
        { siteUrl: 'https://shop.example.com/', permissionLevel: 'siteFullUser' },
        { siteUrl: 'sc-domain:unverified.example', permissionLevel: 'siteUnverifiedUser' },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const result = await listSearchConsoleSites('owner@example.com');

  assert.deepEqual(result.connection, { id: 'search-console-connection', email: 'owner@example.com' });
  assert.deepEqual(result.sites, [
    { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
    { siteUrl: 'https://shop.example.com/', permissionLevel: 'siteFullUser' },
  ]);
  assert.equal(result.unverifiedSitesExcluded, 1);
  assert.equal(JSON.stringify(result).includes(accessToken), false);
});

test('queries an encoded domain property with filters and pagination', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input, init) => {
    assert.equal(
      String(input),
      'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query',
    );
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${accessToken}`);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      startDate: '2026-08-01',
      endDate: '2026-08-20',
      dimensions: ['date', 'query'],
      type: 'web',
      aggregationType: 'byProperty',
      dataState: 'final',
      rowLimit: 2,
      startRow: 2,
      dimensionFilterGroups: [{
        groupType: 'and',
        filters: [{ dimension: 'country', operator: 'equals', expression: 'deu' }],
      }],
    });
    return new Response(JSON.stringify({
      rows: [
        { keys: ['2026-08-01', 'summer shoes'], clicks: 10, impressions: 100, ctr: 0.1, position: 2.4 },
        { keys: ['2026-08-02', 'red shoes'], clicks: 8, impressions: 80, ctr: 0.1, position: 3.1 },
      ],
      responseAggregationType: 'byProperty',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const result = await getSearchConsolePerformance({
    connectionId: 'owner@example.com',
    siteUrl: 'sc-domain:example.com',
    startDate: '2026-08-01',
    endDate: '2026-08-20',
    dimensions: ['date', 'query'],
    searchType: 'web',
    aggregationType: 'byProperty',
    dataState: 'final',
    filters: [{ dimension: 'country', operator: 'equals', expression: 'deu' }],
    rowLimit: 2,
    startRow: 2,
  });

  assert.equal(result.siteUrl, 'sc-domain:example.com');
  assert.equal(result.rowCount, 2);
  assert.equal(result.nextStartRow, 4);
  assert.equal(JSON.stringify(result).includes(accessToken), false);
});

test('URL-encodes the complete URL-prefix property identifier', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input) => {
    assert.equal(
      String(input),
      'https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fshop.example.com%2Fcatalog%2F/searchAnalytics/query',
    );
    return new Response(JSON.stringify({ rows: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await getSearchConsolePerformance({
    connectionId: 'owner@example.com',
    siteUrl: 'https://shop.example.com/catalog/',
    startDate: '2026-08-01',
    endDate: '2026-08-20',
  });

  assert.equal(result.siteUrl, 'https://shop.example.com/catalog/');
  assert.equal(result.rowCount, 0);
  assert.equal(result.nextStartRow, null);
});

test('preserves URL-prefix identifiers and validates incompatible requests', () => {
  assert.equal(normalizeSearchConsoleSiteUrl('https://shop.example.com/catalog/'), 'https://shop.example.com/catalog/');
  assert.throws(() => normalizeSearchConsoleSiteUrl('example.com'), /exact sc-domain/);
  const boundaryRequest = buildSearchAnalyticsRequest({
    siteUrl: 'sc-domain:example.com',
    startDate: '2026-08-01',
    endDate: '2026-08-20',
    rowLimit: 25_000,
    startRow: 50_000,
  });
  assert.equal(boundaryRequest.rowLimit, 25_000);
  assert.equal(boundaryRequest.startRow, 50_000);
  assert.throws(() => buildSearchAnalyticsRequest({
    siteUrl: 'sc-domain:example.com',
    startDate: '2026-02-30',
    endDate: '2026-08-20',
  }), /valid calendar date/);
  assert.throws(() => buildSearchAnalyticsRequest({
    siteUrl: 'sc-domain:example.com',
    startDate: '2026-08-01',
    endDate: '2026-08-20',
    rowLimit: 25_001,
  }), /rowLimit must be an integer/);
  assert.throws(() => buildSearchAnalyticsRequest({
    siteUrl: 'sc-domain:example.com',
    startDate: '2026-08-20',
    endDate: '2026-08-01',
  }), /startDate must be on or before endDate/);
  assert.throws(() => buildSearchAnalyticsRequest({
    siteUrl: 'sc-domain:example.com',
    startDate: '2026-08-01',
    endDate: '2026-08-20',
    dimensions: ['date', 'date'],
  }), /dimensions must be unique/);
  assert.throws(() => buildSearchAnalyticsRequest({
    siteUrl: 'sc-domain:example.com',
    startDate: '2026-08-01',
    endDate: '2026-08-20',
    dimensions: ['hour'],
  }), /hour dimension requires dataState hourly_all/);
  assert.throws(() => buildSearchAnalyticsRequest({
    siteUrl: 'sc-domain:example.com',
    startDate: '2026-08-01',
    endDate: '2026-08-20',
    dimensions: ['hour'],
    dataState: 'hourly_all',
  }), /at most 10 inclusive days/);
  assert.throws(() => buildSearchAnalyticsRequest({
    siteUrl: 'sc-domain:example.com',
    startDate: '2026-08-01',
    endDate: '2026-08-20',
    dimensions: ['searchAppearance', 'query'],
  }), /searchAppearance must be the only grouping dimension/);
  assert.throws(() => buildSearchAnalyticsRequest({
    siteUrl: 'sc-domain:example.com',
    startDate: '2026-08-01',
    endDate: '2026-08-20',
    dimensions: ['page'],
    aggregationType: 'byProperty',
  }), /byProperty cannot be combined/);
  assert.throws(() => buildSearchAnalyticsRequest({
    siteUrl: 'sc-domain:example.com',
    startDate: '2026-08-01',
    endDate: '2026-08-20',
    searchType: 'discover',
    aggregationType: 'byProperty',
  }), /not supported for Discover or Google News/);
  assert.deepEqual(buildSearchAnalyticsRequest({
    siteUrl: 'sc-domain:example.com',
    startDate: '2026-08-01',
    endDate: '2026-08-20',
    dimensions: [],
  }).dimensions, []);
});

test('returns an actionable, token-safe error when Search Console access is missing', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => new Response('permission denied', { status: 403 });

  await assert.rejects(
    listSearchConsoleSites('owner@example.com'),
    (error: unknown) => {
      assert.ok(error instanceof SearchConsoleApiError);
      assert.equal(error.status, 403);
      assert.match(error.message, /Reconnect the Google account/);
      assert.equal(error.message.includes(accessToken), false);
      return true;
    },
  );
});
