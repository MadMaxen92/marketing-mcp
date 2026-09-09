# Marketing MCP

Self-hosted Model Context Protocol server for connecting ChatGPT Work to marketing data sources.

Initial scope:

- Google Analytics 4 via Google OAuth 2.0
- Google Search Console performance via read-only Google OAuth 2.0
- Google Ads via Google Ads API
- Google Merchant Center via Merchant API v1
- Shopify orders and products via GraphQL Admin API
- DataForSEO keyword research, domain rankings, and live Google SERPs
- Remote MCP over HTTP
- Docker deployment on Hetzner
- Nginx reverse proxy

Merchant Center tools cover account discovery, account and product issues, product
eligibility, product performance, price insights, and advanced read-only MCQL
queries. See [docs/MERCHANT_CENTER.md](docs/MERCHANT_CENTER.md) for setup and usage.

Search Console tools discover verified domain and URL-prefix properties and return
clicks, impressions, CTR, and average position across date, query, page, country,
device, and search-appearance dimensions. See
[docs/SEARCH_CONSOLE.md](docs/SEARCH_CONSOLE.md) for setup, query behavior, and
data limits.

Shopify uses a merchant-owned Dev Dashboard app with short-lived client-credentials
tokens. Products, collections, sales channels, publication state, and metaobjects
can be read with narrowly scoped Shopify permissions. Product descriptions,
collection metadata, manual collection membership, and collection publication
state can be changed only through a preview plus an exact, short-lived confirmation
code. Existing merchant-defined shipping prices and kilogram weight bands use the
same guarded preview flow through Shopify delivery profiles. PDP theme files can be
read and updated only on an unpublished theme; the live theme is never writable.
Product prices, inventory, automated collection rules, and metaobjects remain read-only. See
[docs/SHOPIFY.md](docs/SHOPIFY.md).

DataForSEO uses the account's API login and password through server-side Basic
authentication. The integration includes free connection/location checks plus capped,
read-only paid calls for Google keyword volumes, keyword ideas, ranked keywords, and
live organic SERPs. Every paid result reports the actual DataForSEO cost. See
[docs/DATAFORSEO.md](docs/DATAFORSEO.md).

> Never commit `.env` files, OAuth client secrets, refresh tokens, or private keys.
