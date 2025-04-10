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
  claimableBalance: string;
  netFlowRate: string;
  lastUpdatedAt: number;
  hasPoolMembership: boolean;
}

export interface AccountTokenSnapshot {
  id: string;
  totalNetFlowRate: string;
  updatedAtTimestamp: string;
  balanceUntilUpdatedAt: string;
  account: {
    id: string;
    poolMemberships: {
      id: string;
      isConnected: boolean;
      pool: {
        id: string;
        perUnitFlowRate: string;
      };
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
  return createPublicClient({
    transport: http(rpcUrl)
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

  return items;
}

// Batch fetch balances via RPC
export async function batchFetchBalances(
  client: PublicClient,
  tokenAddress: string,
  accounts: string[],
  batchSize: number
): Promise<{ balances: Record<string, string>, stats: { totalTime: number, batchCount: number, maxBatchTime: number } }> {
  const balances: Record<string, string> = {};
  
  let totalTime = 0;
  let maxBatchTime = 0;
  let batchCount = 0;
  
  // Create an ERC20 contract instance
  const erc20Contract = getContract({
    address: tokenAddress as `0x${string}`,
    abi: ERC20_ABI,
    client
  });
  
  // Process in batches
  for (let i = 0; i < accounts.length; i += batchSize) {
    batchCount++;
    const batchAccounts = accounts.slice(i, i + batchSize);
    const batchStart = performance.now();
    
    // Make batch call to balanceOf for all accounts in this batch
    const batchResults = await Promise.all(
      batchAccounts.map(account => 
        erc20Contract.read.balanceOf([account as `0x${string}`])
          .then(balance => ({ account, balance: balance.toString() }))
          .catch(err => {
            console.error(`Error fetching balance for ${account}:`, err);
            return { account, balance: '0' };
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
    
    process.stdout.write("+");
  }
  
  return { 
    balances,
    stats: {
      totalTime,
      batchCount,
      maxBatchTime
    }
  };
}

// Calculate holder balance based on the formula from the spec
export function calculateHolderBalance(snapshot: AccountTokenSnapshot, currentTimestamp: number): TokenHolder {
  const address = snapshot.account.id;
  const balanceUntilUpdatedAt = snapshot.balanceUntilUpdatedAt || "0";
  const netFlowRate = snapshot.totalNetFlowRate || "0";
  const updatedAtTimestamp = parseInt(snapshot.updatedAtTimestamp || "0");
  
  // Calculate deltaT (time since last update)
  const deltaT = currentTimestamp - updatedAtTimestamp;
  
  // Start with balance at last update
  let balance = BigInt(balanceUntilUpdatedAt);
  let claimableBalance = BigInt(0);
  
  // Add flow rate contribution if non-zero
  if (netFlowRate !== "0") {
    balance += BigInt(netFlowRate) * BigInt(deltaT);
  }
  
  // Check if account has pool memberships
  const hasPoolMembership = snapshot.account.poolMemberships && 
                           snapshot.account.poolMemberships.length > 0;
  
  // Add GDA in if there are pool memberships
  if (hasPoolMembership) {
    for (const pms of snapshot.account.poolMemberships) {
      const perUnitFlowRate = pms.pool.perUnitFlowRate || "0";
      const units = pms.units || "0";
      
      if (pms.isConnected) {
        // Connected pool memberships affect current balance
        balance += BigInt(perUnitFlowRate) * BigInt(units) * BigInt(deltaT);
      } else {
        // Non-connected pool memberships contribute to claimable balance
        claimableBalance += BigInt(perUnitFlowRate) * BigInt(units) * BigInt(deltaT);
      }
    }
  }
  
  return {
    address,
    balance: balance.toString(),
    claimableBalance: claimableBalance.toString(),
    netFlowRate,
    lastUpdatedAt: updatedAtTimestamp,
    hasPoolMembership
  };
}

// Ensure data directory exists
export function ensureDataDirectory(): void {
  const dataDir = path.join(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir);
  }
}

// Save token holders to JSON file
export function saveTokenHolders(chainName: string, tokenAddress: string, holders: TokenHolder[]): void {
  ensureDataDirectory();
  const filePath = path.join(process.cwd(), 'data', `${chainName}_${tokenAddress.toLowerCase()}.json`);
  fs.writeFileSync(filePath, JSON.stringify({
    updatedAt: Date.now(),
    holders
  }, null, 2));
}

// Load token holders from JSON file (or return empty array if file doesn't exist)
export function loadTokenHolders(chainName: string, tokenAddress: string): { updatedAt: number, holders: TokenHolder[] } {
  ensureDataDirectory();
  const filePath = path.join(process.cwd(), 'data', `${chainName}_${tokenAddress.toLowerCase()}.json`);
  
  if (fs.existsSync(filePath)) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      console.error(`Error loading token holders for ${chainName}:${tokenAddress}:`, error);
    }
  }
  
  return { updatedAt: 0, holders: [] };
}

// Get network by name
export function getNetwork(networkName: string): any {
  return sfMeta.getNetworkByName(networkName);
} 