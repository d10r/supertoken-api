import express from 'express';
import sfMeta from '@superfluid-finance/metadata';
import { getTokenHolders } from './snapshot';
import { getNetwork } from './utils';
import { extendedSuperTokenList } from '@superfluid-finance/tokenlist';
import { isAddress } from 'viem';

// Create Express router
export const router = express.Router();

// Supported chain IDs from Superfluid metadata
const supportedChainIds = sfMeta.networks
  .map(network => network.chainId)
  .filter(Boolean) as number[];

// Filter tokens from tokenlist that have the "supertoken" tag and are on supported chains
const superTokens = extendedSuperTokenList.tokens.filter(token => 
  token.tags?.includes('supertoken') && 
  supportedChainIds.includes(token.chainId)
);

// Group tokens by chainId
const tokenConfig: Record<number, Array<{ address: string, symbol: string }>> = {};

// Initialize empty token lists for all supported chains
supportedChainIds.forEach(chainId => {
  tokenConfig[chainId] = [];
});

// Populate token config with tokens from the tokenlist
superTokens.forEach(token => {
  if (tokenConfig[token.chainId]) {
    tokenConfig[token.chainId].push({
      address: token.address.toLowerCase(),
      symbol: token.symbol
    });
  }
});

// Middleware to validate token parameter (address or symbol)
function validateToken(req: express.Request, res: express.Response, next: express.NextFunction) {
  const tokenParam = req.params.tokenAddress;
  const chainId = req.query.chainId;
  
  if (!tokenParam) {
    return res.status(400).json({
      error: 'Token address or symbol is required'
    });
  }
  
  if (!chainId) {
    return res.status(400).json({
      error: 'chainId query parameter is required'
    });
  }
  
  // Validate chain ID is a number
  if (!/^\d+$/.test(chainId as string)) {
    return res.status(400).json({
      error: 'chainId must be a number'
    });
  }
  
  // Check if the chainId is supported
  const chainIdNum = parseInt(chainId as string);
  if (!supportedChainIds.includes(chainIdNum)) {
    return res.status(400).json({
      error: `Unsupported chainId: ${chainId}. Supported chainIds: ${supportedChainIds.join(', ')}`
    });
  }
  
  if (isAddress(tokenParam, { strict: false })) {
    // validate if it exists in our tokenConfig for this chain
    const tokenAddress = tokenParam.toLowerCase();
    if (!tokenConfig[chainIdNum].some(token => token.address === tokenAddress)) {
      return res.status(400).json({
        error: `Token ${tokenAddress} is not a recognized SuperToken on chain ${chainId}`
      });
    }
    
    // Store the address in lowercase for later use
    req.params.tokenAddress = tokenAddress;
  } else {
    // It's a symbol, look up the address for this chain
    const tokenInfo = tokenConfig[chainIdNum].find(token => token.symbol === tokenParam);
    
    if (!tokenInfo) {
      return res.status(400).json({
        error: `Token symbol ${tokenParam} is not a recognized SuperToken on chain ${chainId}`
      });
    }
    
    // Store the address for later use
    req.params.tokenAddress = tokenInfo.address;
    console.log(`Resolved symbol ${tokenParam} to address ${tokenInfo.address} on chain ${chainIdNum}`);
  }
  
  next();
}

// GET /v0/tokens/:tokenAddress/holders
router.get('/v0/tokens/:tokenAddress/holders',
  validateToken,
  (req, res) => {
    const tokenAddress = req.params.tokenAddress; // Already validated and normalized in middleware
    const chainId = parseInt(req.query.chainId as string);
    
    // Get query parameters with defaults
    const limit = Math.min(parseInt(req.query.limit as string || '100'), 1000000);
    const offset = parseInt(req.query.offset as string || '0');
    const minBalanceWei = req.query.minBalanceWei as string || '1';
    
    // Find network by chainId from Superfluid metadata
    let networkName = '';
    try {
      const network = sfMeta.getNetworkByChainId(chainId);
      if (!network) {
        res.status(400).json({
          error: `Unsupported chainId: ${chainId}`
        });
        return;
      }
      networkName = network.name;
    } catch (error) {
      console.error('Error finding network:', error);
      res.status(500).json({
        error: 'Internal server error'
      });
      return;
    }
    
    // Get token holders
    const result = getTokenHolders(networkName, tokenAddress, limit, offset, minBalanceWei);
    
    // Get the token symbol for the response
    const tokenInfo = tokenConfig[chainId].find(t => t.address === tokenAddress);
    const tokenSymbol = tokenInfo ? tokenInfo.symbol : '';
    
    // Return response
    res.json({
      tokenAddress,
      tokenSymbol,
      chainId,
      blockNumber: result.blockNumber,
      limit,
      offset,
      total: result.holders.length,
      holders: result.holders
    });
  }
);

// GET /v0/supported-chains
router.get('/v0/supported-chains', (req, res) => {
  res.json({
    chains: supportedChainIds
  });
});

// GET /v0/tokens
router.get('/v0/tokens', (req, res) => {
  const chainId = req.query.chainId ? parseInt(req.query.chainId as string) : null;
  
  if (chainId && !supportedChainIds.includes(chainId)) {
    return res.status(400).json({
      error: `Unsupported chainId: ${chainId}. Supported chainIds: ${supportedChainIds.join(', ')}`
    });
  }
  
  // If chainId is provided, return tokens for that chain only
  if (chainId) {
    return res.json({
      chainId,
      tokens: tokenConfig[chainId] || []
    });
  }
  
  // Otherwise return all tokens grouped by chainId
  const response: Record<string, Array<{ address: string, symbol: string }>> = {};
  
  Object.entries(tokenConfig).forEach(([chainIdStr, tokens]) => {
    response[chainIdStr] = tokens;
  });
  
  res.json({
    tokens: response
  });
});

// Catch-all route for invalid endpoints
router.use((req, res) => {
  res.status(404).json({
    error: 'Not found'
  });
});

// Error handling middleware
export const errorHandler = (err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error(err.stack);
  res.status(500).json({
    error: 'Internal server error'
  });
};

// Create Express application
export const app = express();

// Middleware
app.use(express.json());

// Use router
app.use(router);

// Error handling middleware
app.use(errorHandler); 