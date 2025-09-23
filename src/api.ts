import express from 'express';
import sfMeta from '@superfluid-finance/metadata';
import { getTokenHolders } from './snapshot';
import { createRpcClient, getNetFlowRate } from './utils';
import { isAddress, getContract, parseAbi, erc20Abi } from 'viem';
import { config, supportedChainIds } from './config';
import { getMetrics, httpRequestsTotal, httpRequestDuration, httpResponseSize } from './metrics';

// Create Express router
export const router = express.Router();

// Request logging middleware - logs all requests and responses
router.use((req, res, next) => {
  const start = Date.now();
  const originalSend = res.send;
  
  // Override res.send to capture response details
  res.send = function(data) {
    const duration = Date.now() - start;
    const responseSize = Buffer.byteLength(data || '', 'utf8');
    
    // Log the request/response
    const logLevel = res.statusCode >= 400 ? 'ERROR' : 'INFO';
    console.log(`[${logLevel}] ${req.method} ${req.url} - ${res.statusCode} - ${duration}ms - ${responseSize} bytes`);
    
    // For error responses, also log the response body (helpful for debugging)
    if (res.statusCode >= 400) {
      try {
        const responseData = JSON.parse(data || '{}');
        console.log(`[ERROR] Response: ${JSON.stringify(responseData)}`);
      } catch (e) {
        // If not JSON, just log the raw response
        console.log(`[ERROR] Response: ${data}`);
      }
    }
    
    // Call original send
    return originalSend.call(this, data);
  };
  
  next();
});

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
  
  const chainTokens = config[chainIdNum]?.tokens || [];
  
  if (isAddress(tokenParam, { strict: false })) {
    // validate if it exists in our tokenConfig for this chain
    const tokenAddress = tokenParam.toLowerCase();
    if (!chainTokens.some(token => token.address === tokenAddress)) {
      return res.status(400).json({
        error: `Token ${tokenAddress} is not a recognized SuperToken on chain ${chainId}`
      });
    }
    
    // Store the address in lowercase for later use
    req.params.resolvedTokenAddress = tokenAddress;
  } else {
    // It's a symbol, look up the address for this chain
    const tokenInfo = chainTokens.find(token => token.symbol === tokenParam);
    
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
    const tokenInfo = config[chainId].tokens.find(t => t.address === tokenAddress);
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
        abi: erc20Abi,
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
      const tokenInfo = config[chainId].tokens.find(t => t.address === tokenAddress);
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
  
  // If chainId is provided, return config for that chain
  if (chainId) {
    return res.json({
      chainId,
      ...config[chainId] || { tokens: [] }
    });
  }
  
  // Otherwise return all config grouped by chainId
  res.json({
    chains: config
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

// Custom HTTP metrics middleware
app.use((req, res, next) => {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    const responseSize = parseInt(res.get('content-length') || '0', 10);
    const labels = {
      status_code: res.statusCode.toString()
    };
    
    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe({}, duration);
    httpResponseSize.observe({}, responseSize);
  });
  
  next();
});

// Custom metrics endpoint that includes our custom metrics (must be before router)
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', 'text/plain');
  const metrics = await getMetrics();
  res.send(metrics);
});

// Middleware
app.use(express.json());

// Use router
app.use(router);

// Error handling middleware
app.use(errorHandler); 