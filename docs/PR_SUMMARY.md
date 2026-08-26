# Pull request summary

This branch adds read-only Google Search Console support to the self-hosted Marketing MCP:

- Verified property discovery with exact domain and URL-prefix identifiers
- Search Analytics clicks, impressions, CTR, and average position
- Dimensions, filters, search types, aggregation, freshness, and pagination
- Least-privilege Search Console OAuth scope with encrypted shared credentials
- Guardrails for invalid API combinations, incomplete hourly data, and date ranges
- Automated provider tests plus CI, deployment, and operator documentation
