# Deployment on Hetzner

## Prerequisites

- Docker and Docker Compose
- DNS records for `marketing.klubnavi.de`
- Nginx on the host
- Google OAuth web client
- Required Google APIs enabled, including Search Console API

The Google OAuth redirect URI must be exactly:

```text
https://marketing.klubnavi.de/oauth/google/callback
```

## 1. Clone and configure

```bash
cd ~
git clone https://github.com/MadMaxen92/marketing-mcp.git
cd marketing-mcp
cp .env.example .env
mkdir -p data
chmod 700 data
nano .env
```

Generate secrets locally on the server:

```bash
openssl rand -hex 32  # MCP_BEARER_TOKEN
openssl rand -hex 32  # ADMIN_TOKEN
openssl rand -hex 32  # TOKEN_ENCRYPTION_KEY
```

Enter the Google OAuth client ID and client secret in `.env`. Never commit `.env`.
Add `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD` from the DataForSEO API Access
page when enabling the DataForSEO tools.

## 2. Build and start

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f marketing-mcp
```

Local health check:

```bash
curl http://127.0.0.1:8000/health
```

## 3. Configure Nginx

```bash
sudo cp deploy/nginx/marketing.klubnavi.de.conf /etc/nginx/sites-available/marketing.klubnavi.de
sudo ln -s /etc/nginx/sites-available/marketing.klubnavi.de /etc/nginx/sites-enabled/marketing.klubnavi.de
sudo nginx -t
sudo systemctl reload nginx
```

External health check:

```bash
curl https://marketing.klubnavi.de/health
```

## 4. Connect a Google account

Open this URL in a browser, replacing the token with `ADMIN_TOKEN` from `.env`:

```text
https://marketing.klubnavi.de/connect/google?admin_token=YOUR_ADMIN_TOKEN
```

Authorize the Google account that has access to the desired GA4 and Search Console
properties. Repeat this process for additional Google accounts. Reconnect existing
accounts after adding a new Google OAuth scope.

When the Google OAuth app remains in **Testing**, Google may expire refresh tokens after a limited period. Move the app to Production once the setup has been validated and complete any verification Google requires for the requested scope.

## 5. Connect ChatGPT Work

Create a custom MCP plugin with:

- Server URL: `https://marketing.klubnavi.de/mcp`
- Authentication: Bearer token
- Token: the value of `MCP_BEARER_TOKEN`

Start with these tool calls:

1. `list_google_connections`
2. `list_ga4_properties`
3. `list_search_console_sites`
4. `get_search_console_performance`
5. `get_ecommerce_overview`
6. `get_landing_page_performance`
7. `get_dataforseo_account_status`
8. `list_dataforseo_locations`

## Operations

For the 0.14.0 Shopify management upgrade, first build a separate candidate image
and verify its MCP tool registry and live Shopify scopes without catalogue writes:

```bash
docker build -t marketing-mcp-candidate .
docker run --rm --env-file .env marketing-mcp-candidate node dist/shopify-check.js
```

The check prints version, shop, tool count and granted-area operation counts. It
does not print credentials or mutate Shopify. Keep the previous image/commit for
rollback and retain `.env` and `data/`. Upgrade only the `marketing-mcp` service:

```bash
docker compose up -d --build --no-deps marketing-mcp
docker exec marketing-mcp node dist/shopify-check.js
```

Then refresh the client tool definitions as described in
[CHATGPT_SETUP.md](CHATGPT_SETUP.md). No Shopify reinstallation or new scope is
needed when the required scopes are already reported as granted.

Update:

```bash
git pull
docker compose up -d --build
```

Logs:

```bash
docker compose logs --tail=200 marketing-mcp
```

Backup the encrypted token store:

```bash
tar -czf marketing-mcp-data-$(date +%F).tar.gz data/
```

The backup is only useful together with the unchanged `TOKEN_ENCRYPTION_KEY`.
