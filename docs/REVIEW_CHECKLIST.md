# Review checklist

- [ ] Secrets are absent from Git history.
- [ ] OAuth redirect URI matches Google Cloud exactly.
- [ ] Only read-only Analytics scopes are requested.
- [ ] Port 8000 is bound to localhost only.
- [ ] Nginx uses the existing wildcard certificate.
- [ ] MCP endpoint rejects missing or invalid bearer tokens.
- [ ] Encrypted token data survives container restarts.
- [ ] GA4 tools return the expected mambo.cc data.
