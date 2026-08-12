import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const testDirectory = await mkdtemp(join(tmpdir(), 'marketing-mcp-registration-'));

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

const { registerMerchantGcp } = await import('./merchant-center.js');
const { upsertConnection } = await import('./token-store.js');

after(async () => {
  await rm(testDirectory, { recursive: true, force: true });
});

test('registers the configured GCP project through the matching OAuth identity', async (context) => {
  await upsertConnection({
    id: 'max-connection',
    email: 'max@flow.fast',
    refreshToken: 'not-used',
    accessToken: 'access-token',
    accessTokenExpiresAt: Date.now() + 60_000,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input, init) => {
    assert.equal(
      String(input),
      'https://merchantapi.googleapis.com/accounts/v1/accounts/5500122470/developerRegistration:registerGcp',
    );
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer access-token');
    assert.deepEqual(JSON.parse(String(init?.body)), { developerEmail: 'max@flow.fast' });
    return new Response(JSON.stringify({ name: 'accounts/5500122470/developerRegistration' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await registerMerchantGcp({
    connectionId: 'max@flow.fast',
    accountId: '5500122470',
    developerEmail: 'max@flow.fast',
  });

  assert.equal(result.connection.email, 'max@flow.fast');
  assert.equal(result.accountId, '5500122470');
  assert.equal(result.developerRegistration.name, 'accounts/5500122470/developerRegistration');
});

test('refuses registration when OAuth and developer identities differ', async (context) => {
  await upsertConnection({
    id: 'other-connection',
    email: 'other@example.com',
    refreshToken: 'not-used',
    accessToken: 'access-token',
    accessTokenExpiresAt: Date.now() + 60_000,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => {
    assert.fail('Merchant API must not be called for a mismatched OAuth identity.');
  };

  await assert.rejects(
    registerMerchantGcp({
      connectionId: 'other@example.com',
      accountId: '5500122470',
      developerEmail: 'max@flow.fast',
    }),
    /does not match developer email/,
  );
});
