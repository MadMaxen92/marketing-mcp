# Operations

The service is designed to run as one Docker container behind the existing host-level Nginx instance.

Routine commands:

```bash
docker compose ps
docker compose logs --tail=200 marketing-mcp
docker compose restart marketing-mcp
docker compose up -d --build
```

Do not delete the `data/` directory or change `TOKEN_ENCRYPTION_KEY` without first planning a token migration. Either action makes stored Google refresh tokens unavailable.

## One-time Merchant API developer registration

The registration command is a local container CLI, not an HTTP or MCP endpoint. It
requires explicit operator confirmation for GCP project `first-medium-504614-q0`
and is locked to Merchant Center account `5500122470` and the existing OAuth
connection for `max@flow.fast`.
The GCP project linked by Google is the project that owns the configured
`GOOGLE_CLIENT_ID`; the project ID is not sent as an API request parameter.

After deploying a build that contains the command, run it once on the host:

```bash
docker compose exec marketing-mcp npm run merchant:register-gcp -- \
  --confirm first-medium-504614-q0:5500122470:max@flow.fast
```

The command refuses to call the registration API unless the selected encrypted
OAuth connection belongs to `max@flow.fast`. It registers the project, then calls
the existing Merchant Center account overview as a verification step. It never
prints OAuth or refresh tokens and creates no new OAuth client or service account.
Because Google can take up to five minutes to propagate a new registration, only
the specific `GCP_NOT_REGISTERED` response is retried during that verification.
