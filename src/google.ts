import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from './config.js';
import { getConnection, readStore, upsertConnection, type GoogleConnection } from './token-store.js';

const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const pendingStates = new Map<string, number>();

type TokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
};

async function postForm(url: string, values: Record<string, string>): Promise<any> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(values),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Google OAuth error ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

export function beginGoogleOAuth(req: Request, res: Response): void {
  if (req.query.admin_token !== config.ADMIN_TOKEN) {
    res.status(401).send('Unauthorized');
    return;
  }
  const state = randomUUID();
  pendingStates.set(state, Date.now() + 10 * 60_000);
  const params = new URLSearchParams({
    client_id: config.GOOGLE_CLIENT_ID,
    redirect_uri: config.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
}

export async function finishGoogleOAuth(req: Request, res: Response): Promise<void> {
  const code = String(req.query.code ?? '');
  const state = String(req.query.state ?? '');
  const expiry = pendingStates.get(state);
  pendingStates.delete(state);
  if (!code || !expiry || expiry < Date.now()) {
    res.status(400).send('Invalid or expired OAuth state. Start the connection again.');
    return;
  }

  const tokens = (await postForm('https://oauth2.googleapis.com/token', {
    code,
    client_id: config.GOOGLE_CLIENT_ID,
    client_secret: config.GOOGLE_CLIENT_SECRET,
    redirect_uri: config.GOOGLE_REDIRECT_URI,
    grant_type: 'authorization_code',
  })) as TokenResponse;

  if (!tokens.refresh_token) throw new Error('Google did not return a refresh token. Revoke access and reconnect.');
  const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  const profile = (await profileResponse.json()) as { email?: string; sub?: string };
  if (!profileResponse.ok || !profile.email) throw new Error('Could not read Google account identity.');

  const now = new Date().toISOString();
  const existing = (await readStore()).connections.find((item) => item.email === profile.email);
  const connection: GoogleConnection = {
    id: existing?.id ?? profile.sub ?? randomUUID(),
    email: profile.email,
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token,
    accessTokenExpiresAt: Date.now() + tokens.expires_in * 1000 - 60_000,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await upsertConnection(connection);
  res.type('html').send(`<h1>Google Analytics connected</h1><p>${profile.email}</p><p>You can close this window.</p>`);
}

export async function getAccessToken(connectionId?: string): Promise<{ token: string; connection: GoogleConnection }> {
  const connection = await getConnection(connectionId);
  if (connection.accessToken && (connection.accessTokenExpiresAt ?? 0) > Date.now()) {
    return { token: connection.accessToken, connection };
  }
  const tokens = (await postForm('https://oauth2.googleapis.com/token', {
    client_id: config.GOOGLE_CLIENT_ID,
    client_secret: config.GOOGLE_CLIENT_SECRET,
    refresh_token: connection.refreshToken,
    grant_type: 'refresh_token',
  })) as TokenResponse;
  connection.accessToken = tokens.access_token;
  connection.accessTokenExpiresAt = Date.now() + tokens.expires_in * 1000 - 60_000;
  connection.updatedAt = new Date().toISOString();
  await upsertConnection(connection);
  return { token: connection.accessToken, connection };
}

async function googleJson(url: string, token: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Google API error ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

export async function listProperties(connectionId?: string): Promise<any> {
  const { token, connection } = await getAccessToken(connectionId);
  const body = await googleJson('https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200', token);
  return { connection: { id: connection.id, email: connection.email }, ...body };
}

export async function runReport(input: {
  connectionId?: string;
  propertyId: string;
  startDate: string;
  endDate: string;
  dimensions?: string[];
  metrics: string[];
  limit?: number;
}): Promise<any> {
  const { token, connection } = await getAccessToken(input.connectionId);
  const body = {
    dateRanges: [{ startDate: input.startDate, endDate: input.endDate }],
    dimensions: (input.dimensions ?? []).map((name) => ({ name })),
    metrics: input.metrics.map((name) => ({ name })),
    limit: String(input.limit ?? 100),
    keepEmptyRows: false,
  };
  const report = await googleJson(
    `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(input.propertyId)}:runReport`,
    token,
    { method: 'POST', body: JSON.stringify(body) },
  );
  return { connection: { id: connection.id, email: connection.email }, propertyId: input.propertyId, ...report };
}
