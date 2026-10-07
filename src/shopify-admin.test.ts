import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { buildSchema, getIntrospectionQuery, graphqlSync } from 'graphql';

const directory = await mkdtemp(join(tmpdir(), 'shopify-admin-'));
Object.assign(process.env, {
  PUBLIC_BASE_URL: 'https://example.com', MCP_BEARER_TOKEN: 'm'.repeat(32), ADMIN_TOKEN: 'a'.repeat(32),
  TOKEN_ENCRYPTION_KEY: '0'.repeat(64), TOKEN_STORE_PATH: join(directory, 'tokens.enc'),
  GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret', GOOGLE_REDIRECT_URI: 'https://example.com/callback',
  GOOGLE_ADS_DEVELOPER_TOKEN: 'developer-token', GOOGLE_ADS_LOGIN_CUSTOMER_ID: '1234567890',
  CHATGPT_OAUTH_CLIENT_ID: 'chatgpt-client-id-123', CHATGPT_OAUTH_CLIENT_SECRET: 's'.repeat(32), CHATGPT_OAUTH_REDIRECT_URI: 'https://chatgpt.com/callback',
  SHOPIFY_SHOP: 'mambo-test', SHOPIFY_CLIENT_ID: 'test-client', SHOPIFY_CLIENT_SECRET: 'shopify-test-secret',
});
const { previewShopifyAdminMutation: preview, applyShopifyAdminMutation: apply, runShopifyQuery,
  getShopifyCapabilities, inspectShopifyOperation } = await import('./shopify-admin.js');
after(() => rm(directory, { recursive: true, force: true }));
const fixture = buildSchema(`
  directive @idempotent(key: String!) on FIELD
  type Shop { myshopifyDomain: String! }
  type Product { id: ID!, title: String!, updatedAt: String! }
  type Collection { id: ID!, title: String!, updatedAt: String! }
  type PageInfo { hasNextPage: Boolean!, hasPreviousPage: Boolean! }
  type ProductConnection { nodes: [Product!]!, pageInfo: PageInfo! }
  type Inventory { id: ID!, quantity: Int! }
  type UserError { field: [String!], message: String! }
  type Payload { product: Product, newProduct: Product, deletedProductId: ID, deletedCollectionId: ID, userErrors: [UserError!]! }
  enum ProductStatus { DRAFT ACTIVE ARCHIVED }
  input ProductInput { id: ID, title: String, status: ProductStatus }
  input DeleteInput { id: ID! }
  input InventoryQuantity { inventoryItemId: ID!, locationId: ID!, quantity: Int!, compareQuantity: Int }
  input InventoryInput { ignoreCompareQuantity: Boolean, quantities: [InventoryQuantity!]! }
  input MetafieldInput { ownerId: ID!, key: String!, value: String!, compareDigest: String }
  enum OwnerType { PRODUCT CUSTOMER }
  input DefinitionInput { id: ID, ownerType: OwnerType, name: String }
  type Definition { id: ID!, ownerType: OwnerType!, name: String! }
  type Query { shop: Shop!, product(id: ID!): Product, collection(id: ID!): Collection, products(first: Int): ProductConnection!, inventory(id: ID!): Inventory, metafieldDefinition(id: ID!): Definition }
  type Mutation {
    productUpdate(product: ProductInput!): Payload!
    productDuplicate(productId: ID!, newTitle: String!, newStatus: ProductStatus): Payload!
    productDelete(input: DeleteInput!): Payload!
    collectionDelete(input: DeleteInput!): Payload!
    productCreate(product: ProductInput!): Payload!
    inventorySetQuantities(input: InventoryInput!): Payload!
    metafieldsSet(metafields: [MetafieldInput!]!): Payload!
    metafieldDefinitionCreate(definition: DefinitionInput!): Payload!
    metafieldDefinitionUpdate(definition: DefinitionInput!): Payload!
    fileDelete(id: ID!): Payload!
    locationDelete(id: ID!): Payload!
    metaobjectUpdate(id: ID!): Payload!
    metaobjectDefinitionUpdate(id: ID!): Payload!
    menuUpdate(id: ID!): Payload!
    themePublish(id: ID!): Payload!
    publishablePublish(id: ID!): Payload!
    deliveryProfileUpdate(id: ID!): Payload!
    deliveryCustomizationUpdate(id: ID!): Payload!
    refundCreate(id: ID!): Payload!
  }
`);
const schemaData = graphqlSync({ schema: fixture, source: getIntrospectionQuery() }).data;
const id = (n: number) => `gid://shopify/Product/${n}`;
const read = (n: number) => ({ query: 'query State($id: ID!) { product(id: $id) { id title updatedAt } }', variables: { id: id(n) } });
const plan = (n: number) => ({ summary: `Rename the identified draft product ${n} to New title.`,
  mutation: 'mutation Rename($product: ProductInput!) { productUpdate(product: $product) { product { id title updatedAt } userErrors { field message } } }',
  variables: { product: { id: id(n), title: 'New title' } }, before: read(n), after: read(n),
});
type Options = { scopes?: string[]; shop?: string; title?: string; stamp?: string; fail?: boolean; userErrors?: any[]; truncated?: boolean; definitionOwner?: string };
function mock(t: any, options: Options = {}) {
  const count = { mutations: 0, scopes: options.scopes ?? ['write_products'] };
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/admin/oauth/access_token')) return Response.json({ access_token: 'test-token', expires_in: 86400 });
    const { query, variables } = JSON.parse(init.body as string);
    if (query.includes('IntrospectionQuery')) return Response.json({ data: schemaData });
    if (query.includes('ShopifyAdminAccess')) return Response.json({ data: { shop: { myshopifyDomain: options.shop ?? 'mambo-test.myshopify.com' }, currentAppInstallation: { accessScopes: count.scopes.map(handle => ({ handle })) } } });
    if (query.trim().startsWith('mutation')) {
      count.mutations++;
      if (options.fail) throw new Error('Connection lost after request was sent');
      const name = query.match(/\{\s*(\w+)\(/)![1]!;
      return Response.json({ data: { [name]: { product: { id: variables.product?.id ?? variables.productId, title: 'New title' }, userErrors: options.userErrors ?? [] } } });
    }
    if (query.includes('products(')) return Response.json({ data: { products: { nodes: [], pageInfo: { hasNextPage: options.truncated ?? false } } } });
    if (query.includes('product(')) return Response.json({ data: { product: { id: variables.id, title: options.title ?? 'Old title', updatedAt: options.stamp ?? 'v1' } } });
    if (query.includes('metafieldDefinition(')) return Response.json({ data: { metafieldDefinition: { id: variables.id, ownerType: options.definitionOwner ?? 'PRODUCT', name: 'Existing definition' } } });
    return Response.json({ data: { shop: { myshopifyDomain: 'mambo-test.myshopify.com' } } });
  });
  return count;
}
const approved = (p: Awaited<ReturnType<typeof preview>>) => ({ plan: p.plan, confirmationCode: p.safety.confirmationCode, confirmationToken: p.confirmationToken });

