# ChatGPT Work setup

After the server is deployed and a Google account has been connected, create a custom plugin in ChatGPT Work.

## Connector settings

- Name: `Marketing MCP`
- Description: `Read-only access to connected marketing data sources.`
- Connection: `Server URL`
- Server URL: `https://marketing.klubnavi.de/mcp`
- Authentication: `Bearer token`
- Token: use `MCP_BEARER_TOKEN` from the server `.env`

Do not use the Google client secret in ChatGPT. Google OAuth is handled between your browser, Google, and the MCP server.

## Initial tests

1. `List all connected Google accounts.`
2. `List all GA4 properties available to the first connected Google account.`
3. `For the mambo.cc property, show ecommerce performance for the last 30 complete days.`
4. `Show the 20 landing pages with the most sessions and compare transactions, revenue and session conversion rate.`

## Current tools

- `list_google_connections`
- `list_ga4_properties`
- `run_ga4_report`
- `get_ecommerce_overview`
- `get_landing_page_performance`
