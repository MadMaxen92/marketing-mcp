# Marketing MCP

Self-hosted Model Context Protocol server for connecting ChatGPT Work to marketing data sources.

Initial scope:

- Google Analytics 4 via Google OAuth 2.0
- Google Ads via Google Ads API
- Google Merchant Center via Merchant API v1
- Remote MCP over HTTP
- Docker deployment on Hetzner
- Nginx reverse proxy

Merchant Center tools cover account discovery, account and product issues, product
eligibility, product performance, price insights, and advanced read-only MCQL
queries. See [docs/MERCHANT_CENTER.md](docs/MERCHANT_CENTER.md) for setup and usage.

> Never commit `.env` files, OAuth client secrets, refresh tokens, or private keys.
