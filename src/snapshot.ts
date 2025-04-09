import {
  getSubgraphUrl,
  queryAllPages,
  saveTokenHolders,
  calculateHolderBalance,
  TokenHolder,
  AccountTokenSnapshot
} from './utils';

// In-memory cache of token holders
const tokenHoldersCache: Record<string, { updatedAt: number, holders: TokenHolder[] }> = {};

// Take a snapshot of token holders for a specific token on a specific chain
export async function takeSnapshot(
  chainName: string,
  tokenAddress: string
): Promise<void> {
  console.log(`Taking snapshot for ${chainName}:${tokenAddress}`);
  
  try {
    const subgraphUrl = getSubgraphUrl(chainName);
    const currentTimestamp = Math.floor(Date.now() / 1000);
    
    // Fetch all token holders from the subgraph
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
        }`,
      // Extract items from response
      (response) => response.data.data.accountTokenSnapshots || [],
      // Return the item as is
      (item) => item,
      subgraphUrl
    );
    
    // Process snapshots and calculate balances
    const holders = snapshots
      .map(snapshot => calculateHolderBalance(snapshot, currentTimestamp))
      .sort((a, b) => {
        // Sort by balance descending
        const balanceA = BigInt(a.balance);
        const balanceB = BigInt(b.balance);
        if (balanceB > balanceA) return 1;
        if (balanceB < balanceA) return -1;
        return 0;
      });
    
    console.log(`\nFound ${holders.length} holders for ${chainName}:${tokenAddress}`);
    
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