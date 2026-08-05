# Known limitations in v0.1

- The encrypted token store is file-based and intended for a single server instance.
- OAuth state is held in memory for ten minutes; restarting during login invalidates the attempt.
- GA4 dimension and metric names are passed through to Google and are not yet validated against property metadata.
- Report output is returned largely in the native Google Analytics Data API shape.
- The connector is read-only.
- Google OAuth apps in Testing may issue refresh tokens with limited lifetime; production publishing and possible Google verification should be completed after validation.
