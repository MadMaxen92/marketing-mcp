# v0.1 test plan

## Build

```bash
npm install
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

## Security

- `.env` is ignored by Git.
- Port 8000 only binds to `127.0.0.1` on the host.
- HTTPS terminates at Nginx.
- MCP access requires a long bearer token.
