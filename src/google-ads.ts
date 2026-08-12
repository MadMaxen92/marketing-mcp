import { config } from './config.js';
import { getAccessToken } from './google.js';

const GOOGLE_ADS_API_VERSION = 'v25';
const BASE_URL = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`;

function normalizeCustomerId(value: string): string {
  return value.replace(/-/g, '');
}

function assertCustomerId(value: string): string {
  const normalized = normalizeCustomerId(value);
  if (!/^\d{10}$/.test(normalized)) throw new Error('Google Ads customer ID must contain 10 digits.');
  return normalized;
}

async function googleAdsJson(
  url: string,
  token: string,
  init?: RequestInit,
  includeLoginCustomerId = true,
): Promise<any> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    'developer-token': config.GOOGLE_ADS_DEVELOPER_TOKEN,
    'content-type': 'application/json',
  };
  if (includeLoginCustomerId) {
    headers['login-customer-id'] = config.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
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

async function searchStream(customerId: string, query: string, connectionId?: string): Promise<any[]> {
  const customer = assertCustomerId(customerId);
  const { token } = await getAccessToken(connectionId);
  const body = await googleAdsJson(
    `${BASE_URL}/customers/${customer}/googleAds:searchStream`,
    token,
    { method: 'POST', body: JSON.stringify({ query }) },
  );
  return Array.isArray(body) ? body.flatMap((batch) => batch.results ?? []) : [];
}

export async function listGoogleAdsAccounts(connectionId?: string): Promise<any> {
  const { token, connection } = await getAccessToken(connectionId);
  const accessible = await googleAdsJson(
    `${BASE_URL}/customers:listAccessibleCustomers`,
    token,
    { method: 'GET' },
    false,
  );

  const managerId = config.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  let managedAccounts: any[] = [];
  try {
    managedAccounts = await searchStream(
      managerId,
      `SELECT
        customer_client.id,
        customer_client.descriptive_name,
        customer_client.manager,
        customer_client.level,
        customer_client.status,
        customer_client.currency_code,
        customer_client.time_zone
      FROM customer_client
      WHERE customer_client.level <= 1
      ORDER BY customer_client.descriptive_name`,
      connectionId,
    );
  } catch (error) {
    managedAccounts = [{ warning: error instanceof Error ? error.message : String(error) }];
  }

  return {
    connection: { id: connection.id, email: connection.email },
    loginCustomerId: managerId,
    directlyAccessibleCustomerResourceNames: accessible.resourceNames ?? [],
    managedAccounts,
  };
}

export async function getGoogleAdsAccountOverview(input: {
  connectionId?: string;
  customerId: string;
  startDate: string;
  endDate: string;
}): Promise<any> {
  const customerId = assertCustomerId(input.customerId);
  const rows = await searchStream(
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
  const rows = await searchStream(
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
  const rows = await searchStream(
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
  const rows = await searchStream(customerId, input.query, input.connectionId);
  return { customerId, rows };
}
