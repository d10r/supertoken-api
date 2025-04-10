import {
  getSubgraphUrl,
  queryAllPages,
  saveTokenHolders,
  getNetFlowRate,
  createRpcClient,
  batchFetchBalances,
  TokenHolder,
  TokenHolderSnapshot,
  AccountTokenSnapshot
} from './utils';

// In-memory cache of token holders
const tokenHoldersCache: Record<string, TokenHolderSnapshot> = {};

// Take a snapshot of token holders for a specific token on a specific chain
export async function takeSnapshot(
  chainName: string,
  tokenAddress: string,
  rpcBatchSize: number = 100
): Promise<void> {
  console.log(`Taking snapshot for ${chainName}:${tokenAddress}`);
  
  try {
    const subgraphUrl = getSubgraphUrl(chainName);
    
    // Fetch all token holders from the subgraph - we still need this for netFlowRate info
    console.log(`Querying subgraph for account token snapshots...`);
    const snapshots = await queryAllPages<AccountTokenSnapshot>(
      // Query function with pagination
      (lastId) => `{
        accountTokenSnapshots(
          first: 1000,
          where: {token: "${tokenAddress.toLowerCase()}", id_gt: "${lastId}"},
          orderBy: id,
          orderDirection: asc
        ) {
          totalNetFlowRate
          account {
            id
            poolMemberships(first: 256 where: {isConnected: true pool_: {token: "${tokenAddress.toLowerCase()}"}}) {
              units
              syncedPerUnitFlowRate
            }
          }
        }
      }`,
      // Extract items from response
      (response) => response.data.data.accountTokenSnapshots || [],
      // Return the item as is
      (item) => item,
      subgraphUrl
    );
    
    console.log(`\nFound ${snapshots.length} account token snapshots`);
    
    // Create flow rate map - we only need flow rates from the subgraph data
    const flowRateMap: Record<string, string> = {};
    snapshots.forEach(snapshot => {
      flowRateMap[snapshot.account.id] = getNetFlowRate(snapshot);
    });
    
    // Count accounts with and without pool memberships
    const accountsWithPools = snapshots.filter(s => 
      s.account.poolMemberships && s.account.poolMemberships.length > 0
    ).length;
    const accountsWithoutPools = snapshots.length - accountsWithPools;
    
    console.log(`Accounts with pool memberships: ${accountsWithPools}`);
    console.log(`Accounts without pool memberships: ${accountsWithoutPools}`);
    
    // Create RPC client for this network
    console.log(`Creating RPC client for ${chainName}...`);
    const rpcClient = createRpcClient(chainName);
    
    // Get all unique account addresses
    const allAccounts = snapshots.map(s => s.account.id);
    
    // Fetch real balances via RPC - this is now the only source of balance data
    console.log(`Fetching real balances via RPC in batches of ${rpcBatchSize}...`);
    try {
      const { balances: realBalances, blockNumber, stats } = await batchFetchBalances(
        rpcClient,
        tokenAddress,
        allAccounts,
        rpcBatchSize
      );
      
      // Log RPC batch stats
      console.log(`\nRPC Batch Statistics:`);
      console.log(`Block number: ${blockNumber}`);
      console.log(`Total batches: ${stats.batchCount}`);
      console.log(`Total time: ${stats.totalTime.toFixed(2)}ms`);
      console.log(`Average time per batch: ${(stats.totalTime / stats.batchCount).toFixed(2)}ms`);
      console.log(`Max batch time: ${stats.maxBatchTime.toFixed(2)}ms`);
      
      // Create holder objects with balances from RPC and flow rates from the subgraph
      const holders: TokenHolder[] = allAccounts.map(address => {
        const balance = realBalances[address] || "0";
        return {
          address,
          balance,
          netFlowRate: flowRateMap[address] || "0"
        };
      });
      
      // Remove accounts with zero balance
      const nonZeroHolders = holders.filter(h => h.balance !== "0");
      console.log(`Removed ${holders.length - nonZeroHolders.length} accounts with zero balance`);
      
      // Sort holders by balance descending
      nonZeroHolders.sort((a, b) => {
        const balanceA = BigInt(a.balance);
        const balanceB = BigInt(b.balance);
        if (balanceB > balanceA) return 1;
        if (balanceB < balanceA) return -1;
        return 0;
      });
      
      console.log(`\nFinished processing ${nonZeroHolders.length} holders for ${chainName}:${tokenAddress}`);
      
      // Create snapshot data
      const snapshot: TokenHolderSnapshot = {
        updatedAt: Date.now(),
        blockNumber,
        holders: nonZeroHolders
      };
      
      // Update cache
      const key = `${chainName}:${tokenAddress.toLowerCase()}`;
      tokenHoldersCache[key] = snapshot;
      
      // Save to file
      saveTokenHolders(chainName, tokenAddress, nonZeroHolders, blockNumber);
    } catch (error) {
      console.error(`Error fetching balances for ${chainName}:${tokenAddress}:`, error);
      console.error(`Snapshot failed. Will try again on next update.`);
      // Note: We're not crashing the application here, just logging the error
    }
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
  minBalanceWei: string = '1'
): TokenHolderSnapshot {
  const key = `${chainName}:${tokenAddress.toLowerCase()}`;
  const cached = tokenHoldersCache[key];
  
  if (cached) {
    const filteredHolders = cached.holders
      .filter(holder => BigInt(holder.balance) >= BigInt(minBalanceWei))
      .slice(offset, offset + limit);
      
    return {
      updatedAt: cached.updatedAt,
      blockNumber: cached.blockNumber,
      holders: filteredHolders
    };
  }
  
  return {
    updatedAt: 0,
    blockNumber: 0,
    holders: []
  };
} 