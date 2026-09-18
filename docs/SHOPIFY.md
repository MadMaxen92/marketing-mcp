# Shopify

The Shopify integration is designed for one merchant-owned store. It uses the
GraphQL Admin API `2026-07` and Shopify's client-credentials grant. Access tokens
last 24 hours and are requested and cached by the service automatically.

## Data and privacy scope

Configure these app scopes:

- `read_orders`
- `read_products`
- `write_products` for guarded draft-product creation, unpublished collection
  creation, product-description and collection update flows
- `write_online_store_navigation` for creating separate launch menus (includes
  read access); no existing menu editing or live-theme assignment is exposed
- `read_product_listings` for detailed product publication data
- `read_publications` and `write_publications` for guarded collection publication
  previews and updates
- `read_metaobject_definitions` and `read_metaobjects` for structured drop,
  design-family, and related-product data
- `write_metaobject_definitions` and `write_metaobjects` are reserved for the
  later schema rollout; the current MCP release exposes no Metaobject write tool
- `read_themes` for listing themes and reading selected PDP theme files
- `write_themes` for guarded PDP file updates on unpublished themes only; Shopify
  must also grant the app an exemption for theme-file modification
- `read_shipping` for reading delivery profiles, location groups, zones, rates,
  and weight conditions
- `write_shipping` for guarded updates to existing merchant-defined shipping
  rates through `deliveryProfileUpdate`
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
5. Select the GraphQL Admin API scopes listed under **Data and privacy scope**,
   then release the version.
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

- `get_shopify_launch_capabilities`: reports granted scopes and the limits of
  launch preparation. Scopes alone do not prove Shopify theme exemption access.
- `preview_shopify_launch_preparation` and `apply_shopify_launch_preparation`:
  preview and create one launch resource using the existing exact-code
  confirmation model. Supported actions:
  - `CREATE_DRAFT_PRODUCT`: one DRAFT product, 1–3 ordered options (use Size then
    Colour), up to 100 explicit variants with unique SKUs and prices, up to 20
    images with variant associations, SEO, tags, template suffix and up to 30
    product metafields. Inventory is tracked with no stock allocation and selling
    when out of stock is disabled. No existing product/variant/file IDs accepted.
  - `CREATE_UNPUBLISHED_COLLECTION`: a new manual collection with no publications,
    optionally containing up to 100 existing DRAFT products. Existing guarded
    membership tools can prepare larger collections in batches.
  - `CREATE_LAUNCH_MENU`: new `launch-` handle, up to three nested levels of
    store-relative links. Existing handles and default menus cannot be overwritten.
    The new menu is not assigned to any theme. Custom storefront code that lists
    all menus needs separate review before creating menus.
  - `DUPLICATE_THEME`: copy a ready source theme into a new UNPUBLISHED theme.
    The source's state must still match the preview. Requires Shopify theme API
    approval as well as `write_themes`; no live-theme replacement is exposed.

### Launch preparation operation safety

Preview calls only read Shopify. Their signed ten-minute confirmations bind the
shop, exact normalized input and source state. Apply requires the user to return
the exact code after seeing the full preview. Unknown fields are rejected, not
forwarded to Shopify. Apply rechecks access, handle collisions and source state.
These tools do not use `productSet` to replace existing products, since omitted
list entries could otherwise delete variants or metafields.

Creation uses persistent, exclusive operation locks and receipts in
`shopify-launch-operations/` beside `TOKEN_STORE_PATH`, on the existing data volume.
An operation is keyed by shop and normalized input. A repeated successful apply
returns the receipt; concurrent attempts and uncertain/failed attempts cannot
automatically run the mutation again. Mutation requests have no automatic retry.
Keep this directory across deploys and include it in data-volume backups. All
replicas must share the volume; this is not a distributed lock implementation.

For a failed/uncertain operation, inspect its receipt and Shopify by returned ID
or expected handle/name before retrying. The lock intentionally survives failure
and process restarts. Only an operator who has established whether Shopify created
the resource should remove a lock/receipt. A new preview does not bypass the lock.
Image processing can continue after creation; inspect media status and imagery
before launch. Source images need publicly fetchable or signed HTTPS URLs; a
private Google Drive viewer link is not suitable. Shopify may require additional
file permissions for a future staged-upload tool; none is exposed here.

