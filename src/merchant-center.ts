import { getAccessToken } from './google.js';

const MERCHANT_API_BASE_URL = 'https://merchantapi.googleapis.com';

export const MERCHANT_PRODUCT_STATUSES = [
  'ELIGIBLE',
  'ELIGIBLE_LIMITED',
  'PENDING',
  'NOT_ELIGIBLE_OR_DISAPPROVED',
] as const;

type MerchantProductStatus = (typeof MERCHANT_PRODUCT_STATUSES)[number];

export class MerchantApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly responseBody: unknown,
  ) {
    super(`Merchant API error ${status}: ${JSON.stringify(responseBody)}`);
    this.name = 'MerchantApiError';
  }
}

export function isMerchantGcpNotRegisteredError(error: unknown): boolean {
  if (!(error instanceof MerchantApiError) || error.status !== 401) return false;
  const body = error.responseBody as {
    error?: { details?: Array<{ metadata?: { REASON?: string } }> };
  };
  return body.error?.details?.some((detail) => detail.metadata?.REASON === 'GCP_NOT_REGISTERED') ?? false;
}

export function normalizeMerchantAccountId(value: string): string {
  const normalized = value.replace(/^accounts\//, '');
  if (!/^\d+$/.test(normalized)) throw new Error('Merchant Center account ID must contain digits only.');
  return normalized;
}

function escapeMcqlString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

function merchantUrl(path: string, query?: Record<string, string | number | undefined>): string {
  const url = new URL(path, MERCHANT_API_BASE_URL);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function merchantRequest(token: string, path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(merchantUrl(path), {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) throw new MerchantApiError(response.status, body);
  return body;
}

async function merchantJson(connectionId: string | undefined, path: string, init?: RequestInit): Promise<{
  body: any;
  connection: { id: string; email: string };
}> {
  const { token, connection } = await getAccessToken(connectionId);
  const body = await merchantRequest(token, path, init);
  return { body, connection: { id: connection.id, email: connection.email } };
}

async function merchantGet(
  connectionId: string | undefined,
  path: string,
  query?: Record<string, string | number | undefined>,
): Promise<{ body: any; connection: { id: string; email: string } }> {
  return merchantJson(connectionId, merchantUrl(path, query), { method: 'GET' });
}

async function searchMerchantReports(input: {
  connectionId?: string;
  accountId: string;
  query: string;
  pageSize?: number;
  pageToken?: string;
}): Promise<any> {
  const accountId = normalizeMerchantAccountId(input.accountId);
  const { body, connection } = await merchantJson(
    input.connectionId,
    `/reports/v1/accounts/${accountId}/reports:search`,
    {
      method: 'POST',
      body: JSON.stringify({
        query: input.query,
        pageSize: Math.min(Math.max(input.pageSize ?? 1000, 1), 5000),
        ...(input.pageToken ? { pageToken: input.pageToken } : {}),
      }),
    },
  );
  return { connection, accountId, query: input.query, ...body };
}

export function assertReadOnlyMerchantQuery(query: string): void {
  if (!/^\s*SELECT\b/i.test(query)) throw new Error('MCQL query must start with SELECT.');
  if (/\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|MUTATE|REMOVE)\b/i.test(query)) {
    throw new Error('Only read-only MCQL SELECT queries are allowed.');
  }
  if (query.includes(';')) throw new Error('MCQL query must contain a single SELECT statement without a semicolon.');
}

export async function listMerchantCenterAccounts(input: {
  connectionId?: string;
  pageSize?: number;
  pageToken?: string;
  filter?: string;
}): Promise<any> {
  const { body, connection } = await merchantGet(input.connectionId, '/accounts/v1/accounts', {
    pageSize: Math.min(Math.max(input.pageSize ?? 250, 1), 500),
    pageToken: input.pageToken,
    filter: input.filter,
  });
  return { connection, ...body };
}

export async function getMerchantAccountOverview(input: {
  connectionId?: string;
  accountId: string;
}): Promise<any> {
  const accountId = normalizeMerchantAccountId(input.accountId);
  const accountPath = `/accounts/v1/accounts/${accountId}`;
  // Resolve or refresh the shared OAuth token before issuing the remaining
  // requests concurrently, avoiding simultaneous refreshes for an expired token.
  const account = await merchantGet(input.connectionId, accountPath);
  const [accountIssues, aggregateProductStatuses] = await Promise.all([
    merchantGet(input.connectionId, `${accountPath}/issues`, { pageSize: 100 }),
    merchantGet(
      input.connectionId,
      `/issueresolution/v1/accounts/${accountId}/aggregateProductStatuses`,
      { pageSize: 250 },
    ),
  ]);
  return {
    connection: account.connection,
    accountId,
    account: account.body,
    accountIssues: accountIssues.body.accountIssues ?? [],
    accountIssuesNextPageToken: accountIssues.body.nextPageToken,
    aggregateProductStatuses: aggregateProductStatuses.body.aggregateProductStatuses ?? [],
    aggregateProductStatusesNextPageToken: aggregateProductStatuses.body.nextPageToken,
  };
}

export async function registerMerchantGcp(input: {
  connectionId: string;
  accountId: string;
  developerEmail: string;
}): Promise<any> {
  const accountId = normalizeMerchantAccountId(input.accountId);
  const developerEmail = input.developerEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(developerEmail)) {
    throw new Error('Developer email must be a valid email address.');
  }

  const { token, connection } = await getAccessToken(input.connectionId);
  if (connection.email.trim().toLowerCase() !== developerEmail) {
    throw new Error(
      `Refusing Merchant registration: OAuth connection ${connection.email} does not match developer email ${developerEmail}.`,
    );
  }

  const developerRegistration = await merchantRequest(
    token,
    `/accounts/v1/accounts/${accountId}/developerRegistration:registerGcp`,
    {
      method: 'POST',
      body: JSON.stringify({ developerEmail }),
    },
  );

  return {
    connection: { id: connection.id, email: connection.email },
    accountId,
    developerRegistration,
  };
}

export function buildMerchantProductStatusQuery(input: {
  offerId?: string;
  status?: MerchantProductStatus;
  reportingContext?: string;
  limit?: number;
}): string {
  const conditions: string[] = [];
  if (input.offerId) conditions.push(`offer_id = '${escapeMcqlString(input.offerId)}'`);
  if (input.status) conditions.push(`aggregated_reporting_context_status = '${input.status}'`);
  if (input.reportingContext) conditions.push(`reporting_context = '${escapeMcqlString(input.reportingContext)}'`);
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
  return `SELECT
  id,
  offer_id,
  feed_label,
  title,
  brand,
  price,
  availability,
  reporting_context,
  aggregated_reporting_context_status,
  status_per_reporting_context,
  item_issues
FROM product_view${conditions.length ? `\nWHERE ${conditions.join('\n  AND ')}` : ''}
ORDER BY offer_id
LIMIT ${limit}`;
}

export async function getMerchantProductStatus(input: {
  connectionId?: string;
  accountId: string;
  offerId?: string;
  status?: MerchantProductStatus;
  reportingContext?: string;
  limit?: number;
  pageToken?: string;
}): Promise<any> {
  return searchMerchantReports({
    ...input,
    query: buildMerchantProductStatusQuery(input),
    pageSize: input.limit,
  });
}

export async function getMerchantProductIssues(input: {
  connectionId?: string;
  accountId: string;
  reportingContext?: string;
  limit?: number;
  pageToken?: string;
}): Promise<any> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
  const reportingContext = input.reportingContext
    ? `\n  AND reporting_context = '${escapeMcqlString(input.reportingContext)}'`
    : '';
  const query = `SELECT
  id,
  offer_id,
  feed_label,
  title,
  brand,
  reporting_context,
  aggregated_reporting_context_status,
  status_per_reporting_context,
  item_issues
FROM product_view
WHERE aggregated_reporting_context_status IN ('ELIGIBLE_LIMITED', 'NOT_ELIGIBLE_OR_DISAPPROVED')${reportingContext}
ORDER BY offer_id
LIMIT ${limit}`;
  return searchMerchantReports({ ...input, query, pageSize: limit });
}

