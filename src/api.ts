import express from 'express';
import sfMeta from '@superfluid-finance/metadata';
import { getTokenHolders } from './snapshot';
import { getNetwork } from './utils';

// Create Express router
export const router = express.Router();

// Middleware to validate token address
function validateTokenAddress(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const tokenAddress = req.params.tokenAddress;
  
  // Check if token address is valid (0x followed by 40 hex characters)
  if (!/^0x[a-fA-F0-9]{40}$/.test(tokenAddress)) {
    res.status(400).json({
      error: 'Invalid token address format'
    });
    return;
  }
  
  next();
}

// Middleware to validate chainId
function validateChainId(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const chainId = req.query.chainId as string;
  
  if (!chainId) {
    res.status(400).json({
      error: 'chainId query parameter is required'
    });
    return;
  }
  
  // Check if chainId is a number
  if (!/^\d+$/.test(chainId)) {
    res.status(400).json({
      error: 'chainId must be a number'
    });
    return;
  }
  
  next();
}

// GET /v0/tokens/:tokenAddress/holders
router.get('/v0/tokens/:tokenAddress/holders',
  validateTokenAddress,
  validateChainId,
  (req, res) => {
    const tokenAddress = req.params.tokenAddress.toLowerCase();
    const chainId = parseInt(req.query.chainId as string);
    
    // Get query parameters with defaults
    const limit = Math.min(parseInt(req.query.limit as string || '100'), 1000000);
    const offset = parseInt(req.query.offset as string || '0');
    const minBalanceWei = req.query.minBalanceWei as string || '0';
    
    // Find network by chainId from Superfluid metadata
    let networkName = '';
    try {
      // Get all networks available in the metadata
      const allNetworks = sfMeta.networks;
      const network = allNetworks.find(n => n.chainId === chainId);
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
    
    // Return response
    res.json({
      tokenAddress,
      chainId,
      updatedAt: result.updatedAt,
      limit,
      offset,
      total: result.holders.length,
      holders: result.holders
    });
  }
);

// Create Express application
export const app = express();

// Middleware
app.use(express.json());

// Use router
app.use(router);

// Error handling middleware
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error(err.stack);
  res.status(500).json({
    error: 'Internal server error'
  });
}); 