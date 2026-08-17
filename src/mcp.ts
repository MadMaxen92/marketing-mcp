import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listProperties, runReport } from './google.js';
import {
  getGoogleAdsAccountOverview,
  getGoogleAdsCampaignPerformance,
  getGoogleAdsSearchTerms,
  listGoogleAdsAccounts,
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
import { readStore } from './token-store.js';
import {
  applyShopifyProductDescriptionUpdate,
  getShopifySalesOverview,
  getShopifyShopOverview,
  listShopifyOrderDeliveryDetails,
  listShopifyProducts,
  previewShopifyProductDescriptionUpdate,
} from './shopify.js';

function result(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  };
}

export function createMarketingMcpServer(): McpServer {
  const server = new McpServer({ name: 'marketing-mcp', version: '0.5.0' });

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

  server.tool(
    'get_shopify_shop_overview',
    'Checks the read-only Shopify connection and returns non-sensitive shop details plus granted app scopes.',
    {},
    async () => result(await getShopifyShopOverview()),
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
