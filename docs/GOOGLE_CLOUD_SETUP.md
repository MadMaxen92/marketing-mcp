# Google Cloud setup

1. Enable **Google Analytics Data API**.
2. Enable **Google Analytics Admin API**.
3. Configure the OAuth consent screen.
4. Add your Google account as a test user while the app is in Testing.
5. Create an OAuth 2.0 Client ID with type **Web application**.
6. Add this authorized redirect URI exactly:

```text
https://marketing.klubnavi.de/oauth/google/callback
```

7. Copy the client ID and client secret into the server `.env`.

The app requests read-only Analytics access plus basic OpenID identity scopes. No Google service-account key is required.
