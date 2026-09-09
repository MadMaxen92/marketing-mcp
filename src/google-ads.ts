import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { getAccessToken } from './google.js';

const GOOGLE_ADS_API_VERSION = 'v25';
const BASE_URL = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`;
const GOOGLE_ADS_WRITE_CONFIRMATION_TTL_MS = 10 * 60 * 1000;

type GoogleAdsConversionActionSnapshot = {
  resourceName: string;
  id: string;
  name: string;
  status: string;
  type: string;
  category: string;
  primaryForGoal: boolean;
};

type GoogleAdsConversionPrimaryConfirmation = {
  version: 1;
  kind: 'conversion_action_primary_for_goal';
  connectionId: string;
  customerId: string;
  conversionActionId: string;
  expected: GoogleAdsConversionActionSnapshot;
  proposedPrimaryForGoal: boolean;
  confirmationCode: string;
  expiresAt: string;
};

function normalizeCustomerId(value: string): string {
  return value.replace(/-/g, '');
}

function assertCustomerId(value: string): string {
  const normalized = normalizeCustomerId(value);
  if (!/^\d{10}$/.test(normalized)) throw new Error('Google Ads customer ID must contain 10 digits.');
  return normalized;
}

export function assertConversionActionId(value: string): string {
  if (!/^\d+$/.test(value)) throw new Error('Google Ads conversion action ID must contain digits only.');
  return value;
}

function isUserPermissionDenied(error: unknown): boolean {
  return error instanceof Error && error.message.includes('USER_PERMISSION_DENIED');
}

async function googleAdsJson(
  url: string,
  token: string,
  init?: RequestInit,
  loginCustomerId?: string,
): Promise<any> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    'developer-token': config.GOOGLE_ADS_DEVELOPER_TOKEN,
    'content-type': 'application/json',
  };
  if (loginCustomerId) {
    headers['login-customer-id'] = assertCustomerId(loginCustomerId);
  }

  const response = await fetch(url, {
    ...init,
    headers: { ...headers, ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) throw new Error(`Google Ads API error ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function searchStream(
  customerId: string,
  query: string,
  connectionId?: string,
  loginCustomerId: string | undefined = config.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
): Promise<any[]> {
  const customer = assertCustomerId(customerId);
  const { token } = await getAccessToken(connectionId);
  const body = await googleAdsJson(
    `${BASE_URL}/customers/${customer}/googleAds:searchStream`,
    token,
    { method: 'POST', body: JSON.stringify({ query }) },
    loginCustomerId,
  );
  return Array.isArray(body) ? body.flatMap((batch) => batch.results ?? []) : [];
}

async function searchStreamWithDirectFallback(
  customerId: string,
  query: string,
  connectionId?: string,
): Promise<any[]> {
  try {
    return await searchStream(customerId, query, connectionId, config.GOOGLE_ADS_LOGIN_CUSTOMER_ID);
  } catch (error) {
    if (!isUserPermissionDenied(error)) throw error;
    return searchStream(customerId, query, connectionId, undefined);
  }
}

async function mutateConversionActionsWithDirectFallback(
  customerId: string,
  body: unknown,
  connectionId?: string,
): Promise<any> {
  const customer = assertCustomerId(customerId);
  const { token } = await getAccessToken(connectionId);
  const url = `${BASE_URL}/customers/${customer}/conversionActions:mutate`;
  try {
    return await googleAdsJson(
      url,
      token,
      { method: 'POST', body: JSON.stringify(body) },
      config.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
    );
  } catch (error) {
    if (!isUserPermissionDenied(error)) throw error;
    return googleAdsJson(url, token, { method: 'POST', body: JSON.stringify(body) });
  }
}

export function buildConversionActionPrimaryMutationBody(
  resourceName: string,
  primaryForGoal: boolean,
  validateOnly = false,
): any {
  if (!/^customers\/\d{10}\/conversionActions\/\d+$/.test(resourceName)) {
    throw new Error('Invalid Google Ads conversion action resource name.');
  }
  return {
    operations: [{
      update: { resourceName, primaryForGoal },
      updateMask: 'primaryForGoal',
    }],
    partialFailure: false,
    validateOnly,
  };
}

function signConversionPrimaryConfirmation(payload: GoogleAdsConversionPrimaryConfirmation): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', config.ADMIN_TOKEN).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

