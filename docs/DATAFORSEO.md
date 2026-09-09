# DataForSEO

The DataForSEO integration adds read-only SEO and keyword-research data to the
Marketing MCP. Credentials stay in the server `.env` file and are never returned by
an MCP tool.

## Configuration

Copy the API login and API password from the DataForSEO API Access page into:

```text
DATAFORSEO_LOGIN=...
DATAFORSEO_PASSWORD=...
```

Restart the container after changing the environment file.

## Tools

- `get_dataforseo_account_status`: free connection, balance, and limit check
- `list_dataforseo_locations`: free country/language lookup
- `get_dataforseo_keyword_search_volume`: paid Google Ads keyword volume request,
  capped at 1,000 keywords
- `get_dataforseo_keyword_ideas`: paid Google keyword-idea request, capped at 100
  returned rows per call
- `get_dataforseo_ranked_keywords`: paid Google organic ranking request, capped at
  100 returned rows per call
- `get_dataforseo_google_organic_serp`: paid live Google SERP request, capped at
  depth 100

Every paid tool returns `costUsd` from DataForSEO. Use
`get_dataforseo_account_status` before a larger batch and prefer one batched keyword
volume call over many small calls.

## Suggested checks

1. Call `get_dataforseo_account_status` and confirm a non-null balance.
2. Call `list_dataforseo_locations` with `countryIsoCode` set to `GB` or `DE`.
3. Run one low-volume keyword request and confirm `costUsd`, location, and language.

Do not whitelist a single source IP in DataForSEO when the integration may later be
moved or proxied. If IP restrictions are enabled, allow the production server's
stable outbound IP.
