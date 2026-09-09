import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
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
  assertConversionActionId,
  buildConversionActionPrimaryMutationBody,
  verifyConversionPrimaryConfirmation,
} = await import('./google-ads.js');

function signedToken(expiresAt: string): string {
  const payload = {
    version: 1,
    kind: 'conversion_action_primary_for_goal',
    connectionId: 'connection-1',
    customerId: '7158961762',
    conversionActionId: '7717312012',
    expected: {
      resourceName: 'customers/7158961762/conversionActions/7717312012',
      id: '7717312012',
      name: 'Purchase',
      status: 'ENABLED',
      type: 'GOOGLE_ANALYTICS_4_PURCHASE',
      category: 'PURCHASE',
      primaryForGoal: true,
    },
    proposedPrimaryForGoal: false,
    confirmationCode: 'GOOGLE-ADS-ABCDEF12',
    expiresAt,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', process.env.ADMIN_TOKEN!).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

test('accepts numeric conversion action IDs and rejects unsafe input', () => {
  assert.equal(assertConversionActionId('7717312012'), '7717312012');
  assert.throws(() => assertConversionActionId('7717 OR 1=1'), /digits only/);
  assert.throws(() => assertConversionActionId(''), /digits only/);
});

test('builds a mutation that can change only primaryForGoal', () => {
  assert.deepEqual(
    buildConversionActionPrimaryMutationBody(
      'customers/7158961762/conversionActions/7717312012',
      false,
      true,
    ),
    {
      operations: [{
        update: {
          resourceName: 'customers/7158961762/conversionActions/7717312012',
          primaryForGoal: false,
        },
        updateMask: 'primaryForGoal',
      }],
      partialFailure: false,
      validateOnly: true,
    },
  );
  assert.throws(
    () => buildConversionActionPrimaryMutationBody('customers/7158961762/campaigns/123', false),
    /Invalid Google Ads conversion action resource name/,
  );
});

test('verifies a valid signed Google Ads confirmation and rejects tampering', () => {
  const token = signedToken(new Date(Date.now() + 60_000).toISOString());
  assert.equal(verifyConversionPrimaryConfirmation(token).proposedPrimaryForGoal, false);
  const [encoded, signature] = token.split('.');
  assert.ok(encoded && signature);
  const tampered = `${encoded.slice(0, -1)}A.${signature}`;
  assert.throws(() => verifyConversionPrimaryConfirmation(tampered), /Invalid Google Ads confirmation token/);
});

test('rejects expired Google Ads confirmations', () => {
  const token = signedToken(new Date(Date.now() - 1_000).toISOString());
  assert.throws(() => verifyConversionPrimaryConfirmation(token), /confirmation expired/);
});
