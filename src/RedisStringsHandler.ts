import { commandOptions, createClient } from 'redis';
import { SyncedMap } from './SyncedMap';
import { DeduplicatedRequestHandler } from './DeduplicatedRequestHandler';
import { debug } from './utils/debug';
import { bufferReviver, bufferReplacer } from './utils/json';

export type CommandOptions = ReturnType<typeof commandOptions>;
export type Client = ReturnType<typeof createClient>;

export type CacheEntry = {
  value: unknown;
  lastModified: number;
  tags: string[];
};

export type CreateRedisStringsHandlerOptions = {
  /** Redis redis_url to use.
   * @default process.env.REDIS_URL? process.env.REDIS_URL : process.env.REDISHOST
          ? `redis://${process.env.REDISHOST}:${process.env.REDISPORT}`
          : 'redis://localhost:6379'
   */
  redis_url?:string;  
  /** Redis database number to use. Uses DB 0 for production, DB 1 otherwise
   * @default process.env.VERCEL_ENV === 'production' ? 0 : 1
   */
  database?: number;
  /** Prefix added to all Redis keys
   * @default process.env.VERCEL_URL || 'UNDEFINED_URL_'
   */
  keyPrefix?: string;
  /** Timeout in milliseconds for Redis operations
   * @default 5000
   */
  timeoutMs?: number;
  /** Number of entries to query in one batch during full sync of shared tags hash map
   * @default 250
   */
  revalidateTagQuerySize?: number;
  /** Key used to store shared tags hash map in Redis
   * @default '__sharedTags__'
   */
  sharedTagsKey?: string;
  /** Average interval in milliseconds between tag map full re-syncs
   * @default 3600000 (1 hour)
   */
  avgResyncIntervalMs?: number;
  /** Enable deduplication of Redis get requests via internal in-memory cache
   * @default true
   */
  redisGetDeduplication?: boolean;
  /** Time in milliseconds to cache Redis get results in memory. Set this to 0 to disable in-memory caching completely
   * @default 10000
   */
  inMemoryCachingTime?: number;
  /** Default stale age in seconds for cached items
   * @default 1209600 (14 days)
   */
  defaultStaleAge?: number;
  /** Function to calculate expire age (redis TTL value) from stale age
   * @default Production: staleAge * 2, Other: staleAge * 1.2
   */
  estimateExpireAge?: (staleAge: number) => number;
};

// Identifier prefix used by Next.js to mark automatically generated cache tags
// These tags are created internally by Next.js for route-based invalidation
const NEXT_CACHE_IMPLICIT_TAG_ID = '_N_T_';

// Redis key used to store a map of tags and their last revalidation timestamps
// This helps track when specific tags were last invalidated
const REVALIDATED_TAGS_KEY = '__revalidated_tags__';

export function getTimeoutRedisCommandOptions(
  timeoutMs: number,
): CommandOptions {
  return commandOptions({ signal: AbortSignal.timeout(timeoutMs) });
}

export default class RedisStringsHandler {
  private client: Client;
  private sharedTagsMap: SyncedMap<string[]>;
  private revalidatedTagsMap: SyncedMap<number>;
  private inMemoryDeduplicationCache: SyncedMap<
    Promise<ReturnType<Client['get']>>
  >;
  private redisGet: Client['get'];
  private redisDeduplicationHandler: DeduplicatedRequestHandler<
    Client['get'],
    string | Buffer | null
  >;
  private deduplicatedRedisGet: (key: string) => Client['get'];
  private timeoutMs: number;
  private keyPrefix: string;
  private redisGetDeduplication: boolean;
  private inMemoryCachingTime: number;
  private defaultStaleAge: number;
  private estimateExpireAge: (staleAge: number) => number;

