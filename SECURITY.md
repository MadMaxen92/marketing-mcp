# Security

- Never commit `.env`, OAuth client secrets, bearer tokens, refresh tokens, or encryption keys.
- The MCP endpoint is protected with a long bearer token.
- Google refresh tokens are encrypted at rest with AES-256-GCM.
- Shopify client credentials stay in `.env`; short-lived access tokens stay in memory.
- The server exposes read-only Google and Shopify tools.
- Keep Docker, Node.js, Nginx, and host packages patched.
- Back up the encrypted token store and encryption key separately.
- Rotate `MCP_BEARER_TOKEN` and `ADMIN_TOKEN` if either is exposed.

Report suspected vulnerabilities privately to the repository owner rather than opening a public issue.
