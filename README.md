# Marketing MCP

Self-hosted Model Context Protocol server for connecting ChatGPT Work to marketing data sources.

Initial scope:

- Google Analytics 4 via Google OAuth 2.0
- Google Ads via Google Ads API
- Google Merchant Center via Merchant API v1
- Shopify orders and products via GraphQL Admin API
- Remote MCP over HTTP
- Docker deployment on Hetzner
- Nginx reverse proxy

Merchant Center tools cover account discovery, account and product issues, product
eligibility, product performance, price insights, and advanced read-only MCQL
queries. See [docs/MERCHANT_CENTER.md](docs/MERCHANT_CENTER.md) for setup and usage.

Shopify uses a merchant-owned Dev Dashboard app with short-lived client-credentials
tokens. Products, collections, sales channels, publication state, and metaobjects
can be read with narrowly scoped Shopify permissions. Product descriptions,
collection metadata, manual collection membership, and collection publication
state can be changed only through a preview plus an exact, short-lived confirmation
code. Prices, inventory, automated collection rules, themes, and metaobjects remain
read-only. See [docs/SHOPIFY.md](docs/SHOPIFY.md).

> Never commit `.env` files, OAuth client secrets, refresh tokens, or private keys.
