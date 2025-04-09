import fs from 'fs';
import path from 'path';
import axios from 'axios';
import sfMeta from '@superfluid-finance/metadata';

// Types
export interface TokenHolder {
  address: string;
  balance: string;
  claimableBalance: string;
  netFlowRate: string;
  lastUpdatedAt: number;
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
  
  // Add GDA in if there are pool memberships
  if (snapshot.account.poolMemberships && snapshot.account.poolMemberships.length > 0) {
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
    lastUpdatedAt: updatedAtTimestamp
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