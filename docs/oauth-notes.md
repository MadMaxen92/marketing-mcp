# MCP OAuth scope notes

The MCP protected resource requires only the resource scope `mcp:read`.

`offline_access` is an authorization-server capability used by ChatGPT to request refresh tokens. It is advertised by the authorization server but is intentionally not advertised as a protected-resource scope and is not included in the `WWW-Authenticate` resource challenge.
