// Read-only deployment diagnostic. No catalogue mutation or token is printed.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMarketingMcpServer } from './mcp.js';
import { getShopifyCapabilities } from './shopify-admin.js';
import { MARKETING_MCP_VERSION } from './version.js';

const client = new Client({ name: 'shopify-deployment-check', version: '1' });
const server = createMarketingMcpServer();
const [left, right] = InMemoryTransport.createLinkedPair();
await server.connect(left);
await client.connect(right);
try {
  const { tools } = await client.listTools();
  const required = ['get_shopify_capabilities', 'inspect_shopify_operation', 'run_shopify_query',
    'preview_shopify_admin_mutation', 'apply_shopify_admin_mutation'];
  for (const name of required) if (!tools.some(tool => tool.name === name)) throw new Error(`Missing MCP tool ${name}`);
  const capabilities = await getShopifyCapabilities();
  console.log(JSON.stringify({ version: MARKETING_MCP_VERSION, shop: capabilities.shop, apiVersion: capabilities.apiVersion,
    toolCount: tools.length, managementTools: required,
    areas: capabilities.managementAreas.map(area => ({ area: area.area, granted: area.granted, operations: area.operations.length })),
    catalogWrites: 0 }, null, 2));
} finally {
  await client.close();
  await server.close();
}
