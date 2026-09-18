import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const directory = await mkdtemp(join(tmpdir(), 'shopify-launch-'));
Object.assign(process.env, {
  PUBLIC_BASE_URL: 'https://example.com', MCP_BEARER_TOKEN: 'm'.repeat(32), ADMIN_TOKEN: 'a'.repeat(32),
  TOKEN_ENCRYPTION_KEY: '0'.repeat(64), TOKEN_STORE_PATH: join(directory, 'tokens.enc'),
  GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret',
  GOOGLE_REDIRECT_URI: 'https://example.com/oauth/google/callback',
  GOOGLE_ADS_DEVELOPER_TOKEN: 'developer-token', GOOGLE_ADS_LOGIN_CUSTOMER_ID: '1234567890',
  CHATGPT_OAUTH_CLIENT_ID: 'chatgpt-client-id-123', CHATGPT_OAUTH_CLIENT_SECRET: 's'.repeat(32),
  CHATGPT_OAUTH_REDIRECT_URI: 'https://chatgpt.com/connector/oauth/test',
  SHOPIFY_SHOP: 'mambo-test', SHOPIFY_CLIENT_ID: 'test-client', SHOPIFY_CLIENT_SECRET: 'shopify-test-secret',
});
const { previewShopifyLaunchPreparation: preview, applyShopifyLaunchPreparation: apply } = await import('./shopify-launch.js');
after(() => rm(directory, { recursive: true, force: true }));
type Handler = (query: string, variables: any) => unknown;
function mock(t: any, handler: Handler, scopes = ['write_products', 'write_themes', 'write_online_store_navigation']) {
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/admin/oauth/access_token')) return Response.json({ access_token: 'test-token', expires_in: 86400 });
    const { query, variables } = JSON.parse(init.body as string);
    if (query.includes('ShopifyLaunchAccess')) return Response.json({ data: {
      shop: { myshopifyDomain: 'mambo-test.myshopify.com' }, currentAppInstallation: { accessScopes: scopes.map(handle => ({ handle })) },
    } });
    const data = handler(query, variables);
    assert.ok(data, `Unhandled query: ${query}`);
    return Response.json({ data });
  });
}
const product = (handle: string) => ({ kind: 'CREATE_DRAFT_PRODUCT', title: 'Farting Dog Tee', handle,
  descriptionHtml: '<p>Artwork story</p>', productType: 'T-Shirts', vendor: 'Mambo', templateSuffix: 'new-pdp',
  tags: ['fw26'], options: [{ name: 'Size', values: ['S', 'M'] }, { name: 'Colour', values: ['Black'] }],
  variants: [{ sku: 'DOG-BK-S', price: '30.00', values: ['S', 'Black'], imageIndex: 0 },
    { sku: 'DOG-BK-M', price: '30.00', values: ['M', 'Black'], imageIndex: 0 }],
  images: [{ originalSource: 'https://example.com/dog.jpg', alt: 'Farting Dog Black front' }],
});
const approved = (action: unknown, p: Awaited<ReturnType<typeof preview>>) => ({ action, confirmationCode: p.safety.confirmationCode, confirmationToken: p.confirmationToken });

test('draft product preserves size/colour order, forces safe status and ignores no unexpected fields', async t => {
  let mutations = 0;
  mock(t, (query, variables) => {
    if (query.includes('LaunchProductHandle')) return { productByHandle: null };
    assert.match(query, /productSet\(input: \$input, synchronous: true\)/);
    mutations++;
    assert.equal(variables.input.status, 'DRAFT');
    assert.equal(variables.input.id, undefined);
    assert.deepEqual(variables.input.productOptions.map((o: any) => [o.name, o.position]), [['Size', 1], ['Colour', 2]]);
    assert.deepEqual(variables.input.variants[0].optionValues, [{ optionName: 'Size', name: 'S' }, { optionName: 'Colour', name: 'Black' }]);
    assert.equal(variables.input.variants[0].inventoryPolicy, 'DENY');
    assert.equal(variables.input.variants[0].inventoryItem.tracked, true);
    assert.deepEqual(variables.input.variants[0].file, variables.input.files[0]);
    assert.equal(variables.input.files[0].duplicateResolutionMode, 'APPEND_UUID');
    return { productSet: { product: { id: 'gid://shopify/Product/1', handle: 'draft-dog', status: 'DRAFT' }, userErrors: [] } };
  });
  const action = product('draft-dog');
  const p = await preview(action);
  assert.equal(mutations, 0);
  const result = await apply(approved(action, p));
  assert.equal(result.applied, true);
  assert.equal((await apply(approved(action, p))).replayed, true);
  assert.equal(mutations, 1);
  await assert.rejects(preview({ ...action, status: 'ACTIVE' }), /Unrecognized key/);
});

