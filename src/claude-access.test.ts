import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import express from 'express';

test('Claude sign-in, scoped writes and revocation preserve the legacy ChatGPT path', { timeout: 30_000 }, async t => {
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
  const { provisionMember, revokeMember, readMember, grantSchema } = await import('./claude-members.js');
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
  assert.equal(grantSchema.safeParse({ writes: { shopify: true } }).success, false);
  assert.equal(grantSchema.safeParse({ googleAds: [{ id: '1234567890', connectionId }],
    writes: { googleAdsCustomerIds: ['9999999999'] } }).success, false);
  const writer = await provisionMember('writer@example.com', {
    shopify: 'test-shop', googleAds: [{ id: '1234567890', connectionId }, { id: '2222222222', connectionId }],
    writes: { shopify: true, googleAdsCustomerIds: ['1234567890'] },
  });

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

  // A real browser keeps both cookies when a reconnect opens a second page.
  // Previously both responses used one cookie name and the first page failed.
  const parallelPages = await Promise.all([fetch(authorizationUrl), fetch(authorizationUrl)]);
  const parallel = await Promise.all(parallelPages.map(async response => {
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const name = cookie.split('=')[0]!;
    const flow = /name="flow" value="([^"]+)"/.exec(await response.text())![1]!;
    return { cookie, name, flow };
  }));
  assert.notEqual(parallel[0]!.name, parallel[1]!.name);
  const submitParallel = (index: number, cookie: string) => fetch(baseUrl + '/claude/oauth/login', {
    method: 'POST', redirect: 'manual', headers: { cookie },
    body: new URLSearchParams({ flow: parallel[index]!.flow, email: member.email, password: member.password }),
  });
  const missingProof = await submitParallel(0, parallel[1]!.cookie);
  assert.equal(missingProof.status, 400);
  assert.match(await missingProof.text(), /did not return the sign-in cookie/);
  const wrongProof = await submitParallel(0, parallel[0]!.name + '=' + 'x'.repeat(43));
  assert.equal(wrongProof.status, 400);
  assert.match(await wrongProof.text(), /browser sign-in session changed/);
  const bothCookies = parallel.map(page => page.cookie).join('; ');
  for (let index = 0; index < parallel.length; index++) {
    const response = await submitParallel(index, index === 0 ? bothCookies : parallel[1]!.cookie);
    assert.equal(response.status, 303);
    assert.ok(response.headers.get('set-cookie')!.startsWith(parallel[index]!.name + '='));
    const code = new URL(response.headers.get('location')!).searchParams.get('code')!;
    assert.equal((await tokenRequest({ ...exchange, code })).status, 200);
    assert.equal((await submitParallel(index, bothCookies)).status, 400);
  }
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
    writeAccess: { shopify: false, googleAdsCustomerIds: [] },
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

  async function signIn(credentials: { email: string; password: string }, scope: string) {
    const url = new URL(authorizationUrl);
    url.searchParams.set('scope', scope);
    const response = await fetch(url);
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    const flow = /name="flow" value="([^"]+)"/.exec(await response.text())?.[1];
    assert.ok(cookie && flow);
    const login = await fetch(baseUrl + '/claude/oauth/login', {
      method: 'POST', body: new URLSearchParams({ flow, ...credentials }), headers: { cookie }, redirect: 'manual',
    });
    assert.equal(login.status, 303);
    const code = new URL(login.headers.get('location')!).searchParams.get('code')!;
    const token = await tokenRequest({ ...exchange, code });
    assert.equal(token.status, 200);
    return token.json();
  }
  const readTokens = await signIn(writer, 'mcp:read offline_access');
  const readClient = await connect(resource, readTokens.access_token);
  assert.ok(!(await readClient.listTools()).tools.some(tool => tool.name.startsWith('apply_')));
  const expandedRefresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: readTokens.refresh_token,
    resource, scope: 'mcp:read mcp:write offline_access' });
  assert.equal(expandedRefresh.status, 400);

  // Sessions issued by v0.15/v0.16 have no scope claim and must stay read-only.
  const signingKey = createHmac('sha256', Buffer.from('0'.repeat(64), 'hex'))
    .update(JSON.stringify(['claude-session-v1', baseUrl + '/claude', clientId])).digest();
  const oldPayload = Buffer.from(JSON.stringify({ email: writer.email, version: (await readMember(writer.email))!.sessionVersion,
    kind: 'access', expires: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  const oldToken = 'hub1.' + oldPayload + '.' + createHmac('sha256', signingKey).update(oldPayload).digest('base64url');
  const oldClient = await connect(resource, oldToken);
  assert.ok(!(await oldClient.listTools()).tools.some(tool => tool.name.startsWith('apply_')));

  const deniedTokens = await signIn(other, 'mcp:read mcp:write offline_access');
  assert.equal(deniedTokens.scope, 'mcp:read offline_access');
  const deniedClient = await connect(resource, deniedTokens.access_token);
  assert.ok(!(await deniedClient.listTools()).tools.some(tool => tool.name.startsWith('apply_')));

  const writeTokens = await signIn(writer, 'mcp:read mcp:write offline_access');
  assert.equal(writeTokens.scope, 'mcp:read mcp:write offline_access');
  const writeClient = await connect(resource, writeTokens.access_token);
  const writeTools = (await writeClient.listTools()).tools;
  assert.ok(writeTools.some(tool => tool.name === 'apply_shopify_admin_mutation'));
  assert.ok(writeTools.some(tool => tool.name === 'preview_shopify_launch_preparation'));
  assert.ok(writeTools.some(tool => tool.name === 'apply_google_ads_conversion_primary_update'));
  assert.ok(!writeTools.some(tool => tool.name === 'list_google_connections'));
  const listed = await writeClient.callTool({ name: 'list_authorized_accounts', arguments: {} });
  assert.deepEqual(JSON.parse((listed.content as [{ text: string }])[0].text).writeAccess,
    { shopify: true, googleAdsCustomerIds: ['1234567890'] });

  let adsPrimary = true;
  let writes = 0;
  let upstreamCalls = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith(baseUrl + '/')) return originalFetch(input, init);
    upstreamCalls++;
    const url = String(input);
    assert.match(url, /^https:\/\/googleads.googleapis.com\/v\d+\/customers\/1234567890\//);
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-access-token');
    if (url.endsWith('/googleAds:searchStream')) return Response.json([{ results: [{ conversionAction: {
      resourceName: 'customers/1234567890/conversionActions/987', id: '987', name: 'Purchase', status: 'ENABLED',
      type: 'GOOGLE_ANALYTICS_4_PURCHASE', category: 'PURCHASE', primaryForGoal: adsPrimary,
    } }] }]);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.operations[0].updateMask, 'primaryForGoal');
    if (!body.validateOnly) { writes++; adsPrimary = false; }
    return Response.json({ results: [{ resourceName: 'customers/1234567890/conversionActions/987' }] });
  };
  try {
    const args = { customerId: '2222222222', conversionActionId: '987', primaryForGoal: false };
    const previewName = 'preview_google_ads_conversion_primary_update';
    assert.equal((await writeClient.callTool({ name: previewName, arguments: args })).isError, true);
    assert.equal(upstreamCalls, 0); // Reporting permission alone never authorizes a write.
    const allowed = { ...args, customerId: '123-456-7890', connectionId: 'spoofed' };
    const previewResult = await writeClient.callTool({ name: previewName, arguments: allowed });
    assert.notEqual(previewResult.isError, true);
    const preview = JSON.parse((previewResult.content as [{ text: string }])[0].text);
    assert.equal(writes, 0);
    const approval = { ...allowed, confirmationCode: preview.safety.confirmationCode, confirmationToken: preview.confirmationToken };
    const applyName = 'apply_google_ads_conversion_primary_update';
    assert.equal((await writeClient.callTool({ name: applyName, arguments: { ...approval, confirmationCode: 'GOOGLE-ADS-00000000' } })).isError, true);
    assert.equal(writes, 0);
    const callsBeforeDenial = upstreamCalls;
    assert.equal((await writeClient.callTool({ name: applyName, arguments: { ...approval, customerId: '2222222222' } })).isError, true);
    assert.equal(upstreamCalls, callsBeforeDenial);
    assert.notEqual((await writeClient.callTool({ name: applyName, arguments: approval })).isError, true);
    assert.equal(writes, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
  // Replacing grants immediately invalidates write tokens and their refresh token.
  await provisionMember(writer.email, { shopify: 'test-shop' });
  assert.equal((await fetch(resource, { headers: { authorization: 'Bearer ' + writeTokens.access_token } })).status, 401);
  assert.equal((await tokenRequest({ grant_type: 'refresh_token', refresh_token: writeTokens.refresh_token, resource })).status, 400);
  await revokeMember(other.email);
  assert.equal((await fetch(resource, { headers: { authorization: 'Bearer ' + otherTokens.access_token } })).status, 401);

  const legacy = await connect(baseUrl + '/mcp', legacyToken);
  const legacyTools = (await legacy.listTools()).tools.map(tool => tool.name);
  assert.ok(legacyTools.includes('list_google_connections'));
  assert.ok(legacyTools.includes('apply_shopify_admin_mutation'));
  assert.ok(!legacyTools.includes('list_authorized_accounts'));
});
