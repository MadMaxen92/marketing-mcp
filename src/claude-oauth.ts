import { createHmac, randomBytes } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { InvalidGrantError, InvalidRequestError, InvalidScopeError, InvalidTokenError, ServerError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { type ClaudeMember, type MemberGrants, equalSecret, readMember, secretHash } from './claude-members.js';
import { config } from './config.js';
import { createClaudeMcpServer } from './claude-tools.js';
import { handleMcpRequest } from './mcp-http.js';

const callback = 'https://claude.ai/api/mcp/auth_callback';
const resourcePath = '/claude/mcp';
const loginPath = '/claude/oauth/login';
const authorizePath = '/claude/oauth/authorize';
const tokenPath = '/claude/oauth/token';
const resourceMetadataPath = '/.well-known/oauth-protected-resource' + resourcePath;
const scope = 'mcp:read';
const writeScope = 'mcp:write';
const scopes = [scope, writeScope, 'offline_access'];
const flowLifetimeMs = 10 * 60_000;
const accessLifetimeSeconds = 3600;
const refreshLifetimeSeconds = 30 * 24 * 3600;
const cookiePrefix = 'hub_claude_signin_';
const cookieOptions = { httpOnly: true, secure: true, sameSite: 'lax', path: loginPath } as const;
const randomSecret = () => randomBytes(32).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

const sessionSchema = z.object({
  email: z.string(),
  version: z.string().uuid(),
  kind: z.enum(['access', 'refresh']),
  expires: z.number().int(),
  scopes: z.array(z.enum(['mcp:read', 'mcp:write', 'offline_access'])).optional(),
});

type Session = z.infer<typeof sessionSchema>;
type SignInParams = AuthorizationParams & { state: string };
type PendingFlow = { params: SignInParams; browserProof: string; expires: number };
type PendingCode = { params: AuthorizationParams; email: string; version: string; expires: number };

function savePending<T extends { expires: number }>(entries: Map<string, T>, value: T): string {
  for (const [key, entry] of entries) {
    if (entry.expires <= Date.now()) entries.delete(key);
  }
  if (entries.size >= 1000) throw new ServerError('Too many pending sign-ins.');
  const key = randomSecret();
  entries.set(key, value);
  return key;
}

export function createClaudeRouter(clientId: string, clientSecret: string): Router {
  const router = Router();
  const issuer = new URL('/claude', config.PUBLIC_BASE_URL).href;
  const resource = new URL(resourcePath, issuer).href;
  const flows = new Map<string, PendingFlow>();
  const codes = new Map<string, PendingCode>();
  const signingKey = createHmac('sha256', Buffer.from(config.TOKEN_ENCRYPTION_KEY, 'hex'))
    .update(JSON.stringify(['claude-session-v1', issuer, clientId])).digest();
  const sign = (value: string) => createHmac('sha256', signingKey).update(value).digest('base64url');

  function sessionToken(member: ClaudeMember, kind: Session['kind'], lifetime: number, grantedScopes: string[]): string {
    const payload = Buffer.from(JSON.stringify({
      email: member.email, version: member.sessionVersion, kind, expires: now() + lifetime,
      scopes: grantedScopes as NonNullable<Session['scopes']>,
    } satisfies Session)).toString('base64url');
    return 'hub1.' + payload + '.' + sign(payload);
  }

  async function memberForToken(token: string, kind: Session['kind']): Promise<{ member: ClaudeMember; expiresAt: number; scopes: string[] } | undefined> {
    const parts = /^hub1\.([A-Za-z0-9_-]{1,900})\.([A-Za-z0-9_-]{43})$/.exec(token);
    const payload = parts?.[1];
    const signature = parts?.[2];
    if (!payload || !signature || !equalSecret(sign(payload), signature)) return;
    const session = sessionSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
    if (session.kind !== kind || session.expires <= now()) return;
    const member = await readMember(session.email);
    if (member?.sessionVersion === session.version) {
      return { member, expiresAt: session.expires, scopes: session.scopes ?? [scope, 'offline_access'] };
    }
  }

  function tokensFor(member: ClaudeMember, requestedScopes: string[], refreshToken?: string) {
    const canWrite = member.grants.writes?.shopify || (member.grants.writes?.googleAdsCustomerIds.length ?? 0) > 0;
    const grantedScopes = requestedScopes.filter(value => value !== writeScope || canWrite);
    return {
      access_token: sessionToken(member, 'access', accessLifetimeSeconds, grantedScopes),
      token_type: 'Bearer',
      expires_in: accessLifetimeSeconds,
      refresh_token: refreshToken ?? sessionToken(member, 'refresh', refreshLifetimeSeconds, grantedScopes),
      scope: grantedScopes.join(' '),
    };
  }

  function checkResource(value?: URL) {
    if (value && value.href !== resource) throw new InvalidRequestError('Invalid resource.');
  }

  function checkScopes(requested?: string[]) {
    if (requested && (!requested.includes(scope) || requested.some(value => !scopes.includes(value)))) {
      throw new InvalidScopeError('Invalid scope.');
    }
  }

  function pendingCode(key: string): PendingCode {
    const pending = codes.get(key);
    if (!pending || pending.expires <= Date.now()) throw new InvalidGrantError('Invalid or expired code.');
    return pending;
  }

  const provider: OAuthServerProvider = {
    clientsStore: {
      getClient: id => id === clientId ? {
        client_id: clientId, client_secret: clientSecret, redirect_uris: [callback],
        token_endpoint_auth_method: 'client_secret_post',
      } : undefined,
    },
    async authorize(_client, params, res) {
      checkResource(params.resource);
      checkScopes(params.scopes);
      if (!params.state || params.state.length > 2048 || !/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)) {
        throw new InvalidRequestError('Missing state or invalid PKCE challenge.');
      }
      const browserProof = randomSecret();
      const flow = savePending(flows, {
        params: { ...params, state: params.state }, browserProof, expires: Date.now() + flowLifetimeMs,
      });
      // A retry or a second tab must not replace another pending flow's proof.
      res.cookie(cookiePrefix + flow, browserProof, { ...cookieOptions, maxAge: flowLifetimeMs });
      res.set({
        'Content-Security-Policy': "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        'Referrer-Policy': 'no-referrer',
      });
      res.type('html').send(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in to Marketing Data Hub</title></head>
<body>
<h1>Sign in to Marketing Data Hub</h1>
<p>Connect Claude to your authorized reporting accounts using the login issued by your Hub administrator.</p>
<form method="post" action="${loginPath}">
  <input type="hidden" name="flow" value="${flow}">
  <p><label>Email <input type="email" name="email" autocomplete="username" maxlength="254" required></label></p>
  <p><label>Hub password <input type="password" name="password" autocomplete="current-password" maxlength="43" required></label></p>
  <button type="submit">Connect Claude</button>
</form>
</body>
</html>`);
    },
    async challengeForAuthorizationCode(_client, code) {
      return pendingCode(code).params.codeChallenge;
    },
    async exchangeAuthorizationCode(_client, code, _verifier, redirectUri, tokenResource) {
      const pending = pendingCode(code);
      checkResource(tokenResource);
      if (redirectUri !== pending.params.redirectUri) throw new InvalidGrantError('Invalid redirect URI.');
      codes.delete(code);
      const member = await readMember(pending.email);
      if (!member || member.sessionVersion !== pending.version) throw new InvalidGrantError('Access has been revoked.');
      return tokensFor(member, pending.params.scopes ?? [scope]);
    },
    async exchangeRefreshToken(_client, refreshToken, requested, tokenResource) {
      checkResource(tokenResource);
      checkScopes(requested);
      const session = await memberForToken(refreshToken, 'refresh');
      if (!session) throw new InvalidGrantError('Invalid or expired refresh token.');
      if (requested?.some(value => !session.scopes.includes(value))) throw new InvalidScopeError('Cannot expand a refresh token scope.');
      return tokensFor(session.member, requested ?? session.scopes, refreshToken);
    },
    async verifyAccessToken(token) {
      const session = await memberForToken(token, 'access');
      if (!session) throw new InvalidTokenError('Invalid or expired access token.');
      return {
        token, clientId, scopes: session.scopes, resource: new URL(resource), expiresAt: session.expiresAt,
        extra: { grants: session.scopes.includes(writeScope)
          ? session.member.grants : { ...session.member.grants, writes: undefined } },
      };
    },
  };

  const resourceMetadata = new URL(resourceMetadataPath, issuer).href;
  router.get(resourceMetadataPath, (_req, res) => {
    res.json({ resource, authorization_servers: [issuer], scopes_supported: [scope, writeScope], bearer_methods_supported: ['header'] });
  });
  router.get(['/.well-known/oauth-authorization-server/claude', '/claude/.well-known/oauth-authorization-server'], (_req, res) => {
    res.json({
      issuer, authorization_endpoint: new URL(authorizePath, issuer).href, token_endpoint: new URL(tokenPath, issuer).href,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_post'],
      scopes_supported: scopes,
    });
  });

  router.use(authorizePath, authorizationHandler({ provider }));
  router.use(tokenPath, tokenHandler({ provider }));
  router.post(loginPath, async (req, res) => {
    const flowKey = typeof req.body?.flow === 'string' ? req.body.flow : '';
    const flow = flows.get(flowKey);
    const cookieName = cookiePrefix + flowKey;
    const browserProof = (req.header('cookie') ?? '').split(';').map(part => part.trim())
      .find(part => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1) ?? '';
    res.setHeader('Cache-Control', 'no-store');

    if (!flow || flow.expires <= Date.now() || !equalSecret(browserProof, flow.browserProof)) {
      const reason = !flow ? 'unknown_flow' : flow.expires <= Date.now() ? 'expired_flow'
        : !browserProof ? 'missing_browser_cookie' : 'browser_cookie_mismatch';
      console.warn(JSON.stringify({ event: 'claude_signin_rejected', reason }));
      const message = reason === 'missing_browser_cookie'
        ? 'This browser did not return the sign-in cookie. Reconnect from Claude in a browser that allows cookies.'
        : reason === 'browser_cookie_mismatch'
          ? 'The browser sign-in session changed. Return to Claude and reconnect.'
          : 'Sign-in expired. Return to Claude and reconnect.';
      res.status(400).send(message);
      return;
    }
    flows.delete(flowKey);
    res.clearCookie(cookieName, cookieOptions);
    const email = typeof req.body?.email === 'string' ? req.body.email : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const member = /^[A-Za-z0-9_-]{43}$/.test(password) ? await readMember(email) : undefined;
    if (!member || !equalSecret(member.passwordHash, secretHash(password))) {
      res.status(401).send('Sign-in denied. Check your Hub login and reconnect from Claude.');
      return;
    }

    const code = savePending(codes, {
      params: flow.params, email: member.email, version: member.sessionVersion, expires: Date.now() + flowLifetimeMs,
    });
    const redirect = new URL(flow.params.redirectUri);
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('state', flow.params.state);
    res.redirect(303, redirect.href);
  });

  router.all(resourcePath, requireBearerAuth({
    verifier: provider, requiredScopes: [scope], resourceMetadataUrl: resourceMetadata,
  }), (req, res, next) => {
    const grants = req.auth?.extra?.grants as MemberGrants | undefined;
    if (!grants) return next(new Error('Missing authenticated account grants.'));
    return handleMcpRequest(createClaudeMcpServer(grants), req, res, next);
  });

  return router;
}
