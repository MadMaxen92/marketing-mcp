import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import express from 'express';

test('Claude sign-in, account isolation and revocation preserve the legacy ChatGPT path', { timeout: 15_000 }, async t => {
  const data = await mkdtemp(join(tmpdir(), 'marketing-hub-access-'));
  t.after(() => rm(data, { recursive: true, force: true }));
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  const listener = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    listener.once('listening', resolve);
    listener.once('error', reject);
  });
  t.after(() => {
    listener.close();
    listener.closeAllConnections();
  });
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = 'http://127.0.0.1:' + address.port;
  const legacyToken = 'm'.repeat(32);
  const clientId = 'marketing-hub-claude';
  const clientSecret = 'c'.repeat(32);
  const callback = 'https://claude.ai/api/mcp/auth_callback';
  const resource = baseUrl + '/claude/mcp';

  Object.assign(process.env, {
    PUBLIC_BASE_URL: baseUrl,
    MCP_BEARER_TOKEN: legacyToken,
    ADMIN_TOKEN: 'a'.repeat(32),
    TOKEN_ENCRYPTION_KEY: '0'.repeat(64),
    GOOGLE_CLIENT_ID: 'test-client',
    GOOGLE_CLIENT_SECRET: 'test-secret',
    GOOGLE_REDIRECT_URI: baseUrl + '/oauth/google/callback',
    GOOGLE_ADS_DEVELOPER_TOKEN: 'developer-token',
    GOOGLE_ADS_LOGIN_CUSTOMER_ID: '1234567890',
    CHATGPT_OAUTH_CLIENT_ID: 'chatgpt-client-id-123',
    CHATGPT_OAUTH_CLIENT_SECRET: 's'.repeat(32),
    CHATGPT_OAUTH_REDIRECT_URI: 'https://chatgpt.com/connector/oauth/test',
    SHOPIFY_SHOP: 'test-shop',
    TOKEN_STORE_PATH: join(data, 'google-connections.enc'),
  });

  const { createClaudeRouter } = await import('./claude-oauth.js');
  const { provisionMember, revokeMember } = await import('./claude-members.js');
  const { writeStore } = await import('./token-store.js');
  const { handleMcpRequest } = await import('./mcp-http.js');
  const { createMarketingMcpServer } = await import('./mcp.js');
  const { authorizationServerMetadata, requireMcpOAuth } = await import('./oauth.js');
  app.get('/.well-known/oauth-authorization-server', authorizationServerMetadata);
  app.all('/mcp', requireMcpOAuth, (req, res, next) =>
    handleMcpRequest(createMarketingMcpServer(), req, res, next));
  app.use(createClaudeRouter(clientId, clientSecret));

  const connectionId = '123456789012345678901';
  const memberGrants = { ga4: [{ id: '111', connectionId }] };
  const timestamp = new Date().toISOString();
  await writeStore({ connections: [{
    id: connectionId, email: 'owner@example.com', refreshToken: 'test-refresh-token',
    accessToken: 'test-access-token', accessTokenExpiresAt: Date.now() + 3_600_000,
    createdAt: timestamp, updatedAt: timestamp,
  }] });
  const member = await provisionMember('Member@example.com', memberGrants);
  const other = await provisionMember('other@example.com', { shopify: 'test-shop' });

  const anonymous = await fetch(resource);
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get('www-authenticate') ?? '', /oauth-protected-resource\/claude\/mcp/);
  const protectedMetadata = await (await fetch(baseUrl + '/.well-known/oauth-protected-resource/claude/mcp')).json();
  assert.equal(protectedMetadata.resource, resource);
  assert.deepEqual(protectedMetadata.authorization_servers, [baseUrl + '/claude']);
  const metadata = await (await fetch(baseUrl + '/.well-known/oauth-authorization-server/claude')).json();
  const legacyMetadata = await (await fetch(baseUrl + '/.well-known/oauth-authorization-server')).json();
  assert.equal(metadata.authorization_endpoint, baseUrl + '/claude/oauth/authorize');
  assert.equal(legacyMetadata.authorization_endpoint, baseUrl + '/oauth/authorize');
  assert.equal((await fetch(resource, { headers: { authorization: 'Bearer ' + legacyToken } })).status, 401);

  const verifier = 'v'.repeat(43);
  const authorizationUrl = new URL(metadata.authorization_endpoint);
  authorizationUrl.search = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: callback, state: 'client-state',
    code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    scope: 'mcp:read offline_access', resource,
  }).toString();
  const authorize = await fetch(authorizationUrl);
  assert.equal(authorize.status, 200);
  const cookie = authorize.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const form = await authorize.text();
  const flow = /name="flow" value="([^"]+)"/.exec(form)?.[1];
  assert.ok(flow);

  const loginBody = new URLSearchParams({ flow, email: member.email, password: member.password });
  const login = (cookie?: string) => fetch(baseUrl + '/claude/oauth/login', {
    method: 'POST', body: loginBody, headers: cookie ? { cookie } : {}, redirect: 'manual',
  });
  assert.equal((await login()).status, 400);
  const authorized = await login(cookie);
  assert.equal(authorized.status, 303);
  assert.equal((await login(cookie)).status, 400);
  const redirect = new URL(authorized.headers.get('location') ?? '');
  assert.equal(redirect.origin + redirect.pathname, callback);
  assert.equal(redirect.searchParams.get('state'), 'client-state');
  const code = redirect.searchParams.get('code');
  assert.ok(code);

  const tokenRequest = (params: Record<string, string>) => fetch(metadata.token_endpoint, {
    method: 'POST', body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }),
  });
  const exchange = { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: callback, resource };
  assert.equal((await tokenRequest({ ...exchange, code_verifier: 'x'.repeat(43) })).status, 400);
  assert.equal((await tokenRequest({ ...exchange, redirect_uri: 'https://example.com/' })).status, 400);
  assert.equal((await tokenRequest({ ...exchange, resource: baseUrl + '/mcp' })).status, 400);
  const exchangeResponse = await tokenRequest(exchange);
  assert.equal(exchangeResponse.status, 200);
  const tokens = await exchangeResponse.json();
  assert.equal((await tokenRequest(exchange)).status, 400);
  assert.equal((await fetch(baseUrl + '/mcp', { headers: { authorization: 'Bearer ' + tokens.access_token } })).status, 401);
  assert.equal((await fetch(resource, { headers: { authorization: 'Bearer ' + tokens.refresh_token } })).status, 401);

  const connect = async (url: string, token: string) => {
    const client = new Client({ name: 'verification', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: 'Bearer ' + token } },
    }));
    t.after(() => client.close());
    return client;
  };

  const client = await connect(resource, tokens.access_token);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['list_authorized_accounts', 'run_ga4_report']);
  const accounts = await client.callTool({ name: 'list_authorized_accounts', arguments: {} });
  const accountContent = accounts.content as [{ text: string }];
  assert.deepEqual(JSON.parse(accountContent[0].text), {
    ga4PropertyIds: ['111'], googleAdsCustomerIds: [], searchConsoleSites: [], merchantCenterAccountIds: [], shopifyShop: null,
  });

  const originalFetch = globalThis.fetch;
  const providerCalls: string[] = [];
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith(baseUrl + '/')) return originalFetch(input, init);
    providerCalls.push(String(input));
    assert.equal(String(input), 'https://analyticsdata.googleapis.com/v1beta/properties/111:runReport');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-access-token');
    return Response.json({ rows: [], rowCount: 0 });
  };
  try {
    const report = { name: 'run_ga4_report', arguments: { propertyId: '222', startDate: '2026-10-01', endDate: '2026-10-31', metrics: ['sessions'] } };
    assert.equal((await client.callTool(report)).isError, true);
    assert.deepEqual(providerCalls, []);
    assert.notEqual((await client.callTool({ ...report, arguments: { ...report.arguments, propertyId: '111', connectionId: 'spoofed' } })).isError, true);
    assert.equal(providerCalls.length, 1);
    assert.equal((await client.callTool({ name: 'apply_shopify_admin_mutation', arguments: {} })).isError, true);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const refresh = { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, resource };
  assert.equal((await tokenRequest(refresh)).status, 200);
  await provisionMember(member.email, memberGrants);
  assert.equal((await tokenRequest(refresh)).status, 400);
  await revokeMember(member.email);
  assert.equal((await fetch(resource, { headers: { authorization: 'Bearer ' + tokens.access_token } })).status, 401);

  const otherAuthorize = await fetch(authorizationUrl);
  const otherCookie = otherAuthorize.headers.get('set-cookie')?.split(';')[0];
  const otherFlow = /name="flow" value="([^"]+)"/.exec(await otherAuthorize.text())?.[1];
  assert.ok(otherCookie && otherFlow);
  const otherLogin = await fetch(baseUrl + '/claude/oauth/login', {
    method: 'POST',
    body: new URLSearchParams({ flow: otherFlow, email: other.email, password: other.password }),
    headers: { cookie: otherCookie },
    redirect: 'manual',
  });
  assert.equal(otherLogin.status, 303);
  const otherCode = new URL(otherLogin.headers.get('location') ?? '').searchParams.get('code');
  assert.ok(otherCode);
  const otherResponse = await tokenRequest({ ...exchange, code: otherCode });
  assert.equal(otherResponse.status, 200);
  const otherTokens = await otherResponse.json();
  const otherClient = await connect(resource, otherTokens.access_token);
  assert.deepEqual((await otherClient.listTools()).tools.map(tool => tool.name), [
    'list_authorized_accounts', 'get_shopify_sales_overview',
  ]);
  await revokeMember(other.email);
  assert.equal((await fetch(resource, { headers: { authorization: 'Bearer ' + otherTokens.access_token } })).status, 401);

  const legacy = await connect(baseUrl + '/mcp', legacyToken);
  const legacyTools = (await legacy.listTools()).tools.map(tool => tool.name);
  assert.ok(legacyTools.includes('list_google_connections'));
  assert.ok(legacyTools.includes('apply_shopify_admin_mutation'));
  assert.ok(!legacyTools.includes('list_authorized_accounts'));
});
