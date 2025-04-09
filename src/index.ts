import dotenv from 'dotenv';
import cron from 'node-cron';
import { app } from './api';
import { takeSnapshot } from './snapshot';
import { loadTokenHolders } from './utils';

// Load environment variables
dotenv.config();

// Configuration
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const UPDATE_INTERVAL = process.env.UPDATE_INTERVAL || '0 * * * *'; // Default: every hour

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

// Load initial data from files
async function loadInitialData() {
  console.log('Loading initial data from files...');
  
  Object.keys(tokenConfig).forEach(chainName => {
    tokenConfig[chainName].forEach(tokenAddress => {
      const data = loadTokenHolders(chainName, tokenAddress);
      console.log(`Loaded ${data.holders.length} holders for ${chainName}:${tokenAddress}`);
    });
  });
}

// Take snapshots for all tokens
async function takeSnapshots() {
  console.log('Taking snapshots...');
  
  for (const chainName of Object.keys(tokenConfig)) {
    for (const tokenAddress of tokenConfig[chainName]) {
      await takeSnapshot(chainName, tokenAddress);
    }
  }
}

// Initialize and start server
async function start() {
  // Load initial data
  await loadInitialData();
  
  // Start the server
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
  
  // Schedule initial snapshot
  console.log('Starting initial snapshots...');
  await takeSnapshots();
  
  // Schedule regular snapshots
  if (cron.validate(UPDATE_INTERVAL)) {
    console.log(`Scheduling snapshots with interval: ${UPDATE_INTERVAL}`);
    cron.schedule(UPDATE_INTERVAL, takeSnapshots);
  } else {
    console.error(`Invalid cron expression: ${UPDATE_INTERVAL}`);
  }
}

// Start the application
start().catch(err => {
  console.error('Error starting application:', err);
  process.exit(1);
}); 