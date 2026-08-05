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
