import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { MemberGrants } from './claude-members.js';
import { config } from './config.js';
import { runReport } from './google.js';
import { getGoogleAdsAccountOverview, getGoogleAdsCampaignPerformance, getGoogleAdsSearchTerms } from './google-ads.js';
import { getMerchantProductPerformance, getMerchantProductStatus } from './merchant-center.js';
import {
  getSearchConsolePerformance,
  SEARCH_CONSOLE_DIMENSIONS,
  SEARCH_CONSOLE_SEARCH_TYPES,
} from './search-console.js';
import { getShopifySalesOverview } from './shopify.js';
import { MARKETING_MCP_VERSION } from './version.js';
import { registerShopifyManagementTools } from './shopify-management-tools.js';
import { registerGoogleAdsWriteTools } from './google-ads-write-tools.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const dates = { startDate: date, endDate: date };
const reportLimit = z.number().int().min(1).max(1000).default(100);
const adsInputs = { ...dates, customerId: z.string().regex(/^\d{10}$/) };
const merchantInputs = { accountId: z.string().regex(/^\d+$/), limit: reportLimit, pageToken: z.string().max(4096).optional() };
const reporting = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function connectionFor(resources: MemberGrants['ga4'], id: string): string {
  const grant = resources.find(resource => resource.id === id);
  if (!grant) throw new Error('This reporting account has not been granted to your Hub login.');
  return grant.connectionId;
}

export function createClaudeMcpServer(grants: MemberGrants): McpServer {
  const server = new McpServer({ name: 'marketing-data-hub-claude', version: MARKETING_MCP_VERSION });
  const hasShopify = grants.shopify !== undefined && grants.shopify === config.SHOPIFY_SHOP;
  server.registerTool('list_authorized_accounts', {
    description: 'Lists the exact reporting account and property IDs granted to your Hub login.',
    annotations: reporting,
  }, () => result({
    ga4PropertyIds: grants.ga4.map(resource => resource.id),
    googleAdsCustomerIds: grants.googleAds.map(resource => resource.id),
    searchConsoleSites: grants.searchConsole.map(resource => resource.id),
    merchantCenterAccountIds: grants.merchantCenter.map(resource => resource.id),
    shopifyShop: hasShopify ? grants.shopify : null,
    writeAccess: {
      shopify: hasShopify && grants.writes?.shopify === true,
      googleAdsCustomerIds: grants.writes?.googleAdsCustomerIds ?? [],
    },
  }));

  if (grants.ga4.length > 0) {
    server.registerTool('run_ga4_report', {
      description: 'Runs a GA4 report for an authorized property. Use GA4 Data API dimension and metric names.',
      inputSchema: {
        ...dates,
        propertyId: z.string().regex(/^\d+$/),
        dimensions: z.array(z.string()).max(9).default([]),
        metrics: z.array(z.string()).min(1).max(10),
        limit: z.number().int().min(1).max(10000).default(100),
      },
      annotations: reporting,
    }, async input => result(await runReport({
      ...input, connectionId: connectionFor(grants.ga4, input.propertyId),
    })));
  }

  if (grants.googleAds.length > 0) {
    server.registerTool('get_google_ads_account_overview', {
      description: 'Returns account-level Google Ads performance for an authorized customer.',
      inputSchema: adsInputs,
      annotations: reporting,
    }, async input => result(await getGoogleAdsAccountOverview({
      ...input, connectionId: connectionFor(grants.googleAds, input.customerId),
    })));
    server.registerTool('get_google_ads_campaign_performance', {
      description: 'Returns Google Ads campaign performance for an authorized customer.',
      inputSchema: { ...adsInputs, limit: reportLimit },
      annotations: reporting,
    }, async input => result(await getGoogleAdsCampaignPerformance({
      ...input, connectionId: connectionFor(grants.googleAds, input.customerId),
    })));
    server.registerTool('get_google_ads_search_terms', {
      description: 'Returns Google Ads search-term performance for an authorized customer.',
      inputSchema: { ...adsInputs, limit: reportLimit },
      annotations: reporting,
    }, async input => result(await getGoogleAdsSearchTerms({
      ...input, connectionId: connectionFor(grants.googleAds, input.customerId),
    })));
  }

  if (grants.searchConsole.length > 0) {
    server.registerTool('get_search_console_performance', {
      description: 'Returns Google Search Console search performance for an authorized site. Use the exact site string.',
      inputSchema: {
        ...dates,
        siteUrl: z.string().min(1).max(2048),
        dimensions: z.array(z.enum(SEARCH_CONSOLE_DIMENSIONS)).max(7).default(['date']),
        searchType: z.enum(SEARCH_CONSOLE_SEARCH_TYPES).default('web'),
        rowLimit: z.number().int().min(1).max(25000).default(1000),
        startRow: z.number().int().min(0).default(0),
      },
      annotations: reporting,
    }, async input => result(await getSearchConsolePerformance({
      ...input, connectionId: connectionFor(grants.searchConsole, input.siteUrl),
    })));
  }

  if (grants.merchantCenter.length > 0) {
    server.registerTool('get_merchant_product_status', {
      description: 'Returns product eligibility and item issues for an authorized Merchant Center account.',
      inputSchema: merchantInputs,
      annotations: reporting,
    }, async input => result(await getMerchantProductStatus({
      ...input, connectionId: connectionFor(grants.merchantCenter, input.accountId),
    })));
    server.registerTool('get_merchant_product_performance', {
      description: 'Returns product performance for an authorized Merchant Center account.',
      inputSchema: { ...dates, ...merchantInputs },
      annotations: reporting,
    }, async input => result(await getMerchantProductPerformance({
      ...input, connectionId: connectionFor(grants.merchantCenter, input.accountId),
    })));
  }

  if (hasShopify) {
    server.registerTool('get_shopify_sales_overview', {
      description: 'Returns aggregate order count, revenue and average order value for the authorized Shopify shop.',
      inputSchema: { ...dates, maxOrders: z.number().int().min(1).max(5000).default(1000) },
      annotations: reporting,
    }, async input => result(await getShopifySalesOverview(input)));
  }

  if (hasShopify && grants.writes?.shopify) registerShopifyManagementTools(server);
  const writableAds = grants.googleAds.filter(resource => grants.writes?.googleAdsCustomerIds.includes(resource.id));
  if (writableAds.length > 0) {
    registerGoogleAdsWriteTools(server, id => connectionFor(writableAds, id));
  }

  return server;
}
