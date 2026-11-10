import { z } from 'zod';
import { config } from './config.js';

const ukDomainId = 2;
const historyDays = 90;
const keepaEpoch = Date.UTC(2011, 0, 1);
const indexes = { amazonPrice: 0, newPrice: 1, salesRank: 3, newOfferCount: 11, rating: 16, ratingCount: 17, buyBoxPrice: 18 };

export const keepaAsinSchema = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{10}$/);

const numericSeries = z.array(z.number().nullable()).nullish();
const statsSchema = z.object({
  current: numericSeries,
  avg30: numericSeries,
  avg90: numericSeries,
  minInInterval: z.array(numericSeries).nullish(),
  maxInInterval: z.array(numericSeries).nullish(),
  outOfStockPercentage30: numericSeries,
  outOfStockPercentage90: numericSeries,
  buyBoxSellerId: z.string().nullish(),
  buyBoxPrice: z.number().nullish(),
  buyBoxShipping: z.number().nullish(),
  buyBoxAvailabilityMessage: z.string().nullish(),
  buyBoxIsFBA: z.boolean().nullish(),
  buyBoxIsAmazon: z.boolean().nullish(),
  lastBuyBoxUpdate: z.number().nullish(),
});

const productSchema = z.object({
  asin: keepaAsinSchema,
  domainId: z.literal(ukDomainId),
  productType: z.number().int(),
  title: z.string().nullish(),
  brand: z.string().nullish(),
  color: z.string().nullish(),
  parentAsin: z.string().nullish(),
  parentTitle: z.string().nullish(),
  variations: z.array(z.object({
    asin: keepaAsinSchema,
    attributes: z.array(z.object({ dimension: z.string(), value: z.string() })).nullish(),
  })).nullish(),
  lastUpdate: z.number().nullish(),
  lastRatingUpdate: z.number().nullish(),
  trackingSince: z.number().nullish(),
  salesRankReference: z.number().nullish(),
  categoryTree: z.array(z.object({ catId: z.number(), name: z.string() })).nullish(),
  monthlySold: z.number().nullish(),
  lastSoldUpdate: z.number().nullish(),
  stats: statsSchema.nullish(),
  csv: z.array(numericSeries).nullish(),
});

const envelopeSchema = z.object({
  tokensLeft: z.number().optional(),
  tokensConsumed: z.number().optional(),
  refillIn: z.number().optional(),
  refillRate: z.number().optional(),
  products: z.array(productSchema).optional(),
});

