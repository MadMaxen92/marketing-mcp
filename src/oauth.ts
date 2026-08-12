import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';

const SCOPE = 'mcp:read offline_access';
const AUTH_CODE_TTL_MS = 10 * 60_000;

type PendingAuthorization = {
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
  scope: string;
  resource?: string;
  expiresAt: number;
};

const pendingAuthorizations = new Map<string, PendingAuthorization>();

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isAllowedRedirectUri(value: string): boolean {
  return value === config.CHATGPT_OAUTH_REDIRECT_URI;
}

function readClientCredentials(req: Request): { clientId: string; clientSecret: string } {
  const authorization = req.header('authorization');
  if (authorization?.startsWith('Basic ')) {
    const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    return {
      clientId: separator >= 0 ? decoded.slice(0, separator) : decoded,
      clientSecret: separator >= 0 ? decoded.slice(separator + 1) : '',
    };
  }

  return {
    clientId: String(req.body.client_id ?? ''),
    clientSecret: String(req.body.client_secret ?? ''),
  };
}

function validateClient(clientId: string, clientSecret: string): boolean {
  return secureEqual(clientId, config.CHATGPT_OAUTH_CLIENT_ID)
    && secureEqual(clientSecret, config.CHATGPT_OAUTH_CLIENT_SECRET);
}

function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function htmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function protectedResourceMetadata(_req: Request, res: Response): void {
  res.json({
    resource: `${config.PUBLIC_BASE_URL}/mcp`,
    authorization_servers: [config.PUBLIC_BASE_URL],
    scopes_supported: ['mcp:read', 'offline_access'],
    bearer_methods_supported: ['header'],
  });
}

export function authorizationServerMetadata(_req: Request, res: Response): void {
  res.json({
    issuer: config.PUBLIC_BASE_URL,
    authorization_endpoint: `${config.PUBLIC_BASE_URL}/oauth/authorize`,
    token_endpoint: `${config.PUBLIC_BASE_URL}/oauth/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
    scopes_supported: ['mcp:read', 'offline_access'],
  });
}

export function showAuthorizationPage(req: Request, res: Response): void {
  const clientId = String(req.query.client_id ?? '');
  const redirectUri = String(req.query.redirect_uri ?? '');
  const responseType = String(req.query.response_type ?? '');
  const state = String(req.query.state ?? '');
  const codeChallenge = req.query.code_challenge ? String(req.query.code_challenge) : undefined;
  const codeChallengeMethod = req.query.code_challenge_method ? String(req.query.code_challenge_method) : undefined;
  const scope = String(req.query.scope ?? SCOPE);
  const resource = req.query.resource ? String(req.query.resource) : undefined;

  const pkceIsValid = !codeChallenge || codeChallengeMethod === 'S256';
  if (
    clientId !== config.CHATGPT_OAUTH_CLIENT_ID
    || !isAllowedRedirectUri(redirectUri)
    || responseType !== 'code'
    || !state
    || !pkceIsValid
  ) {
    res.status(400).send('Invalid OAuth authorization request.');
    return;
  }

  const hiddenFields = {
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge ?? '',
    scope,
    resource: resource ?? '',
  };

  res.type('html').send(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize Marketing MCP</title></head>
<body style="font-family:system-ui;max-width:560px;margin:48px auto;padding:0 20px">
  <h1>Authorize Marketing MCP</h1>
  <p>Allow ChatGPT to use the read-only tools exposed by your Marketing MCP server.</p>
  <form method="post" action="/oauth/authorize">
    ${Object.entries(hiddenFields).map(([key, value]) => `<input type="hidden" name="${key}" value="${htmlEscape(value)}">`).join('\n')}
    <label for="admin_token">Admin token</label><br>
    <input id="admin_token" name="admin_token" type="password" required autocomplete="current-password" style="box-sizing:border-box;width:100%;padding:10px;margin:8px 0 16px">
    <button type="submit" style="padding:10px 16px">Authorize</button>
  </form>
</body>
</html>`);
}

export function approveAuthorization(req: Request, res: Response): void {
  const clientId = String(req.body.client_id ?? '');
  const redirectUri = String(req.body.redirect_uri ?? '');
  const state = String(req.body.state ?? '');
  const codeChallenge = req.body.code_challenge ? String(req.body.code_challenge) : undefined;
  const scope = String(req.body.scope ?? SCOPE);
  const resource = req.body.resource ? String(req.body.resource) : undefined;
  const adminToken = String(req.body.admin_token ?? '');

  if (
    clientId !== config.CHATGPT_OAUTH_CLIENT_ID
    || !isAllowedRedirectUri(redirectUri)
    || !secureEqual(adminToken, config.ADMIN_TOKEN)
    || !state
  ) {
    res.status(401).send('Authorization denied.');
    return;
  }

  const code = randomUUID();
  pendingAuthorizations.set(code, {
    clientId,
    redirectUri,
    codeChallenge,
    scope,
    resource,
    expiresAt: Date.now() + AUTH_CODE_TTL_MS,
  });

  const callback = new URL(redirectUri);
  callback.searchParams.set('code', code);
  callback.searchParams.set('state', state);
  res.redirect(callback.toString());
}

export function exchangeToken(req: Request, res: Response): void {
  const grantType = String(req.body.grant_type ?? '');
  const { clientId, clientSecret } = readClientCredentials(req);

  if (!validateClient(clientId, clientSecret)) {
    res.status(401).json({ error: 'invalid_client' });
    return;
  }

  if (grantType === 'authorization_code') {
    const code = String(req.body.code ?? '');
    const redirectUri = String(req.body.redirect_uri ?? '');
    const codeVerifier = req.body.code_verifier ? String(req.body.code_verifier) : undefined;
    const pending = pendingAuthorizations.get(code);
    pendingAuthorizations.delete(code);

    const pkceIsValid = !pending?.codeChallenge
      || (!!codeVerifier && sha256Base64Url(codeVerifier) === pending.codeChallenge);

    if (
      !pending
      || pending.expiresAt < Date.now()
      || pending.clientId !== clientId
      || pending.redirectUri !== redirectUri
      || !pkceIsValid
    ) {
      res.status(400).json({ error: 'invalid_grant' });
      return;
    }

    res.json({
      access_token: config.MCP_BEARER_TOKEN,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: config.MCP_BEARER_TOKEN,
      scope: pending.scope,
    });
    return;
  }

  if (grantType === 'refresh_token') {
    const refreshToken = String(req.body.refresh_token ?? '');
    if (!secureEqual(refreshToken, config.MCP_BEARER_TOKEN)) {
      res.status(400).json({ error: 'invalid_grant' });
      return;
    }

    res.json({
      access_token: config.MCP_BEARER_TOKEN,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: config.MCP_BEARER_TOKEN,
      scope: SCOPE,
    });
    return;
  }

  res.status(400).json({ error: 'unsupported_grant_type' });
}

export function requireMcpOAuth(req: Request, res: Response, next: NextFunction): void {
  const token = req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!secureEqual(token, config.MCP_BEARER_TOKEN)) {
    res.setHeader(
      'WWW-Authenticate',
      `Bearer resource_metadata="${config.PUBLIC_BASE_URL}/.well-known/oauth-protected-resource", scope="mcp:read"`,
    );
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}
