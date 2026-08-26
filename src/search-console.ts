import { getAccessToken } from './google.js';

const SEARCH_CONSOLE_API_BASE = 'https://www.googleapis.com/webmasters/v3';

export const SEARCH_CONSOLE_DIMENSIONS = [
  'date',
  'hour',
  'query',
  'page',
  'country',
  'device',
  'searchAppearance',
] as const;

export const SEARCH_CONSOLE_FILTER_DIMENSIONS = [
  'query',
  'page',
  'country',
  'device',
  'searchAppearance',
] as const;

export const SEARCH_CONSOLE_FILTER_OPERATORS = [
  'contains',
  'equals',
  'notContains',
  'notEquals',
  'includingRegex',
  'excludingRegex',
] as const;

export const SEARCH_CONSOLE_SEARCH_TYPES = [
  'web',
  'image',
  'video',
  'news',
  'discover',
  'googleNews',
] as const;

export const SEARCH_CONSOLE_AGGREGATION_TYPES = ['auto', 'byPage', 'byProperty'] as const;
export const SEARCH_CONSOLE_DATA_STATES = ['final', 'all', 'hourly_all'] as const;

type SearchConsoleDimension = (typeof SEARCH_CONSOLE_DIMENSIONS)[number];
type SearchConsoleFilterDimension = (typeof SEARCH_CONSOLE_FILTER_DIMENSIONS)[number];
type SearchConsoleFilterOperator = (typeof SEARCH_CONSOLE_FILTER_OPERATORS)[number];
type SearchConsoleSearchType = (typeof SEARCH_CONSOLE_SEARCH_TYPES)[number];
type SearchConsoleAggregationType = (typeof SEARCH_CONSOLE_AGGREGATION_TYPES)[number];
type SearchConsoleDataState = (typeof SEARCH_CONSOLE_DATA_STATES)[number];

export type SearchConsoleFilter = {
  dimension: SearchConsoleFilterDimension;
  operator: SearchConsoleFilterOperator;
  expression: string;
};

export type SearchConsolePerformanceInput = {
  connectionId?: string;
  siteUrl: string;
  startDate: string;
  endDate: string;
  dimensions?: SearchConsoleDimension[];
  searchType?: SearchConsoleSearchType;
  aggregationType?: SearchConsoleAggregationType;
  dataState?: SearchConsoleDataState;
  filters?: SearchConsoleFilter[];
  rowLimit?: number;
  startRow?: number;
};

type SearchAnalyticsRequest = {
  startDate: string;
  endDate: string;
  dimensions: SearchConsoleDimension[];
  type: SearchConsoleSearchType;
  aggregationType: SearchConsoleAggregationType;
  dataState: SearchConsoleDataState;
  rowLimit: number;
  startRow: number;
  dimensionFilterGroups?: Array<{
    groupType: 'and';
    filters: SearchConsoleFilter[];
  }>;
};

type SearchConsoleSiteEntry = {
  siteUrl?: string;
  permissionLevel?: string;
  [key: string]: unknown;
};

export class SearchConsoleApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    const reconnectHint = status === 401 || status === 403
      ? ' Reconnect the Google account to grant Search Console read-only access.'
      : '';
    super(`Search Console API error ${status}: ${JSON.stringify(body)}.${reconnectHint}`);
    this.name = 'SearchConsoleApiError';
  }
}

function parseResponseBody(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 2000) };
  }
}

async function searchConsoleJson(url: string, token: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const body = parseResponseBody(await response.text());
  if (!response.ok) throw new SearchConsoleApiError(response.status, body);
  return body;
}

