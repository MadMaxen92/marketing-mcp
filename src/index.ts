import express, { type NextFunction, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './config.js';
import { beginGoogleOAuth, finishGoogleOAuth } from './google.js';
import { createMarketingMcpServer } from './mcp.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'marketing-mcp', version: '0.1.0' });
});

app.get('/connect/google', beginGoogleOAuth);
app.get('/oauth/google/callback', (req, res, next) => {
  finishGoogleOAuth(req, res).catch(next);
});

function requireMcpBearer(req: Request, res: Response, next: NextFunction): void {
  const token = req.header('authorization')?.replace(/^Bearer\s+/i, '');
  if (token !== config.MCP_BEARER_TOKEN) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

app.all('/mcp', requireMcpBearer, async (req, res, next) => {
  const server = createMarketingMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    next(error);
  } finally {
    res.on('close', () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });
  }
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(error);
  if (!res.headersSent) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
  }
});

app.listen(config.PORT, '0.0.0.0', () => {
  console.log(`Marketing MCP listening on port ${config.PORT}`);
  console.log(`Google connect URL: ${config.PUBLIC_BASE_URL}/connect/google?admin_token=***`);
});
