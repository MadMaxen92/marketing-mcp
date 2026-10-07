import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  buildClientSchema, getIntrospectionQuery, getNamedType, getVariableValues,
  isInputObjectType, isEnumType, isObjectType, Kind, parse, print, validate, visit,
  type FieldNode, type GraphQLInputType, type GraphQLSchema, type IntrospectionQuery, type OperationDefinitionNode,
} from 'graphql';
import { z } from 'zod';
import { config } from './config.js';
import { SHOPIFY_API_VERSION, shopifyGraphql } from './shopify.js';

// A scope authorizes an area, not every possible API operation. These families
// deliberately exclude app access, customers, payments, refunds and order writes.
const AREAS = [
  { area: 'products_and_collections', scope: 'write_products', pattern: /^(product(?!ResourceFeedback|Publish|Unpublish)|collection(?!Publish|Unpublish))[A-Z]/ },
  { area: 'publications', scope: 'write_publications', pattern: /^(publishable|publication)[A-Z]|^(product|collection)(Publish|Unpublish)$/ },
  { area: 'files', scope: 'write_files', pattern: /^(file[A-Z]|stagedUploadsCreate$)/ },
  { area: 'inventory', scope: 'write_inventory', pattern: /^inventory[A-Z]/ },
  { area: 'locations', scope: 'write_locations', pattern: /^location[A-Z]/ },
  { area: 'metaobject_definitions', scope: 'write_metaobject_definitions', pattern: /^metaobjectDefinition[A-Z]/ },
  { area: 'metaobjects', scope: 'write_metaobjects', pattern: /^metaobject(?!Definition)[A-Z]/ },
  { area: 'navigation', scope: 'write_online_store_navigation', pattern: /^(menu|urlRedirect)[A-Z]/ },
  { area: 'themes', scope: 'write_themes', pattern: /^theme[A-Z]/ },
  { area: 'shipping', scope: 'write_shipping', pattern: /^(deliveryProfile|deliverySetting|deliveryLocationGroup|deliveryZone|deliveryMethodDefinition|deliveryCarrierService|carrierService)[A-Z]/ },
  { area: 'delivery_customizations', scope: 'write_delivery_customizations', pattern: /^deliveryCustomization[A-Z]/ },
] as const;
const OWNER_SCOPES: Record<string, string> = {
  Product: 'write_products', ProductVariant: 'write_products', Collection: 'write_products',
  Metaobject: 'write_metaobjects', Location: 'write_locations', InventoryItem: 'write_inventory',
  DeliveryCustomization: 'write_delivery_customizations',
};
const NEEDS_IDEMPOTENCY = /^(inventorySetQuantities|inventoryAdjustQuantities|inventoryMoveQuantities|inventoryActivate)$/;
const TTL = 10 * 60 * 1000;
const MAX_BYTES = 500_000;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

const readSchema = z.object({
  query: z.string().min(1).max(30000), variables: z.record(z.unknown()).default({}),
}).strict();
export const shopifyAdminPlanSchema = z.object({
  summary: z.string().trim().min(10).max(4000).describe('Concrete human-readable change, affected records, and storefront/deletion effects.'),
  mutation: z.string().min(1).max(30000).describe('Exactly one Shopify mutation field. Use variables for every argument and select userErrors { field message }.'),
  variables: z.record(z.unknown()).default({}),
  before: readSchema.describe('Read-only query of current affected state; include every referenced Shopify ID, changed fields, nested state, and pageInfo for connections.'),
  after: readSchema.describe('Read-only verification of the resulting state. Use the same targets; for creation, look up the explicit new handle or use IDs from the mutation result.'),
}).strict();
export type AdminPlan = z.infer<typeof shopifyAdminPlanSchema>;

async function access() {
  const data = await shopifyGraphql<{ shop: { myshopifyDomain: string }; currentAppInstallation: { accessScopes: { handle: string }[] } }>(`query ShopifyAdminAccess {
    shop { myshopifyDomain } currentAppInstallation { accessScopes { handle } }
  }`);
  return { shop: data.shop.myshopifyDomain, scopes: data.currentAppInstallation.accessScopes.map(s => s.handle).sort() };
}

