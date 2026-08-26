# Review checklist

- [ ] Secrets are absent from Git history.
- [ ] OAuth redirect URI matches Google Cloud exactly.
- [ ] Search Console API is enabled and the OAuth consent screen includes `webmasters.readonly`.
- [ ] The existing Google account is reconnected after deployment for the new scope.
- [ ] Port 8000 is bound to localhost only.
- [ ] Nginx uses the existing wildcard certificate.
- [ ] MCP endpoint rejects missing or invalid bearer tokens.
- [ ] Encrypted token data survives container restarts.
- [ ] GA4 tools return the expected mambo.cc data.
- [ ] `list_search_console_sites` returns the verified domain property.
- [ ] Search Console performance matches the UI for identical dates, type, dimensions, filters, aggregation, and freshness.
- [ ] Tests, typecheck, build, Docker build, and GitHub Actions pass.