test('discovers every granted management area from the actual schema, excluding refund/order writes', async t => {
  mock(t, { scopes: ['write_products', 'write_inventory', 'write_files', 'write_locations', 'write_metaobjects', 'write_metaobject_definitions', 'write_online_store_navigation', 'write_themes', 'write_publications', 'write_shipping', 'write_delivery_customizations'] });
  const c = await getShopifyCapabilities();
  assert.equal(c.managementAreas.length, 11);
  assert.ok(c.managementAreas.every(a => a.granted && a.operations.length));
  assert.ok(c.managementAreas.find(a => a.area === 'products_and_collections')!.operations.includes('productDuplicate'));
  assert.ok(!c.managementAreas.some(a => a.operations.includes('refundCreate')));
  const operation = await inspectShopifyOperation({ name: 'productDuplicate', kind: 'mutation' });
  assert.ok(operation.inputTypes.ProductStatus);
});

test('read interface rejects writes, multiple operations, subscriptions, invalid fields and unbounded pages before sending a mutation', async t => {
  const count = mock(t);
  await assert.rejects(runShopifyQuery({ query: plan(1).mutation, variables: plan(1).variables }), /one query/);
  await assert.rejects(runShopifyQuery({ query: 'query A { shop { myshopifyDomain } } query B { shop { myshopifyDomain } }', variables: {} }), /one query/);
  await assert.rejects(runShopifyQuery({ query: '{ products(first: 101) { nodes { id } } }', variables: {} }), /between 1 and 100/);
  await assert.rejects(runShopifyQuery({ query: '{ shop { unknown } }', variables: {} }), /schema validation/);
  assert.equal(count.mutations, 0);
});