  constructor({
    redis_url = process.env.REDIS_URL? process.env.REDIS_URL : process.env.REDISHOST
          ? `redis://${process.env.REDISHOST}:${process.env.REDISPORT}`
          : 'redis://localhost:6379',
    database = process.env.VERCEL_ENV === 'production' ? 0 : 1,
    keyPrefix = process.env.VERCEL_URL || 'UNDEFINED_URL_',
    sharedTagsKey = '__sharedTags__',
    timeoutMs = 5_000,
    revalidateTagQuerySize = 250,
    avgResyncIntervalMs = 60 * 60 * 1_000,
    redisGetDeduplication = true,
    inMemoryCachingTime = 10_000,
    defaultStaleAge = 60 * 60 * 24 * 14,
    estimateExpireAge = (staleAge) =>
      process.env.VERCEL_ENV === 'production' ? staleAge * 2 : staleAge * 1.2,
  }: CreateRedisStringsHandlerOptions) {
    this.keyPrefix = keyPrefix;
    this.timeoutMs = timeoutMs;
    this.redisGetDeduplication = redisGetDeduplication;
    this.inMemoryCachingTime = inMemoryCachingTime;
    this.defaultStaleAge = defaultStaleAge;
    this.estimateExpireAge = estimateExpireAge;

    try {
      this.client = createClient({
        ...(database !== 0 ? { database } : {}),
        url: redis_url,
      });

      this.client.on('error', (error) => {
        console.error('Redis client error', error);
      });

      this.client
        .connect()
        .then(() => {
          console.info('Redis client connected.');
        })
        .catch(() => {
          this.client.connect().catch((error) => {
            console.error('Failed to connect Redis client:', error);
            this.client.disconnect();
            throw error;
          });
        });
    } catch (error: unknown) {
      console.error('Failed to initialize Redis client');
      throw error;
    }

    const filterKeys = (key: string): boolean =>
      key !== REVALIDATED_TAGS_KEY && key !== sharedTagsKey;

    this.sharedTagsMap = new SyncedMap<string[]>({
      client: this.client,
      keyPrefix,
      redisKey: sharedTagsKey,
      database,
      timeoutMs,
      querySize: revalidateTagQuerySize,
      filterKeys,
      resyncIntervalMs:
        avgResyncIntervalMs -
        avgResyncIntervalMs / 10 +
        Math.random() * (avgResyncIntervalMs / 10),
    });

    this.revalidatedTagsMap = new SyncedMap<number>({
      client: this.client,
      keyPrefix,
      redisKey: REVALIDATED_TAGS_KEY,
      database,
      timeoutMs,
      querySize: revalidateTagQuerySize,
      filterKeys,
      resyncIntervalMs:
        avgResyncIntervalMs +
        avgResyncIntervalMs / 10 +
        Math.random() * (avgResyncIntervalMs / 10),
    });

    this.inMemoryDeduplicationCache = new SyncedMap({
      client: this.client,
      keyPrefix,
      redisKey: 'inMemoryDeduplicationCache',
      database,
      timeoutMs,
      querySize: revalidateTagQuerySize,
      filterKeys,
      customizedSync: {
        withoutRedisHashmap: true,
        withoutSetSync: true,
      },
    });

    const redisGet: Client['get'] = this.client.get.bind(this.client);
    this.redisDeduplicationHandler = new DeduplicatedRequestHandler(
      redisGet,
      inMemoryCachingTime,
      this.inMemoryDeduplicationCache,
    );
    this.redisGet = redisGet;
    this.deduplicatedRedisGet =
      this.redisDeduplicationHandler.deduplicatedFunction;
  }

  resetRequestCache(): void {}

  private async assertClientIsReady(): Promise<void> {
    await Promise.all([
      this.sharedTagsMap.waitUntilReady(),
      this.revalidatedTagsMap.waitUntilReady(),
    ]);
    if (!this.client.isReady) {
      throw new Error('Redis client is not ready yet or connection is lost.');
    }
  }