Still separate: stock imports, existing draft variant editing, shared metaobject
schema changes, assigning menus/homepage sections in an unpublished theme, channel
publication and launch-day redirects. Existing PDP-file tools retain their current
unpublished-theme restrictions. This release does not change those tools' scope.

Deployment: update the Shopify app version to request
`write_online_store_navigation`, release/install the permission update for the
merchant store, deploy the server, then refresh the connector's tool list. Verify
`get_shopify_launch_capabilities` before preparation. Do not create test products
in the merchant store solely to prove write access.

API references: [productSet](https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/productSet),
[collectionCreate](https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/collectionCreate),
[menuCreate](https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/menuCreate),
[themeDuplicate](https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/themeDuplicate).

### Existing tools

- `get_shopify_shop_overview`: verifies authentication, reports shop metadata,
  API version, and the scopes actually granted to the installed app.
- `get_shopify_shipping_profiles`: reads merchant-owned delivery profiles and
  returns fulfillment locations, geographic zones, merchant-defined flat-rate
  prices, and all delivery conditions.
- `preview_shopify_shipping_rates_update` and
  `apply_shopify_shipping_rates_update`: preview and then update existing
  merchant-defined rate prices, labels, active state, or kilogram weight bands.
  The apply tool requires the exact short-lived confirmation code, rechecks the
  complete delivery profile for concurrent changes, and calls only Shopify's
  `deliveryProfileUpdate` mutation. It cannot create or delete profiles, zones,
  location groups, carrier-calculated rates, or product assignments.
- `list_shopify_themes`: lists Online Store themes and identifies live and
  unpublished roles.
- `get_shopify_theme_files`: reads up to 20 selected PDP template, section,
  snippet, CSS, or JavaScript files.
- `preview_shopify_theme_files_upsert` and `apply_shopify_theme_files_upsert`:
  create or update PDP-related text files only on an `UNPUBLISHED` theme. The
  apply tool requires an exact short-lived confirmation, rechecks every file,
  and refuses live, demo, or development themes.
- `list_shopify_products`: lists products and the first 20 variants per product,
  with product pagination.
- `list_shopify_collections`: lists manual and automated collections with product
  counts, rules, sort order, SEO metadata, images, and pagination.
- `get_shopify_collection`: returns one collection plus a paginated list of its
  products.
- `list_shopify_publications`: lists sales channels and their automatic and
  scheduled publication capabilities.
- `get_shopify_collection_publication_status`: shows where one collection is
  currently published or scheduled.
- `preview_shopify_collection_publication_update` and
  `apply_shopify_collection_publication_update`: preview and then publish,
  schedule, or unpublish one collection on selected sales channels with an exact
  short-lived confirmation code.
- `list_shopify_metaobject_definitions`: lists structured-content definitions,
  fields, validations, access, and capabilities.
- `list_shopify_metaobjects` and `get_shopify_metaobject`: read structured entries
  and their raw field values. No Metaobject write path is exposed yet.
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
manual collections and one add or remove action per preview. Collection publication
updates are bound to the exact selected sales channels and the publication state
read during preview. Audit logs never contain confirmation tokens or description
text. Successful metadata updates return the previous values as a recovery snapshot.
Shipping-rate updates return the complete previous definition of each affected
rate as a recovery snapshot. Replacing a weight band deletes only that method's
existing `TOTAL_WEIGHT` conditions and recreates the explicitly previewed
kilogram range; unrelated price conditions and other methods are preserved.
Theme updates are additionally restricted to product JSON templates, sections,
snippets, and CSS/JavaScript assets, with a maximum of 20 files and 500 KB per
confirmed operation. Layout, configuration, locale, and non-PDP template files
are rejected. Shopify requires `write_themes` plus a theme-file exemption before
the GraphQL mutation can succeed.

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
10. `Liste alle Shopify-Verkaufskanäle und ihren Veröffentlichungsmodus auf.`
11. `Zeige, auf welchen Verkaufskanälen Collection <ID> veröffentlicht ist.`
12. `Liste alle Metaobject-Definitionen auf.`
13. `Liste alle unveröffentlichten Shopify-Themes auf.`
14. `Lies templates/product.json aus Theme <THEME_ID>.`
15. `Liste die Shopify-Versandprofile mit Zonen, Preisen und Gewichtsbedingungen auf.`
16. `Erstelle nur eine Vorschau für die Versandkostenänderungen im Profil <PROFILE_ID>.`
