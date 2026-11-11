import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { config } from './config.js';
import { readStore } from './token-store.js';

const emailSchema = z.string().trim().toLowerCase().email().max(254);
const googleResources = (id: z.ZodString) => z.array(z.object({
  id,
  connectionId: z.union([z.string().regex(/^\d+$/), z.string().uuid()]),
}).strict()).max(100).superRefine((resources, ctx) => {
  if (new Set(resources.map(resource => resource.id)).size !== resources.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Resource IDs must be unique per platform.' });
  }
});

export const grantSchema = z.object({
  ga4: googleResources(z.string().regex(/^\d+$/)).default([]),
  googleAds: googleResources(z.string().regex(/^\d{10}$/)).default([]),
  searchConsole: googleResources(z.string().min(1).max(2048)).default([]),
  merchantCenter: googleResources(z.string().regex(/^\d+$/)).default([]),
  shopify: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
  writes: z.object({
    shopify: z.boolean().default(false),
    googleAdsCustomerIds: z.array(z.string().regex(/^\d{10}$/)).max(100).default([]),
  }).strict().optional(),
}).strict().superRefine((grants, ctx) => {
  if (grants.writes?.shopify && !grants.shopify) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Shopify writes require a Shopify reporting grant.' });
  }
  const ids = grants.writes?.googleAdsCustomerIds ?? [];
  if (new Set(ids).size !== ids.length || ids.some(id => !grants.googleAds.some(resource => resource.id === id))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Google Ads write IDs must be unique and have reporting grants.' });
  }
});

export type MemberGrants = z.infer<typeof grantSchema>;

const memberSchema = z.object({
  email: emailSchema,
  passwordHash: z.string().regex(/^[a-f0-9]{64}$/),
  sessionVersion: z.string().uuid(),
  grants: grantSchema,
});

export type ClaudeMember = z.infer<typeof memberSchema>;

export function secretHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function memberPath(email: string): string {
  return join(dirname(config.TOKEN_STORE_PATH), 'claude-members', secretHash(email) + '.json');
}

export async function readMember(email: string): Promise<ClaudeMember | undefined> {
  const parsed = emailSchema.safeParse(email);
  if (!parsed.success) return;
  try {
    const member = memberSchema.parse(JSON.parse(await readFile(memberPath(parsed.data), 'utf8')));
    if (member.email === parsed.data) return member;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function provisionMember(email: string, rawGrants: unknown): Promise<{ email: string; password: string }> {
  const normalizedEmail = emailSchema.parse(email);
  const grants = grantSchema.parse(rawGrants);
  const resources = [...grants.ga4, ...grants.googleAds, ...grants.searchConsole, ...grants.merchantCenter];
  if (resources.length === 0 && !grants.shopify) throw new Error('Grant at least one reporting resource.');
  if (grants.shopify && grants.shopify !== config.SHOPIFY_SHOP) {
    throw new Error('The Shopify store must match the configured shop subdomain.');
  }
  if (resources.length > 0) {
    const { connections } = await readStore();
    const ids = new Set(connections.map(connection => connection.id));
    if (resources.some(resource => !ids.has(resource.connectionId))) {
      throw new Error('A grant refers to an unknown Hub Google connection ID.');
    }
  }

  const password = randomBytes(32).toString('base64url');
  const member: ClaudeMember = {
    email: normalizedEmail,
    passwordHash: secretHash(password),
    sessionVersion: randomUUID(),
    grants,
  };
  const path = memberPath(normalizedEmail);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = path + '.' + member.sessionVersion + '.tmp';
  try {
    await writeFile(temporaryPath, JSON.stringify(member), { mode: 0o600, flag: 'wx' });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return { email: normalizedEmail, password };
}

export async function revokeMember(email: string): Promise<void> {
  await rm(memberPath(emailSchema.parse(email)), { force: true });
}
