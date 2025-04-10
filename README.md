# Super Token API

A simple REST API for retrieving Super Token holder information, including balances calculated based on all four primitives (transfer to one, transfer to many, stream to one, stream to many).

## Overview

This API provides access to token holder data for Super Tokens across multiple EVM chains. It periodically takes snapshots of token holder balances by querying the Superfluid subgraph and calculating accurate balances that include streaming and pool memberships, which conventional ERC20 tools often miss. For accuracy, it also verifies balances using RPC calls.

## Features

- REST API for querying Super Token holders with filtering and pagination
- Support for multiple chains and tokens
- Periodic background jobs to update token holder data
- Calculation of correct token balances including streaming rates
- RPC verification of token balances for improved accuracy
- In-memory caching with JSON file persistence

## API Endpoints

### Get Token Holders

```
GET /v0/tokens/{tokenAddress}/holders?chainId={chainId}&limit={limit}&offset={offset}&minBalanceWei={minBalanceWei}
```

**Path Parameters:**
- `tokenAddress` (required): The contract address of the Super Token (e.g., `0xa69f80524381275a7ffdb3ae01c54150644c8792`)

**Query Parameters:**
- `chainId` (required): The EVM chain ID where the token exists (e.g., `1` for Ethereum Mainnet)
- `limit` (optional): Maximum number of holders to return per request (default: 100, max: 1000000)
- `offset` (optional): Number of records to skip for pagination (default: 0)
- `minBalanceWei` (optional): Filter holders with a minimum token balance (in wei, default: 0)

**Example Response:**
```json
{
  "tokenAddress": "0xa69f80524381275a7ffdb3ae01c54150644c8792",
  "chainId": 1,
  "blockNumber": 17000000,
  "limit": 10,
  "offset": 0,
  "total": 5,
  "holders": [
    {
      "address": "0x1234...",
      "balance": "100000000000000000000",
      "netFlowRate": "1000000000"
    },
    // ...more holders
  ]
}
```

## Setup

### Prerequisites

- Node.js 20 or higher
- npm or yarn

### Installation

1. Clone the repository
```bash
git clone https://github.com/your-username/supertoken-api.git
cd supertoken-api
```

2. Install dependencies
```bash
npm install
```

3. Create and configure .env file
```bash
cp .env.example .env
```
Edit the `.env` file with your configuration.

4. Build the application
```bash
npm run build
```

5. Start the server
```bash
npm start
```

### Configuration

Configure the application by setting the following environment variables in the `.env` file:

- `CHAINS`: Comma-separated list of supported chains (network names from @superfluid-finance/metadata)
- `TOKENS_BASE_MAINNET`: Comma-separated list of token addresses for Base Mainnet (currently only Base Mainnet is supported for token monitoring)
- `UPDATE_INTERVAL`: Snapshot update interval in seconds (default: 3600 = every hour)
- `PORT`: Port for the API server (default: 3000)
- `RPC_BATCH_SIZE`: Number of accounts to include in each RPC batch call for balance verification (default: 100)

## How It Works

1. The application periodically queries the Superfluid subgraph for account token snapshots
2. For each token holder, it calculates the current balance using:
   - The balance at the last update time
   - The net flow rate (for streaming)
   - Connected pool memberships (for distribution agreements)
3. It then verifies the balances by making RPC calls to the blockchain
4. The results are stored in memory and persisted to JSON files
5. The API serves this data with filtering and pagination

## Development

### Running in Development Mode

```bash
npm run dev
```

### Project Structure

- `src/index.ts` - Application entry point
- `src/api.ts` - API endpoints
- `src/snapshot.ts` - Token holder snapshot logic
- `src/utils.ts` - Helper functions
- `data/` - Directory for JSON files with token holder data 