  public async get(
    key: string,
    ctx:
      | {
          kind: 'APP_ROUTE' | 'APP_PAGE';
          isRoutePPREnabled: boolean;
          isFallback: boolean;
        }
      | {
          kind: 'FETCH';
          revalidate: number;
          fetchUrl: string;
          fetchIdx: number;
          tags: string[];
          softTags: string[];
          isFallback: boolean;
        },
  ): Promise<CacheEntry | null> {
    if (
      ctx.kind !== 'APP_ROUTE' &&
      ctx.kind !== 'APP_PAGE' &&
      ctx.kind !== 'FETCH'
    ) {
      console.warn(
        'RedisStringsHandler.get() called with',
        key,
        ctx,
        ' this cache handler is only designed and tested for kind APP_ROUTE and APP_PAGE and not for kind ',
        (ctx as { kind: string })?.kind,
      );
    }

    debug('green', 'RedisStringsHandler.get() called with', key, ctx);
    await this.assertClientIsReady();

    const clientGet = this.redisGetDeduplication
      ? this.deduplicatedRedisGet(key)
      : this.redisGet;
    const serializedCacheEntry = await clientGet(
      getTimeoutRedisCommandOptions(this.timeoutMs),
      this.keyPrefix + key,
    );

    debug(
      'green',
      'RedisStringsHandler.get() finished with result (serializedCacheEntry)',
      serializedCacheEntry?.substring(0, 200),
    );

    if (!serializedCacheEntry) {
      return null;
    }

    const cacheEntry: CacheEntry | null = JSON.parse(
      serializedCacheEntry,
      bufferReviver,
    );

    debug(
      'green',
      'RedisStringsHandler.get() finished with result (cacheEntry)',
      JSON.stringify(cacheEntry).substring(0, 200),
    );

    if (!cacheEntry) {
      return null;
    }

    if (!cacheEntry?.tags) {
      console.warn(
        'RedisStringsHandler.get() called with',
        key,
        ctx,
        'cacheEntry is mall formed (missing tags)',
      );
    }
    if (!cacheEntry?.value) {
      console.warn(
        'RedisStringsHandler.get() called with',
        key,
        ctx,
        'cacheEntry is mall formed (missing value)',
      );
    }
    if (!cacheEntry?.lastModified) {
      console.warn(
        'RedisStringsHandler.get() called with',
        key,
        ctx,
        'cacheEntry is mall formed (missing lastModified)',
      );
    }

    if (ctx.kind === 'FETCH') {
      const combinedTags = new Set([
        ...(ctx?.softTags || []),
        ...(ctx?.tags || []),
      ]);

      if (combinedTags.size === 0) {
        return cacheEntry;
      }

      // INFO: implicit tags (revalidate of nested fetch in api route/page on revalidatePath call of the page/api route). See revalidateTag() for more information
      //
      // This code checks if any of the cache tags associated with this entry (normally the internal tag of the parent page/api route containing the fetch request)
      // have been revalidated since the entry was last modified. If any tag was revalidated more recently than the entry's
      // lastModified timestamp, then the cached content is considered stale (therefore return null) and should be removed.
      for (const tag of combinedTags) {
        // Get the last revalidation time for this tag from our revalidatedTagsMap
        const revalidationTime = this.revalidatedTagsMap.get(tag);

        // If we have a revalidation time for this tag and it's more recent than when
        // this cache entry was last modified, the entry is stale
        if (revalidationTime && revalidationTime > cacheEntry.lastModified) {
          const redisKey = this.keyPrefix + key;

          // We don't await this cleanup since it can happen asynchronously in the background.
          // The cache entry is already considered invalid at this point.
          this.client
            .unlink(getTimeoutRedisCommandOptions(this.timeoutMs), redisKey)
            .catch((err) => {
              // If the first unlink fails, only log the error
              // Never implement a retry here as the cache entry will be updated directly after this get request
              console.error(
                'Error occurred while unlinking stale data. Error was:',
                err,
              );
            })
            .finally(async () => {
              // Clean up our tag tracking maps after the Redis key is removed
              await this.sharedTagsMap.delete(key);
              await this.revalidatedTagsMap.delete(tag);
            });

          debug(
            'green',
            'RedisStringsHandler.get() found revalidation time for tag. Cache entry is stale and will be deleted and "null" will be returned.',
            tag,
            redisKey,
            revalidationTime,
            cacheEntry,
          );

          // Return null to indicate no valid cache entry was found
          return null;
        }
      }
    }

    return cacheEntry;
  }
  public async set(
    key: string,
    data:
      | {
          kind: 'APP_PAGE';
          status: number;
          headers: {
            'x-nextjs-stale-time': string; // timestamp in ms
            'x-next-cache-tags': string; // comma separated paths (tags)
          };
          html: string;
          rscData: Buffer;
          segmentData: unknown;
          postboned: unknown;
        }
      | {
          kind: 'APP_ROUTE';
          status: number;
          headers: {
            'cache-control'?: string;
            'x-nextjs-stale-time': string; // timestamp in ms
            'x-next-cache-tags': string; // comma separated paths (tags)
          };
          body: Buffer;
        }
      | {
          kind: 'FETCH';
          data: {
            headers: Record<string, string>;
            body: string; // base64 encoded
            status: number;
            url: string;
          };
          revalidate: number | false;
        },
    ctx: {
      isRoutePPREnabled: boolean;
      isFallback: boolean;
      tags?: string[];
      // Different versions of Next.js use different arguments for the same functionality
      revalidate?: number | false; // Version 15.0.3
      cacheControl?: { revalidate: 5; expire: undefined }; // Version 15.0.3
    },
  ) {
    if (
      data.kind !== 'APP_ROUTE' &&
      data.kind !== 'APP_PAGE' &&
      data.kind !== 'FETCH'
    ) {
      console.warn(
        'RedisStringsHandler.set() called with',
        key,
        ctx,
        data,
        ' this cache handler is only designed and tested for kind APP_ROUTE and APP_PAGE and not for kind ',
        (data as { kind: string })?.kind,
      );
    }

    await this.assertClientIsReady();

    if (data.kind === 'APP_PAGE' || data.kind === 'APP_ROUTE') {
      const tags = data.headers['x-next-cache-tags']?.split(',');
      ctx.tags = [...(ctx.tags || []), ...(tags || [])];
    }

    // Constructing and serializing the value for storing it in redis
    const cacheEntry: CacheEntry = {
      lastModified: Date.now(),
      tags: ctx?.tags || [],
      value: data,
    };
    const serializedCacheEntry = JSON.stringify(cacheEntry, bufferReplacer);

    // pre seed data into deduplicated get client. This will reduce redis load by not requesting
    // the same value from redis which was just set.
    if (this.redisGetDeduplication) {
      this.redisDeduplicationHandler.seedRequestReturn(
        key,
        serializedCacheEntry,
      );
    }

    // TODO: implement expiration based on cacheControl.expire argument, -> probably relevant for cacheLife and "use cache" etc.: https://nextjs.org/docs/app/api-reference/functions/cacheLife
    // Constructing the expire time for the cache entry
    const revalidate = ctx.revalidate || ctx.cacheControl?.revalidate;
    const expireAt =
      revalidate && Number.isSafeInteger(revalidate) && revalidate > 0
        ? this.estimateExpireAge(revalidate)
        : this.estimateExpireAge(this.defaultStaleAge);

    // Setting the cache entry in redis
    const options = getTimeoutRedisCommandOptions(this.timeoutMs);
    const setOperation: Promise<string | null> = this.client.set(
      options,
      this.keyPrefix + key,
      serializedCacheEntry,
      {
        EX: expireAt,
      },
    );

    debug(
      'blue',
      'RedisStringsHandler.set() will set the following serializedCacheEntry',
      this.keyPrefix,
      key,
      data,
      ctx,
      serializedCacheEntry?.substring(0, 200),
      expireAt,
    );

    // Setting the tags for the cache entry in the sharedTagsMap (locally stored hashmap synced via redis)
    let setTagsOperation: Promise<void> | undefined;
    if (ctx.tags && ctx.tags.length > 0) {
      const currentTags = this.sharedTagsMap.get(key);
      const currentIsSameAsNew =
        currentTags?.length === ctx.tags.length &&
        currentTags.every((v) => ctx.tags!.includes(v)) &&
        ctx.tags.every((v) => currentTags.includes(v));

      if (!currentIsSameAsNew) {
        setTagsOperation = this.sharedTagsMap.set(
          key,
          structuredClone(ctx.tags) as string[],
        );
      }
    }

    debug(
      'blue',
      'RedisStringsHandler.set() will set the following sharedTagsMap',
      key,
      ctx.tags as string[],
    );

    await Promise.all([setOperation, setTagsOperation]);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public async revalidateTag(tagOrTags: string | string[], ...rest: any[]) {
    debug(
      'red',
      'RedisStringsHandler.revalidateTag() called with',
      tagOrTags,
      rest,
    );
    const tags = new Set([tagOrTags || []].flat());
    await this.assertClientIsReady();

    // find all keys that are related to this tag
    const keysToDelete: Set<string> = new Set();

    for (const tag of tags) {
      // INFO: implicit tags (revalidate of nested fetch in api route/page on revalidatePath call of the page/api route)
      //
      // Invalidation logic for fetch requests that are related to a invalidated page.
      // revalidateTag is called for the page tag (_N_T_...) and the fetch request needs to be invalidated as well
      // unfortunately this is not possible since the revalidateTag is not called with any data that would allow us to find the cache entry of the fetch request
      // in case of a fetch request get method call, the get method of the cache handler is called with some information about the pages/routes the fetch request is inside
      // therefore we only mark the page/route as stale here (with help of the revalidatedTagsMap)
      // and delete the cache entry of the fetch request on the next request to the get function
      if (tag.startsWith(NEXT_CACHE_IMPLICIT_TAG_ID)) {
        const now = Date.now();
        debug(
          'red',
          'RedisStringsHandler.revalidateTag() set revalidation time for tag',
          tag,
          'to',
          now,
        );
        await this.revalidatedTagsMap.set(tag, now);
      }
    }

    // Scan the whole sharedTagsMap for keys that are dependent on any of the revalidated tags
    for (const [key, sharedTags] of this.sharedTagsMap.entries()) {
      if (sharedTags.some((tag) => tags.has(tag))) {
        keysToDelete.add(key);
      }
    }

    debug(
      'red',
      'RedisStringsHandler.revalidateTag() found',
      keysToDelete,
      'keys to delete',
    );

    // exit early if no keys are related to this tag
    if (keysToDelete.size === 0) {
      return;
    }

    // prepare deletion of all keys in redis that are related to this tag
    const redisKeys = Array.from(keysToDelete);
    const fullRedisKeys = redisKeys.map((key) => this.keyPrefix + key);
    const options = getTimeoutRedisCommandOptions(this.timeoutMs);
    const deleteKeysOperation = this.client.unlink(options, fullRedisKeys);

    // also delete entries from in-memory deduplication cache if they get revalidated
    if (this.redisGetDeduplication && this.inMemoryCachingTime > 0) {
      for (const key of keysToDelete) {
        this.inMemoryDeduplicationCache.delete(key);
      }
    }

    // prepare deletion of entries from shared tags map if they get revalidated so that the map will not grow indefinitely
    const deleteTagsOperation = this.sharedTagsMap.delete(redisKeys);

    // execute keys and tag maps deletion
    await Promise.all([deleteKeysOperation, deleteTagsOperation]);
    debug(
      'red',
      'RedisStringsHandler.revalidateTag() finished delete operations',
    );
  }
}
