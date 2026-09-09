import { config } from './config.js';

const DATAFORSEO_API_BASE = 'https://api.dataforseo.com';
const DATAFORSEO_SUCCESS = 20_000;

type DataForSeoTask = {
  id?: string;
  status_code?: number;
  status_message?: string;
  time?: string;
  cost?: number;
  result_count?: number;
  result?: unknown;
};

type DataForSeoResponse = {
  version?: string;
  status_code?: number;
  status_message?: string;
  time?: string;
  cost?: number;
  tasks_count?: number;
  tasks_error?: number;
  tasks?: DataForSeoTask[];
};

export type DataForSeoLocationInput = {
  countryIsoCode?: string;
  languageCode?: string;
  query?: string;
  limit?: number;
};

export type DataForSeoTargetingInput = {
  locationCode?: number;
  locationName?: string;
  languageCode?: string;
  languageName?: string;
};

export type DataForSeoSearchVolumeInput = DataForSeoTargetingInput & {
  keywords: string[];
  dateFrom?: string;
  dateTo?: string;
  searchPartners?: boolean;
};

export type DataForSeoKeywordIdeasInput = DataForSeoTargetingInput & {
  keywords: string[];
  limit?: number;
  offset?: number;
  minSearchVolume?: number;
  includeSerpInfo?: boolean;
};

export type DataForSeoRankedKeywordsInput = DataForSeoTargetingInput & {
  target: string;
  limit?: number;
  offset?: number;
  minSearchVolume?: number;
  maxOrganicRank?: number;
};

export type DataForSeoOrganicSerpInput = DataForSeoTargetingInput & {
  keyword: string;
  device?: 'desktop' | 'mobile';
  depth?: number;
};

export class DataForSeoApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly apiStatusCode: number | undefined,
    public readonly apiStatusMessage: string | undefined,
  ) {
    const detail = apiStatusCode ? ` (${apiStatusCode}: ${apiStatusMessage ?? 'unknown error'})` : '';
    super(`DataForSEO API error ${status}${detail}. Check the API credentials, balance, request parameters, and account limits.`);
    this.name = 'DataForSeoApiError';
  }
}

function credentials(): { login: string; password: string } {
  if (!config.DATAFORSEO_LOGIN || !config.DATAFORSEO_PASSWORD) {
    throw new Error('DataForSEO is not configured. Set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD on the server.');
  }
  return { login: config.DATAFORSEO_LOGIN, password: config.DATAFORSEO_PASSWORD };
}

function parseResponseBody(text: string): DataForSeoResponse {
  if (!text) return {};
  try {
    return JSON.parse(text) as DataForSeoResponse;
  } catch {
    return { status_message: text.slice(0, 500) };
  }
}

async function dataForSeoJson(path: string, init?: RequestInit): Promise<DataForSeoResponse> {
  const { login, password } = credentials();
  const authorization = Buffer.from(`${login}:${password}`, 'utf8').toString('base64');
  const response = await fetch(`${DATAFORSEO_API_BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Basic ${authorization}`,
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const body = parseResponseBody(await response.text());
  if (!response.ok || body.status_code !== DATAFORSEO_SUCCESS) {
    throw new DataForSeoApiError(response.status, body.status_code, body.status_message);
  }
  return body;
}

function unwrapTask(body: DataForSeoResponse): DataForSeoTask {
  const task = body.tasks?.[0];
  if (!task) throw new DataForSeoApiError(200, body.status_code, 'DataForSEO returned no task.');
  if (task.status_code !== DATAFORSEO_SUCCESS) {
    throw new DataForSeoApiError(200, task.status_code, task.status_message);
  }
  return task;
}

function taskMeta(body: DataForSeoResponse, task: DataForSeoTask) {
  return {
    apiVersion: body.version ?? null,
    taskId: task.id ?? null,
    time: task.time ?? body.time ?? null,
    costUsd: task.cost ?? body.cost ?? 0,
  };
}

function firstResultObject(task: DataForSeoTask): Record<string, any> {
  return Array.isArray(task.result) && task.result[0] && typeof task.result[0] === 'object'
    ? task.result[0] as Record<string, any>
    : {};
}

function cleanString(value: string, field: string, maxLength: number): string {
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > maxLength) {
    throw new Error(`${field} must contain 1 to ${maxLength} characters.`);
  }
  return cleaned;
}

