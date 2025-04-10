import fs from 'fs';
import path from 'path';
import axios from 'axios';
import sfMeta from '@superfluid-finance/metadata';
import { createPublicClient, http, type PublicClient, getContract } from 'viem';
import { parseAbi } from 'viem';

// ERC20 ABI for balanceOf call
const ERC20_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)'
]);

// Types
export interface TokenHolder {
  address: string;
  balance: string;
  netFlowRate: string;
}

// Types for snapshots
export interface TokenHolderSnapshot {
  updatedAt: number;
  blockNumber: number;
  holders: TokenHolder[];
}

export interface AccountTokenSnapshot {
  id: string;
  totalNetFlowRate: string;
  balanceUntilUpdatedAt: string;
  updatedAtTimestamp: string;
  updatedAtBlockNumber: string;
  account: {
    id: string;
    poolMemberships: {
      syncedPerUnitFlowRate: string;
      units: string;
    }[];
  };
}

// Get subgraph URL for a network
export function getSubgraphUrl(networkName: string): string {
  return `https://subgraph-endpoints.superfluid.dev/${networkName}/protocol-v1`;
}

// Get RPC URL for a network
export function getRpcUrl(networkName: string): string {
  return `https://${networkName}.rpc.x.superfluid.dev`;
}

// Create Viem Public Client for a network
export function createRpcClient(networkName: string): PublicClient {
  const rpcUrl = getRpcUrl(networkName);
  
  // Create client with built-in retry logic
  return createPublicClient({
    transport: http(rpcUrl, { 
      retryCount: 3,       // Viem will retry failed requests up to 3 times
      retryDelay: 1000     // Initial delay before first retry (ms)
    }),
    batch: {
      multicall: true
    }
  });
}

// Query Superfluid subgraph with pagination - generic helper
export async function queryAllPages<T>(
  queryFn: (lastId: string) => string,
  toItems: (response: any) => any[],
  itemFn: (item: any) => T,
  graphqlEndpoint: string
): Promise<T[]> {
  let lastId = "";
  const items: T[] = [];
  const pageSize = 1000;

  while (true) {
    const response = await axios.post(graphqlEndpoint, {
      query: queryFn(lastId)
    });

    if (response.data.errors) {
      console.error('GraphQL errors:', response.data.errors);
      break;
    }

    const newItems = toItems(response);
    items.push(...newItems.map(itemFn));

    if (newItems.length < pageSize) {
      break;
    } else {
      lastId = newItems[newItems.length - 1].id;
    }
    process.stdout.write(".");
  }
  console.log("");

  return items;
}

// Batch fetch balances via RPC
export async function batchFetchBalances(
  client: PublicClient,
  tokenAddress: string,
  accounts: string[],
  batchSize: number
): Promise<{ 
  balances: Record<string, string>, 
  blockNumber: number,
  stats: { totalTime: number, batchCount: number, maxBatchTime: number }
}> {
  const balances: Record<string, string> = {};
  
  let totalTime = 0;
  let maxBatchTime = 0;
  let batchCount = 0;
  let blockNumber = 0;
  
  // Create an ERC20 contract instance
  const erc20Contract = getContract({
    address: tokenAddress as `0x${string}`,
    abi: ERC20_ABI,
    client
  });
  
  // Get current block number first to ensure atomicity
  try {
    blockNumber = Number(await client.getBlockNumber());
  } catch (error) {
    console.error('Failed to get block number:', error);
    throw new Error('Could not get current block number');
  }
  
  // Process in batches
  const totalBatches = Math.ceil(accounts.length / batchSize);
  process.stdout.write(`Fetching balances at block ${blockNumber} - ${totalBatches} batches of ${batchSize}`);
  
  for (let i = 0; i < accounts.length; i += batchSize) {
    batchCount++;
    const batchAccounts = accounts.slice(i, i + batchSize);
    const batchStart = performance.now();
    
    try {
      // Make batch call to balanceOf for all accounts in this batch
      const batchResults = await Promise.all(
        batchAccounts.map(account => 
          erc20Contract.read.balanceOf(
            [account as `0x${string}`], 
            { blockNumber: BigInt(blockNumber) }
          )
          .then(balance => ({ account, balance: balance.toString() }))
          .catch(err => {
            console.error(`Error fetching balance for ${account}:`, err);
            throw err; // Let viem's retry handle this
          })
        )
      );
      
      // Calculate batch time
      const batchTime = performance.now() - batchStart;
      totalTime += batchTime;
      maxBatchTime = Math.max(maxBatchTime, batchTime);
      
      // Add results to balances map
      batchResults.forEach(result => {
        balances[result.account] = result.balance;
      });
      
      process.stdout.write(".");
    } catch (error) {
      console.error(`Failed to process batch ${batchCount}/${totalBatches}`);
      process.stdout.write("x");
    }
  }
  
  console.log("");
  
  return { 
    balances,
    blockNumber,
    stats: {
      totalTime,
      batchCount,
      maxBatchTime
    }
  };
}

// Calculate net flow rate from an account token snapshot
export function getNetFlowRate(snapshot: AccountTokenSnapshot): string {
  let netFlowRate = BigInt(snapshot.totalNetFlowRate);
  for (const poolMembership of snapshot.account.poolMemberships) {
    netFlowRate += BigInt(poolMembership.syncedPerUnitFlowRate) * BigInt(poolMembership.units);
  }
  return netFlowRate.toString();
}

// Ensure data directory exists
export function ensureDataDirectory(): void {
  const dataDir = path.join(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir);
  }
}

// Save token holders to JSON file
export function saveTokenHolders(chainName: string, tokenAddress: string, holders: TokenHolder[], blockNumber: number): void {
  ensureDataDirectory();
  const filePath = path.join(process.cwd(), 'data', `${chainName}_${tokenAddress.toLowerCase()}.json`);
  fs.writeFileSync(filePath, JSON.stringify({
    updatedAt: Date.now(),
    blockNumber,
    holders
  }, null, 2));
}

// Load token holders from JSON file (or return empty array if file doesn't exist)
export function loadTokenHolders(chainName: string, tokenAddress: string): TokenHolderSnapshot {
  ensureDataDirectory();
  const filePath = path.join(process.cwd(), 'data', `${chainName}_${tokenAddress.toLowerCase()}.json`);
  
  if (fs.existsSync(filePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      // Handle both old and new format
      return {
        updatedAt: data.updatedAt || 0,
        blockNumber: data.blockNumber || 0,
        holders: data.holders || []
      };
    } catch (error) {
      console.error(`Error loading token holders for ${chainName}:${tokenAddress}:`, error);
    }
  }
  
  return { updatedAt: 0, blockNumber: 0, holders: [] };
}

// Get network by name
export function getNetwork(networkName: string): any {
  return sfMeta.getNetworkByName(networkName);
} 