import dotenv from 'dotenv';
import { app } from './api';
import { takeSnapshot } from './snapshot';
import { loadTokenHolders } from './utils';

// Load environment variables
dotenv.config();

// Configuration
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const UPDATE_INTERVAL = process.env.UPDATE_INTERVAL 
  ? parseInt(process.env.UPDATE_INTERVAL)
  : 3600; // Default: every hour (3600 seconds)

// Parse chains from environment variables
const chains = (process.env.CHAINS || '').split(',').filter(Boolean);
const tokenConfig: Record<string, string[]> = {};

// Initialize empty token lists for all chains
chains.forEach(chainName => {
  tokenConfig[chainName] = [];
});

// Parse token addresses for base-mainnet
if (process.env.TOKENS_BASE_MAINNET) {
  const tokens = process.env.TOKENS_BASE_MAINNET.split(',').filter(Boolean);
  
  if (tokens.length > 0 && tokenConfig['base-mainnet']) {
    tokenConfig['base-mainnet'] = tokens.map(token => token.toLowerCase());
  }
}

// Load initial data from files and update if stale
async function loadInitialData(): Promise<void> {
  console.log('Loading initial data from files...');
  
  for (const chainName of Object.keys(tokenConfig)) {
    for (const tokenAddress of tokenConfig[chainName]) {
      const data = loadTokenHolders(chainName, tokenAddress);
      console.log(`Loaded ${data.holders.length} holders for ${chainName}:${tokenAddress}`);
      
      // Check if data is stale and needs to be updated
      const now = Math.floor(Date.now() / 1000);
      const dataAge = now - Math.floor(data.updatedAt / 1000);
      
      if (data.holders.length === 0 || dataAge > UPDATE_INTERVAL) {
        console.log(`Data for ${chainName}:${tokenAddress} is stale (${dataAge}s old), updating...`);
        await takeSnapshot(chainName, tokenAddress);
      } else {
        console.log(`Using cached data for ${chainName}:${tokenAddress} (${dataAge}s old)`);
      }
    }
  }
}

// Take snapshots for all tokens
async function takeSnapshots(): Promise<void> {
  console.log('Taking snapshots...');
  
  for (const chainName of Object.keys(tokenConfig)) {
    for (const tokenAddress of tokenConfig[chainName]) {
      await takeSnapshot(chainName, tokenAddress);
    }
  }
}

// Initialize and start server
async function start(): Promise<void> {
  // Load initial data and update if stale
  await loadInitialData();
  
  // Start the server
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
  
  // Setup periodic updates with setInterval
  console.log(`Scheduling snapshots every ${UPDATE_INTERVAL} seconds`);
  setInterval(takeSnapshots, UPDATE_INTERVAL * 1000);
}

// Start the application
start().catch(err => {
  console.error('Error starting application:', err);
  process.exit(1);
}); 