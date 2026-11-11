import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { previewGoogleAdsConversionPrimaryUpdate, applyGoogleAdsConversionPrimaryUpdate } from './google-ads.js';

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

export function registerGoogleAdsWriteTools(
  server: McpServer,
  connectionForCustomer?: (customerId: string) => string,
): void {
  function authorized<T extends { customerId: string; connectionId?: string }>(input: T): T {
    if (!connectionForCustomer) return input;
    return { ...input, connectionId: connectionForCustomer(input.customerId.replace(/-/g, '')) };
  }
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
    async (input) => result(await previewGoogleAdsConversionPrimaryUpdate(authorized(input))),
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
    async (input) => result(await applyGoogleAdsConversionPrimaryUpdate(authorized(input))),
  );
}
