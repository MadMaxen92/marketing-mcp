import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listProperties, runReport } from './google.js';
import {
  applyGoogleAdsConversionPrimaryUpdate,
  getGoogleAdsAccountOverview,
  getGoogleAdsCampaignPerformance,
  getGoogleAdsSearchTerms,
  listGoogleAdsAccounts,
  previewGoogleAdsConversionPrimaryUpdate,
  runGoogleAdsQuery,
} from './google-ads.js';
import {
  getMerchantAccountOverview,
  getMerchantPriceInsights,
  getMerchantProductIssues,
  getMerchantProductPerformance,
  getMerchantProductStatus,
  listMerchantCenterAccounts,
  MERCHANT_PRODUCT_STATUSES,
  runMerchantCenterQuery,
} from './merchant-center.js';
import {
  getSearchConsolePerformance,
  listSearchConsoleSites,
  SEARCH_CONSOLE_AGGREGATION_TYPES,
  SEARCH_CONSOLE_DATA_STATES,
  SEARCH_CONSOLE_DIMENSIONS,
  SEARCH_CONSOLE_FILTER_DIMENSIONS,
  SEARCH_CONSOLE_FILTER_OPERATORS,
  SEARCH_CONSOLE_SEARCH_TYPES,
} from './search-console.js';
import { readStore } from './token-store.js';
import { MARKETING_MCP_VERSION } from './version.js';
import { launchActionSchema, getShopifyLaunchCapabilities, previewShopifyLaunchPreparation, applyShopifyLaunchPreparation } from './shopify-launch.js';
import { shopifyAdminPlanSchema, getShopifyCapabilities, inspectShopifyOperation, runShopifyQuery, previewShopifyAdminMutation, applyShopifyAdminMutation } from './shopify-admin.js';
import {
  getDataForSeoAccountStatus,
  getDataForSeoKeywordIdeas,
  getDataForSeoKeywordSearchVolume,
  getDataForSeoOrganicSerp,
  getDataForSeoRankedKeywords,
  listDataForSeoLocations,
} from './dataforseo.js';
import {
  applyShopifyShippingRatesUpdate,
  applyShopifyCollectionProductsUpdate,
  applyShopifyCollectionPublicationUpdate,
  applyShopifyCollectionUpdate,
  applyShopifyProductDescriptionUpdate,
  applyShopifyThemeFilesUpsert,
  getShopifyCollection,
  getShopifyCollectionPublicationStatus,
  getShopifyMetaobject,
  getShopifySalesOverview,
  getShopifyShippingProfiles,
  getShopifyShopOverview,
  getShopifyThemeFiles,
  listShopifyOrderDeliveryDetails,
  listShopifyCollections,
  listShopifyMetaobjectDefinitions,
  listShopifyMetaobjects,
  listShopifyPublications,
  listShopifyProducts,
  listShopifyThemes,
  previewShopifyCollectionProductsUpdate,
  previewShopifyCollectionPublicationUpdate,
  previewShopifyCollectionUpdate,
  previewShopifyProductDescriptionUpdate,
  previewShopifyShippingRatesUpdate,
  previewShopifyThemeFilesUpsert,
} from './shopify.js';

const SHOPIFY_COLLECTION_SORT_ORDERS = [
  'ALPHA_ASC',
  'ALPHA_DESC',
  'BEST_SELLING',
  'CREATED',
  'CREATED_DESC',
  'MANUAL',
  'MOST_RELEVANT',
  'PRICE_ASC',
  'PRICE_DESC',
] as const;

const SHOPIFY_THEME_ROLES = ['MAIN', 'UNPUBLISHED', 'DEVELOPMENT', 'DEMO'] as const;

const SHOPIFY_SHIPPING_RATE_UPDATE_SCHEMA = z.object({
  locationGroupId: z.string().regex(/^gid:\/\/shopify\/DeliveryLocationGroup\/\d+$/),
  zoneId: z.string().regex(/^gid:\/\/shopify\/DeliveryZone\/\d+$/),
  methodDefinitionId: z.string().regex(/^gid:\/\/shopify\/DeliveryMethodDefinition\/\d+$/),
  name: z.string().trim().min(1).max(255).optional(),
  description: z.string().max(1000).optional(),
  active: z.boolean().optional(),
  priceAmount: z.number().finite().min(0).max(1_000_000).optional(),
  currencyCode: z.string().regex(/^[A-Z]{3}$/).optional(),
  weightRangeKg: z.object({
    min: z.number().finite().min(0),
    max: z.number().finite().positive().nullable().optional(),
  }).strict().optional(),
}).strict();

function result(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  };
}

