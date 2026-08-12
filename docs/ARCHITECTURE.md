# Architecture

```text
ChatGPT Work
  -> HTTPS + MCP bearer token
Nginx at marketing.klubnavi.de
  -> 127.0.0.1:8000
Docker container
  -> Streamable HTTP MCP endpoint
  -> Google OAuth web flow
  -> encrypted local token store
  -> Shopify client-credentials token cache (memory only)
Google Analytics Admin API
Google Analytics Data API
Google Ads API
Google Merchant API
Shopify GraphQL Admin API
```

Authentication has two separate layers:

1. ChatGPT authenticates to the MCP endpoint with `MCP_BEARER_TOKEN`.
2. Each Google account is authorized through Google OAuth. Refresh tokens are encrypted at rest with `TOKEN_ENCRYPTION_KEY`.
3. The merchant-owned Shopify app exchanges its client credentials for a short-lived access token, which is cached only in memory.

The first release is stateless at the MCP transport layer. Each MCP request creates a fresh server and transport, while Google account connections persist in the encrypted file store.

GA4, Google Ads, and Merchant Center share the same Google OAuth connection.
Merchant Center calls use the stable Merchant API v1 endpoints for accounts,
reports, products, and issue resolution. No legacy Content API for Shopping
endpoint is used.

Shopify calls use the stable GraphQL Admin API `2026-07`. Only order and product
read scopes are requested, and the exposed tools do not query customer identity
fields.
