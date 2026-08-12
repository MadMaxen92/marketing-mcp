# Shopify

The Shopify integration is designed for one merchant-owned store. It uses the
GraphQL Admin API `2026-07` and Shopify's client-credentials grant. Access tokens
last 24 hours and are requested and cached by the service automatically.

## Data and privacy scope

Configure only these app scopes for the first version:

- `read_orders`
- `read_products`

Do not grant `read_customers`. The MCP tools intentionally request no customer
names, email addresses, phone numbers, or postal addresses.

`read_orders` normally covers the most recent 60 days. Access to older orders
requires Shopify approval for `read_all_orders`; that scope is not required for
the initial integration.

## Create and install the Shopify app

1. Open `https://dev.shopify.com/dashboard` while signed in to the merchant
   organization that owns the production store.
2. Go to **Apps**, select **Create app**, then **Start from Dev Dashboard**.
3. Name the app `Marketing Data Hub`.
4. Create a version. The app is API-only, so it can use Shopify's default app URL.
5. Select GraphQL Admin API scopes `read_orders` and `read_products`, then release
   the version.
6. From the app home, select **Install app**, choose the production store, review
   the two read-only permissions, and install it.
7. Open the app's **Settings** page and copy the Client ID and Client secret.

The app and store must be in the same Shopify organization for the
client-credentials grant. If Shopify returns `shop_not_permitted`, verify the
organization shown in the Dev Dashboard URL and the store association.

## Server configuration

Add these values to the deployment `.env` file. `SHOPIFY_SHOP` is only the stable
`.myshopify.com` subdomain, not the storefront domain and not the full URL.

```dotenv
SHOPIFY_SHOP=your-store-subdomain
SHOPIFY_CLIENT_ID=your-client-id
SHOPIFY_CLIENT_SECRET=your-client-secret
```

Never commit the real values. Recreate the container after changing `.env`:

```bash
docker compose up -d --build --force-recreate
docker compose ps
curl -fsS http://127.0.0.1:8000/health
```

## MCP tools

- `get_shopify_shop_overview`: verifies authentication, reports shop metadata,
  API version, and the scopes actually granted to the installed app.
- `list_shopify_products`: lists products and the first 20 variants per product,
  with product pagination.
- `get_shopify_sales_overview`: aggregates order count, current net revenue,
  subtotal, AOV, financial and fulfillment statuses, and UTC daily totals.

The sales tool excludes test and cancelled orders by default, processes up to
1,000 orders by default, and reports when the configured cap truncates a result.

## Initial verification prompts

1. `Prüfe die Shopify-Verbindung und zeige die freigegebenen Scopes.`
2. `Liste die ersten 20 aktiven Shopify-Produkte auf.`
3. `Zeige den Shopify-Umsatzüberblick für die letzten 30 vollständigen Tage.`
