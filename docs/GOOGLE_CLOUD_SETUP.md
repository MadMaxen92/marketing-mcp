# Google Cloud setup

1. Enable **Google Analytics Data API**.
2. Enable **Google Analytics Admin API**.
3. Enable **Google Ads API**.
4. Enable **Merchant API**.
5. Configure the OAuth consent screen.
6. Add your Google account as a test user while the app is in Testing.
7. Create an OAuth 2.0 Client ID with type **Web application**.
8. Add this authorized redirect URI exactly:

```text
https://marketing.klubnavi.de/oauth/google/callback
```

9. Copy the client ID and client secret into the server `.env`.

The app requests Analytics read-only access, Google Ads access, Merchant Center
access (`https://www.googleapis.com/auth/content`), and basic OpenID identity
scopes. No Google service-account key is required. The Merchant scope is not
read-only at OAuth level, so the server enforces read-only behavior by exposing
only GET/report operations and by validating custom MCQL as a single `SELECT`.

After adding Merchant Center to an existing deployment, reconnect every stored
Google account at `/connect/google?admin_token=...`. Existing refresh tokens do
not automatically gain the new Merchant Center scope.
