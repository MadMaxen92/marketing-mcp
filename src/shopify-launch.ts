import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { config } from './config.js';
import { shopifyGraphql, SHOPIFY_API_VERSION } from './shopify.js';

const title = z.string().trim().min(1).max(255);
const handle = z.string().min(1).max(200).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const productId = z.string().regex(/^gid:\/\/shopify\/Product\/\d+$/);
const money = z.string().regex(/^(0|[1-9]\d{0,6})(\.\d{1,2})?$/);
const seo = z.object({ title: z.string().max(70), description: z.string().max(320) }).strict();
const image = z.object({
  originalSource: z.string().url().max(2000).refine(value => new URL(value).protocol === 'https:', 'Use HTTPS image URLs'),
  alt: z.string().max(1000),
}).strict();
const menuLeaf = z.object({ title, url: z.string().max(2000).regex(/^\/(?!\/)/) }).strict();
const menuChild = menuLeaf.extend({ items: z.array(menuLeaf).max(20).optional() });
const menuItem = menuLeaf.extend({ items: z.array(menuChild).max(20).optional() });

// Deliberately not raw Shopify input: callers cannot supply status, publication,
// existing file/variant IDs, inventory quantities or arbitrary mutation fields.
export const launchActionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('CREATE_DRAFT_PRODUCT'), title, handle,
    descriptionHtml: z.string().max(100000),
    productType: title, vendor: title,
    templateSuffix: z.string().max(100).regex(/^[a-z0-9-]*$/),
    tags: z.array(z.string().trim().min(1).max(100)).max(50),
    seo: seo.optional(),
    options: z.array(z.object({ name: title, values: z.array(title).min(1).max(100) }).strict()).min(1).max(3),
    variants: z.array(z.object({
      sku: title, price: money, compareAtPrice: money.optional(),
      values: z.array(title).min(1).max(3),
      imageIndex: z.number().int().min(0).max(19).optional(),
    }).strict()).min(1).max(100),
    images: z.array(image).max(20).default([]),
    metafields: z.array(z.object({
      namespace: z.string().regex(/^[a-zA-Z0-9_-]{3,255}$/),
      key: z.string().regex(/^[a-zA-Z0-9_-]{3,64}$/),
      type: z.enum(['single_line_text_field', 'multi_line_text_field', 'rich_text_field', 'boolean', 'number_integer', 'number_decimal', 'json']),
      value: z.string().max(20000),
    }).strict()).max(30).default([]),
  }).strict(),
  z.object({
    kind: z.literal('CREATE_UNPUBLISHED_COLLECTION'), title, handle,
    descriptionHtml: z.string().max(100000), seo: seo.optional(),
    productIds: z.array(productId).max(100).default([]),
  }).strict(),
  z.object({
    kind: z.literal('CREATE_LAUNCH_MENU'), title,
    handle: handle.refine(value => value.startsWith('launch-'), 'New menu handles must start with launch-'),
    items: z.array(menuItem).min(1).max(20),
  }).strict(),
  z.object({
    kind: z.literal('DUPLICATE_THEME'),
    sourceThemeId: z.string().regex(/^gid:\/\/shopify\/OnlineStoreTheme\/\d+$/),
    name: z.string().trim().min(1).max(50),
  }).strict(),
]);
export type LaunchAction = z.infer<typeof launchActionSchema>;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function validateAction(raw: unknown): LaunchAction {
  const action = launchActionSchema.parse(raw);
  function unique(values: string[], label: string) {
    if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}.`);
  }
  if (action.kind === 'CREATE_DRAFT_PRODUCT') {
    unique(action.options.map(option => option.name.toLowerCase()), 'option names');
    action.options.forEach(option => unique(option.values, 'option values'));
    unique(action.variants.map(variant => variant.sku), 'SKUs');
    unique(action.variants.map(variant => JSON.stringify(variant.values)), 'variant combinations');
    unique(action.images.map(file => file.originalSource), 'image URLs');
    unique(action.metafields.map(field => `${field.namespace}.${field.key}`), 'metafields');
    for (const variant of action.variants) {
      if (variant.values.length !== action.options.length
        || variant.values.some((value, index) => !action.options[index]!.values.includes(value))) {
        throw new Error('Each variant must specify one declared value per option, in option order.');
      }
      if (variant.imageIndex !== undefined && !action.images[variant.imageIndex]) throw new Error('Variant image index is out of range.');
      if (variant.compareAtPrice !== undefined && Number(variant.compareAtPrice) < Number(variant.price)) {
        throw new Error('Compare-at price must be at least the selling price.');
      }
    }
    action.options.forEach((option, index) => {
      if (option.values.some(value => !action.variants.some(variant => variant.values[index] === value))) {
        throw new Error('Each declared option value must be used by a variant.');
      }
    });
  }
  if (action.kind === 'CREATE_UNPUBLISHED_COLLECTION') unique(action.productIds, 'product IDs');
  return action;
}

type Access = { shop: { myshopifyDomain: string }; currentAppInstallation: { accessScopes: { handle: string }[] } };
const requiredScope = (action: LaunchAction) => action.kind === 'DUPLICATE_THEME' ? 'write_themes'
  : action.kind === 'CREATE_LAUNCH_MENU' ? 'write_online_store_navigation' : 'write_products';

export async function getShopifyLaunchCapabilities() {
  const data = await shopifyGraphql<Access>(`query ShopifyLaunchAccess {
    shop { myshopifyDomain }
    currentAppInstallation { accessScopes { handle } }
  }`);
  const accessScopes = data.currentAppInstallation.accessScopes.map(scope => scope.handle).sort();
  return { shop: data.shop.myshopifyDomain, apiVersion: SHOPIFY_API_VERSION, accessScopes,
    operations: ['write_products', 'write_online_store_navigation', 'write_themes'].map(scope => ({ scope, granted: accessScopes.includes(scope) })),
    limitations: ['Theme duplication also requires Shopify theme access approval.',
      'New product images must have Shopify-accessible HTTPS source URLs; private Drive links are not direct image URLs.',
      'No publishing, live menu assignment, stock import, metaobject definition edits or existing product replacement is exposed by these preparation tools.'],
  };
}

type Theme = { id: string; name: string; role: string; updatedAt: string; processing: boolean; processingFailed: boolean };
async function preflight(action: LaunchAction) {
  const access = await getShopifyLaunchCapabilities();
  if (!access.accessScopes.includes(requiredScope(action))) throw new Error(`Missing Shopify scope ${requiredScope(action)}. Update the installed Shopify app permissions.`);
  if (action.kind === 'CREATE_DRAFT_PRODUCT') {
    const data = await shopifyGraphql<{ productByHandle: { id: string } | null }>(`query LaunchProductHandle($handle: String!) {
      productByHandle(handle: $handle) { id }
    }`, { handle: action.handle });
    if (data.productByHandle) throw new Error('Product handle already exists. Existing products cannot be overwritten.');
  } else if (action.kind === 'CREATE_UNPUBLISHED_COLLECTION') {
    const data = await shopifyGraphql<{ collectionByHandle: { id: string } | null; nodes: ({ id: string; status: string; updatedAt: string } | null)[] }>(`query LaunchCollectionState($handle: String!, $ids: [ID!]!) {
      collectionByHandle(handle: $handle) { id }
      nodes(ids: $ids) { ... on Product { id status updatedAt } }
    }`, { handle: action.handle, ids: action.productIds });
    if (data.collectionByHandle) throw new Error('Collection handle already exists.');
    if (data.nodes.length !== action.productIds.length || data.nodes.some((node, index) => !node || node.id !== action.productIds[index] || node.status !== 'DRAFT')) {
      throw new Error('Initial collection members must all exist and be DRAFT products.');
    }
    return { shop: access.shop, state: data.nodes };
  } else if (action.kind === 'CREATE_LAUNCH_MENU') {
    // menus has no handle filter; inspect every page instead of treating the first
    // search result page as proof that a handle is free.
    let after: string | undefined;
    for (let page = 0; page < 100; page++) {
      const data = await shopifyGraphql<{ menus: { nodes: { handle: string }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }>(`query LaunchMenuHandles($after: String) {
        menus(first: 100, after: $after) { nodes { handle } pageInfo { hasNextPage endCursor } }
      }`, { after });
      if (data.menus.nodes.some(menu => menu.handle === action.handle)) throw new Error('Menu handle already exists. Existing menus cannot be overwritten.');
      if (!data.menus.pageInfo.hasNextPage) return { shop: access.shop, state: null };
      if (!data.menus.pageInfo.endCursor || data.menus.pageInfo.endCursor === after) throw new Error('Incomplete menu pagination.');
      after = data.menus.pageInfo.endCursor;
    }
    throw new Error('Menu pagination limit exceeded.');
  } else {
    const data = await shopifyGraphql<{ theme: Theme | null }>(`query LaunchSourceTheme($id: ID!) {
      theme(id: $id) { id name role updatedAt processing processingFailed }
    }`, { id: action.sourceThemeId });
    if (!data.theme || data.theme.processing || data.theme.processingFailed) throw new Error('Source theme is missing or not ready.');
    return { shop: access.shop, state: data.theme };
  }
  return { shop: access.shop, state: null };
}

type Confirmation = { kind: 'launch_preparation'; shop: string; actionHash: string; stateHash: string; code: string; expires: number };
function sign(payload: Confirmation) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${createHmac('sha256', config.ADMIN_TOKEN).update(encoded).digest('base64url')}`;
}
function verify(token: string): Confirmation {
  const [encoded, signature, extra] = token.split('.');
  if (!encoded || !signature || extra) throw new Error('Invalid launch confirmation.');
  const expected = createHmac('sha256', config.ADMIN_TOKEN).update(encoded).digest();
  const received = Buffer.from(signature, 'base64url');
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw new Error('Invalid launch confirmation signature.');
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as Confirmation;
  if (payload.kind !== 'launch_preparation' || !Number.isFinite(payload.expires) || payload.expires <= Date.now()) throw new Error('Expired or invalid launch confirmation. Create a new preview.');
  return payload;
}

