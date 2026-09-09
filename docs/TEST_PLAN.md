# v0.12 test plan

## Build

```bash
npm install
npm test
npm run typecheck
npm run build
docker build -t marketing-mcp:test .
```

## Runtime

- `/health` returns HTTP 200.
- `/mcp` returns HTTP 401 without the bearer token.
- Google OAuth callback stores an encrypted connection file.
- Restarting the container preserves the Google connection.
- `list_google_connections` never returns refresh or access tokens.
- `list_ga4_properties` returns the expected mambo.cc property.
- `get_ecommerce_overview` returns data for a known date range.
- `get_landing_page_performance` returns landing pages and ecommerce metrics.
- Google Ads conversion write previews use `validateOnly`, bind the exact current
  purchase-action state, and expire after ten minutes.
- Applying a Google Ads conversion role change requires the exact confirmation
  code and token, rejects stale state, changes only `primary_for_goal`, and reads
  the action back after mutation.
- `list_search_console_sites` returns the expected verified domain property.
- `get_search_console_performance` matches Search Console for the same property,
  dates, search type, aggregation, dimensions, filters, and data state.
- Domain properties use their exact `sc-domain:` identifier and URL-prefix
  properties preserve their exact trailing slash and path.

## Security

- `.env` is ignored by Git.
- Port 8000 only binds to `127.0.0.1` on the host.
- HTTPS terminates at Nginx.
- MCP access requires a long bearer token.
