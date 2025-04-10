import {
  getSubgraphUrl,
  queryAllPages,
  saveTokenHolders,
  calculateHolderBalance,
  createRpcClient,
  batchFetchBalances,
  TokenHolder,
  AccountTokenSnapshot
} from './utils';

// In-memory cache of token holders
const tokenHoldersCache: Record<string, { updatedAt: number, holders: TokenHolder[] }> = {};

// Take a snapshot of token holders for a specific token on a specific chain
export async function takeSnapshot(
  chainName: string,
  tokenAddress: string,
  rpcBatchSize: number = 100
): Promise<void> {
  console.log(`Taking snapshot for ${chainName}:${tokenAddress}`);
  
  try {
    const subgraphUrl = getSubgraphUrl(chainName);
    const currentTimestamp = Math.floor(Date.now() / 1000);
    
    // Fetch all token holders from the subgraph
    console.log(`Querying subgraph for account token snapshots...`);
    const snapshots = await queryAllPages<AccountTokenSnapshot>(
      // Query function with pagination
      (lastId) => {
        const whereClause = lastId 
          ? `{token: "${tokenAddress.toLowerCase()}", id_gt: "${lastId}"}`
          : `{token: "${tokenAddress.toLowerCase()}"}`;
          
        return `{
          accountTokenSnapshots(
            first: 1000,
            where: ${whereClause},
            orderBy: id,
            orderDirection: asc
          ) {
            id
            totalNetFlowRate
            account {
              id
              poolMemberships {
                id
                isConnected
                pool {
                  id
                  perUnitFlowRate
                }
                units
              }
            }
            updatedAtTimestamp
            balanceUntilUpdatedAt
          }
        }`;
      },
      // Extract items from response
      (response) => response.data.data.accountTokenSnapshots || [],
      // Return the item as is
      (item) => item,
      subgraphUrl
    );
    
    console.log(`\nFound ${snapshots.length} account token snapshots`);
    
    // Calculate balances from subgraph data
    console.log(`Calculating balances from subgraph data...`);
    const calculatedHolders = snapshots.map(snapshot => 
      calculateHolderBalance(snapshot, currentTimestamp)
    );
    
    // Count accounts with and without pool memberships
    const accountsWithPools = calculatedHolders.filter(h => h.hasPoolMembership);
    const accountsWithoutPools = calculatedHolders.filter(h => !h.hasPoolMembership);
    
    console.log(`Accounts with pool memberships: ${accountsWithPools.length}`);
    console.log(`Accounts without pool memberships: ${accountsWithoutPools.length}`);
    
    // Create RPC client for this network
    console.log(`Creating RPC client for ${chainName}...`);
    const rpcClient = createRpcClient(chainName);
    
    // Get all unique account addresses
    const allAccounts = calculatedHolders.map(h => h.address);
    
    // Fetch real balances via RPC
    console.log(`Fetching real balances via RPC in batches of ${rpcBatchSize}...`);
    const { balances: realBalances, stats } = await batchFetchBalances(
      rpcClient,
      tokenAddress,
      allAccounts,
      rpcBatchSize
    );
    
    // Log RPC batch stats
    console.log(`\nRPC Batch Statistics:`);
    console.log(`Total batches: ${stats.batchCount}`);
    console.log(`Total time: ${stats.totalTime.toFixed(2)}ms`);
    console.log(`Average time per batch: ${(stats.totalTime / stats.batchCount).toFixed(2)}ms`);
    console.log(`Max batch time: ${stats.maxBatchTime.toFixed(2)}ms`);
    
    // Update holders with real balances from RPC
    const holders = calculatedHolders.map(holder => ({
      ...holder,
      balance: realBalances[holder.address] || holder.balance
    }));
    
    // Sort holders by balance descending
    holders.sort((a, b) => {
      const balanceA = BigInt(a.balance);
      const balanceB = BigInt(b.balance);
      if (balanceB > balanceA) return 1;
      if (balanceB < balanceA) return -1;
      return 0;
    });
    
    console.log(`\nFinished processing ${holders.length} holders for ${chainName}:${tokenAddress}`);
    
    // Update cache
    const key = `${chainName}:${tokenAddress.toLowerCase()}`;
    tokenHoldersCache[key] = {
      updatedAt: Date.now(),
      holders
    };
    
    // Save to file
    saveTokenHolders(chainName, tokenAddress, holders);
  } catch (error) {
    console.error(`Error taking snapshot for ${chainName}:${tokenAddress}:`, error);
  }
}

// Get token holders from cache or file (used by API)
export function getTokenHolders(
  chainName: string,
  tokenAddress: string,
  limit: number = 100,
  offset: number = 0,
  minBalanceWei: string = '0'
): { updatedAt: number, holders: TokenHolder[] } {
  const key = `${chainName}:${tokenAddress.toLowerCase()}`;
  const cached = tokenHoldersCache[key];
  
  if (cached) {
    const filteredHolders = cached.holders
      .filter(holder => BigInt(holder.balance) >= BigInt(minBalanceWei))
      .slice(offset, offset + limit);
      
    return {
      updatedAt: cached.updatedAt,
      holders: filteredHolders
    };
  }
  
  return {
    updatedAt: 0,
    holders: []
  };
} 