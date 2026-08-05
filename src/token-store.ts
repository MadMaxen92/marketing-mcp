import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config } from './config.js';

export type GoogleConnection = {
  id: string;
  email: string;
  refreshToken: string;
  accessToken?: string;
  accessTokenExpiresAt?: number;
  createdAt: string;
  updatedAt: string;
};

type StoreData = { connections: GoogleConnection[] };
const key = Buffer.from(config.TOKEN_ENCRYPTION_KEY, 'hex');

function encrypt(value: StoreData): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]);
}

function decrypt(payload: Buffer): StoreData {
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const encrypted = payload.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')) as StoreData;
}

export async function readStore(): Promise<StoreData> {
  try {
    return decrypt(await readFile(config.TOKEN_STORE_PATH));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { connections: [] };
    throw error;
  }
}

export async function writeStore(data: StoreData): Promise<void> {
  await mkdir(dirname(config.TOKEN_STORE_PATH), { recursive: true });
  await writeFile(config.TOKEN_STORE_PATH, encrypt(data), { mode: 0o600 });
}

export async function upsertConnection(connection: GoogleConnection): Promise<void> {
  const store = await readStore();
  const index = store.connections.findIndex((item) => item.email === connection.email);
  if (index >= 0) store.connections[index] = connection;
  else store.connections.push(connection);
  await writeStore(store);
}

export async function getConnection(id?: string): Promise<GoogleConnection> {
  const store = await readStore();
  const connection = id
    ? store.connections.find((item) => item.id === id || item.email === id)
    : store.connections[0];
  if (!connection) throw new Error('No matching Google connection. Connect an account first.');
  return connection;
}
