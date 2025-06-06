import RedisStringsHandler, {
  CreateRedisStringsHandlerOptions,
} from './RedisStringsHandler';
import { debugVerbose } from './utils/debug';

let cachedHandler: RedisStringsHandler;

export default class CachedHandler {
  constructor(options: CreateRedisStringsHandlerOptions) {
    if (!cachedHandler) {
      console.log('created cached handler');
      cachedHandler = new RedisStringsHandler(options);
    }
  }
  get(
    ...args: Parameters<RedisStringsHandler['get']>
  ): ReturnType<RedisStringsHandler['get']> {
    debugVerbose('CachedHandler.get called with', args);
    return cachedHandler.get(...args);
  }
  set(
    ...args: Parameters<RedisStringsHandler['set']>
  ): ReturnType<RedisStringsHandler['set']> {
    debugVerbose('CachedHandler.set called with', args);
    return cachedHandler.set(...args);
  }
  revalidateTag(
    ...args: Parameters<RedisStringsHandler['revalidateTag']>
  ): ReturnType<RedisStringsHandler['revalidateTag']> {
    debugVerbose('CachedHandler.revalidateTag called with', args);
    return cachedHandler.revalidateTag(...args);
  }
  resetRequestCache(
    ...args: Parameters<RedisStringsHandler['resetRequestCache']>
  ): ReturnType<RedisStringsHandler['resetRequestCache']> {
    // debug("CachedHandler.resetRequestCache called with", args);
    return cachedHandler.resetRequestCache(...args);
  }
}
