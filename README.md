# Marketing MCP

Self-hosted Model Context Protocol server for connecting ChatGPT Work to marketing data sources.

Initial scope:

- Google Analytics 4 via Google OAuth 2.0
- Google Search Console performance via read-only Google OAuth 2.0
- Google Ads reporting plus guarded purchase-conversion Primary/Secondary updates via Google Ads API
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
state retain their existing preview plus exact-confirmation tools. The advanced
Shopify management tools cover every installed management area: full product and
variant editing, product duplication/deletion, manual and automated collections,
publication, files, inventory, locations, metaobjects and definitions, navigation,
themes, shipping and delivery customizations. They discover the live API schema
and granted scopes rather than assuming a fixed permission list. Every write
requires a complete current-state preview, explicit expiring approval, stale-state
check and readback; partial or uncertain writes are locked against automatic retry.
Orders remain read-only and Shopify platform restrictions still apply. See
[docs/SHOPIFY_ADMIN.md](docs/SHOPIFY_ADMIN.md) and the legacy workflows in
[docs/SHOPIFY.md](docs/SHOPIFY.md).

DataForSEO uses the account's API login and password through server-side Basic
authentication. The integration includes free connection/location checks plus capped,
read-only paid calls for Google keyword volumes, keyword ideas, ranked keywords, and
live organic SERPs. Every paid result reports the actual DataForSEO cost. See
[docs/DATAFORSEO.md](docs/DATAFORSEO.md).

Google Ads writes are restricted to `primary_for_goal` on an existing enabled
purchase conversion action. A read-only `validateOnly` preview, signed expiring
token, exact confirmation code, stale-state check, and post-write verification are
required. Campaigns, budgets, bids, ads, conversion values/windows/status, and
deletions remain unavailable.

> Never commit `.env` files, OAuth client secrets, refresh tokens, or private keys.
