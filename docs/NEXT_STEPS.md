# Immediate next steps

1. Open and review the v0.8 pull request.
2. Let GitHub Actions run the TypeScript and Docker build.
3. Fix any compatibility errors found by CI.
4. Merge v0.8 into `main`.
5. Enable Search Console API and deploy the updated `main` build on Hetzner.
6. Reconnect the existing Google account to grant the read-only Search Console scope.
7. Refresh the Marketing Data Hub connector's discovered MCP tools.
8. Call `list_search_console_sites`, then validate `get_search_console_performance`
   against the same property and date range in Search Console.