export function createMarketingMcpServer(): McpServer {
  const server = new McpServer({ name: 'marketing-mcp', version: MARKETING_MCP_VERSION });

  server.registerTool('get_shopify_capabilities', {
    description: 'Discovers the live Shopify permission scopes and available API operations for products, variants, collections, publications, files, inventory, locations, metaobjects/definitions, menus, redirects, themes, shipping and delivery customizations. Use this first for any Shopify management request; scopes do not automatically imply staff permissions or theme approval.',
    inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async () => result(await getShopifyCapabilities()));
  server.registerTool('inspect_shopify_operation', {
    description: 'Returns an operation’s exact argument types, nested input fields, enum values and result fields from the store’s installed Shopify API schema. Use before constructing an advanced operation; never guess version-specific inputs.',
    inputSchema: { name: z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/), kind: z.enum(['query', 'mutation']) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async input => result(await inspectShopifyOperation(input)));
  server.registerTool('run_shopify_query', {
    description: 'Runs one schema-validated, read-only Shopify Admin query within the installed app permissions. Supports full product/variant detail and all granted Shopify read areas with explicit bounded pagination. Mutations and subscriptions are rejected.',
    inputSchema: { query: z.string().min(1).max(30000), variables: z.record(z.unknown()).default({}) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async input => result(await runShopifyQuery(input)));
  server.registerTool('preview_shopify_admin_mutation', {
    description: 'Read-only preview of ONE Shopify operation across all granted management areas: full product/variant editing, create/duplicate/delete, manual or automated collection management, publication, file/media, stock/location, metaobjects/definitions, menus/redirects, theme, shipping and delivery customization changes. Inspect the API schema first. Include complete current affected state and an after-state query. Explain the concrete change and all live/deletion effects in plain language; show the full preview before asking for its exact code. This never sends a mutation.',
    inputSchema: { plan: shopifyAdminPlanSchema },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ plan }) => result(await previewShopifyAdminMutation(plan)));
  server.registerTool('apply_shopify_admin_mutation', {
    description: 'Applies exactly one previewed Shopify operation only after the user explicitly supplies that preview’s exact SHOPIFY confirmation code. Rejects altered, expired, cross-store or stale-state plans. Rechecks permissions and holds durable replay/concurrency locks. Never automatically retries writes. Returns the mutation result and readback; compare actual values and asynchronous-job status before reporting completion. Deletions, live-theme edits, publication, checkout and inventory changes require explicit disclosure in the preview.',
    inputSchema: { plan: shopifyAdminPlanSchema, confirmationCode: z.string().regex(/^SHOPIFY-[A-F0-9]{8}$/), confirmationToken: z.string().min(80).max(10000) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async input => result(await applyShopifyAdminMutation(input)));

  server.registerTool('get_shopify_launch_capabilities', {
    description: 'Checks granted Shopify scopes and limitations for draft catalogue, unpublished collection, separate launch menu and theme-copy preparation.',
    inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async () => result(await getShopifyLaunchCapabilities()));
  server.registerTool('preview_shopify_launch_preparation', {
    description: 'Read-only preview for creating one DRAFT product with ordered options, SKUs, prices, images and metafields; an unpublished manual collection; a separate launch- menu; or an unpublished theme copy. Does not edit existing resources or publish. Show the full preview before asking for its confirmation code.',
    inputSchema: { action: launchActionSchema },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ action }) => result(await previewShopifyLaunchPreparation(action)));
  server.registerTool('apply_shopify_launch_preparation', {
    description: 'Creates exactly the previewed Shopify preparation resource. Call only after showing the full preview and receiving the exact SHOPIFY confirmation code explicitly from the user. Refuses altered, stale, expired or replayed operations. Never publishes or edits existing products, menus or themes.',
    inputSchema: { action: launchActionSchema, confirmationCode: z.string().regex(/^SHOPIFY-[A-F0-9]{8}$/), confirmationToken: z.string().min(80).max(10000) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async input => result(await applyShopifyLaunchPreparation(input)));

  server.tool(
    'list_google_connections',
    'Lists Google accounts connected to this private Marketing MCP. Does not expose tokens.',
    {},
    async () => {
      const store = await readStore();
      return result(store.connections.map(({ id, email, createdAt, updatedAt }) => ({ id, email, createdAt, updatedAt })));
    },
  );

  server.tool(
    'list_ga4_properties',
    'Lists all GA4 accounts and properties accessible by a connected Google account.',
    { connectionId: z.string().optional().describe('Connection ID or Google email. Defaults to the first connection.') },
    async ({ connectionId }) => result(await listProperties(connectionId)),
  );

  server.tool(
    'run_ga4_report',
    'Runs a read-only Google Analytics 4 report. Use GA4 Data API dimension and metric names.',
    {
      connectionId: z.string().optional().describe('Connection ID or Google email. Defaults to the first connection.'),
      propertyId: z.string().regex(/^\d+$/).describe('Numeric GA4 property ID.'),
      startDate: z.string().describe('YYYY-MM-DD or GA4 relative date such as 30daysAgo.'),
      endDate: z.string().describe('YYYY-MM-DD, today, or yesterday.'),
      dimensions: z.array(z.string()).max(9).optional().default([]),
      metrics: z.array(z.string()).min(1).max(10),
      limit: z.number().int().min(1).max(10000).optional().default(100),
    },
    async (input) => result(await runReport(input)),
  );

  server.tool(
    'get_ecommerce_overview',
    'Returns a standard ecommerce overview for a GA4 property and date range.',
    {
      connectionId: z.string().optional(),
      propertyId: z.string().regex(/^\d+$/),
      startDate: z.string().default('30daysAgo'),
      endDate: z.string().default('yesterday'),
    },
    async (input) => result(await runReport({
      ...input,
      dimensions: ['date'],
      metrics: ['sessions', 'activeUsers', 'transactions', 'purchaseRevenue', 'sessionConversionRate'],
      limit: 366,
    })),
  );

  server.tool(
    'get_landing_page_performance',
    'Returns landing-page performance with sessions, engagement, transactions, and revenue.',
    {
      connectionId: z.string().optional(),
      propertyId: z.string().regex(/^\d+$/),
      startDate: z.string().default('30daysAgo'),
      endDate: z.string().default('yesterday'),
      limit: z.number().int().min(1).max(1000).default(100),
    },
    async (input) => result(await runReport({
      ...input,
      dimensions: ['landingPagePlusQueryString'],
      metrics: ['sessions', 'engagedSessions', 'transactions', 'purchaseRevenue', 'sessionConversionRate'],
    })),
  );

  server.tool(
    'list_search_console_sites',
    'Lists verified Google Search Console properties available to a connected Google account. Preserve and reuse the exact returned siteUrl.',
    {
      connectionId: z.string().optional().describe('Connection ID or Google email. Defaults to the first connection.'),
    },
    async ({ connectionId }) => result(await listSearchConsoleSites(connectionId)),
  );

  server.tool(
    'get_search_console_performance',
    'Returns read-only Search Console clicks, impressions, CTR, and average position. Defaults to daily web-search performance; dimensions and AND filters can be customized.',
    {
      connectionId: z.string().optional().describe('Connection ID or Google email. Defaults to the first connection.'),
      siteUrl: z.string().trim().min(1).max(2048).describe('Exact siteUrl from list_search_console_sites, for example sc-domain:example.com or https://www.example.com/.'),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Inclusive date in YYYY-MM-DD format; Search Console uses Pacific Time.'),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Inclusive date in YYYY-MM-DD format; finalized data normally trails by 2–3 days.'),
      dimensions: z.array(z.enum(SEARCH_CONSOLE_DIMENSIONS)).max(7).default(['date']).describe('Grouping dimensions. Pass an empty array for one aggregate row.'),
      searchType: z.enum(SEARCH_CONSOLE_SEARCH_TYPES).default('web'),
      aggregationType: z.enum(SEARCH_CONSOLE_AGGREGATION_TYPES).default('auto'),
      dataState: z.enum(SEARCH_CONSOLE_DATA_STATES).default('final'),
      filters: z.array(z.object({
        dimension: z.enum(SEARCH_CONSOLE_FILTER_DIMENSIONS),
        operator: z.enum(SEARCH_CONSOLE_FILTER_OPERATORS),
        expression: z.string().min(1).max(4096),
      })).max(10).optional().describe('Optional filters combined with AND.'),
      rowLimit: z.number().int().min(1).max(25000).default(1000),
      startRow: z.number().int().min(0).default(0),
    },
    async (input) => result(await getSearchConsolePerformance(input)),
  );

  server.tool(
    'list_google_ads_accounts',
    'Lists Google Ads customers available to the connected Google account and the configured manager account.',
    { connectionId: z.string().optional().describe('Connection ID or Google email. Defaults to the first connection.') },
    async ({ connectionId }) => result(await listGoogleAdsAccounts(connectionId)),
  );

  server.tool(
    'get_google_ads_account_overview',
    'Returns read-only Google Ads account-level performance for a date range.',
    {
      connectionId: z.string().optional(),
      customerId: z.string().describe('10-digit Google Ads customer ID; hyphens are accepted.'),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    },
    async (input) => result(await getGoogleAdsAccountOverview(input)),
  );

  server.tool(
    'get_google_ads_campaign_performance',
    'Returns campaign-level Google Ads spend, traffic, conversions, conversion value and efficiency metrics.',
    {
      connectionId: z.string().optional(),
      customerId: z.string(),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      limit: z.number().int().min(1).max(1000).default(100),
    },
    async (input) => result(await getGoogleAdsCampaignPerformance(input)),
  );

  server.tool(
    'get_google_ads_search_terms',
    'Returns Google Ads search-term performance for a date range.',
    {
      connectionId: z.string().optional(),
      customerId: z.string(),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      limit: z.number().int().min(1).max(1000).default(100),
    },
    async (input) => result(await getGoogleAdsSearchTerms(input)),
  );

  server.tool(
    'run_google_ads_query',
    'Runs a read-only Google Ads Query Language (GAQL) SELECT query for advanced analysis.',
    {
      connectionId: z.string().optional(),
      customerId: z.string(),
      query: z.string().min(6).max(12000).describe('Read-only GAQL SELECT query.'),
    },
    async (input) => result(await runGoogleAdsQuery(input)),
  );

  server.registerTool(
    'preview_google_ads_conversion_primary_update',
    {
      title: 'Preview Google Ads purchase conversion Primary/Secondary update',
      description: 'Validates and previews changing only primary_for_goal on one existing ENABLED PURCHASE conversion action. It never writes. The validation call uses Google Ads validateOnly and returns an expiring confirmation code and signed token.',
      inputSchema: {
        connectionId: z.string().optional().describe('Connection ID or Google email. Defaults to the first connection.'),
        customerId: z.string().describe('10-digit Google Ads customer ID; hyphens are accepted.'),
        conversionActionId: z.string().regex(/^\d+$/).describe('Numeric ID of an existing Google Ads conversion action.'),
        primaryForGoal: z.boolean().describe('True makes the purchase action Primary; false makes it Secondary.'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => result(await previewGoogleAdsConversionPrimaryUpdate(input)),
  );

  server.registerTool(
    'apply_google_ads_conversion_primary_update',
    {
      title: 'Apply Google Ads purchase conversion Primary/Secondary update',
      description: 'Applies exactly one previewed primary_for_goal change to an existing ENABLED PURCHASE conversion action. Call only after showing the complete preview and the user explicitly replies with its exact GOOGLE-ADS confirmation code. It cannot change campaigns, budgets, bids, ads, values, windows, status, or delete data.',
      inputSchema: {
        connectionId: z.string().optional().describe('Must resolve to the same Google connection used by the preview.'),
        customerId: z.string().describe('10-digit Google Ads customer ID; hyphens are accepted.'),
        conversionActionId: z.string().regex(/^\d+$/),
        primaryForGoal: z.boolean(),
        confirmationCode: z.string().regex(/^GOOGLE-ADS-[A-F0-9]{8}$/),
        confirmationToken: z.string().min(80).max(10000),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => result(await applyGoogleAdsConversionPrimaryUpdate(input)),
  );

  server.tool(
    'list_merchant_center_accounts',
    'Lists Merchant Center accounts accessible to a connected Google account using Merchant API v1.',
    {
      connectionId: z.string().optional().describe('Connection ID or Google email. Defaults to the first connection.'),
      pageSize: z.number().int().min(1).max(500).default(250),
      pageToken: z.string().optional(),
      filter: z.string().max(2000).optional().describe('Optional Merchant API account filter.'),
    },
    async (input) => result(await listMerchantCenterAccounts(input)),
  );

  server.tool(
    'get_merchant_account_overview',
    'Returns Merchant Center account details, account-level issues, and aggregate product-status statistics.',
    {
      connectionId: z.string().optional(),
      accountId: z.string().regex(/^(accounts\/)?\d+$/).describe('Numeric Merchant Center account ID.'),
    },
    async (input) => result(await getMerchantAccountOverview(input)),
  );

  server.tool(
    'get_merchant_product_status',
    'Returns products with eligibility status, destination status, and item issues; supports optional filters.',
    {
      connectionId: z.string().optional(),
      accountId: z.string().regex(/^(accounts\/)?\d+$/),
      offerId: z.string().max(250).optional(),
      status: z.enum(MERCHANT_PRODUCT_STATUSES).optional(),
      reportingContext: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional().describe('For example SHOPPING_ADS or FREE_LISTINGS.'),
      limit: z.number().int().min(1).max(1000).default(100),
      pageToken: z.string().optional(),
    },
    async (input) => result(await getMerchantProductStatus(input)),
  );

  server.tool(
    'get_merchant_product_issues',
    'Lists limited or disapproved Merchant Center products together with their item-level issues.',
    {
      connectionId: z.string().optional(),
      accountId: z.string().regex(/^(accounts\/)?\d+$/),
      reportingContext: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
      limit: z.number().int().min(1).max(1000).default(100),
      pageToken: z.string().optional(),
    },
    async (input) => result(await getMerchantProductIssues(input)),
  );

  server.tool(
    'get_merchant_product_performance',
    'Returns Merchant Center product impressions, clicks, conversions, and conversion value for a date range.',
    {
      connectionId: z.string().optional(),
      accountId: z.string().regex(/^(accounts\/)?\d+$/),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      limit: z.number().int().min(1).max(1000).default(100),
      pageToken: z.string().optional(),
    },
    async (input) => result(await getMerchantProductPerformance(input)),
  );

  server.tool(
    'get_merchant_price_insights',
    'Returns available Merchant Center price recommendations and predicted performance changes.',
    {
      connectionId: z.string().optional(),
      accountId: z.string().regex(/^(accounts\/)?\d+$/),
      limit: z.number().int().min(1).max(1000).default(100),
      pageToken: z.string().optional(),
    },
    async (input) => result(await getMerchantPriceInsights(input)),
  );

  server.tool(
    'run_merchant_center_query',
    'Runs one read-only Merchant Center Query Language (MCQL) SELECT query for advanced reporting.',
    {
      connectionId: z.string().optional(),
      accountId: z.string().regex(/^(accounts\/)?\d+$/),
      query: z.string().min(6).max(12000),
      pageSize: z.number().int().min(1).max(5000).default(1000),
      pageToken: z.string().optional(),
    },
    async (input) => result(await runMerchantCenterQuery(input)),
  );

  server.registerTool(
    'get_dataforseo_account_status',
    {
      title: 'Get DataForSEO account status',
      description: 'Checks the configured DataForSEO connection and returns balance and account limits. This endpoint is free and never exposes the API password.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => result(await getDataForSeoAccountStatus()),
  );

  server.registerTool(
    'list_dataforseo_locations',
    {
      title: 'List DataForSEO locations and languages',
      description: 'Lists supported country locations and languages for DataForSEO Labs. This endpoint is free.',
      inputSchema: {
        countryIsoCode: z.string().regex(/^[A-Za-z]{2}$/).optional().describe('Optional two-letter country code, for example GB or DE.'),
        languageCode: z.string().regex(/^[A-Za-z-]{2,10}$/).optional().describe('Optional language code, for example en or de.'),
        query: z.string().trim().min(1).max(100).optional().describe('Optional case-insensitive location-name search.'),
        limit: z.number().int().min(1).max(1000).default(100),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => result(await listDataForSeoLocations(input)),
  );

  server.registerTool(
    'get_dataforseo_keyword_search_volume',
    {
      title: 'Get DataForSEO keyword search volume',
      description: 'Returns Google Ads search volume, monthly searches, competition, CPC, and bid ranges for up to 1,000 keywords. This is a paid live DataForSEO request and deducts its reported cost from the connected account balance.',
      inputSchema: {
        keywords: z.array(z.string().trim().min(1).max(80)).min(1).max(1000),
        locationCode: z.number().int().positive().optional(),
        locationName: z.string().trim().min(1).max(250).optional(),
        languageCode: z.string().trim().min(1).max(10).optional(),
        languageName: z.string().trim().min(1).max(100).optional(),
        dateFrom: z.string().regex(/^\d{4}-\d{2}-01$/).optional().describe('Optional first month in YYYY-MM-01 format.'),
        dateTo: z.string().regex(/^\d{4}-\d{2}-01$/).optional().describe('Optional last month in YYYY-MM-01 format.'),
        searchPartners: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => result(await getDataForSeoKeywordSearchVolume(input)),
  );

  server.registerTool(
    'get_dataforseo_keyword_ideas',
    {
      title: 'Get DataForSEO keyword ideas',
      description: 'Finds related Google keyword ideas with search volume, CPC, competition, trend, and optional SERP data. This is a paid live DataForSEO request, capped at 100 results, and returns the exact account cost.',
      inputSchema: {
        keywords: z.array(z.string().trim().min(1).max(80)).min(1).max(200),
        locationCode: z.number().int().positive().optional(),
        locationName: z.string().trim().min(1).max(250).optional(),
        languageCode: z.string().trim().min(1).max(10).optional(),
        languageName: z.string().trim().min(1).max(100).optional(),
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().min(0).max(100000).default(0),
        minSearchVolume: z.number().int().min(0).max(1000000000).optional(),
        includeSerpInfo: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => result(await getDataForSeoKeywordIdeas(input)),
  );

  server.registerTool(
    'get_dataforseo_ranked_keywords',
    {
      title: 'Get DataForSEO ranked keywords',
      description: 'Lists Google organic keywords a domain, subdomain, or page ranks for, with rank and keyword metrics. This is a paid live DataForSEO request, capped at 100 results, and returns the exact account cost.',
      inputSchema: {
        target: z.string().trim().min(1).max(1000).describe('Domain without protocol/www, or a full page URL.'),
        locationCode: z.number().int().positive().optional(),
        locationName: z.string().trim().min(1).max(250).optional(),
        languageCode: z.string().trim().min(1).max(10).optional(),
        languageName: z.string().trim().min(1).max(100).optional(),
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().min(0).max(100000).default(0),
        minSearchVolume: z.number().int().min(0).max(1000000000).optional(),
        maxOrganicRank: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => result(await getDataForSeoRankedKeywords(input)),
  );

  server.registerTool(
    'get_dataforseo_google_organic_serp',
    {
      title: 'Get a live Google organic SERP from DataForSEO',
      description: 'Returns a live Google organic results page with ranking positions and SERP features for one keyword. This is a paid live DataForSEO request, capped at depth 100, and returns the exact account cost.',
      inputSchema: {
        keyword: z.string().trim().min(1).max(700),
        locationCode: z.number().int().positive().optional(),
        locationName: z.string().trim().min(1).max(250).optional(),
        languageCode: z.string().trim().min(1).max(10).optional(),
        languageName: z.string().trim().min(1).max(100).optional(),
        device: z.enum(['desktop', 'mobile']).default('desktop'),
        depth: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => result(await getDataForSeoOrganicSerp(input)),
  );

  server.tool(
    'get_shopify_shop_overview',
    'Checks the read-only Shopify connection and returns non-sensitive shop details plus granted app scopes.',
    {},
    async () => result(await getShopifyShopOverview()),
  );

  server.registerTool(
    'get_shopify_shipping_profiles',
    {
      title: 'Get Shopify shipping profiles',
      description: 'Reads merchant-owned Shopify delivery profiles with fulfillment location groups, geographic zones, flat-rate prices, and weight conditions. Requires read_shipping or write_shipping and never writes.',
      inputSchema: {
        merchantOwnedOnly: z.boolean().default(true).describe('Keep true to exclude profiles managed by third-party apps.'),
        limit: z.number().int().min(1).max(50).default(20),
        pageToken: z.string().optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => result(await getShopifyShippingProfiles(input)),
  );

  server.registerTool(
    'preview_shopify_shipping_rates_update',
    {
      title: 'Preview Shopify shipping-rate updates',
      description: 'Creates a read-only preview for changing prices, names, active state, or kilogram weight bands on existing merchant-defined Shopify rates. It never writes; use returned IDs from get_shopify_shipping_profiles.',
      inputSchema: {
        profileId: z.string().regex(/^gid:\/\/shopify\/DeliveryProfile\/\d+$/),
        updates: z.array(SHOPIFY_SHIPPING_RATE_UPDATE_SCHEMA).min(1).max(50),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => result(await previewShopifyShippingRatesUpdate(input)),
  );

  server.registerTool(
    'apply_shopify_shipping_rates_update',
    {
      title: 'Apply Shopify shipping-rate updates',
      description: 'Applies exactly one previewed batch of updates to existing merchant-defined Shopify shipping rates through deliveryProfileUpdate. Call only after showing the complete preview and the user explicitly replies with its exact SHOPIFY confirmation code. Rejects altered, expired, or stale previews.',
      inputSchema: {
        profileId: z.string().regex(/^gid:\/\/shopify\/DeliveryProfile\/\d+$/),
        updates: z.array(SHOPIFY_SHIPPING_RATE_UPDATE_SCHEMA).min(1).max(50),
        confirmationCode: z.string().regex(/^SHOPIFY-[A-F0-9]{8}$/),
        confirmationToken: z.string().min(80).max(20000),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => result(await applyShopifyShippingRatesUpdate(input)),
  );

  server.tool(
    'list_shopify_products',
    'Lists Shopify products, variants, prices, statuses, and inventory without customer data.',
    {
      query: z.string().max(1000).optional().describe('Optional Shopify product search query.'),
      limit: z.number().int().min(1).max(250).default(100),
      pageToken: z.string().optional(),
    },
    async (input) => result(await listShopifyProducts(input)),
  );

  server.tool(
    'list_shopify_themes',
    'Lists Shopify Online Store themes and their roles. MAIN is live; all theme file writes are restricted to UNPUBLISHED themes. Requires read_themes.',
    {
      roles: z.array(z.enum(SHOPIFY_THEME_ROLES)).max(4).optional(),
      limit: z.number().int().min(1).max(50).default(20),
      pageToken: z.string().optional(),
    },
    async (input) => result(await listShopifyThemes(input)),
  );

  server.tool(
    'get_shopify_theme_files',
    'Reads up to 20 selected PDP-related text files from one Shopify theme. Supports product JSON templates, sections, snippets, and CSS/JS assets. Requires read_themes.',
    {
      themeId: z.string().regex(/^gid:\/\/shopify\/OnlineStoreTheme\/\d+$/),
      filenames: z.array(z.string().min(1).max(255)).min(1).max(20),
    },
    async (input) => result(await getShopifyThemeFiles(input)),
  );

  server.tool(
    'preview_shopify_theme_files_upsert',
    'Creates a read-only preview for creating or updating selected PDP theme files. It never writes and rejects live, demo, or development themes. Use only an UNPUBLISHED theme.',
    {
      themeId: z.string().regex(/^gid:\/\/shopify\/OnlineStoreTheme\/\d+$/),
      files: z.array(z.object({
        filename: z.string().min(1).max(255),
        content: z.string().max(150000),
      })).min(1).max(20),
    },
    async (input) => result(await previewShopifyThemeFilesUpsert(input)),
  );

  server.tool(
    'apply_shopify_theme_files_upsert',
    'Applies exactly one previewed PDP theme-file update to an UNPUBLISHED Shopify theme. Call only after showing the full preview and the user explicitly replies with its exact SHOPIFY confirmation code. Refuses live-theme, altered, expired, or stale updates.',
    {
      themeId: z.string().regex(/^gid:\/\/shopify\/OnlineStoreTheme\/\d+$/),
      files: z.array(z.object({
        filename: z.string().min(1).max(255),
        content: z.string().max(150000),
      })).min(1).max(20),
      confirmationCode: z.string().regex(/^SHOPIFY-[A-F0-9]{8}$/),
      confirmationToken: z.string().min(80).max(10000),
    },
    async (input) => result(await applyShopifyThemeFilesUpsert(input)),
  );

  server.tool(
    'list_shopify_collections',
    'Lists manual and automated Shopify collections with product counts, rules, sort order, SEO, and pagination. Requires only read_products.',
    {
      query: z.string().max(1000).optional().describe('Optional Shopify collection search query, for example title:Sale.'),
      limit: z.number().int().min(1).max(250).default(100),
      pageToken: z.string().optional(),
    },
    async (input) => result(await listShopifyCollections(input)),
  );

  server.tool(
    'get_shopify_collection',
    'Returns one Shopify collection, its rules and metadata, and a paginated list of its products. Requires only read_products.',
    {
      collectionId: z.string().regex(/^gid:\/\/shopify\/Collection\/\d+$/),
      productLimit: z.number().int().min(1).max(250).default(100),
      productPageToken: z.string().optional(),
    },
    async (input) => result(await getShopifyCollection(input)),
  );

  server.tool(
    'list_shopify_publications',
    'Lists Shopify publications (sales channels) and whether they support automatic or scheduled publishing.',
    {
      limit: z.number().int().min(1).max(250).default(100),
      pageToken: z.string().optional(),
    },
    async (input) => result(await listShopifyPublications(input)),
  );

  server.tool(
    'get_shopify_collection_publication_status',
    'Returns the current and scheduled publication state of one Shopify collection across sales channels.',
    {
      collectionId: z.string().regex(/^gid:\/\/shopify\/Collection\/\d+$/),
    },
    async (input) => result(await getShopifyCollectionPublicationStatus(input)),
  );

  server.tool(
    'preview_shopify_collection_publication_update',
    'Creates a read-only preview for publishing, scheduling, or unpublishing one collection on selected Shopify publications. It never writes.',
    {
      collectionId: z.string().regex(/^gid:\/\/shopify\/Collection\/\d+$/),
      action: z.enum(['PUBLISH', 'UNPUBLISH']),
      publicationIds: z.array(z.string().regex(/^gid:\/\/shopify\/Publication\/\d+$/)).min(1).max(20),
      publishDate: z.string().datetime({ offset: true }).optional(),
    },
    async (input) => result(await previewShopifyCollectionPublicationUpdate(input)),
  );

  server.tool(
    'apply_shopify_collection_publication_update',
    'Applies exactly one previewed collection publish, scheduled publish, or unpublish action. Call only after the user explicitly replies with the exact SHOPIFY confirmation code.',
    {
      collectionId: z.string().regex(/^gid:\/\/shopify\/Collection\/\d+$/),
      action: z.enum(['PUBLISH', 'UNPUBLISH']),
      publicationIds: z.array(z.string().regex(/^gid:\/\/shopify\/Publication\/\d+$/)).min(1).max(20),
      publishDate: z.string().datetime({ offset: true }).optional(),
      confirmationCode: z.string().regex(/^SHOPIFY-[A-F0-9]{8}$/),
      confirmationToken: z.string().min(80).max(4000),
    },
    async (input) => result(await applyShopifyCollectionPublicationUpdate(input)),
  );

  server.tool(
    'list_shopify_metaobject_definitions',
    'Lists Shopify metaobject definitions, fields, validation rules, access, and capabilities. Read-only.',
    {
      limit: z.number().int().min(1).max(250).default(100),
      pageToken: z.string().optional(),
    },
    async (input) => result(await listShopifyMetaobjectDefinitions(input)),
  );

  server.tool(
    'list_shopify_metaobjects',
    'Lists Shopify metaobject entries for one definition type, including raw structured field values. Read-only.',
    {
      type: z.string().regex(/^[a-zA-Z0-9_$-]+$/).max(255),
      query: z.string().max(1000).optional(),
      limit: z.number().int().min(1).max(250).default(100),
      pageToken: z.string().optional(),
    },
    async (input) => result(await listShopifyMetaobjects(input)),
  );

  server.tool(
    'get_shopify_metaobject',
    'Returns one Shopify metaobject entry with all raw structured field values. Read-only.',
    {
      metaobjectId: z.string().regex(/^gid:\/\/shopify\/Metaobject\/\d+$/),
    },
    async (input) => result(await getShopifyMetaobject(input)),
  );

  server.tool(
    'preview_shopify_collection_update',
    'Creates a read-only preview for changing collection metadata. It never writes. Plain-text descriptions are converted to safe HTML. Use the returned confirmation code and token with apply_shopify_collection_update only after explicit user approval.',
    {
      collectionId: z.string().regex(/^gid:\/\/shopify\/Collection\/\d+$/),
      title: z.string().trim().min(1).max(255).optional(),
      descriptionText: z.string().max(50000).optional(),
      handle: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(255).optional(),
      sortOrder: z.enum(SHOPIFY_COLLECTION_SORT_ORDERS).optional(),
      seoTitle: z.string().max(255).optional(),
      seoDescription: z.string().max(5000).optional(),
    },
    async (input) => result(await previewShopifyCollectionUpdate(input)),
  );

  server.tool(
    'apply_shopify_collection_update',
    'Applies exactly one previously previewed Shopify collection metadata update. Call only after showing the full preview and the user explicitly replies with its exact SHOPIFY confirmation code. Rejects expired, altered, or stale previews.',
    {
      collectionId: z.string().regex(/^gid:\/\/shopify\/Collection\/\d+$/),
      title: z.string().trim().min(1).max(255).optional(),
      descriptionText: z.string().max(50000).optional(),
      handle: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(255).optional(),
      sortOrder: z.enum(SHOPIFY_COLLECTION_SORT_ORDERS).optional(),
      seoTitle: z.string().max(255).optional(),
      seoDescription: z.string().max(5000).optional(),
      confirmationCode: z.string().regex(/^SHOPIFY-[A-F0-9]{8}$/),
      confirmationToken: z.string().min(80).max(4000),
    },
    async (input) => result(await applyShopifyCollectionUpdate(input)),
  );

  server.tool(
    'preview_shopify_collection_products_update',
    'Creates a read-only preview for adding products to or removing products from one manual Shopify collection. Automated collection membership must be changed through rules. It never writes.',
    {
      collectionId: z.string().regex(/^gid:\/\/shopify\/Collection\/\d+$/),
      action: z.enum(['ADD', 'REMOVE']),
      productIds: z.array(z.string().regex(/^gid:\/\/shopify\/Product\/\d+$/)).min(1).max(50),
    },
    async (input) => result(await previewShopifyCollectionProductsUpdate(input)),
  );

  server.tool(
    'apply_shopify_collection_products_update',
    'Applies exactly one previewed add/remove operation for up to 50 products in a manual Shopify collection. Call only after the user explicitly replies with the preview exact SHOPIFY confirmation code.',
    {
      collectionId: z.string().regex(/^gid:\/\/shopify\/Collection\/\d+$/),
      action: z.enum(['ADD', 'REMOVE']),
      productIds: z.array(z.string().regex(/^gid:\/\/shopify\/Product\/\d+$/)).min(1).max(50),
      confirmationCode: z.string().regex(/^SHOPIFY-[A-F0-9]{8}$/),
      confirmationToken: z.string().min(80).max(4000),
    },
    async (input) => result(await applyShopifyCollectionProductsUpdate(input)),
  );

  server.tool(
    'preview_shopify_product_description_update',
    'Creates a read-only preview for changing one Shopify product description. Converts plain text to safe HTML and returns a short-lived confirmation code and token. Never applies the change.',
    {
      productId: z.string().regex(/^gid:\/\/shopify\/Product\/\d+$/),
      descriptionText: z.string().max(50000).describe('Plain text only. Blank lines create paragraphs; single line breaks become br tags.'),
    },
    async (input) => result(await previewShopifyProductDescriptionUpdate(input)),
  );

  server.tool(
    'apply_shopify_product_description_update',
    'Applies exactly one previously previewed Shopify product description. Call only after showing the full preview and the user explicitly replies with its exact SHOPIFY confirmation code. Rejects expired, altered, or stale previews. Cannot change prices, inventory, status, title, tags, SEO, or themes.',
    {
      productId: z.string().regex(/^gid:\/\/shopify\/Product\/\d+$/),
      descriptionText: z.string().max(50000),
      confirmationCode: z.string().regex(/^SHOPIFY-[A-F0-9]{8}$/),
      confirmationToken: z.string().min(80).max(4000),
    },
    async (input) => result(await applyShopifyProductDescriptionUpdate(input)),
  );

  server.tool(
    'get_shopify_sales_overview',
    'Returns Shopify order count, net current revenue, AOV, statuses, and daily totals without customer data.',
    {
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      includeCancelled: z.boolean().default(false),
      includeTest: z.boolean().default(false),
      maxOrders: z.number().int().min(1).max(5000).default(1000),
    },
    async (input) => result(await getShopifySalesOverview(input)),
  );

  server.tool(
    'list_shopify_order_delivery_details',
    'Returns per-order destination country, purchased products, customer product/shipping costs, and fulfillment/delivery durations. Excludes customer identity, street address, postal code, phone, email, and tracking numbers.',
    {
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      includeCancelled: z.boolean().default(false),
      includeTest: z.boolean().default(false),
      limit: z.number().int().min(1).max(250).default(50),
      pageToken: z.string().optional(),
    },
    async (input) => result(await listShopifyOrderDeliveryDetails(input)),
  );

  return server;
}