function keepaDate(minutes: number | null | undefined): string | null {
  if (minutes == null || minutes <= 0) return null;
  const date = new Date(keepaEpoch + minutes * 60_000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function nonnegative(value: number | null | undefined): number | null {
  return value != null && value >= 0 ? value : null;
}

function pounds(pence: number | null | undefined): number | null {
  const value = nonnegative(pence);
  return value === null ? null : value / 100;
}

function decodePriceHistory(series: z.infer<typeof numericSeries>, includesShipping = false) {
  if (!series) return [];
  const entrySize = includesShipping ? 3 : 2;
  const changes = [];
  for (let index = 0; index + entrySize <= series.length; index += entrySize) {
    const observedAt = keepaDate(series[index]);
    const price = nonnegative(series[index + 1]);
    const shipping = includesShipping ? nonnegative(series[index + 2]) : 0;
    if (observedAt) {
      changes.push({ observedAt, priceGbp: price === null || shipping === null ? null : pounds(price + shipping) });
    }
  }
  return changes;
}

export async function getKeepaUkProduct(input: {
  asin: string;
  includeBuyBox?: boolean;
  includeRatings?: boolean;
  includeHistory?: boolean;
}) {
  const asin = keepaAsinSchema.parse(input.asin);
  if (!config.KEEPA_API_KEY) throw new Error('Keepa is not configured on the Hub server.');

  const url = new URL('https://api.keepa.com/product');
  url.search = new URLSearchParams({
    key: config.KEEPA_API_KEY,
    asin,
    domain: String(ukDomainId),
    stats: String(historyDays),
    days: String(historyDays),
    history: input.includeHistory ? '1' : '0',
    buybox: input.includeBuyBox ? '1' : '0',
    rating: input.includeRatings ? '1' : '0',
  }).toString();

  let response: Response;
  try {
    response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new Error('Could not reach the Keepa API.');
  }
  if (response.status === 429) throw new Error('Keepa has run out of tokens. Try again after the allowance refills.');
  if ([401, 402, 403].includes(response.status)) throw new Error('Keepa denied access. Check the configured API key and plan.');
  if (!response.ok) throw new Error(`Keepa request failed (HTTP ${response.status}).`);

  // Provider error bodies and URLs can contain credentials. Only return known fields.
  const parsed = envelopeSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new Error('Keepa returned an unexpected product response.');
  const { products, tokensLeft, tokensConsumed, refillIn, refillRate } = parsed.data;
  const product = products?.find(item => item.asin === asin);
  const usage = { tokensConsumed: tokensConsumed ?? null, tokensLeft: tokensLeft ?? null,
    refillInMs: refillIn ?? null, refillRatePerMinute: refillRate ?? null };
  if (!product || product.productType === 4) {
    return { asin, marketplace: 'Amazon UK', found: false as const, usage };
  }

  const stats = product.stats;
  const priceSummary = (index: number) => ({
    latest: pounds(stats?.current?.[index]),
    average30Days: pounds(stats?.avg30?.[index]),
    average90Days: pounds(stats?.avg90?.[index]),
    low90Days: pounds(stats?.minInInterval?.[index]?.[1]),
    high90Days: pounds(stats?.maxInInterval?.[index]?.[1]),
    outOfStockPercentage30Days: nonnegative(stats?.outOfStockPercentage30?.[index]),
    outOfStockPercentage90Days: nonnegative(stats?.outOfStockPercentage90?.[index]),
  });
  const buyBoxPrice = nonnegative(stats?.buyBoxPrice);
  const buyBoxShipping = nonnegative(stats?.buyBoxShipping);
  const rating = nonnegative(stats?.current?.[indexes.rating]);
  const rankCategoryId = product.salesRankReference;
  const category = product.categoryTree?.find(item => item.catId === rankCategoryId);

  return {
    asin,
    marketplace: 'Amazon UK',
    found: true as const,
    productType: product.productType,
    title: product.title ?? null,
    brand: product.brand ?? null,
    colour: product.color ?? null,
    parentAsin: product.parentAsin ?? null,
    parentTitle: product.parentTitle ?? null,
    variations: product.variations ?? null,
    trackingSince: keepaDate(product.trackingSince),
    lastProductUpdate: keepaDate(product.lastUpdate),
    pricesGbp: {
      amazon: priceSummary(indexes.amazonPrice),
      marketplaceNew: priceSummary(indexes.newPrice),
      buyBoxWithShipping: priceSummary(indexes.buyBoxPrice),
    },
    newOfferCount: nonnegative(stats?.current?.[indexes.newOfferCount]),
    buyBox: input.includeBuyBox ? {
      priceGbp: buyBoxPrice === null || buyBoxShipping === null ? null : pounds(buyBoxPrice + buyBoxShipping),
      sellerId: stats?.buyBoxSellerId && !stats.buyBoxSellerId.startsWith('-') ? stats.buyBoxSellerId : null,
      availability: stats?.buyBoxAvailabilityMessage ?? null,
      fulfilledByAmazon: stats?.buyBoxIsFBA ?? null,
      soldByAmazon: stats?.buyBoxIsAmazon ?? null,
      lastUpdate: keepaDate(stats?.lastBuyBoxUpdate),
    } : null,
    salesRank: {
      latest: nonnegative(stats?.current?.[indexes.salesRank]),
      average30Days: nonnegative(stats?.avg30?.[indexes.salesRank]),
      categoryId: rankCategoryId && Number.isSafeInteger(rankCategoryId) && rankCategoryId > 0 ? rankCategoryId : null,
      categoryName: category?.name ?? null,
    },
    ratings: input.includeRatings ? {
      stars: rating === null || rating > 50 ? null : rating / 10,
      ratingCount: nonnegative(stats?.current?.[indexes.ratingCount]),
      lastUpdate: keepaDate(product.lastRatingUpdate),
    } : null,
    boughtPastMonthMinimum: product.monthlySold && product.monthlySold > 0 ? product.monthlySold : null,
    boughtPastMonthLastUpdate: keepaDate(product.lastSoldUpdate),
    ...(input.includeHistory ? { priceChanges90Days: {
      amazon: decodePriceHistory(product.csv?.[indexes.amazonPrice]),
      marketplaceNew: decodePriceHistory(product.csv?.[indexes.newPrice]),
      buyBoxWithShipping: decodePriceHistory(product.csv?.[indexes.buyBoxPrice], true),
    } } : {}),
    usage,
  };
}
