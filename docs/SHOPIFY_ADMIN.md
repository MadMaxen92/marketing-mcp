# Shopify management (0.14.0)

This management layer uses the installed store's GraphQL Admin schema and live
permissions. It supplements the older, narrower Shopify tools; existing
description, collection, launch and unpublished-theme workflows still work.

## Discover first

1. `get_shopify_capabilities` reports the shop, API version, active scopes and API
   operations in each supported management area.
2. `inspect_shopify_operation` returns exact operation arguments, nested input
   types, enum values and payload fields from that API version. Do not guess an
   input shape from an example for another API version.
3. `run_shopify_query` provides bounded read access, including complete product
   variants, options, media, metafields and all other granted read areas. It
   rejects mutations, subscriptions, multiple operations and pages over 100.

| Installed write scope | Management area |
| --- | --- |
| `write_products` | Product create/update/duplicate/delete, variants/options, product media associations, manual/automated collection create/update/delete/membership/order |
| `write_publications` | Publication and publishable-resource management, product/collection publication and unpublication |
| `write_files` | File/media create/update/delete and staged uploads |
| `write_inventory` | Inventory-item management and stock activation/adjustment/setting/movement |
| `write_locations` | Location add/update/activate/deactivate/delete |
| `write_metaobject_definitions` | Metaobject schema create/update/delete |
| `write_metaobjects` | Metaobject entry create/update/upsert/delete |
| `write_online_store_navigation` | Menu and URL redirect create/update/delete/import |
| `write_themes` | Theme create/copy/update/publish/delete and file changes |
| `write_shipping` | Delivery profiles, rates/zones and carrier services |
| `write_delivery_customizations` | Shopify Function-backed delivery customization create/update/delete |

Metafield definition management and value setting/deletion use the affected
owner's write scope. Existing definition owners are read from Shopify rather than
trusted from caller input. Every metafield
set input must include `compareDigest`, including `null` for a new field.

The catalog lists operations present in Shopify's schema, not a guarantee that
Shopify will execute each one. Staff permissions, app ownership, sales-channel
configuration, Shopify plans, protected-data approval and theme-file exemptions
can impose additional restrictions. Delivery customizations require an existing
Function belonging to this Shopify app; this connector does not deploy Functions.
Order/customer/payment/refund/access-management writes are not exposed. A write
scope includes read access; no new Shopify scopes are requested by this release.

## Preview and apply

`preview_shopify_admin_mutation` takes a `plan`:

- `summary`: explain the change, records and storefront/deletion effects in plain
  language. Do not make the user understand GraphQL to decide.
- `mutation`: exactly one unaliased mutation field, with every argument supplied
  through variables. Select unaliased `userErrors { field message }` and useful
  result fields, including IDs and job/status fields where relevant.
- `variables`: exact inputs, validated/coerced against the installed API schema.
- `before`: a read-only query and its variables containing current affected
  values and **every referenced Shopify ID**, including owners, variants,
  locations and publications. Include `updatedAt` where available. Read menu
  items, metaobject fields and definition fields, not just resource names. For
  stock writes read the affected quantities. Connections must include
  `pageInfo { hasNextPage }` and must not be truncated; narrow or explicitly
  paginate the affected records. Batches are limited to 100 records.
- `after`: a schema-validated read-only query and its variables for verification.
  For creation use an explicit new handle or a precise lookup that can be matched
  to the newly returned ID. For deletion query the original ID and verify null.

Preview **does not execute a mutation** and is not Shopify's mutation
`validateOnly` (Shopify does not offer it for most operations). It validates the
schema and input values, checks installed scopes, reads current state and signs
the exact plan. Show the user the full human-readable preview and its warnings.
Apply only after the user explicitly supplies that preview's exact
`SHOPIFY-XXXXXXXX` code; earlier or general authorization cannot replace it.

`apply_shopify_admin_mutation` accepts the exact normalized plan returned by
preview, the user-supplied code and the signed confirmation token. It checks the
10-minute expiration, signature, store, plan, current permissions and state again
while holding a durable operation lock. It sends one mutation with automatic
network/auth retry disabled, checks `userErrors`, and reads back the requested
after-state. **Accepted is not a claim that an asynchronous job has finished or
that every requested value matches.** Compare the returned state to the request,
inspect jobs when present and report pending/unverified changes accurately.

Creation/duplication receipts prevent repeated creation. Update receipts are
bound to the previewed state. Two approvals with different summaries or selection
sets cannot bypass the operation lock for the same mutation inputs. Partial,
network-uncertain or unverified results retain a lock across fresh previews and
server restarts. Inspect Shopify and the durable receipt before an operator
reconciles an unresolved operation; never generate a new key to retry blindly.
Receipts are private files under `data/shopify-admin-operations/`. Audit logs
contain only shop, operation name and operation ID, not payloads or tokens.

Inventory quantity writes require an explicit Shopify `@idempotent(key: $key)`
variable. Setting absolute stock also requires compare-and-set values for every
row and rejects `ignoreCompareQuantity: true`. Product duplication requires an
explicit `newStatus`; choose `DRAFT` unless the user requested another status.
Filter-based bulk deletion is disabled; use a reviewed explicit ID list.

## Example workflow: duplicate a product

1. Discover capabilities and inspect `productDuplicate`.
2. Read the source product with its ID, title, status, variants and `updatedAt`.
3. Build a single `productDuplicate` with the exact `productId`, `newTitle`,
   explicit `newStatus: DRAFT`, and the desired image/translation settings.
4. Preview the source state and a precise after-state lookup for the new product.
   Explain which product will be copied and that the copy starts as a draft.
5. Obtain the exact confirmation code, apply the returned normalized plan, then
   verify the new product ID/title/status and any image/job processing state.

The same flow supports full product/variant editing, automated collection rules,
collection creation/deletion and the other granted areas. Prefer a narrower
existing tool when it already covers the requested change.

## Deployment and client discovery

Run the full tests, typecheck and build, then build the Docker image. Preserve the
existing `.env`, encrypted connections and `data/` directory. After deployment,
`/health` must report `0.14.0`; verify MCP `tools/list` advertises:

- `get_shopify_capabilities`
- `inspect_shopify_operation`
- `run_shopify_query`
- `preview_shopify_admin_mutation`
- `apply_shopify_admin_mutation`

Refresh the ChatGPT custom connection's metadata and start a new conversation.
For a packaged plugin update its imported definition/version as needed. Reconnect
or refresh discovery in Claude as well. Reconnecting Shopify OAuth alone cannot
add tool definitions. See [CHATGPT_SETUP.md](CHATGPT_SETUP.md).

Rollback to the previous commit/image and rebuild only `marketing-mcp`; retain
the data volume, including operation receipts and locks. Do not restart unrelated
Klubnavi, Marketank or n8n services.
