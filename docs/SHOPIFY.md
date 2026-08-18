# Shopify

The Shopify integration is designed for one merchant-owned store. It uses the
GraphQL Admin API `2026-07` and Shopify's client-credentials grant. Access tokens
last 24 hours and are requested and cached by the service automatically.

## Data and privacy scope

Configure these app scopes:

- `read_orders`
- `read_products`
- `write_products` for guarded product-description and collection update flows
- `read_all_orders` when historical order analysis beyond 60 days is needed and
  Shopify has granted access

Do not grant `read_customers`. The MCP tools intentionally request no customer
names, email addresses, phone numbers, or postal addresses.

`read_orders` normally covers the most recent 60 days. Access to older orders
requires Shopify approval for `read_all_orders` in addition to `read_orders`.

The order-delivery tool processes protected order and fulfillment data. It
requests only the destination country and ISO country code, never the customer's
name, street, city, postal code, email address, phone number, coordinates, or
tracking number. If Shopify redacts the destination country, configure the app's
protected customer data access in the Dev Dashboard before reinstalling or
updating the app.

## Create and install the Shopify app

1. Open `https://dev.shopify.com/dashboard` while signed in to the merchant
   organization that owns the production store.
2. Go to **Apps**, select **Create app**, then **Start from Dev Dashboard**.
3. Name the app `Marketing Data Hub`.
4. Create a version. The app is API-only, so it can use Shopify's default app URL.
5. Select GraphQL Admin API scopes `read_orders`, `read_products`, and
   `write_products`, then release the version.
6. From the app home, select **Install app**, choose the production store, review
   the permissions, and install or update it.
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
- `list_shopify_collections`: lists manual and automated collections with product
  counts, rules, sort order, SEO metadata, images, and pagination.
- `get_shopify_collection`: returns one collection plus a paginated list of its
  products.
- `preview_shopify_collection_update` and `apply_shopify_collection_update`:
  preview and then update collection title, safe plain-text description, handle,
  sort order, or SEO fields with an exact short-lived confirmation code.
- `preview_shopify_collection_products_update` and
  `apply_shopify_collection_products_update`: preview and then add or remove up
  to 50 products in one manual collection. Automated collection membership stays
  controlled by collection rules.
- `get_shopify_sales_overview`: aggregates order count, current net revenue,
  subtotal, AOV, financial and fulfillment statuses, and UTC daily totals.
- `list_shopify_order_delivery_details`: returns per-order destination country,
  products and quantities, original and discounted product costs, shipping cost,
  tax, total, shipping method, fulfillment events, and delivery durations.
- `preview_shopify_product_description_update`: reads one product and returns the
  current and proposed description HTML plus a signed confirmation token and an
  exact `SHOPIFY-XXXXXXXX` confirmation code. It never writes.
- `apply_shopify_product_description_update`: accepts only the unchanged text,
  token, product ID, and exact confirmation code from a preview that is at most
  ten minutes old. It aborts if the product changed after preview creation.

Description write paths accept plain text rather than arbitrary HTML. They escape
HTML characters, convert blank lines to paragraphs, and convert single line breaks
to `<br>`. Apply tools must not be called until the full preview has been shown and
the user has explicitly replied with the exact confirmation code. Tokens expire
after ten minutes and are bound to the shop, resource, proposed values, and the
resource version read during preview. Collection product operations are limited to
manual collections and one add or remove action per preview. Audit logs never
contain confirmation tokens or description text. Successful metadata updates
return the previous values as a recovery snapshot.

The sales tool excludes test and cancelled orders by default, processes up to
1,000 orders by default, and reports when the configured cap truncates a result.

The delivery-detail tool excludes test and cancelled orders by default and
returns up to 50 recent orders in the selected date range per page. For split
shipments, `firstShippedAt` is the first known carrier in-transit timestamp, or
the fulfillment creation timestamp when no carrier timestamp exists.
`fullyDeliveredAt` is the last delivery timestamp only when every active physical
fulfillment has a delivery timestamp. Carrier-dependent timestamps can be null
when Shopify has not received the corresponding tracking event.

## Initial verification prompts

1. `Prüfe die Shopify-Verbindung und zeige die freigegebenen Scopes.`
2. `Liste die ersten 20 aktiven Shopify-Produkte auf.`
3. `Zeige den Shopify-Umsatzüberblick für die letzten 30 vollständigen Tage.`
4. `Zeige pro Shopify-Bestellung der letzten 30 Tage Zielland, Produkte,
   Produkt- und Versandkosten sowie die Dauer bis Versand und Zustellung.`
5. `Erstelle nur eine Vorschau für eine neue Beschreibung von Produkt <ID>.`
6. After reviewing the preview, confirm with the exact code shown by the tool.
7. `Liste alle Shopify-Collections mit Typ, Produktanzahl und Regeln auf.`
8. `Zeige die Produkte und Regeln der Collection <ID>.`
9. `Erstelle nur eine Vorschau, um Produkt <PRODUCT_ID> zur manuellen Collection
   <COLLECTION_ID> hinzuzufügen.`
