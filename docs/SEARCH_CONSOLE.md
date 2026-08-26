# Google Search Console

The Search Console integration reuses the server's encrypted Google OAuth
connections and requests only the read-only `webmasters.readonly` scope. It does
not create properties, submit sitemaps, inspect URLs, or write Search Console
data.

## Setup

1. Enable **Google Search Console API** in the Google Cloud project used by the
   server's OAuth client.
2. Add `https://www.googleapis.com/auth/webmasters.readonly` to the OAuth consent
   configuration if the consent screen manages scopes explicitly.
3. Deploy version 0.8.0 or later.
4. Reconnect the Google account at `/connect/google?admin_token=...` so its new
   refresh token includes the Search Console scope.
5. Refresh the MCP connector's tool schema after deployment.

The connected Google identity must have access to the property in Search Console.
The OAuth callback verifies that every required Google API scope was actually
granted and does not replace the stored connection after a partial permission
grant.
An external OAuth consent app left in Testing can issue refresh tokens that expire
after seven days; publish and verify the app as appropriate before relying on
unattended access.

## Tools

`list_search_console_sites` returns verified properties and permission levels. Use
the exact returned `siteUrl` in later calls:

- Domain property: `sc-domain:example.com`
- URL-prefix property: `https://www.example.com/`

Do not reconstruct or remove the trailing slash from a property identifier.

`get_search_console_performance` returns native Search Analytics rows containing
dimension-aligned `keys`, `clicks`, `impressions`, `ctr`, and average `position`.
It defaults to daily web-search data in final state and supports:

- dimensions: date, hour, query, page, country, device, and search appearance;
- search types: web, image, video, news, Discover, and Google News;
- AND filters for query, page, country, device, and search appearance;
- automatic, page, or property aggregation;
- final, fresh/incomplete, or hourly data;
- pagination with `rowLimit` up to 25,000 and zero-based `startRow`.

Pass an empty `dimensions` array for a single aggregate row. Search appearance
must be the only grouping dimension; use it as a filter when grouping by another
dimension. Property aggregation is not available for Discover or Google News and
cannot be combined with page grouping or filtering.

Example:

```json
{
  "siteUrl": "sc-domain:example.com",
  "startDate": "2026-08-01",
  "endDate": "2026-08-20",
  "dimensions": ["date", "query"],
  "searchType": "web",
  "dataState": "final",
  "rowLimit": 1000
}
```

## Data behavior

Search Console dates are inclusive and use Pacific Time. Final data normally
trails by two to three days. `dataState: all` can include incomplete recent data;
inspect `metadata.first_incomplete_date` when Google returns it. The `hour`
dimension requires `dataState: hourly_all`.
Hourly reports are limited to the most recent ten days and a single request can
cover no more than ten inclusive days.

The API returns top rows, not guaranteed-complete query/page detail. It exposes at
most 50,000 rows per property, day, and search type. Page or query detail also
uses more API load than property-level daily totals. For larger syncs, query one
day at a time and advance `startRow` by 25,000 until Google returns no rows.

See Google's official [Search Analytics query reference](https://developers.google.com/webmaster-tools/v1/searchanalytics/query),
[property listing reference](https://developers.google.com/webmaster-tools/v1/sites/list),
and [usage limits](https://developers.google.com/webmaster-tools/limits).
