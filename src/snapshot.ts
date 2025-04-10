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
  console.log(`--- Taking snapshot: ${chainName}: ${tokenAddress} ---`);
  
  try {
    const subgraphUrl = getSubgraphUrl(chainName);
    
    // Fetch all token holders from the subgraph - we still need this for netFlowRate info
    process.stdout.write(`Querying subgraph for account token snapshots`);
    const snapshots = await queryAllPages<AccountTokenSnapshot>(
      // Query function with pagination
      (lastId) => `{
        accountTokenSnapshots(
          first: 1000,
          where: {token: "${tokenAddress.toLowerCase()}", id_gt: "${lastId}"},
          orderBy: id,
          orderDirection: asc
        ) {
          id
          totalNetFlowRate
          balanceUntilUpdatedAt
          updatedAtBlockNumber
          account {
            id
            poolMemberships(first: 256 where: {isConnected: true pool_: {token: "${tokenAddress.toLowerCase()}"}}) {
              units
              pool {
                perUnitFlowRate
              }
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
    
    console.log(`Found ${snapshots.length} account token snapshots`);
    
    // Create flow rate map - we only need flow rates from the subgraph data
    const flowRateMap: Record<string, string> = {};
    const accountsWithNonZeroFlowRate = snapshots.filter(snapshot => 
      snapshot.totalNetFlowRate !== "0"
    ).length;
    
    snapshots.forEach(snapshot => {
      flowRateMap[snapshot.account.id] = getNetFlowRate(snapshot);
    });
    
    // Count accounts with and without pool memberships
    const accountsWithPools = snapshots.filter(s => 
      s.account.poolMemberships && s.account.poolMemberships.length > 0
    ).length;
    const accountsWithoutPools = snapshots.length - accountsWithPools;
    
    console.log(`Accounts: ${snapshots.length} total (${accountsWithPools} with pools, ${accountsWithoutPools} without, ${accountsWithNonZeroFlowRate} with non-zero flow rate)`);
    
    const rpcClient = createRpcClient(chainName);
    
    // Determine which accounts need RPC balance verification and which can use subgraph data directly
    const accountsNeedingRpc: string[] = [];
    const subgraphBalances: Record<string, string> = {};
    
    // First, get current block number to compare with updatedAtBlockNumber
    const currentBlockNumber = Number(await rpcClient.getBlockNumber());
    
    // Determine which accounts need RPC verification and which can use subgraph data
    snapshots.forEach(snapshot => {
      const account = snapshot.account.id;
      const snapshotBlockNumber = Number(snapshot.updatedAtBlockNumber);
      const hasNoFlowRate = snapshot.totalNetFlowRate === "0";
      const hasNoPools = !snapshot.account.poolMemberships || snapshot.account.poolMemberships.length === 0;
      
      // If the snapshot is current or older, has no flow rate, and no pool memberships, use subgraph data
      if (snapshotBlockNumber <= currentBlockNumber && hasNoFlowRate && hasNoPools) {
        subgraphBalances[account] = snapshot.balanceUntilUpdatedAt;
      } else {
        accountsNeedingRpc.push(account);
      }
    });
    
    console.log(`Using subgraph data for ${Object.keys(subgraphBalances).length} accounts, fetching ${accountsNeedingRpc.length} via RPC`);
    
    // Only fetch balances via RPC for accounts that need it
    let rpcBalances: Record<string, string> = {};
    let blockNumber = currentBlockNumber;
    let stats = { totalTime: 0, batchCount: 0, maxBatchTime: 0 };
    
    // If we need RPC data, fetch it - abort on failure
    if (accountsNeedingRpc.length > 0) {
      try {
        const rpcResult = await batchFetchBalances(
          rpcClient,
          tokenAddress,
          accountsNeedingRpc,
          rpcBatchSize
        );
        
        rpcBalances = rpcResult.balances;
        blockNumber = rpcResult.blockNumber;
        stats = rpcResult.stats;
        
        // Log RPC batch stats
        console.log(`Stats: block=${blockNumber}, batches=${stats.batchCount}, time=${stats.totalTime.toFixed(0)}ms`);
      } catch (error) {
        console.error(`Error fetching balances: ${error instanceof Error ? error.message : String(error)}`);
        console.error(`Snapshot failed. Will keep previous data until next update.`);
        // Abort the update for this token
        return;
      }
    } else {
      console.log(`No RPC queries needed for this token`);
    }
    
    // Combine balances from both sources
    const combinedBalances: Record<string, string> = {
      ...subgraphBalances,
      ...rpcBalances
    };
    
    // Create holder objects with balances from both sources and flow rates from the subgraph
    const holders: TokenHolder[] = snapshots.map(snapshot => {
      const address = snapshot.account.id;
      const balance = combinedBalances[address] || "0";
      return {
        address,
        balance,
        netFlowRate: flowRateMap[address] || "0"
      };
    });
    
    // Remove accounts with zero balance
    const nonZeroHolders = holders.filter(h => h.balance !== "0");
    console.log(`Results: ${nonZeroHolders.length} holders with non-zero balance (${holders.length - nonZeroHolders.length} removed)`);
    
    // Sort holders by balance descending
    nonZeroHolders.sort((a, b) => {
      const balanceA = BigInt(a.balance);
      const balanceB = BigInt(b.balance);
      if (balanceB > balanceA) return 1;
      if (balanceB < balanceA) return -1;
      return 0;
    });
    
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
    console.log(`Snapshot completed and saved.`);
  } catch (error) {
    console.error(`Error taking snapshot: ${error instanceof Error ? error.message : String(error)}`);
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

// Update the token holders cache with new data
export function updateTokenHoldersCache(
  chainName: string,
  tokenAddress: string,
  data: TokenHolderSnapshot
): void {
  const key = `${chainName}:${tokenAddress.toLowerCase()}`;
  tokenHoldersCache[key] = data;
  // Only log detailed cache update if DEBUG_LOGS env var is set
  if (process.env.DEBUG_LOGS) {
    console.log(`Updated cache: ${chainName}:${tokenAddress}`);
  }
} 