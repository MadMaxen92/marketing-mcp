# Security

- Never commit `.env`, OAuth client secrets, bearer tokens, refresh tokens, or encryption keys.
- The MCP endpoint is protected with a long bearer token.
- Google refresh tokens are encrypted at rest with AES-256-GCM.
- Shopify client credentials stay in `.env`; short-lived access tokens stay in memory.
- Shopify order delivery analytics use only destination country and exclude customer identity, detailed addresses, contact details, and tracking numbers.
- Google tools and Shopify analytics are read-only. The only Shopify write tool changes one product description after a bound, expiring preview and exact confirmation code.
- Shopify product writes cannot change prices, inventory, publication status, titles, tags, SEO fields, or themes, and log hashes rather than description contents.
- Keep Docker, Node.js, Nginx, and host packages patched.
- Back up the encrypted token store and encryption key separately.
- Rotate `MCP_BEARER_TOKEN` and `ADMIN_TOKEN` if either is exposed.

Report suspected vulnerabilities privately to the repository owner rather than opening a public issue.