test('refuses malformed or duplicate variants and unsupported live mutation fields before network', async t => {
  mock(t, () => { assert.fail('No Shopify requests expected'); });
  const action = product('invalid');
  await assert.rejects(preview({ ...action, variants: [action.variants[0], action.variants[0]] }), /Duplicate SKUs/);
  await assert.rejects(preview({ ...action, variants: [{ ...action.variants[0], values: ['XXL', 'Black'] }] }), /declared value/);
  await assert.rejects(preview({ ...action, variants: [{ ...action.variants[0], imageIndex: 5 }] }), /out of range/);
  await assert.rejects(preview({ ...action, variants: [{ ...action.variants[0], compareAtPrice: '1.00' }] }), /Compare-at/);
  await assert.rejects(preview({ ...action, id: 'gid://shopify/Product/99' }), /Unrecognized key/);
  await assert.rejects(preview({ ...action, images: [{ ...action.images[0], id: 'gid://shopify/MediaImage/99' }] }), /Unrecognized key/);
});

test('requires exact action, code and valid unexpired signed token', async t => {
  mock(t, query => { assert.match(query, /LaunchProductHandle/); return { productByHandle: null }; });
  const action = product('confirm-dog');
  const p = await preview(action);
  await assert.rejects(apply({ ...approved(action, p), action: { ...action, title: 'Changed' } }), /does not match/);
  await assert.rejects(apply({ ...approved(action, p), confirmationCode: 'SHOPIFY-00000000' }), /does not match/);
  await assert.rejects(apply({ ...approved(action, p), confirmationToken: `${p.confirmationToken}x` }), /signature/);
  const payload = JSON.parse(Buffer.from(p.confirmationToken.split('.')[0]!, 'base64url').toString());
  payload.expires = Date.now() - 1;
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const token = `${encoded}.${createHmac('sha256', process.env.ADMIN_TOKEN!).update(encoded).digest('base64url')}`;
  await assert.rejects(apply({ ...approved(action, p), confirmationToken: token }), /Expired/);
});

test('refuses handle collision introduced after preview', async t => {
  let collision = false;
  mock(t, query => { assert.match(query, /LaunchProductHandle/); return { productByHandle: collision ? { id: 'gid://shopify/Product/1' } : null }; });
  const action = product('collision-dog');
  const p = await preview(action);
  collision = true;
  await assert.rejects(apply(approved(action, p)), /already exists/);
});

test('refuses missing scope before mutations', async t => {
  mock(t, () => assert.fail('No mutation expected'), ['write_products']);
  await assert.rejects(preview({ kind: 'CREATE_LAUNCH_MENU', title: 'Launch', handle: 'launch-main', items: [{ title: 'All', url: '/collections/all' }] }), /Missing Shopify scope write_online_store_navigation/);
});

test('checks all menu pages and refuses an existing handle on page two', async t => {
  mock(t, (query, variables) => {
    assert.match(query, /LaunchMenuHandles/);
    return { menus: { nodes: variables.after ? [{ handle: 'launch-main' }] : [], pageInfo: { hasNextPage: !variables.after, endCursor: 'page2' } } };
  });
  await assert.rejects(preview({ kind: 'CREATE_LAUNCH_MENU', title: 'Launch', handle: 'launch-main', items: [{ title: 'All', url: '/collections/all' }] }), /already exists/);
});

test('creates isolated nested launch menu without updating a theme or existing menu', async t => {
  mock(t, (query, variables) => {
    if (query.includes('LaunchMenuHandles')) return { menus: { nodes: [], pageInfo: { hasNextPage: false } } };
    assert.match(query, /menuCreate/);
    assert.equal(variables.handle, 'launch-fw26');
    assert.equal(variables.items[0].items[0].type, 'HTTP');
    return { menuCreate: { menu: { id: 'gid://shopify/Menu/1', handle: 'launch-fw26' }, userErrors: [] } };
  });
  const action = { kind: 'CREATE_LAUNCH_MENU', title: 'FW26', handle: 'launch-fw26', items: [{ title: 'Shop', url: '/collections/fw26', items: [{ title: 'Tees', url: '/collections/fw26-tees' }] }] };
  await apply(approved(action, await preview(action)));
  await assert.rejects(preview({ ...action, handle: 'main-menu' }), /launch-/);
});

