import express from 'express';
import sfMeta from '@superfluid-finance/metadata';
import { getTokenHolders } from './snapshot';
import { getNetwork, createRpcClient, getNetFlowRate } from './utils';
import { extendedSuperTokenList } from '@superfluid-finance/tokenlist';
import { isAddress, getContract, parseAbi } from 'viem';

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

// patch in override list
const overrideList = [
  {
    chainId: 8453,
    address: '0x93419f1c0f73b278c73085c17407794a6580deff',
    symbol: 'stSTREME'
  }
];
// add override list to tokenConfig
overrideList.forEach(override => {
  tokenConfig[override.chainId].push({
    address: override.address.toLowerCase(),
    symbol: override.symbol
  });
});

// ERC20 ABI for balanceOf call
const ERC20_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)'
]);

// Middleware to validate token parameter (address or symbol)
function validateToken(req: express.Request, res: express.Response, next: express.NextFunction) {
  const tokenParam = req.params.tokenAddress || req.params.tokenAddressOrSymbol;
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
    req.params.resolvedTokenAddress = tokenAddress;
  } else {
    // It's a symbol, look up the address for this chain
    const tokenInfo = tokenConfig[chainIdNum].find(token => token.symbol === tokenParam);
    
    if (!tokenInfo) {
      return res.status(400).json({
        error: `Token symbol ${tokenParam} is not a recognized SuperToken on chain ${chainId}`
      });
    }
    
    // Store the address for later use
    req.params.resolvedTokenAddress = tokenInfo.address;
  }
  
  next();
}

// Middleware to validate account parameter
function validateAccount(req: express.Request, res: express.Response, next: express.NextFunction) {
  const accountAddress = req.params.accountAddress;
  
  if (!accountAddress) {
    return res.status(400).json({
      error: 'Account address is required'
    });
  }
  
  if (!isAddress(accountAddress, { strict: false })) {
    return res.status(400).json({
      error: 'Invalid account address format'
    });
  }
  
  // Store normalized address
  req.params.accountAddress = accountAddress.toLowerCase();
  
  next();
}

// Utility function to query the subgraph for an account's token snapshot
async function getAccountTokenSnapshot(networkName: string, tokenAddress: string, accountAddress: string) {
  try {
    const subgraphUrl = `https://subgraph-endpoints.superfluid.dev/${networkName}/protocol-v1`;
    const query = `{
      accountTokenSnapshot(
        id: "${accountAddress.toLowerCase()}-${tokenAddress.toLowerCase()}"
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
    }`;
    
    const response = await fetch(subgraphUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query })
    });
    
    const responseData = await response.json();
    return responseData.data?.accountTokenSnapshot || null;
  } catch (error) {
    console.error('Error fetching account token snapshot:', error);
    return null;
  }
}

// GET /v0/tokens/:tokenAddress/holders
router.get('/v0/tokens/:tokenAddress/holders',
  validateToken,
  (req, res) => {
    const tokenAddress = req.params.resolvedTokenAddress; // Resolved in middleware
    const chainId = parseInt(req.query.chainId as string);
    
    // Get query parameters with defaults
    const limit = Math.min(parseInt(req.query.limit as string || '100'), 1000000);
    const offset = parseInt(req.query.offset as string || '0');
    const minBalanceWei = req.query.minBalanceWei as string || '1';
    
    console.log(`Request: /v0/tokens/${tokenAddress}/holders?chainId=${chainId}&limit=${limit}&offset=${offset}&minBalanceWei=${minBalanceWei}`);
    
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

// GET /v0/accounts/:accountAddress/tokens/:tokenAddressOrSymbol/balance
router.get('/v0/accounts/:accountAddress/tokens/:tokenAddressOrSymbol/balance',
  validateAccount,
  validateToken,
  async (req, res) => {
    const accountAddress = req.params.accountAddress;
    const tokenAddress = req.params.resolvedTokenAddress;
    const chainId = parseInt(req.query.chainId as string);
    
    console.log(`Request: /v0/accounts/${accountAddress}/tokens/${tokenAddress}/balance?chainId=${chainId}`);
    
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
    
    try {
      // Get the RPC client
      const rpcClient = createRpcClient(networkName);
      
      // Create an ERC20 contract instance
      const erc20Contract = getContract({
        address: tokenAddress as `0x${string}`,
        abi: ERC20_ABI,
        client: rpcClient
      });
      
      // Get current block number
      const blockNumber = Number(await rpcClient.getBlockNumber());
      
      // Query the balance
      const balance = await erc20Contract.read.balanceOf(
        [accountAddress as `0x${string}`],
        { blockNumber: BigInt(blockNumber) }
      );
      
      // Query the account token snapshot for flow rate information
      const snapshot = await getAccountTokenSnapshot(networkName, tokenAddress, accountAddress);
      
      // Get the token symbol for the response
      const tokenInfo = tokenConfig[chainId].find(t => t.address === tokenAddress);
      const tokenSymbol = tokenInfo ? tokenInfo.symbol : '';
      
      // Default to zero flow rate if no snapshot exists
      let netFlowRate = "0";
      
      if (snapshot) {
        netFlowRate = getNetFlowRate(snapshot);
      }
      
      res.json({
        account: accountAddress,
        tokenAddress,
        tokenSymbol,
        chainId,
        blockNumber,
        balance: balance.toString(),
        netFlowRate
      });
    } catch (error) {
      console.error('Error fetching account balance:', error);
      res.status(500).json({
        error: 'Error fetching account balance'
      });
    }
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