// Only public schema metadata is cached. Permission and state checks are fresh.
let cachedSchema: { schema: GraphQLSchema; until: number } | undefined;
export async function getShopifyAdminSchema(): Promise<GraphQLSchema> {
  if (cachedSchema && cachedSchema.until > Date.now()) return cachedSchema.schema;
  const data = await shopifyGraphql<IntrospectionQuery>(getIntrospectionQuery());
  const schema = buildClientSchema(data);
  cachedSchema = { schema, until: Date.now() + TTL };
  return schema;
}

function family(name: string) { return AREAS.find(a => a.pattern.test(name)); }
const ownerMutation = (name: string) => /^(metafields(Set|Delete)$|metafieldDefinition[A-Z])/.test(name);
async function mutationScope(name: string, variables: Record<string, unknown>): Promise<string[]> {
  if (/^metafieldDefinition[A-Z]/.test(name)) {
    const definition = variables.definition as any;
    const id = variables.id ?? definition?.id;
    let ownerType = definition?.ownerType;
    if (id) {
      const current = await shopifyGraphql<{ metafieldDefinition: { id: string; ownerType: string } | null }>(`query ShopifyAdminDefinitionOwner($id: ID!) { metafieldDefinition(id: $id) { id ownerType } }`, { id });
      if (!current.metafieldDefinition || (ownerType && ownerType !== current.metafieldDefinition.ownerType)) throw new Error('Metafield definition owner is missing or does not match.');
      ownerType = current.metafieldDefinition.ownerType;
    }
    const entry = Object.entries(OWNER_SCOPES).find(([type]) => type.toUpperCase() === String(ownerType ?? '').replaceAll('_', ''));
    if (!entry) throw new Error('Metafield definition owner is outside the granted management areas.');
    return [entry[1]];
  }
  if (name === 'metafieldsSet' || name === 'metafieldsDelete') {
    const values = (variables.metafields ?? (variables.input as any)?.metafields) as any[] | undefined;
    if (!Array.isArray(values) || !values.length) throw new Error('Metafield operations must use a variable named metafields containing explicit ownerId values.');
    return [...new Set(values.map(value => {
      const type = String(value.ownerId ?? '').match(/^gid:\/\/shopify\/([^/]+)\//)?.[1];
      if (!type || !OWNER_SCOPES[type]) throw new Error('Metafield owner is outside the granted management areas.');
      return OWNER_SCOPES[type]!;
    }))];
  }
  const area = family(name);
  if (!area) throw new Error(`Shopify mutation ${name} is outside the supported permission areas.`);
  return [area.scope];
}

export async function getShopifyCapabilities() {
  const [current, schema] = await Promise.all([access(), getShopifyAdminSchema()]);
  const fields = schema.getMutationType()?.getFields() ?? {};
  return { shop: current.shop, apiVersion: SHOPIFY_API_VERSION, accessScopes: current.scopes,
    managementAreas: AREAS.map(({ area, scope, pattern }) => ({ area, scope, granted: current.scopes.includes(scope),
      operations: Object.keys(fields).filter(name => pattern.test(name)).sort() })),
    ownerScopedMetafields: { operations: Object.keys(fields).filter(ownerMutation).sort(), ownerScopes: OWNER_SCOPES },
    readAccess: current.scopes.filter(scope => scope.startsWith('read_')),
    tools: ['get_shopify_capabilities', 'inspect_shopify_operation', 'run_shopify_query', 'preview_shopify_admin_mutation', 'apply_shopify_admin_mutation'],
    limitations: [
      'Granted scopes are checked before every write. Shopify can additionally require staff permissions, app ownership, a plan or theme access approval.',
      'Read queries are schema-validated and Shopify enforces the installed token permissions. Orders remain read-only.',
      'Writes require one mutation, a complete current-state query, a verification query, and an exact expiring confirmation code.',
      'Deletion, live-theme edits, publishing, stock changes and delivery changes must be identified explicitly in the user-facing preview.',
      'No automatic mutation retries. Partial or uncertain outcomes remain locked until inspected by an operator.',
    ] };
}

export async function inspectShopifyOperation(input: { name: string; kind: 'query' | 'mutation' }) {
  const schema = await getShopifyAdminSchema();
  const root = input.kind === 'mutation' ? schema.getMutationType() : schema.getQueryType();
  const field = root?.getFields()[input.name];
  if (!field) throw new Error('Operation is absent from the installed Shopify API version.');
  if (input.kind === 'mutation' && !family(input.name) && !ownerMutation(input.name)) throw new Error('Mutation is outside supported management areas.');
  const inputTypes: Record<string, unknown> = {};
  function expand(type: GraphQLInputType, depth = 0) {
    const named = getNamedType(type);
    if (depth > 15 || named.name in inputTypes) return;
    if (isInputObjectType(named)) {
      const fields = Object.values(named.getFields());
      inputTypes[named.name] = fields.map(f => ({ name: f.name, type: String(f.type), description: f.description, defaultValue: f.defaultValue }));
      fields.forEach(f => expand(f.type, depth + 1));
    } else if (isEnumType(named)) inputTypes[named.name] = named.getValues().map(v => v.name);
  }
  field.args.forEach(a => expand(a.type));
  const payload = getNamedType(field.type);
  return { name: field.name, kind: input.kind, description: field.description, returnType: String(field.type),
    arguments: field.args.map(a => ({ name: a.name, type: String(a.type), defaultValue: a.defaultValue, description: a.description })),
    inputTypes, resultFields: isObjectType(payload) ? Object.values(payload.getFields()).map(f => ({ name: f.name, type: String(f.type) })) : [],
    requiredScope: family(input.name)?.scope ?? 'Shopify enforces read scopes or metafield owner scope',
  };
}

function checkedDocument(query: string, expected: 'query' | 'mutation', variables: Record<string, unknown>) {
  const document = parse(query, { maxTokens: 5000 });
  const operations = document.definitions.filter(d => d.kind === Kind.OPERATION_DEFINITION) as OperationDefinitionNode[];
  if (operations.length !== 1 || operations[0]!.operation !== expected) throw new Error(`Exactly one ${expected} operation is required.`);
  const operation = operations[0]!;
  if (operation.variableDefinitions?.some(d => d.defaultValue)) throw new Error('Variable defaults are not accepted; show all values explicitly.');
  let fields = 0;
  visit(document, {
    Field(node, _key, _parent, _path, ancestors) {
      if (++fields > 500 || ancestors.length > 60) throw new Error('Shopify operation is too complex. Split it into smaller operations.');
      for (const arg of node.arguments ?? []) {
        if (['first', 'last'].includes(arg.name.value)) {
          const n = arg.value.kind === Kind.VARIABLE ? variables[arg.value.name.value]
            : arg.value.kind === Kind.INT ? Number(arg.value.value) : undefined;
          if (!Number.isInteger(n) || Number(n) < 1 || Number(n) > 100) throw new Error('Every connection page must explicitly request between 1 and 100 records.');
        }
      }
    },
    Directive(node) { if (node.name.value !== 'idempotent' || expected !== 'mutation') throw new Error('Only a root mutation @idempotent directive is accepted.'); },
  });
  return { document, operation };
}

async function validateDocument(query: string, kind: 'query' | 'mutation', variables: Record<string, unknown>) {
  const parsed = checkedDocument(query, kind, variables);
  const schema = await getShopifyAdminSchema();
  const errors = validate(schema, parsed.document);
  if (errors.length) throw new Error(`Shopify schema validation failed: ${errors.map(e => e.message).join('; ')}`);
  const definitions = parsed.operation.variableDefinitions ?? [];
  const defined = new Set(definitions.map(d => d.variable.name.value));
  if (Object.keys(variables).some(key => !defined.has(key))) throw new Error('Unexpected Shopify variable; all variables must be declared and used.');
  const coerced = getVariableValues(schema, definitions, variables);
  if (coerced.errors?.length) throw new Error(`Invalid Shopify variables: ${coerced.errors.map(e => e.message).join('; ')}`);
  return { ...parsed, variables: canonical(coerced.coerced ?? {}), schema };
}

export async function runShopifyQuery(input: z.infer<typeof readSchema>) {
  const { variables, document } = await validateDocument(input.query, 'query', input.variables);
  return { apiVersion: SHOPIFY_API_VERSION, data: await shopifyGraphql<Record<string, unknown>>(print(document), variables) };
}

function strings(value: any): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  return value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
}
function gids(value: unknown) { return [...new Set(strings(value).filter(s => /^gid:\/\/shopify\//.test(s)))].sort(); }
function complete(value: any) {
  if (!value || typeof value !== 'object') return;
  if (value.pageInfo?.hasNextPage || value.pageInfo?.hasPreviousPage) throw new Error('Current-state/verification query is truncated. Narrow the affected records or paginate explicitly.');
  if ('edges' in value || 'nodes' in value) {
    if (!value.pageInfo || typeof value.pageInfo.hasNextPage !== 'boolean') throw new Error('Current-state connections must include pageInfo { hasNextPage }.');
  }
  Object.values(value).forEach(complete);
}
type ValidPlan = { plan: AdminPlan; name: string; argumentsValue: Record<string, any>; requiredScopes: string[]; creation: boolean; destructive: boolean };
async function validatePlan(raw: unknown): Promise<ValidPlan> {
  const plan = shopifyAdminPlanSchema.parse(raw);
  if (Buffer.byteLength(JSON.stringify(plan)) > MAX_BYTES) throw new Error('Shopify plan is too large.');
  function bounded(value: any) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value) && value.length > 100) throw new Error('Limit each management batch to 100 explicit records.');
    Object.values(value).forEach(bounded);
  }
  bounded(plan.variables);
  const parsed = await validateDocument(plan.mutation, 'mutation', plan.variables);
  const root = parsed.operation.selectionSet.selections;
  if (root.length !== 1 || root[0]!.kind !== Kind.FIELD || root[0]!.alias) throw new Error('Use exactly one unaliased mutation field, without root fragments.');
  const field = root[0] as FieldNode;
  if (field.arguments?.some(a => a.value.kind !== Kind.VARIABLE)) throw new Error('Every mutation argument must use an explicit variable.');
  if ((parsed.operation.directives?.length ?? 0) > 0) throw new Error('Directives belong only on the mutation field.');
  let extraDirective = false;
  visit(parsed.document, { Directive(node) { if (!(field.directives ?? []).includes(node)) extraDirective = true; } });
  if (extraDirective) throw new Error('Conditional or nested mutation directives are not supported.');
  const errors = field.selectionSet?.selections.find(s => s.kind === Kind.FIELD && s.name.value === 'userErrors') as FieldNode | undefined;
  const errorNames = errors?.selectionSet?.selections.filter(s => s.kind === Kind.FIELD && !s.alias).map(s => (s as FieldNode).name.value) ?? [];
  if (errors?.alias || !errorNames.includes('message') || !errorNames.includes('field')) throw new Error('Select unaliased userErrors { field message } on the mutation payload.');
  plan.mutation = print(parsed.document);
  plan.variables = parsed.variables;
  // Resolve root arguments to their coerced values even when variable names differ.
  const argumentsValue = Object.fromEntries((field.arguments ?? []).map(a => [a.name.value, parsed.variables[(a.value as any).name.value]]));
  const name = field.name.value;
  const requiredScopes = await mutationScope(name, argumentsValue);
  if (/BulkDelete$/.test(name) && name !== 'productVariantsBulkDelete') {
    const input = argumentsValue.input as any;
    if (!Array.isArray(input?.ids) || !input.ids.length || input.where || input.query) throw new Error('Bulk deletion requires an explicit list of IDs, not an open-ended filter.');
  }
  if (name === 'productDuplicate' && !['DRAFT', 'ACTIVE', 'ARCHIVED'].includes(String(argumentsValue.newStatus))) throw new Error('Product duplication requires an explicit newStatus, normally DRAFT.');
  if (NEEDS_IDEMPOTENCY.test(name)) {
    const directive = field.directives?.find(d => d.name.value === 'idempotent');
    const key = directive?.arguments?.find(a => a.name.value === 'key')?.value;
    if (!key || key.kind !== Kind.VARIABLE || typeof parsed.variables[key.name.value] !== 'string' || !String(parsed.variables[key.name.value]).trim()) throw new Error('Inventory writes require an explicit @idempotent(key: $key) variable. Reuse it when inspecting an uncertain request.');
  }
  if (name === 'inventorySetQuantities') {
    const input = argumentsValue.input as any;
    if (input?.ignoreCompareQuantity === true || !input?.quantities?.length
      || input.quantities.some((q: any) => !Number.isInteger(q.compareQuantity ?? q.changeFromQuantity))) throw new Error('Inventory setting requires a compare quantity for every row; bypassing compare-and-set is disabled.');
  }
  if (name === 'metafieldsSet' && (argumentsValue.metafields as any[]).some(m => !Object.hasOwn(m, 'compareDigest'))) throw new Error('Metafield writes require an explicit compareDigest for every field, including null when creating.');
  for (const read of [plan.before, plan.after]) {
    const checked = await validateDocument(read.query, 'query', read.variables);
    read.query = print(checked.document); read.variables = checked.variables;
  }
  return { plan, name, argumentsValue, requiredScopes, creation: /Create|Duplicate/.test(name) || (name === 'productSet' && !(argumentsValue.input as any)?.id),
    destructive: /Delete|Remove|Revoke|Unpublish|Deactivate|Disable|Detach/.test(name) };
}

async function state(valid: ValidPlan) {
  const current = await access();
  for (const scope of valid.requiredScopes) if (!current.scopes.includes(scope)) throw new Error(`Missing installed Shopify scope ${scope}.`);
  const data = await shopifyGraphql<Record<string, unknown>>(valid.plan.before.query, valid.plan.before.variables);
  complete(data);
  if (Buffer.byteLength(JSON.stringify(data)) > MAX_BYTES) throw new Error('Current-state response is too large. Narrow the query.');
  const referenced = gids(valid.plan.variables);
  const present = new Set(gids(data));
  if (referenced.some(id => !present.has(id))) throw new Error('The current-state query must return every referenced Shopify ID. Include related products, variants, locations, publications and owners.');
  const schema = await getShopifyAdminSchema();
  function checkRecords(value: any) {
    if (!value || typeof value !== 'object') return;
    if (referenced.includes(value.id)) {
      const typeName = String(value.id).match(/^gid:\/\/shopify\/([^/]+)\//)?.[1];
      const type = schema.getType(typeName ?? '');
      if (type && isObjectType(type) && type.getFields().updatedAt && !value.updatedAt) throw new Error(`Read updatedAt for ${value.id} to detect concurrent changes.`);
      if (Object.keys(value).every(k => ['id', '__typename'].includes(k))) throw new Error('Current-state records must include their affected values, not just IDs.');
      const nested: Record<string, string> = { Menu: 'items', Metaobject: 'fields', MetaobjectDefinition: 'fieldDefinitions' };
      if (typeName && nested[typeName] && !Object.hasOwn(value, nested[typeName]!)) throw new Error(`Read ${nested[typeName]} for ${typeName} before changing it.`);
    }
    Object.values(value).forEach(checkRecords);
  }
  checkRecords(data);
  if (/^inventory(Set|Adjust|Move).*Quantities$/.test(valid.name) && !JSON.stringify(data).includes('"quantity"')) throw new Error('Read the affected inventory quantities in the current-state query.');
  if (!Object.keys(data).length) throw new Error('Current-state query returned no state.');
  return { shop: current.shop, data: canonical(data) };
}

type Confirmation = { kind: 'shopify_admin_v1'; shop: string; actionHash: string; stateHash: string; code: string; expires: number };
function sign(value: Confirmation) {
  const encoded = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encoded}.${createHmac('sha256', config.ADMIN_TOKEN).update(encoded).digest('base64url')}`;
}
function verify(token: string): Confirmation {
  const [encoded, signature, extra] = token.split('.');
  if (!encoded || !signature || extra) throw new Error('Invalid Shopify admin confirmation.');
  const expected = createHmac('sha256', config.ADMIN_TOKEN).update(encoded).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Invalid Shopify admin confirmation signature.');
  const value = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as Confirmation;
  if (value.kind !== 'shopify_admin_v1' || !Number.isFinite(value.expires) || value.expires <= Date.now()) throw new Error('Expired Shopify confirmation. Create a new preview.');
  return value;
}
export async function previewShopifyAdminMutation(raw: unknown) {
  const valid = await validatePlan(raw);
  const current = await state(valid);
  const confirmation: Confirmation = { kind: 'shopify_admin_v1', shop: current.shop, actionHash: hash(valid.plan), stateHash: hash(current.data),
    code: `SHOPIFY-${randomBytes(4).toString('hex').toUpperCase()}`, expires: Date.now() + TTL };
  return { dryRun: true, shop: current.shop, operation: valid.name, requiredScopes: valid.requiredScopes, summary: valid.plan.summary,
    plan: valid.plan, currentState: current.data, destructive: valid.destructive,
    warnings: [ ...(valid.destructive ? ['Deletion/removal can permanently affect the identified records.'] : []),
      ...(/theme|publish|delivery|carrier|inventory|location/i.test(valid.name) ? ['This can affect the live storefront, availability or checkout.'] : []),
      'Preview validates schema, permissions and state without executing the mutation. Shopify may still reject an operation for other platform restrictions.' ],
    safety: { confirmationCode: confirmation.code, expiresAt: new Date(confirmation.expires).toISOString(),
      instruction: `Explain all affected records and effects to the user. Apply only after the user explicitly replies with ${confirmation.code}.` },
    confirmationToken: sign(confirmation) };
}

async function readReceipt(path: string): Promise<any | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
async function saveReceipt(path: string, value: unknown) {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, path);
}
export async function applyShopifyAdminMutation(input: { plan: unknown; confirmationCode: string; confirmationToken: string }) {
  const confirmation = verify(input.confirmationToken);
  const valid = await validatePlan(input.plan);
  if (confirmation.code !== input.confirmationCode || confirmation.actionHash !== hash(valid.plan)) throw new Error('Shopify confirmation does not match the proposed action.');
  const current = await access();
  if (current.shop !== confirmation.shop) throw new Error('Shopify confirmation belongs to another store.');
  for (const scope of valid.requiredScopes) if (!current.scopes.includes(scope)) throw new Error(`Missing installed Shopify scope ${scope}.`);
  const directory = join(dirname(config.TOKEN_STORE_PATH), 'shopify-admin-operations');
  // Selection sets, summaries and read-query wording must not bypass replay locks.
  const actionKey = hash({ shop: current.shop, name: valid.name, arguments: canonical(valid.argumentsValue) });
  const key = hash({ actionKey, state: valid.creation ? null : confirmation.stateHash });
  const receiptPath = join(directory, `${key}.json`);
  const receipt = await readReceipt(receiptPath);
  if (receipt) {
    if (receipt.accepted) return { ...receipt, replayed: true };
    throw new Error(`This mutation has an unresolved outcome. Inspect operation ${key} before retrying.`);
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const actionLock = join(directory, `${actionKey}.lock`);
  let lock;
  try { lock = await open(actionLock, 'wx', 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Matching mutation is in progress or has an unresolved outcome. Inspect Shopify before retrying.'); throw error; }
  await lock.sync(); await lock.close();
  let sent = false;
  let result: any;
  try {
    // Recheck state while holding the durable action lock, before any write.
    const before = await state(valid);
    if (hash(before.data) !== confirmation.stateHash) throw new Error('Shopify state changed after preview. Create a new preview.');
    const raced = await readReceipt(receiptPath);
    if (raced) { await unlink(actionLock); return { ...raced, replayed: true }; }
    sent = true;
    result = await shopifyGraphql<Record<string, any>>(valid.plan.mutation, valid.plan.variables, false);
    const payload = result[valid.name];
    if (!payload || !Array.isArray(payload.userErrors) || payload.userErrors.length) throw new Error(`Shopify returned a rejection or partial result: ${JSON.stringify(payload?.userErrors ?? result)}`);
    const after = await shopifyGraphql<Record<string, unknown>>(valid.plan.after.query, valid.plan.after.variables);
    complete(after);
    const value = { accepted: true, shop: current.shop, operation: valid.name, operationId: key, summary: valid.plan.summary,
      result, afterState: after, verification: 'Read back the returned state; compare it with the requested values before reporting completion. Asynchronous jobs may still be pending.', appliedAt: new Date().toISOString() };
    await saveReceipt(receiptPath, value);
    await unlink(actionLock);
    console.info(JSON.stringify({ event: 'shopify_admin_mutation', shop: current.shop, operation: valid.name, operationId: key }));
    return value;
  } catch (error) {
    if (!sent) { await unlink(actionLock); throw error; }
    const message = error instanceof Error ? error.message : String(error);
    await saveReceipt(receiptPath, { accepted: false, unresolved: true, operation: valid.name, operationId: key, result, error: message });
    // Keep the action lock across new previews and restarts on uncertain/partial outcomes.
    throw new Error(`Mutation failed or verification is incomplete. Do not retry automatically. Inspect operation ${key}: ${message}`);
  }
}
