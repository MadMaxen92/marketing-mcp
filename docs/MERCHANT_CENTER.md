# Google Merchant Center

The integration uses the current Google Merchant API, not the legacy Content API
for Shopping. It is read-only at the MCP layer.

## Setup

1. Enable **Merchant API** in the Google Cloud project used by this service.
2. Ensure the OAuth consent screen includes
   `https://www.googleapis.com/auth/content`.
3. Deploy the updated service.
4. Reconnect each Google account through `/connect/google?admin_token=...` so
   Google grants the additional scope.
5. Confirm that the connected Google identity is a user of the required Merchant
   Center accounts. For an advanced account, query each sub-account separately for
   reports and product status.

The OAuth scope can technically authorize writes, but this server does not expose
Merchant write methods. Custom queries must be one MCQL `SELECT` statement.

## MCP tools

- `list_merchant_center_accounts`: accessible accounts, with pagination and an
  optional account filter.
- `get_merchant_account_overview`: account data, account-level issues, and
  aggregate product health by country and reporting context.
- `get_merchant_product_status`: product eligibility and item issues, optionally
  filtered by offer ID, aggregate status, or reporting context.
- `get_merchant_product_issues`: limited and disapproved products with details.
- `get_merchant_product_performance`: impressions, clicks, conversions, and
  conversion value for a date range.
- `get_merchant_price_insights`: suggested prices and predicted performance
  changes when Google has enough data.
- `run_merchant_center_query`: advanced read-only Merchant Center Query Language
  (MCQL) reports.

All account-specific tools accept a numeric `accountId`; `accounts/123456789` is
also accepted. Account discovery and custom report queries accept Google's
`nextPageToken` for pagination. The overview response surfaces continuation
tokens if an account has more than 100 account issues or 250 aggregate status
groups.

Example custom report:

```sql
SELECT
  offer_id,
  title,
  impressions,
  clicks
FROM product_performance_view
WHERE date BETWEEN '2026-07-01' AND '2026-07-31'
ORDER BY clicks DESC
LIMIT 100
```

## API versions and endpoints

- Accounts: `/accounts/v1`
- Reports and MCQL: `/reports/v1`
- Account issues: `/accounts/v1`
- Aggregate product statuses: `/issueresolution/v1`

The predefined product-status tools use `product_view`, which supports filtering
and returns the processed Merchant Center eligibility state. Product performance
and price insights use `product_performance_view` and
`price_insights_product_view` respectively.

## Troubleshooting

- `403 PERMISSION_DENIED`: reconnect the Google account and verify Merchant Center
  user access.
- No performance rows: confirm the requested date range and that Merchant Center
  has reportable traffic.
- No price insights: Google only returns recommendations when sufficient product
  and market data is available.
- Advanced account errors: use `list_merchant_center_accounts`, then run reports
  against a standalone account or an individual sub-account.
