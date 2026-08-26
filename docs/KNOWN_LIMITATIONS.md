# Known limitations in v0.8

- The encrypted token store is file-based and intended for a single server instance.
- OAuth state is held in memory for ten minutes; restarting during login invalidates the attempt.
- GA4 dimension and metric names are passed through to Google and are not yet validated against property metadata.
- Report output is returned largely in the native Google Analytics Data API shape.
- Search Console returns top rows rather than guaranteed-complete query/page detail,
  exposes at most 50,000 rows per property, day, and search type, and normally
  finalizes data after a two-to-three-day delay. Dates use Pacific Time.
- Google and Shopify analytics are read-only. Shopify product descriptions,
  collection metadata, manual collection membership, and collection publication
  state are the only write paths; each requires a fresh preview plus explicit
  confirmation. Metaobjects remain read-only until a store schema is approved.
- Google OAuth apps in Testing may issue refresh tokens with limited lifetime; production publishing and possible Google verification should be completed after validation.