export async function previewShopifyLaunchPreparation(raw: unknown) {
  const action = validateAction(raw);
  const current = await preflight(action);
  const confirmation: Confirmation = { kind: 'launch_preparation', shop: current.shop,
    actionHash: hash(action), stateHash: hash(current.state),
    code: `SHOPIFY-${randomBytes(4).toString('hex').toUpperCase()}`, expires: Date.now() + 600000 };
  return { dryRun: true, shop: current.shop, action, currentState: current.state,
    effects: action.kind === 'CREATE_DRAFT_PRODUCT' ? 'Create one DRAFT product. Options use the supplied order. Inventory tracked at zero, selling when out of stock disabled. No sales-channel publication.'
      : action.kind === 'CREATE_UNPUBLISHED_COLLECTION' ? 'Create a manual collection with no publications.'
      : action.kind === 'CREATE_LAUNCH_MENU' ? 'Create a separate launch menu. No theme or existing menu is updated.'
      : 'Duplicate the source theme into a new unpublished theme. The source remains unchanged.',
    safety: { confirmationCode: confirmation.code, expiresAt: new Date(confirmation.expires).toISOString(),
      instruction: `Show the full preview to the user. Apply only after the user explicitly replies with ${confirmation.code}.` },
    confirmationToken: sign(confirmation) };
}