test('read-only preview, exact signed approval, one write and replay without another write', async t => {
  const count = mock(t);
  const p = await preview(plan(2));
  assert.equal(count.mutations, 0);
  await assert.rejects(apply({ ...approved(p), confirmationCode: 'SHOPIFY-00000000' }), /does not match/);
  await assert.rejects(apply({ ...approved(p), plan: { ...p.plan, summary: 'A different explanation entirely.' } }), /does not match/);
  await assert.rejects(apply({ ...approved(p), confirmationToken: `${p.confirmationToken}x` }), /signature/);
  const result = await apply(approved(p));
  assert.equal(result.accepted, true);
  assert.ok(result.afterState.product);
  assert.equal((await apply(approved(p))).replayed, true);
  assert.equal(count.mutations, 1);
});

test('refuses stale state and revoked scopes at apply; rejects cross-store and expired tokens', async t => {
  const options: Options = {};
  const count = mock(t, options);
  const p = await preview(plan(3));
  options.stamp = 'v2';
  await assert.rejects(apply(approved(p)), /state changed/);
  options.stamp = 'v1'; count.scopes = [];
  await assert.rejects(apply(approved(p)), /Missing installed/);
  count.scopes = ['write_products']; options.shop = 'another.myshopify.com';
  await assert.rejects(apply(approved(p)), /another store/);
  options.shop = 'mambo-test.myshopify.com';
  const value = JSON.parse(Buffer.from(p.confirmationToken.split('.')[0]!, 'base64url').toString());
  value.expires = Date.now() - 1;
  const encoded = Buffer.from(JSON.stringify(value)).toString('base64url');
  await assert.rejects(apply({ ...approved(p), confirmationToken: `${encoded}.${createHmac('sha256', process.env.ADMIN_TOKEN!).update(encoded).digest('base64url')}` }), /Expired/);
  assert.equal(count.mutations, 0);
});

test('refuses aliased, inline, batched and out-of-area writes and rejects invalid input fields', async t => {
  const count = mock(t);
  for (const mutation of [
    'mutation X($product: ProductInput!) { alias: productUpdate(product: $product) { userErrors { field message } } }',
    'mutation X($product: ProductInput!) { productUpdate(product: $product) { userErrors { field message } } productCreate(product: $product) { userErrors { field message } } }',
    'mutation { productUpdate(product: {title: "hidden"}) { userErrors { field message } } }',
  ]) await assert.rejects(preview({ ...plan(4), mutation, variables: mutation.includes('$product') ? plan(4).variables : {} }), /unaliased|explicit variable/);
  await assert.rejects(preview({ ...plan(4), variables: { product: { id: id(4), unexpected: true } } }), /Invalid Shopify variables/);
  await assert.rejects(preview({ ...plan(4), mutation: 'mutation X($id: ID!) { refundCreate(id: $id) { userErrors { field message } } }', variables: { id: id(4) } }), /outside/);
  assert.equal(count.mutations, 0);
});

test('requires error fields, explicit duplicate status, complete affected IDs and nontruncated state', async t => {
  const options: Options = {}; const count = mock(t, options);
  await assert.rejects(preview({ ...plan(5), mutation: plan(5).mutation.replace('userErrors { field message }', '') }), /userErrors/);
  await assert.rejects(preview({ ...plan(5), mutation: 'mutation Copy($productId: ID!, $newTitle: String!) { productDuplicate(productId: $productId, newTitle: $newTitle) { userErrors { field message } } }', variables: { productId: id(5), newTitle: 'Copy' } }), /explicit newStatus/);
  await assert.rejects(preview({ ...plan(5), before: read(999) }), /every referenced/);
  options.truncated = true;
  await assert.rejects(preview({ ...plan(5), before: { query: '{ products(first: 100) { nodes { id title updatedAt } pageInfo { hasNextPage } } }', variables: {} } }), /truncated/);
  assert.equal(count.mutations, 0);
});

test('network uncertainty is not retried and cannot be bypassed with a different summary or read query', async t => {
  const count = mock(t, { fail: true });
  const p = await preview(plan(6));
  await assert.rejects(apply(approved(p)), /Do not retry/);
  const fresh = await preview({ ...plan(6), summary: 'Reworded explanation of the same change to this product.', before: { ...read(6), query: read(6).query.replace('State', 'Reworded') } });
  await assert.rejects(apply(approved(fresh)), /unresolved|Matching mutation/);
  assert.equal(count.mutations, 1);
});

