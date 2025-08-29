import sfMeta from '@superfluid-finance/metadata';
import { extendedSuperTokenList } from '@superfluid-finance/tokenlist';

type ChainConfig = {
  tokens: Array<{ address: string; symbol: string }>;
  // Add more chain-specific config here in the future if needed
};

export let supportedChainIds: number[] = [];
export let config: Record<number, ChainConfig> = {};

export function initializeConfig(chainNames: string[] = [], skipTokensConfig: string = '') {
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

  // Filter SuperTokens
  const superTokens = extendedSuperTokenList.tokens.filter(token => 
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
