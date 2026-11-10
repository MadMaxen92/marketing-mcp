import express, { type NextFunction, type Request, type Response } from 'express';
import { createClaudeRouter } from './claude-oauth.js';
import { handleMcpRequest } from './mcp-http.js';
import { config } from './config.js';
import { beginGoogleOAuth, finishGoogleOAuth } from './google.js';
import { createMarketingMcpServer } from './mcp.js';
import {
  approveAuthorization,
  authorizationServerMetadata,
  exchangeToken,
  protectedResourceMetadata,
  requireMcpOAuth,
  showAuthorizationPage,
} from './oauth.js';
import { MARKETING_MCP_VERSION } from './version.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'marketing-mcp', version: MARKETING_MCP_VERSION });
});

app.get('/connect/google', beginGoogleOAuth);
app.get('/oauth/google/callback', (req, res, next) => {
  finishGoogleOAuth(req, res).catch(next);
});

app.get('/.well-known/oauth-protected-resource', protectedResourceMetadata);
app.get('/.well-known/oauth-protected-resource/mcp', protectedResourceMetadata);
app.get('/.well-known/oauth-authorization-server', authorizationServerMetadata);
app.get('/oauth/authorize', showAuthorizationPage);
app.post('/oauth/authorize', approveAuthorization);
app.post('/oauth/token', exchangeToken);

app.all('/mcp', requireMcpOAuth, (req, res, next) =>
  handleMcpRequest(createMarketingMcpServer(), req, res, next));

if (config.CLAUDE_OAUTH_CLIENT_ID && config.CLAUDE_OAUTH_CLIENT_SECRET) {
  app.use(createClaudeRouter(config.CLAUDE_OAUTH_CLIENT_ID, config.CLAUDE_OAUTH_CLIENT_SECRET));
}

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(error);
  if (!res.headersSent) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
  }
});

app.listen(config.PORT, '0.0.0.0', () => {
  console.log(`Marketing MCP listening on port ${config.PORT}`);
  console.log(`Google connect URL: ${config.PUBLIC_BASE_URL}/connect/google?admin_token=***`);
  console.log(`OAuth issuer: ${config.PUBLIC_BASE_URL}`);
});
