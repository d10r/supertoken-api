import dotenv from 'dotenv';
import { app } from './api';
import { takeSnapshot, updateTokenHoldersCache } from './snapshot';
import { loadTokenHolders } from './utils';
import sfMeta from '@superfluid-finance/metadata';
import { config, initializeConfig, supportedChainIds } from './config';

// Load environment variables
dotenv.config();

// Configuration
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const UPDATE_INTERVAL = process.env.UPDATE_INTERVAL 
  ? parseInt(process.env.UPDATE_INTERVAL)
  : 3600; // Default: every hour (3600 seconds)
const RPC_BATCH_SIZE = process.env.RPC_BATCH_SIZE
  ? parseInt(process.env.RPC_BATCH_SIZE)
  : 100; // Default batch size: 100

// Get supported chains from environment
const supportedChainNames = (process.env.CHAINS || '').split(',').filter(Boolean);

// Parse the SKIP_TOKENS environment variable
const skipTokensConfig = process.env.SKIP_TOKENS || '';

// Initialize config
initializeConfig(supportedChainNames, skipTokensConfig);

if (skipTokensConfig) {
  console.log(`Skipping tokens: ${skipTokensConfig}`);
}

console.log(`Supported chains: ${supportedChainIds.join(', ')}`);

// Log the token configuration
console.log(`\n=== Token Configuration ===`);
Object.entries(config).forEach(([chainIdStr, chainConfig]) => {
  const chainId = parseInt(chainIdStr);
  console.log(`Chain ${chainId}: ${chainConfig.tokens.length} tokens found`);
  chainConfig.tokens.forEach(token => {
    console.log(`  - ${token.symbol} (${token.address})`);
  });
});

// Helper function to get network name from chainId
function getNetworkName(chainId: number): string {
  const network = sfMeta.getNetworkByChainId(chainId);
  if (!network) {
    throw new Error(`Network not found for chainId: ${chainId}`);
  }
  return network.name;
}

// Load initial data from files and update if stale
async function loadInitialData(): Promise<void> {
  console.log(`\n=== Loading Initial Data ===`);
  
  // Track tokens that need updates
  const tokensToUpdate: Array<{ networkName: string, address: string, symbol: string, dataAge: number }> = [];
  let totalTokens = 0;
  let loadedTokens = 0;
  
  // First, load all data from files
  for (const [chainIdStr, chainConfig] of Object.entries(config)) {
    const chainId = parseInt(chainIdStr);
    const networkName = getNetworkName(chainId);
    
    console.log(`Network: ${networkName} (${chainId})`);
    
    for (const token of chainConfig.tokens) {
      totalTokens++;
      // if env var DEBUG_ONLY_TOKEN is set, only process this token
      if (process.env.DEBUG_ONLY_TOKEN && token.symbol !== process.env.DEBUG_ONLY_TOKEN) {
        continue;
      }
      
      // Load data from file
      const data = loadTokenHolders(networkName, token.address);
      
      // Add the loaded data to the in-memory cache regardless of age
      // This ensures API has data available immediately
      if (data) {
        loadedTokens++;
        updateTokenHoldersCache(networkName, token.address, data);
      }
      
      // Check if data is stale and needs to be updated
      const now = Math.floor(Date.now() / 1000);
      const dataAge = now - Math.floor(data.updatedAt / 1000);
      
      if (dataAge > UPDATE_INTERVAL) {
        tokensToUpdate.push({ 
          networkName, 
          address: token.address, 
          symbol: token.symbol,
          dataAge 
        });
      }
      
      // Only log detailed information for tokens with holders or those needing updates
      if (data.holders.length > 0 || dataAge > UPDATE_INTERVAL) {
        console.log(`  ${token.symbol} (${token.address}): ${data.holders.length} holders${dataAge > UPDATE_INTERVAL ? ' (stale: ' + dataAge + 's)' : ' (fresh)'}`);
      }
    }
  }
  
  console.log(`\nLoaded ${loadedTokens}/${totalTokens} tokens with data from files`);
  
  // After loading all data, update stale data in the background
  if (tokensToUpdate.length > 0) {
    console.log(`\n=== Updating ${tokensToUpdate.length} Stale Tokens ===`);
    
    for (let i = 0; i < tokensToUpdate.length; i++) {
      const token = tokensToUpdate[i];
      console.log(`\n[${i+1}/${tokensToUpdate.length}] Updating ${token.symbol} on ${token.networkName}`);
      await takeSnapshot(token.networkName, token.address, RPC_BATCH_SIZE);
    }
    
    console.log(`\n=== Data Updates Complete ===`);
  } else {
    console.log(`\nNo stale data to update`);
  }
}

// Take snapshots for all tokens
async function takeSnapshots(): Promise<void> {
  console.log('Taking snapshots...');
  
  for (const [chainIdStr, chainConfig] of Object.entries(config)) {
    const chainId = parseInt(chainIdStr);
    const networkName = getNetworkName(chainId);
    
    for (const token of chainConfig.tokens) {
      await takeSnapshot(networkName, token.address, RPC_BATCH_SIZE);
    }
  }
}

// Initialize and start server
async function start(): Promise<void> {
  // Start the server first so it's available while data is loading
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
  
  // Load initial data and update if stale
  await loadInitialData();
  
  // Setup periodic updates with setInterval
  console.log(`Scheduling snapshots every ${UPDATE_INTERVAL} seconds`);
  setInterval(takeSnapshots, UPDATE_INTERVAL * 1000);
}

// Start the application
start().catch(err => {
  console.error('Error starting application:', err);
  process.exit(1);
}); 