test('collection creation explicitly leaves publications empty and permits draft members only', async t => {
  let status = 'DRAFT';
  const action = { kind: 'CREATE_UNPUBLISHED_COLLECTION', title: 'Tees', handle: 'fw26-tees', descriptionHtml: '', productIds: ['gid://shopify/Product/1'] };
  mock(t, (query, variables) => {
    if (query.includes('LaunchCollectionState')) return { collectionByHandle: null, nodes: [{ id: action.productIds[0], status, updatedAt: 'v1' }] };
    assert.deepEqual(variables.input.publications, []);
    assert.deepEqual(variables.input.products, action.productIds);
    return { collectionCreate: { collection: { id: 'gid://shopify/Collection/1', handle: action.handle, resourcePublicationsCount: { count: 0 } }, userErrors: [] } };
  });
  await apply(approved(action, await preview(action)));
  status = 'ACTIVE';
  await assert.rejects(preview({ ...action, handle: 'other-tees' }), /DRAFT/);
});

test('theme changed after preview is rejected, including promotion to live', async t => {
  let role = 'UNPUBLISHED';
  mock(t, query => { assert.match(query, /LaunchSourceTheme/); return { theme: { id: 'gid://shopify/OnlineStoreTheme/1', name: 'Source', role, updatedAt: 'v1', processing: false, processingFailed: false } }; });
  const action = { kind: 'DUPLICATE_THEME', sourceThemeId: 'gid://shopify/OnlineStoreTheme/1', name: 'Launch' };
  const p = await preview(action);
  role = 'MAIN';
  await assert.rejects(apply(approved(action, p)), /changed after preview/);
});

test('theme duplication validates returned unpublished role', async t => {
  mock(t, query => {
    if (query.includes('LaunchSourceTheme')) return { theme: { id: 'gid://shopify/OnlineStoreTheme/2', name: 'Source', role: 'MAIN', updatedAt: 'v1', processing: false, processingFailed: false } };
    assert.match(query, /themeDuplicate/);
    return { themeDuplicate: { newTheme: { id: 'gid://shopify/OnlineStoreTheme/3', role: 'UNPUBLISHED', name: 'FW26' }, userErrors: [] } };
  });
  const action = { kind: 'DUPLICATE_THEME', sourceThemeId: 'gid://shopify/OnlineStoreTheme/2', name: 'FW26' };
  assert.equal((await apply(approved(action, await preview(action)))).applied, true);
});

test('uncertain network failure cannot issue another mutation, even with a fresh preview', async t => {
  let mutations = 0;
  mock(t, query => {
    if (query.includes('LaunchProductHandle')) return { productByHandle: null };
    mutations++;
    throw new Error('Connection closed after sending request');
  });
  const action = product('uncertain-dog');
  await assert.rejects(apply(approved(action, await preview(action))), /uncertain outcome/);
  await assert.rejects(apply(approved(action, await preview(action))), /already attempted/);
  assert.equal(mutations, 1);
});

test('simultaneous apply requests create at most one resource', async t => {
  let mutations = 0;
  mock(t, query => {
    if (query.includes('LaunchProductHandle')) return { productByHandle: null };
    mutations++;
    return { productSet: { product: { id: 'gid://shopify/Product/9', handle: 'concurrent-dog', status: 'DRAFT' }, userErrors: [] } };
  });
  const action = product('concurrent-dog');
  const input = approved(action, await preview(action));
  const results = await Promise.allSettled([apply(input), apply(input)]);
  assert.ok(results.some(result => result.status === 'fulfilled'));
  assert.equal(mutations, 1);
});

test('unexpected publication state leaves an operation receipt and blocks retry', async t => {
  mock(t, query => {
    if (query.includes('LaunchProductHandle')) return { productByHandle: null };
    return { productSet: { product: { id: 'gid://shopify/Product/99', handle: 'bad-state-dog', status: 'ACTIVE' }, userErrors: [] } };
  });
  const action = product('bad-state-dog');
  const input = approved(action, await preview(action));
  await assert.rejects(apply(input), /unexpectedly not DRAFT/);
  await assert.rejects(apply(input), /already attempted/);
});