function cleanKeywords(values: string[], maximum: number): string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > maximum) {
    throw new Error(`keywords must contain between 1 and ${maximum} entries.`);
  }
  const keywords = values.map((value, index) => cleanString(value, `keywords[${index}]`, 80));
  if (new Set(keywords.map((value) => value.toLocaleLowerCase())).size !== keywords.length) {
    throw new Error('keywords must not contain duplicates.');
  }
  return keywords;
}

function targeting(input: DataForSeoTargetingInput, required: boolean): Record<string, string | number> {
  if (input.locationCode !== undefined && input.locationName) {
    throw new Error('Use either locationCode or locationName, not both.');
  }
  if (input.languageCode && input.languageName) {
    throw new Error('Use either languageCode or languageName, not both.');
  }
  if (required && input.locationCode === undefined && !input.locationName) {
    throw new Error('Either locationCode or locationName is required.');
  }
  return {
    ...(input.locationCode !== undefined ? { location_code: input.locationCode } : {}),
    ...(input.locationName ? { location_name: cleanString(input.locationName, 'locationName', 250) } : {}),
    ...(input.languageCode ? { language_code: cleanString(input.languageCode, 'languageCode', 10) } : {}),
    ...(input.languageName ? { language_name: cleanString(input.languageName, 'languageName', 100) } : {}),
  };
}

