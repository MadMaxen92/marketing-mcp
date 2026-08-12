import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8000),
  PUBLIC_BASE_URL: z.string().url(),
  MCP_BEARER_TOKEN: z.string().min(32),
  ADMIN_TOKEN: z.string().min(32),
  TOKEN_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REDIRECT_URI: z.string().url(),
  GOOGLE_ADS_DEVELOPER_TOKEN: z.string().min(8),
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: z.string().regex(/^\d{10}$/),
  CHATGPT_OAUTH_CLIENT_ID: z.string().min(16),
  CHATGPT_OAUTH_CLIENT_SECRET: z.string().min(32),
  CHATGPT_OAUTH_REDIRECT_URI: z.string().url(),
  TOKEN_STORE_PATH: z.string().default('/app/data/google-connections.enc'),
});

export const config = schema.parse(process.env);