export async function getMerchantProductPerformance(input: {
  connectionId?: string;
  accountId: string;
  startDate: string;
  endDate: string;
  limit?: number;
  pageToken?: string;
}): Promise<any> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
  const query = `SELECT
  offer_id,
  title,
  brand,
  marketing_method,
  customer_country_code,
  impressions,
  clicks,
  click_through_rate,
  conversions,
  conversion_rate,
  conversion_value
FROM product_performance_view
WHERE date BETWEEN '${input.startDate}' AND '${input.endDate}'
ORDER BY clicks DESC
LIMIT ${limit}`;
  return searchMerchantReports({ ...input, query, pageSize: limit });
}

export async function getMerchantPriceInsights(input: {
  connectionId?: string;
  accountId: string;
  limit?: number;
  pageToken?: string;
}): Promise<any> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
  const query = `SELECT
  id,
  offer_id,
  title,
  brand,
  price,
  suggested_price,
  effectiveness,
  predicted_impressions_change_fraction,
  predicted_clicks_change_fraction,
  predicted_conversions_change_fraction
FROM price_insights_product_view
ORDER BY effectiveness DESC
LIMIT ${limit}`;
  return searchMerchantReports({ ...input, query, pageSize: limit });
}

export async function runMerchantCenterQuery(input: {
  connectionId?: string;
  accountId: string;
  query: string;
  pageSize?: number;
  pageToken?: string;
}): Promise<any> {
  assertReadOnlyMerchantQuery(input.query);
  return searchMerchantReports(input);
}
