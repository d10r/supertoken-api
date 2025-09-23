import client from 'prom-client';

// Create a Registry for our metrics
export const register = new client.Registry();

// HTTP metrics (we'll create these manually since we disabled the middleware's /metrics endpoint)
export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Counter for total requests received',
  labelNames: ['status_code'],
  registers: [register]
});

export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: [],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register]
});

export const httpResponseSize = new client.Histogram({
  name: 'http_response_size_bytes',
  help: 'Size of HTTP response in bytes',
  labelNames: [],
  buckets: [100, 1000, 10000, 100000, 1000000, 10000000],
  registers: [register]
});

// Subgraph metrics
export const subgraphQueries = new client.Counter({
  name: 'subgraph_queries_total',
  help: 'Total number of subgraph queries',
  labelNames: ['chain_id', 'status'],
  registers: [register]
});

export const subgraphDuration = new client.Histogram({
  name: 'subgraph_query_duration_seconds',
  help: 'Subgraph query duration in seconds',
  labelNames: ['chain_id'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register]
});

// RPC metrics
export const rpcCalls = new client.Counter({
  name: 'rpc_calls_total',
  help: 'Total number of RPC calls',
  labelNames: ['chain_id', 'status'],
  registers: [register]
});

export const rpcDuration = new client.Histogram({
  name: 'rpc_call_duration_seconds',
  help: 'RPC call duration in seconds',
  labelNames: ['chain_id'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register]
});

// Data freshness metrics
export const dataLastUpdated = new client.Gauge({
  name: 'data_last_updated_timestamp',
  help: 'Timestamp when token data was last updated (Unix timestamp in seconds)',
  labelNames: ['chain_id', 'token_symbol'],
  registers: [register]
});

// Helper functions for recording metrics
export function recordSubgraphQuery(chainId: number, duration: number, success: boolean) {
  const status = success ? 'success' : 'failure';
  subgraphQueries.inc({ chain_id: chainId.toString(), status });
  subgraphDuration.observe({ chain_id: chainId.toString() }, duration);
}

export function recordRpcCall(chainId: number, duration: number, success: boolean) {
  const status = success ? 'success' : 'failure';
  rpcCalls.inc({ chain_id: chainId.toString(), status });
  rpcDuration.observe({ chain_id: chainId.toString() }, duration);
}

export function updateDataTimestamp(chainId: number, tokenSymbol: string, timestampSeconds: number) {
  dataLastUpdated.set({ chain_id: chainId.toString(), token_symbol: tokenSymbol }, timestampSeconds);
}

// Export metrics endpoint
export async function getMetrics(): Promise<string> {
  return await register.metrics();
}
