# ChatGPT Work setup

After the server is deployed and a Google account has been connected, create a custom plugin in ChatGPT Work.

## Connector settings

- Name: `Marketing MCP`
- Description: `Marketing reporting plus preview-and-confirm Shopify management across the installed app permissions.`
- Connection: `Server URL`
- Server URL: `https://marketing.klubnavi.de/mcp`
- Authentication: `Bearer token`
- Token: use `MCP_BEARER_TOKEN` from the server `.env`

Do not use the Google client secret in ChatGPT. Google OAuth is handled between your browser, Google, and the MCP server.

## Initial tests

1. `List all connected Google accounts.`
2. `List all GA4 properties available to the first connected Google account.`
3. `List all verified Search Console properties available to the first connected Google account.`
4. `For the mambo.cc domain property, show daily Search Console clicks, impressions, CTR, and position for the last 30 finalized days.`
5. `For the mambo.cc property, show ecommerce performance for the last 30 complete days.`
6. `Show the 20 landing pages with the most sessions and compare transactions, revenue and session conversion rate.`

## Suggested starter tools

- `get_shopify_capabilities`
- `inspect_shopify_operation`
- `run_shopify_query`
- `preview_shopify_admin_mutation`
- `apply_shopify_admin_mutation` (requires that preview's exact user-supplied code)

- `list_google_connections`
- `list_ga4_properties`
- `run_ga4_report`
- `get_ecommerce_overview`
- `get_landing_page_performance`
- `list_search_console_sites`
- `get_search_console_performance`

## Refresh after deployment

Adding Shopify scopes and reconnecting OAuth do not add server code or reliably
refresh an already imported tool definition. After deploying 0.14.0, open the
custom Marketing Data Hub connection, select **Refresh** for its metadata/tools,
and verify the five Shopify management tools above are advertised. Start a new
conversation with the connector selected. Confirm its endpoint is
`https://marketing.klubnavi.de/mcp`.

For a packaged/published plugin, update its imported tool definition/version as
appropriate rather than repeatedly disconnecting Shopify authentication.
See [OpenAI's refresh instructions](https://developers.openai.com/plugins/deploy/connect-chatgpt#refresh-metadata).

The same MCP tools can be used by another MCP client, including Claude, after the
client has connected to the endpoint and refreshed its tool discovery. Existing
authentication and installed Shopify scopes remain server-side.