function assertIsoDate(value: string, field: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${field} must use YYYY-MM-DD format.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${field} must be a valid calendar date.`);
  }
}

export function normalizeSearchConsoleSiteUrl(siteUrl: string): string {
  const value = siteUrl.trim();
  if (value.startsWith('sc-domain:')) {
    const domain = value.slice('sc-domain:'.length);
    if (!domain || /[\s/?#]/.test(domain)) {
      throw new Error('Domain properties must use the exact sc-domain:example.com identifier returned by Search Console.');
    }
    return value;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('siteUrl must be the exact sc-domain: or URL-prefix identifier returned by Search Console.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('siteUrl must be the exact sc-domain: or URL-prefix identifier returned by Search Console.');
  }
  return value;
}

export function buildSearchAnalyticsRequest(input: SearchConsolePerformanceInput): SearchAnalyticsRequest {
  assertIsoDate(input.startDate, 'startDate');
  assertIsoDate(input.endDate, 'endDate');
  if (input.startDate > input.endDate) throw new Error('startDate must be on or before endDate.');

  const dimensions = input.dimensions ?? ['date'];
  if (new Set(dimensions).size !== dimensions.length) throw new Error('Search Console dimensions must be unique.');
  if (dimensions.includes('searchAppearance') && dimensions.length > 1) {
    throw new Error('searchAppearance must be the only grouping dimension; use a searchAppearance filter for further detail.');
  }

  const dataState = input.dataState ?? 'final';
  if (dimensions.includes('hour') && dataState !== 'hourly_all') {
    throw new Error('The hour dimension requires dataState hourly_all.');
  }
  const inclusiveDays = ((Date.parse(input.endDate) - Date.parse(input.startDate)) / 86_400_000) + 1;
  if (dimensions.includes('hour') && inclusiveDays > 10) {
    throw new Error('Hourly Search Console reports can cover at most 10 inclusive days.');
  }

  const aggregationType = input.aggregationType ?? 'auto';
  const searchType = input.searchType ?? 'web';
  const hasPageFilter = input.filters?.some(({ dimension }) => dimension === 'page') ?? false;
  if (aggregationType === 'byProperty' && (dimensions.includes('page') || hasPageFilter)) {
    throw new Error('aggregationType byProperty cannot be combined with a page dimension or page filter.');
  }
  if (aggregationType === 'byProperty' && ['discover', 'googleNews'].includes(searchType)) {
    throw new Error('aggregationType byProperty is not supported for Discover or Google News search types.');
  }

  const rowLimit = input.rowLimit ?? 1000;
  const startRow = input.startRow ?? 0;
  if (!Number.isInteger(rowLimit) || rowLimit < 1 || rowLimit > 25_000) {
    throw new Error('rowLimit must be an integer from 1 to 25000.');
  }
  if (!Number.isInteger(startRow) || startRow < 0) throw new Error('startRow must be a non-negative integer.');

  const request: SearchAnalyticsRequest = {
    startDate: input.startDate,
    endDate: input.endDate,
    dimensions,
    type: searchType,
    aggregationType,
    dataState,
    rowLimit,
    startRow,
  };

  if (input.filters?.length) {
    request.dimensionFilterGroups = [{
      groupType: 'and',
      filters: input.filters,
    }];
  }

  return request;
}

export async function listSearchConsoleSites(connectionId?: string): Promise<any> {
  const { token, connection } = await getAccessToken(connectionId);
  const body = await searchConsoleJson(`${SEARCH_CONSOLE_API_BASE}/sites`, token);
  const siteEntries: SearchConsoleSiteEntry[] = Array.isArray(body.siteEntry) ? body.siteEntry : [];
  const sites = siteEntries.filter((site) => site?.permissionLevel !== 'siteUnverifiedUser');
  return {
    connection: { id: connection.id, email: connection.email },
    sites,
    unverifiedSitesExcluded: siteEntries.length - sites.length,
  };
}

export async function getSearchConsolePerformance(input: SearchConsolePerformanceInput): Promise<any> {
  const siteUrl = normalizeSearchConsoleSiteUrl(input.siteUrl);
  const request = buildSearchAnalyticsRequest(input);
  const { token, connection } = await getAccessToken(input.connectionId);
  const report = await searchConsoleJson(
    `${SEARCH_CONSOLE_API_BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    token,
    { method: 'POST', body: JSON.stringify(request) },
  );
  const rows = Array.isArray(report.rows) ? report.rows : [];
  return {
    connection: { id: connection.id, email: connection.email },
    siteUrl,
    request,
    rowCount: rows.length,
    nextStartRow: rows.length === request.rowLimit ? request.startRow + rows.length : null,
    ...report,
  };
}