type MutationResult = { userErrors: { field?: string[] | null; message: string }[]; [key: string]: unknown };
async function createResource(action: LaunchAction): Promise<MutationResult> {
  if (action.kind === 'CREATE_DRAFT_PRODUCT') {
    const files = action.images.map(file => ({ ...file, contentType: 'IMAGE', duplicateResolutionMode: 'APPEND_UUID' }));
    const data = await shopifyGraphql<{ productSet: MutationResult }>(`mutation LaunchDraftProduct($input: ProductSetInput!) {
      productSet(input: $input, synchronous: true) {
        product { id title handle status options { name position values }
          variants(first: 100) { nodes { id sku price selectedOptions { name value } } pageInfo { hasNextPage } }
          media(first: 20) { nodes { id status } }
        }
        userErrors { field message }
      }
    }`, { input: { title: action.title, handle: action.handle, descriptionHtml: action.descriptionHtml,
      productType: action.productType, vendor: action.vendor, templateSuffix: action.templateSuffix,
      tags: action.tags, seo: action.seo, status: 'DRAFT', metafields: action.metafields, files,
      productOptions: action.options.map((option, index) => ({ name: option.name, position: index + 1, values: option.values.map(name => ({ name })) })),
      variants: action.variants.map(variant => ({ sku: variant.sku, price: variant.price, compareAtPrice: variant.compareAtPrice,
        inventoryPolicy: 'DENY', inventoryItem: { tracked: true, requiresShipping: true },
        optionValues: variant.values.map((name, index) => ({ optionName: action.options[index]!.name, name })),
        file: variant.imageIndex === undefined ? undefined : files[variant.imageIndex],
      })),
    } }, false);
    return data.productSet;
  }
  if (action.kind === 'CREATE_UNPUBLISHED_COLLECTION') {
    const data = await shopifyGraphql<{ collectionCreate: MutationResult }>(`mutation LaunchCollection($input: CollectionInput!) {
      collectionCreate(input: $input) { collection { id title handle resourcePublicationsCount { count } } userErrors { field message } }
    }`, { input: { title: action.title, handle: action.handle, descriptionHtml: action.descriptionHtml,
      seo: action.seo, products: action.productIds, sortOrder: 'MANUAL', publications: [] } }, false);
    return data.collectionCreate;
  }
  if (action.kind === 'CREATE_LAUNCH_MENU') {
    type Link = { title: string; url: string; items?: Link[] };
    const links = (items: Link[]): unknown[] => items.map(item => ({ title: item.title, url: item.url, type: 'HTTP', items: links(item.items ?? []) }));
    const data = await shopifyGraphql<{ menuCreate: MutationResult }>(`mutation LaunchMenu($title: String!, $handle: String!, $items: [MenuItemCreateInput!]!) {
      menuCreate(title: $title, handle: $handle, items: $items) { menu { id title handle } userErrors { field message } }
    }`, { title: action.title, handle: action.handle, items: links(action.items) }, false);
    return data.menuCreate;
  }
  const data = await shopifyGraphql<{ themeDuplicate: MutationResult }>(`mutation LaunchThemeCopy($id: ID!, $name: String!) {
    themeDuplicate(id: $id, name: $name) { newTheme { id name role processing } userErrors { field message } }
  }`, { id: action.sourceThemeId, name: action.name }, false);
  return data.themeDuplicate;
}

