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
});

const {
  assertReadOnlyMerchantQuery,
  buildMerchantProductStatusQuery,
  normalizeMerchantAccountId,
} = await import('./merchant-center.js');

test('normalizes plain and resource-form Merchant Center account IDs', () => {
  assert.equal(normalizeMerchantAccountId('123456789'), '123456789');
  assert.equal(normalizeMerchantAccountId('accounts/123456789'), '123456789');
  assert.throws(() => normalizeMerchantAccountId('accounts/not-an-id'), /digits only/);
});

test('accepts one read-only MCQL SELECT and rejects unsafe statements', () => {
  assert.doesNotThrow(() => assertReadOnlyMerchantQuery('SELECT offer_id FROM product_view'));
  assert.throws(() => assertReadOnlyMerchantQuery('DELETE FROM product_view'), /must start with SELECT/);
  assert.throws(
    () => assertReadOnlyMerchantQuery('SELECT offer_id FROM product_view; DELETE FROM product_view'),
    /read-only/,
  );
});

test('builds a bounded product-status query and escapes offer IDs', () => {
  const query = buildMerchantProductStatusQuery({
    offerId: "sku'42",
    status: 'ELIGIBLE_LIMITED',
    reportingContext: 'SHOPPING_ADS',
    limit: 50,
  });
  assert.match(query, /offer_id = 'sku\\'42'/);
  assert.match(query, /aggregated_reporting_context_status = 'ELIGIBLE_LIMITED'/);
  assert.match(query, /reporting_context = 'SHOPPING_ADS'/);
  assert.match(query, /LIMIT 50$/);
});