export function verifyConversionPrimaryConfirmation(token: string): GoogleAdsConversionPrimaryConfirmation {
  const [encoded, signature, extra] = token.split('.');
  if (!encoded || !signature || extra) throw new Error('Invalid Google Ads confirmation token. Create a new preview.');
  const expectedSignature = createHmac('sha256', config.ADMIN_TOKEN).update(encoded).digest();
  let receivedSignature: Buffer;
  try {
    receivedSignature = Buffer.from(signature, 'base64url');
  } catch {
    throw new Error('Invalid Google Ads confirmation token. Create a new preview.');
  }
  if (receivedSignature.length !== expectedSignature.length || !timingSafeEqual(receivedSignature, expectedSignature)) {
    throw new Error('Invalid Google Ads confirmation token. Create a new preview.');
  }

  let payload: GoogleAdsConversionPrimaryConfirmation;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid Google Ads confirmation token. Create a new preview.');
  }
  if (
    payload.version !== 1
    || payload.kind !== 'conversion_action_primary_for_goal'
    || typeof payload.connectionId !== 'string'
    || !/^\d{10}$/.test(payload.customerId)
    || !/^\d+$/.test(payload.conversionActionId)
    || typeof payload.proposedPrimaryForGoal !== 'boolean'
    || !/^GOOGLE-ADS-[A-F0-9]{8}$/.test(payload.confirmationCode)
    || typeof payload.expiresAt !== 'string'
    || !Number.isFinite(Date.parse(payload.expiresAt))
    || !payload.expected
    || typeof payload.expected.primaryForGoal !== 'boolean'
  ) {
    throw new Error('Invalid Google Ads confirmation token. Create a new preview.');
  }
  if (Date.parse(payload.expiresAt) <= Date.now()) {
    throw new Error('Google Ads confirmation expired. Create a new preview.');
  }
  return payload;
}

async function getConversionActionSnapshot(input: {
  connectionId?: string;
  customerId: string;
  conversionActionId: string;
}): Promise<GoogleAdsConversionActionSnapshot> {
  const customerId = assertCustomerId(input.customerId);
  const conversionActionId = assertConversionActionId(input.conversionActionId);
  const rows = await searchStreamWithDirectFallback(
    customerId,
    `SELECT
      conversion_action.id,
      conversion_action.name,
      conversion_action.status,
      conversion_action.type,
      conversion_action.category,
      conversion_action.primary_for_goal
    FROM conversion_action
    WHERE conversion_action.id = ${conversionActionId}`,
    input.connectionId,
  );
  if (rows.length !== 1 || !rows[0]?.conversionAction) {
    throw new Error('Google Ads conversion action was not found or is not accessible.');
  }
  const action = rows[0].conversionAction;
  const snapshot: GoogleAdsConversionActionSnapshot = {
    resourceName: String(action.resourceName ?? `customers/${customerId}/conversionActions/${conversionActionId}`),
    id: String(action.id ?? conversionActionId),
    name: String(action.name ?? ''),
    status: String(action.status ?? ''),
    type: String(action.type ?? ''),
    category: String(action.category ?? ''),
    primaryForGoal: Boolean(action.primaryForGoal),
  };
  if (snapshot.category !== 'PURCHASE') {
    throw new Error('Only PURCHASE conversion actions can be changed by this guarded tool.');
  }
  if (snapshot.status !== 'ENABLED') {
    throw new Error('Only ENABLED purchase conversion actions can be changed by this guarded tool.');
  }
  return snapshot;
}

const CUSTOMER_CLIENT_QUERY = `SELECT
  customer_client.id,
  customer_client.descriptive_name,
  customer_client.manager,
  customer_client.level,
  customer_client.status,
  customer_client.currency_code,
  customer_client.time_zone
FROM customer_client
WHERE customer_client.level <= 1
ORDER BY customer_client.descriptive_name`;