test('partial errors lock the operation and concurrent approvals issue at most one mutation', async t => {
  const count = mock(t, { userErrors: [{ field: ['product'], message: 'Partial result' }] });
  const p = await preview(plan(7));
  await assert.rejects(apply(approved(p)), /partial result/);
  await assert.rejects(apply(approved(p)), /unresolved/);
  assert.equal(count.mutations, 1);
});
test('two simultaneous applies cannot duplicate a write', async t => {
  const count = mock(t);
  const p = await preview(plan(8));
  const results = await Promise.allSettled([apply(approved(p)), apply(approved(p))]);
  assert.ok(results.some(r => r.status === 'fulfilled'));
  assert.equal(count.mutations, 1);
});

test('inventory requires API idempotency and compare-and-set; metafields require owner scopes and compareDigest', async t => {
  mock(t);
  const inventory = { ...plan(9), mutation: 'mutation Stock($input: InventoryInput!) { inventorySetQuantities(input: $input) { userErrors { field message } } }',
    variables: { input: { quantities: [{ inventoryItemId: 'gid://shopify/InventoryItem/1', locationId: 'gid://shopify/Location/1', quantity: 2 }] } } };
  await assert.rejects(preview(inventory), /idempotent/);
  await assert.rejects(preview({ ...inventory, mutation: inventory.mutation.replace('Stock($input: InventoryInput!)', 'Stock($input: InventoryInput!, $key: String!)').replace('input: $input)', 'input: $input) @idempotent(key: $key)'), variables: { ...inventory.variables, key: 'unique-key' } }), /compare quantity/);
  const metafields = { ...plan(9), mutation: 'mutation Set($metafields: [MetafieldInput!]!) { metafieldsSet(metafields: $metafields) { userErrors { field message } } }', variables: { metafields: [{ ownerId: id(9), key: 'test', value: 'value' }] } };
  await assert.rejects(preview(metafields), /compareDigest/);
  await assert.rejects(preview({ ...metafields, variables: { metafields: [{ ownerId: 'gid://shopify/Customer/1', key: 'test', value: 'value', compareDigest: null }] } }), /owner is outside/);
});

test('deletion preview is explicit and still sends no write', async t => {
  const count = mock(t);
  const p = await preview({ ...plan(10), summary: 'Permanently delete this specified product and its variants.', mutation: 'mutation Delete($input: DeleteInput!) { productDelete(input: $input) { deletedProductId userErrors { field message } } }', variables: { input: { id: id(10) } } });
  assert.equal(p.destructive, true);
  assert.match(p.warnings[0]!, /permanently/);
  assert.equal(count.mutations, 0);
});

test('metafield definition management enforces the actual existing owner scope', async t => {
  const options: Options = {}; const count = mock(t, options);
  const definitionId = 'gid://shopify/MetafieldDefinition/100';
  const definitionRead = { query: 'query Definition($id: ID!) { metafieldDefinition(id: $id) { id ownerType name } }', variables: { id: definitionId } };
  const definitionPlan = { ...plan(11), mutation: 'mutation Definition($definition: DefinitionInput!) { metafieldDefinitionUpdate(definition: $definition) { userErrors { field message } } }',
    variables: { definition: { id: definitionId, ownerType: 'PRODUCT', name: 'New definition' } }, before: definitionRead, after: definitionRead };
  const p = await preview(definitionPlan);
  assert.deepEqual(p.requiredScopes, ['write_products']);
  options.definitionOwner = 'CUSTOMER';
  await assert.rejects(apply(approved(p)), /owner is missing or does not match/);
  await assert.rejects(preview({ ...definitionPlan, variables: { definition: { id: definitionId, name: 'New definition' } } }), /owner is outside/);
  assert.equal(count.mutations, 0);
});

test('MCP discovery advertises the expanded tools with read/write annotations', async t => {
  mock(t);
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { createMarketingMcpServer } = await import('./mcp.js');
  const server = createMarketingMcpServer();
  const client = new Client({ name: 'test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left); await client.connect(right);
  try {
    const { tools } = await client.listTools();
    for (const name of ['get_shopify_capabilities', 'inspect_shopify_operation', 'run_shopify_query', 'preview_shopify_admin_mutation', 'apply_shopify_admin_mutation', 'preview_shopify_launch_preparation']) assert.ok(tools.find(t => t.name === name), name);
    assert.equal(tools.find(t => t.name === 'preview_shopify_admin_mutation')!.annotations!.readOnlyHint, true);
    assert.equal(tools.find(t => t.name === 'apply_shopify_admin_mutation')!.annotations!.destructiveHint, true);
  } finally { await client.close(); await server.close(); }
});
