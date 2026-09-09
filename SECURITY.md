# Security

- Never commit `.env`, OAuth client secrets, bearer tokens, refresh tokens, or encryption keys.
- The MCP endpoint is protected with a long bearer token.
- Google refresh tokens are encrypted at rest with AES-256-GCM.
- Shopify client credentials stay in `.env`; short-lived access tokens stay in memory.
- Shopify order delivery analytics use only destination country and exclude customer identity, detailed addresses, contact details, and tracking numbers.
- Google reporting remains read-only. The only Google Ads write path changes `primary_for_goal` on one existing enabled purchase conversion action after a validate-only check, bound expiring preview, exact confirmation code, stale-state check, and post-write verification.
- Shopify product writes cannot change prices, inventory, publication status, titles, tags, SEO fields, or themes, and log hashes rather than description contents.
- Keep Docker, Node.js, Nginx, and host packages patched.
- Back up the encrypted token store and encryption key separately.
- Rotate `MCP_BEARER_TOKEN` and `ADMIN_TOKEN` if either is exposed.

Report suspected vulnerabilities privately to the repository owner rather than opening a public issue.