function checkCreated(action: LaunchAction, result: MutationResult) {
  if (result.userErrors.length) throw new Error(`Shopify rejected the creation: ${JSON.stringify(result.userErrors)}`);
  const resource = (result.product ?? result.collection ?? result.menu ?? result.newTheme) as Record<string, unknown> | undefined;
  if (!resource?.id) throw new Error('Shopify did not return a created resource.');
  if ('handle' in action && resource.handle !== action.handle) throw new Error('Created handle differs from the preview; inspect the returned resource before continuing.');
  if (action.kind === 'CREATE_DRAFT_PRODUCT' && resource.status !== 'DRAFT') throw new Error('Created product is unexpectedly not DRAFT.');
  if (action.kind === 'DUPLICATE_THEME' && resource.role !== 'UNPUBLISHED') throw new Error('Created theme is unexpectedly not UNPUBLISHED.');
  if (action.kind === 'CREATE_UNPUBLISHED_COLLECTION' && (resource.resourcePublicationsCount as { count: number } | undefined)?.count !== 0) {
    throw new Error('Created collection unexpectedly has publications.');
  }
}

export async function applyShopifyLaunchPreparation(input: { action: unknown; confirmationCode: string; confirmationToken: string }) {
  const action = validateAction(input.action);
  const confirmation = verify(input.confirmationToken);
  if (confirmation.code !== input.confirmationCode || confirmation.actionHash !== hash(action)) throw new Error('Launch confirmation does not match the proposed action.');
  const access = await getShopifyLaunchCapabilities();
  if (confirmation.shop !== access.shop) throw new Error('Launch confirmation belongs to another shop.');
  const directory = join(dirname(config.TOKEN_STORE_PATH), 'shopify-launch-operations');
  const key = hash({ shop: confirmation.shop, action });
  const receiptPath = join(directory, `${key}.json`);
  try {
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    if (receipt.applied) return { ...receipt, replayed: true };
    throw new Error('This creation was already attempted. Inspect Shopify and the operation receipt before creating another preview.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const current = await preflight(action);
  if (confirmation.stateHash !== hash(current.state)) throw new Error('Source resources changed after preview. Create a new preview.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // A durable, exclusive lock prevents concurrent/replayed creations, including
  // crashes and uncertain network outcomes. Never retry a mutation automatically.
  let lock;
  try { lock = await open(join(directory, `${key}.lock`), 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Creation already attempted or in progress. Inspect Shopify before retrying.');
    throw error;
  }
  await lock.sync();
  await lock.close();
  let result: MutationResult | undefined;
  try {
    result = await createResource(action);
    checkCreated(action, result);
    const receipt = { applied: true, shop: current.shop, operationId: key, kind: action.kind, result, appliedAt: new Date().toISOString() };
    const temporary = `${receiptPath}.tmp`;
    await writeFile(temporary, JSON.stringify(receipt), { mode: 0o600 });
    await rename(temporary, receiptPath);
    console.info(JSON.stringify({ event: 'shopify_launch_preparation', shop: current.shop, kind: action.kind, operationId: key }));
    return receipt;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeFile(receiptPath, JSON.stringify({ applied: false, operationId: key, kind: action.kind, result, error: message }), { mode: 0o600 });
    throw new Error(`Launch preparation failed or has an uncertain outcome. Inspect Shopify before retrying. Operation ${key}: ${message}`);
  }
}
