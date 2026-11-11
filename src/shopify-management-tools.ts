import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { launchActionSchema, getShopifyLaunchCapabilities, previewShopifyLaunchPreparation, applyShopifyLaunchPreparation } from './shopify-launch.js';
import { shopifyAdminPlanSchema, getShopifyCapabilities, inspectShopifyOperation, runShopifyQuery, previewShopifyAdminMutation, applyShopifyAdminMutation } from './shopify-admin.js';

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

// Register only after the caller has authorized management of the configured shop.
export function registerShopifyManagementTools(server: McpServer): void {
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
}
