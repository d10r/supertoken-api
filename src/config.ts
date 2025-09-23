import sfMeta from '@superfluid-finance/metadata';
import { SuperTokenList } from '@superfluid-finance/tokenlist';

// Cache for token list
let cachedTokenList: SuperTokenList | null = null;
let lastFetchTime: number = 0;
const CACHE_DURATION_MS = 3600 * 1000; // 1 hour

// Function to fetch token list from GitHub
async function fetchTokenList(): Promise<SuperTokenList> {
  const now = Date.now();
  
  // Return cached version if still fresh
  if (cachedTokenList && (now - lastFetchTime) < CACHE_DURATION_MS) {
    return cachedTokenList;
  }
  
  try {
    const response = await fetch('https://tokenlist.superfluid.org/superfluid.extended.tokenlist.json');
    
    if (!response.ok) {
      throw new Error(`Failed to fetch token list: ${response.status} ${response.statusText}`);
    }
    
    const tokenList: SuperTokenList = await response.json();
    console.log(`Fetched list of ${tokenList.tokens.length} tokens`);
    
    // Validate the response structure
    if (!tokenList.tokens || !Array.isArray(tokenList.tokens)) {
      throw new Error('Invalid token list format: missing or invalid tokens array');
    }
    
    // Cache the result
    cachedTokenList = tokenList;
    lastFetchTime = now;
    
    return tokenList;
  } catch (error) {
    console.error('Error fetching token list:', error);
    
    // If we have a cached version, use it even if stale
    if (cachedTokenList) {
      console.warn('Using stale cached token list due to fetch error');
      return cachedTokenList;
    }
    
    // If no cache available, throw the error
    throw new Error(`Failed to fetch token list: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

type ChainConfig = {
  tokens: Array<{ address: string; symbol: string }>;
  // Add more chain-specific config here in the future if needed
};

export let supportedChainIds: number[] = [];
export let config: Record<number, ChainConfig> = {};

export async function initializeConfig(chainNames: string[] = [], skipTokensConfig: string = '') {
  // Parse skip tokens
  const skipTokens = new Set<string>();
  if (skipTokensConfig) {
    skipTokensConfig.split(',').forEach(entry => {
      const [chainId, symbol] = entry.trim().split(':');
      if (chainId && symbol) {
        skipTokens.add(`${chainId}:${symbol}`);
      }
    });
  }

  // Get supported chain IDs
  let chainIds: number[];
  if (chainNames.length === 0) {
    // Default to all chains from metadata if no chains specified
    chainIds = sfMeta.networks
      .map(network => network.chainId)
      .filter(Boolean) as number[];
  } else {
    chainIds = chainNames
      .map(name => {
        const network = sfMeta.getNetworkByName(name);
        return network ? network.chainId : null;
      })
      .filter(Boolean) as number[];
  }

  // Fetch token list from GitHub
  const tokenList = await fetchTokenList();

  // Filter SuperTokens
  const superTokens = tokenList.tokens.filter(token => 
    token.tags?.includes('supertoken') && 
    chainIds.includes(token.chainId) &&
    !skipTokens.has(`${token.chainId}:${token.symbol}`)
  );

  // Build config
  config = {};
  chainIds.forEach(chainId => {
    config[chainId] = { tokens: [] };
  });

  superTokens.forEach(token => {
    if (config[token.chainId]) {
      config[token.chainId].tokens.push({
        address: token.address.toLowerCase(),
        symbol: token.symbol
      });
    }
  });

  // Set supportedChainIds
  supportedChainIds = Object.keys(config).map(Number);
}
