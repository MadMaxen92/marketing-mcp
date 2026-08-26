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
Google Search Console API
Google Ads API
Google Merchant API
Shopify GraphQL Admin API
```

Authentication has two separate layers:

1. ChatGPT authenticates to the MCP endpoint with `MCP_BEARER_TOKEN`.
2. Each Google account is authorized through Google OAuth. Refresh tokens are encrypted at rest with `TOKEN_ENCRYPTION_KEY`.
3. The merchant-owned Shopify app exchanges its client credentials for a short-lived access token, which is cached only in memory.

The first release is stateless at the MCP transport layer. Each MCP request creates a fresh server and transport, while Google account connections persist in the encrypted file store.

GA4, Google Ads, Merchant Center, and Search Console share the same Google OAuth connection.
Merchant Center calls use the stable Merchant API v1 endpoints for accounts,
reports, products, and issue resolution. No legacy Content API for Shopping
endpoint is used.

Search Console calls use only the read-only `webmasters.readonly` OAuth scope.
Property discovery preserves Google's exact domain or URL-prefix identifier, and
performance queries URL-encode that complete identifier before calling the Search
Analytics API.

Shopify calls use the stable GraphQL Admin API `2026-07`. Order tools remain
read-only and do not query customer identity fields. Product descriptions use a
separate two-step write path: a dry-run reads the current description and issues
an HMAC-signed confirmation bound to the shop, product, proposed text, current
product version, and a ten-minute expiry. The apply tool accepts only that exact
preview and sends only `id` and `descriptionHtml` to `productUpdate`.