function assertIsoMonth(value: string, field: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${field} must use YYYY-MM-DD format.`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value || !value.endsWith('-01')) {
    throw new Error(`${field} must be the first day of a valid month in YYYY-MM-01 format.`);
  }
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new Error(`${field} must be an integer from ${min} to ${max}.`);
  }
  return resolved;
}

function taskItems(result: Record<string, any>, fallback: unknown): unknown[] {
  if (Array.isArray(result.items)) return result.items;
  return Array.isArray(fallback) ? fallback : [];
}

async function postLive(path: string, taskData: Record<string, unknown>) {
  const body = await dataForSeoJson(path, { method: 'POST', body: JSON.stringify([taskData]) });
  const task = unwrapTask(body);
  return { body, task, result: firstResultObject(task) };
}

export async function getDataForSeoAccountStatus(): Promise<any> {
  const body = await dataForSeoJson('/v3/appendix/user_data');
  const task = unwrapTask(body);
  const result = firstResultObject(task);
  const money = result.money && typeof result.money === 'object' ? result.money : {};
  return {
    ...taskMeta(body, task),
    account: {
      login: result.login ?? config.DATAFORSEO_LOGIN,
      balance: money.balance ?? result.balance ?? null,
      total: money.total ?? null,
      currency: money.currency ?? 'USD',
      rateLimitPerMinute: result.rate_limit_per_minute ?? null,
    },
  };
}

export async function listDataForSeoLocations(input: DataForSeoLocationInput = {}): Promise<any> {
  const body = await dataForSeoJson('/v3/dataforseo_labs/locations_and_languages');
  const task = unwrapTask(body);
  const results = Array.isArray(task.result) ? task.result as Array<Record<string, any>> : [];
  const country = input.countryIsoCode?.trim().toUpperCase();
  const language = input.languageCode?.trim().toLowerCase();
  const query = input.query?.trim().toLocaleLowerCase();
  const limit = boundedInteger(input.limit, 100, 1, 1000, 'limit');
  const locations = results.filter((location) => {
    if (country && location.country_iso_code !== country) return false;
    if (query && !String(location.location_name ?? '').toLocaleLowerCase().includes(query)) return false;
    if (language && !Array.isArray(location.available_languages)) return false;
    if (language && !location.available_languages.some((item: any) => item?.language_code === language)) return false;
    return true;
  }).slice(0, limit);
  return {
    ...taskMeta(body, task),
    filters: { countryIsoCode: country ?? null, languageCode: language ?? null, query: query ?? null },
    count: locations.length,
    locations,
  };
}

export async function getDataForSeoKeywordSearchVolume(input: DataForSeoSearchVolumeInput): Promise<any> {
  const keywords = cleanKeywords(input.keywords, 1000);
  if (input.dateFrom) assertIsoMonth(input.dateFrom, 'dateFrom');
  if (input.dateTo) assertIsoMonth(input.dateTo, 'dateTo');
  if (input.dateFrom && input.dateTo && input.dateFrom > input.dateTo) {
    throw new Error('dateFrom must be on or before dateTo.');
  }
  const request = {
    keywords,
    ...targeting(input, false),
    ...(input.dateFrom ? { date_from: input.dateFrom } : {}),
    ...(input.dateTo ? { date_to: input.dateTo } : {}),
    search_partners: input.searchPartners ?? false,
  };
  const { body, task } = await postLive('/v3/keywords_data/google_ads/search_volume/live', request);
  const items = Array.isArray(task.result) ? task.result : [];
  return { ...taskMeta(body, task), count: items.length, items };
}

export async function getDataForSeoKeywordIdeas(input: DataForSeoKeywordIdeasInput): Promise<any> {
  const keywords = cleanKeywords(input.keywords, 200);
  const limit = boundedInteger(input.limit, 50, 1, 100, 'limit');
  const offset = boundedInteger(input.offset, 0, 0, 100_000, 'offset');
  const minSearchVolume = input.minSearchVolume === undefined
    ? undefined
    : boundedInteger(input.minSearchVolume, 0, 0, 1_000_000_000, 'minSearchVolume');
  const request = {
    keywords,
    ...targeting(input, true),
    include_serp_info: input.includeSerpInfo ?? false,
    limit,
    offset,
    order_by: ['keyword_info.search_volume,desc'],
    ...(minSearchVolume !== undefined ? { filters: [['keyword_info.search_volume', '>=', minSearchVolume]] } : {}),
  };
  const { body, task, result } = await postLive('/v3/dataforseo_labs/google/keyword_ideas/live', request);
  const items = taskItems(result, task.result);
  return {
    ...taskMeta(body, task),
    seedKeywords: keywords,
    totalCount: result.total_count ?? items.length,
    returnedCount: items.length,
    nextOffset: items.length === limit ? offset + items.length : null,
    items,
  };
}

export async function getDataForSeoRankedKeywords(input: DataForSeoRankedKeywordsInput): Promise<any> {
  const target = cleanString(input.target, 'target', 1000);
  const limit = boundedInteger(input.limit, 50, 1, 100, 'limit');
  const offset = boundedInteger(input.offset, 0, 0, 100_000, 'offset');
  const minSearchVolume = input.minSearchVolume === undefined
    ? undefined
    : boundedInteger(input.minSearchVolume, 0, 0, 1_000_000_000, 'minSearchVolume');
  const maxOrganicRank = input.maxOrganicRank === undefined
    ? undefined
    : boundedInteger(input.maxOrganicRank, 100, 1, 100, 'maxOrganicRank');
  const conditions: unknown[] = [];
  if (minSearchVolume !== undefined) conditions.push(['keyword_data.keyword_info.search_volume', '>=', minSearchVolume]);
  if (maxOrganicRank !== undefined) conditions.push(['ranked_serp_element.serp_item.rank_group', '<=', maxOrganicRank]);
  const filters = conditions.flatMap((condition, index) => index === 0 ? [condition] : ['and', condition]);
  const request = {
    target,
    ...targeting(input, true),
    item_types: ['organic'],
    ignore_synonyms: true,
    load_rank_absolute: true,
    limit,
    offset,
    order_by: ['ranked_serp_element.serp_item.rank_absolute,asc'],
    ...(filters.length ? { filters } : {}),
  };
  const { body, task, result } = await postLive('/v3/dataforseo_labs/google/ranked_keywords/live', request);
  const items = taskItems(result, task.result);
  return {
    ...taskMeta(body, task),
    target,
    totalCount: result.total_count ?? items.length,
    returnedCount: items.length,
    nextOffset: items.length === limit ? offset + items.length : null,
    items,
  };
}

export async function getDataForSeoOrganicSerp(input: DataForSeoOrganicSerpInput): Promise<any> {
  const keyword = cleanString(input.keyword, 'keyword', 700);
  const depth = boundedInteger(input.depth, 20, 1, 100, 'depth');
  const device = input.device ?? 'desktop';
  const request = {
    keyword,
    ...targeting(input, true),
    device,
    os: device === 'mobile' ? 'android' : 'windows',
    depth,
    calculate_rectangles: false,
  };
  const { body, task, result } = await postLive('/v3/serp/google/organic/live/advanced', request);
  const items = taskItems(result, task.result);
  return {
    ...taskMeta(body, task),
    keyword,
    locationCode: result.location_code ?? input.locationCode ?? null,
    locationName: result.location_name ?? input.locationName ?? null,
    languageCode: result.language_code ?? input.languageCode ?? null,
    device,
    checkUrl: result.check_url ?? null,
    totalCount: result.items_count ?? items.length,
    returnedCount: items.length,
    items,
  };
}
