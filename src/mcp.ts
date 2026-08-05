import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listProperties, runReport } from './google.js';
import { readStore } from './token-store.js';

function result(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  };
}

export function createMarketingMcpServer(): McpServer {
  const server = new McpServer({ name: 'marketing-mcp', version: '0.1.0' });

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

  return server;
}
