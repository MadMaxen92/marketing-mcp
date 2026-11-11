# Marketing Data Hub for Claude teams

The Claude connector uses `/claude/mcp`. Each member signs in with a named Hub
login and a unique generated password. A grant specifies exact GA4 properties,
Google Ads customers, Search Console sites, Merchant Center accounts, or the
configured Shopify shop for aggregate sales reporting.

Claude's account list shows only those grants. The server resolves each approved
ID to its assigned Google connection before calling the provider. Reporting-only
logins expose structured reporting tools. Explicit optional write
grants enable the existing guarded Shopify management tools and the Google Ads
purchase conversion Primary/Secondary workflow. Raw Google queries, detailed
Shopify order tools, Keepa and paid DataForSEO tools remain on the admin connection.

## 1. Enable the Claude endpoint

In the existing production service's private `.env`, set a dedicated client ID
of at least 16 characters, such as `marketing-data-hub-claude`, and a newly
generated secret of at least 32 characters (`openssl rand -hex 32`). Use
`CLAUDE_OAUTH_CLIENT_ID` and `CLAUDE_OAUTH_CLIENT_SECRET`. Both are required to
enable the endpoint. Keep the existing ChatGPT OAuth variables and shared admin
credentials intact. The Claude connector accepts the fixed callback
`https://claude.ai/api/mcp/auth_callback`.

Follow the existing deployment procedure and recreate only the Hub service to
apply the environment configuration. Check the existing `/mcp` connection in
ChatGPT and the new resource and issuer discovery routes. Both clients use the
same host. The new routes use the existing reverse proxy and data volume.
Keep the container at one replica as in the current deployment.

## 2. Create a login and choose its access

Get the stable Google connection ID from the existing ChatGPT connector's
`list_google_connections` tool. Use the provider account-list tools to confirm
the exact resource IDs. Google Ads grants use the 10 digits without hyphens.
Merchant Center grants use the digits without `accounts/`. Search Console
grants use the exact site identifier. If enabling Shopify, specify the shop
subdomain from `SHOPIFY_SHOP`, without `.myshopify.com`. Omit all unused fields.

Create a private grants file for the member. Replace the sample IDs and include
only the resources that person is authorized to use.

```json
{
  "ga4": [{ "id": "123456789", "connectionId": "123456789012345678901" }],
  "googleAds": [{ "id": "1234567890", "connectionId": "123456789012345678901" }],
  "searchConsole": [{ "id": "sc-domain:example.com", "connectionId": "123456789012345678901" }],
  "merchantCenter": [{ "id": "1234567", "connectionId": "123456789012345678901" }],
  "shopify": "example-shop",
  "writes": {
    "shopify": true,
    "googleAdsCustomerIds": ["1234567890"]
  }
}
```

Omit `writes` for a reporting-only login. Shopify write access requires the
matching `shopify` reporting grant. Each Google Ads write ID must also be in
`googleAds`; read access to another customer never permits writes to it.
The caller cannot select a different backing Google connection. Google Ads
writes currently change only an enabled Purchase conversion's Primary/Secondary
setting, not campaigns, budgets or ads. Shopify writes cover the management
areas supported by the installed app scopes and the shared admin workflow.
Every write still requires a concrete preview and its exact confirmation code.

From the production checkout:

```bash
docker compose exec -T marketing-mcp node dist/manage-claude-member.js set teammate@example.com < grants.json
```

The command prints the member's unique Hub password once. Share it privately
with that member using your existing credential-sharing process. Running `set`
again replaces the entire grant list, creates a new password and invalidates the
member's previous Claude tokens. Remove access with:

```bash
docker compose exec -T marketing-mcp node dist/manage-claude-member.js revoke teammate@example.com
```

Member records are kept alongside the existing Google connection store in
`data/claude-members/` by default. Include them in the Hub's private backup.
Restoring an older backup can restore old permissions and passwords. Reconcile
membership against your current grant list before restoring the public endpoint.

## 3. Add and test in Claude

A Claude workspace owner adds a custom Web connector under **Organization
settings → Connectors**. Use the Hub URL with `/claude/mcp` appended. Choose
**Use your own OAuth client** and enter the dedicated client ID and secret.
Leave shared request headers empty.

Each member clicks **Connect** and enters their own Hub email and password.
Ask Claude to run `list_authorized_accounts`, then request a small report on an
approved account and confirm an ungranted account is denied. The connector uses
the existing Hub infrastructure and upstream integrations. It requires no new
identity, email, or hosting service.

## OAuth write consent and compatibility

The resource advertises `mcp:read` and `mcp:write`. Claude must request both for
a write-enabled login. `mcp:write` never grants account permissions by itself:
the server intersects it with the member's exact write grants on every request.
A read-only login cannot gain writes by requesting a broader scope. A refresh
token cannot request a scope absent from the original authorization.

Reconnect from Claude after enabling writes so it discovers and requests the
new scope. An old browser sign-in or read-only token continues to expose only
reporting tools. Existing signed sessions issued before write scopes existed
remain reporting-only. Replacing a member with `set` still rotates its password
and invalidates its prior access and refresh tokens. The existing ChatGPT
`/mcp` authentication and capabilities are unchanged.

Each pending sign-in has its own secure, HttpOnly, SameSite=Lax cookie. A
second connection attempt or browser tab does not invalidate another pending
page. Each flow remains limited to ten minutes and one successful submission;
its cookie is cleared independently. A missing or mismatched browser cookie
gets a distinct message rather than being labelled as an expired link.
Rejection logs contain only a reason code, never credentials or flow values.

The sign-in page's form-action policy allows the Hub and only the fixed Claude
callback URL. Chromium applies this directive to redirects after form submission,
so restricting it to self blocks completion after the password was accepted.
The password form action remains the Hub's own login endpoint; the callback
receives only the one-time code and original state through the 303 redirect.
The OAuth client still rejects every other redirect URI.