export async function listGoogleAdsAccounts(connectionId?: string): Promise<any> {
  const { token, connection } = await getAccessToken(connectionId);
  const accessible = await googleAdsJson(
    `${BASE_URL}/customers:listAccessibleCustomers`,
    token,
    { method: 'GET' },
  );

  const managerId = assertCustomerId(config.GOOGLE_ADS_LOGIN_CUSTOMER_ID);
  const directlyAccessibleCustomerIds = (accessible.resourceNames ?? [])
    .map((name: string) => name.split('/').pop())
    .filter((id: string | undefined): id is string => !!id && /^\d{10}$/.test(id));

  const hierarchies: Array<{ seedCustomerId: string; rows?: any[]; warning?: string }> = [];

  // Google's recommended hierarchy-discovery pattern is to start from each
  // directly accessible customer without forcing a login-customer-id.
  for (const seedCustomerId of directlyAccessibleCustomerIds) {
    try {
      const rows = await searchStream(seedCustomerId, CUSTOMER_CLIENT_QUERY, connectionId, undefined);
      hierarchies.push({ seedCustomerId, rows });
    } catch (error) {
      hierarchies.push({
        seedCustomerId,
        warning: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Also try the configured MCC explicitly. This is useful when the manager is
  // not included in listAccessibleCustomers for the OAuth identity, while still
  // preserving the diagnostic error instead of failing the whole tool.
  let configuredManagerHierarchy: any[] | undefined;
  let configuredManagerWarning: string | undefined;
  try {
    configuredManagerHierarchy = await searchStream(managerId, CUSTOMER_CLIENT_QUERY, connectionId, managerId);
  } catch (error) {
    configuredManagerWarning = error instanceof Error ? error.message : String(error);
  }

  return {
    connection: { id: connection.id, email: connection.email },
    loginCustomerId: managerId,
    directlyAccessibleCustomerResourceNames: accessible.resourceNames ?? [],
    directlyAccessibleCustomerIds,
    hierarchies,
    configuredManagerHierarchy,
    configuredManagerWarning,
  };
}

export async function getGoogleAdsAccountOverview(input: {
  connectionId?: string;
  customerId: string;
  startDate: string;
  endDate: string;
}): Promise<any> {
  const customerId = assertCustomerId(input.customerId);
  const rows = await searchStreamWithDirectFallback(
    customerId,
    `SELECT
      customer.id,
      customer.descriptive_name,
      customer.currency_code,
      customer.time_zone,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM customer
    WHERE segments.date BETWEEN '${input.startDate}' AND '${input.endDate}'`,
    input.connectionId,
  );
  return { customerId, startDate: input.startDate, endDate: input.endDate, rows };
}

export async function getGoogleAdsCampaignPerformance(input: {
  connectionId?: string;
  customerId: string;
  startDate: string;
  endDate: string;
  limit?: number;
}): Promise<any> {
  const customerId = assertCustomerId(input.customerId);
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
  const rows = await searchStreamWithDirectFallback(
    customerId,
    `SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.advertising_channel_type,
      metrics.impressions,
      metrics.clicks,
      metrics.ctr,
      metrics.average_cpc,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value,
      metrics.cost_per_conversion
    FROM campaign
    WHERE segments.date BETWEEN '${input.startDate}' AND '${input.endDate}'
      AND campaign.status != 'REMOVED'
    ORDER BY metrics.cost_micros DESC
    LIMIT ${limit}`,
    input.connectionId,
  );
  return { customerId, startDate: input.startDate, endDate: input.endDate, rows };
}

export async function getGoogleAdsSearchTerms(input: {
  connectionId?: string;
  customerId: string;
  startDate: string;
  endDate: string;
  limit?: number;
}): Promise<any> {
  const customerId = assertCustomerId(input.customerId);
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
  const rows = await searchStreamWithDirectFallback(
    customerId,
    `SELECT
      search_term_view.search_term,
      campaign.id,
      campaign.name,
      ad_group.id,
      ad_group.name,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM search_term_view
    WHERE segments.date BETWEEN '${input.startDate}' AND '${input.endDate}'
    ORDER BY metrics.cost_micros DESC
    LIMIT ${limit}`,
    input.connectionId,
  );
  return { customerId, startDate: input.startDate, endDate: input.endDate, rows };
}

export async function runGoogleAdsQuery(input: {
  connectionId?: string;
  customerId: string;
  query: string;
}): Promise<any> {
  const forbidden = /\b(MUTATE|CREATE|UPDATE|REMOVE)\b/i;
  if (forbidden.test(input.query)) throw new Error('Only read-only GAQL SELECT queries are allowed.');
  if (!/^\s*SELECT\b/i.test(input.query)) throw new Error('GAQL query must start with SELECT.');
  const customerId = assertCustomerId(input.customerId);
  const rows = await searchStreamWithDirectFallback(customerId, input.query, input.connectionId);
  return { customerId, rows };
}

export async function previewGoogleAdsConversionPrimaryUpdate(input: {
  connectionId?: string;
  customerId: string;
  conversionActionId: string;
  primaryForGoal: boolean;
}): Promise<any> {
  const customerId = assertCustomerId(input.customerId);
  const conversionActionId = assertConversionActionId(input.conversionActionId);
  const { connection } = await getAccessToken(input.connectionId);
  const current = await getConversionActionSnapshot({
    connectionId: connection.id,
    customerId,
    conversionActionId,
  });
  if (current.primaryForGoal === input.primaryForGoal) {
    throw new Error(`Conversion action is already ${input.primaryForGoal ? 'Primary' : 'Secondary'}; no change is required.`);
  }

  const confirmationCode = `GOOGLE-ADS-${randomBytes(4).toString('hex').toUpperCase()}`;
  const expiresAt = new Date(Date.now() + GOOGLE_ADS_WRITE_CONFIRMATION_TTL_MS).toISOString();
  const confirmation: GoogleAdsConversionPrimaryConfirmation = {
    version: 1,
    kind: 'conversion_action_primary_for_goal',
    connectionId: connection.id,
    customerId,
    conversionActionId,
    expected: current,
    proposedPrimaryForGoal: input.primaryForGoal,
    confirmationCode,
    expiresAt,
  };

  await mutateConversionActionsWithDirectFallback(
    customerId,
    buildConversionActionPrimaryMutationBody(current.resourceName, input.primaryForGoal, true),
    connection.id,
  );

  return {
    dryRun: true,
    apiVersion: GOOGLE_ADS_API_VERSION,
    connection: { id: connection.id, email: connection.email },
    customerId,
    conversionAction: current,
    proposedChange: {
      field: 'primaryForGoal',
      from: current.primaryForGoal,
      to: input.primaryForGoal,
      resultingRole: input.primaryForGoal ? 'PRIMARY' : 'SECONDARY',
    },
    safety: {
      validateOnlyPassed: true,
      touchesOnly: ['conversion_action.primary_for_goal'],
      excluded: ['campaigns', 'budgets', 'bids', 'ads', 'conversion values', 'conversion windows', 'deletions'],
      confirmationCode,
      expiresAt,
      instruction: `Show this preview to the user. Apply it only after the user explicitly replies with ${confirmationCode}.`,
    },
    confirmationToken: signConversionPrimaryConfirmation(confirmation),
  };
}

export async function applyGoogleAdsConversionPrimaryUpdate(input: {
  connectionId?: string;
  customerId: string;
  conversionActionId: string;
  primaryForGoal: boolean;
  confirmationCode: string;
  confirmationToken: string;
}): Promise<any> {
  const confirmation = verifyConversionPrimaryConfirmation(input.confirmationToken);
  const customerId = assertCustomerId(input.customerId);
  const conversionActionId = assertConversionActionId(input.conversionActionId);
  const { connection } = await getAccessToken(input.connectionId);
  if (
    confirmation.connectionId !== connection.id
    || confirmation.customerId !== customerId
    || confirmation.conversionActionId !== conversionActionId
    || confirmation.proposedPrimaryForGoal !== input.primaryForGoal
    || confirmation.confirmationCode !== input.confirmationCode
  ) {
    throw new Error('Google Ads confirmation does not match this conversion-action update. Create a new preview.');
  }

  const current = await getConversionActionSnapshot({
    connectionId: connection.id,
    customerId,
    conversionActionId,
  });
  if (JSON.stringify(current) !== JSON.stringify(confirmation.expected)) {
    throw new Error('The Google Ads conversion action changed after preview. Review it and create a new preview.');
  }

  const response = await mutateConversionActionsWithDirectFallback(
    customerId,
    buildConversionActionPrimaryMutationBody(current.resourceName, input.primaryForGoal),
    connection.id,
  );
  const updated = await getConversionActionSnapshot({
    connectionId: connection.id,
    customerId,
    conversionActionId,
  });
  if (updated.primaryForGoal !== input.primaryForGoal) {
    throw new Error('Google Ads accepted the mutation but the requested Primary/Secondary state was not observed.');
  }

  console.info(JSON.stringify({
    event: 'google_ads_conversion_primary_updated',
    connectionId: connection.id,
    customerId,
    conversionActionId,
    from: current.primaryForGoal,
    to: updated.primaryForGoal,
  }));
  return {
    applied: true,
    apiVersion: GOOGLE_ADS_API_VERSION,
    customerId,
    before: current,
    after: updated,
    mutationResourceName: response.results?.[0]?.resourceName ?? current.resourceName,
  };
}
