// Compatibility exports; update checks and plugin downloads share the same byte limit implementation.
export {
  cancelResponse as cancelMarketResponse,
  readBoundedBody as readBoundedMarketBody,
} from '../util/bounded-response.ts';
export type {
  BodyReader as MarketBodyReader,
  ResponseBody as MarketResponseBody,
  BodyResponse as MarketBodyResponse,
} from '../util/bounded-response.ts';
