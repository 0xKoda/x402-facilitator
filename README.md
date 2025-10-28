# x402 Facilitator for Cloudflare Workers

A high-performance and fast x402 payment facilitator deployed on Cloudflare's edge network, enabling USDC payments on Base using ERC-3009 TransferWithAuthorization.

## Overview

This facilitator provides payment verification, settlement, and service discovery for the x402 protocol. Built on Cloudflare Workers, it offers low-latency responses with global distribution and automatic scaling.

## Features

- **High Performance**: Achieved sub-100ms latency with Edge deployment
- Complete x402 protocol implementation (`verify`, `settle`, `discovery`)
- Base mainnet and Base Sepolia testnet support
- EIP-712 signature verification
- Replay attack prevention via nonce tracking
- Automatic seller registration in discovery catalog

### Performance Benchmark

<p align="center">
  <img src="bench.png" width="350" alt="x402 Facilitator Performance Benchmark">
</p>

## Prerequisites

- Node.js 16+
- Cloudflare account
- Wrangler CLI
- Wallet with ETH on Base for gas (do not use your main wallet or a wallet with substantial funds)

## Installation

Use it as a template with:

```bash
npm create cloudflare@latest -- --template=0xkoda/x402-facilitator
```
Or

Clone and install dependencies:

```bash
git clone https://github.com/0xKoda/x402-facilitator.git
cd x402-facilitator
npm install
```


## Configuration

Create KV namespace for state management:

```bash
wrangler kv namespace create "NONCES"
```

Update `wrangler.jsonc` with your namespace IDs:

```json
{
  "kv_namespaces": [
    {
      "binding": "NONCES",
      "id": "<production-id>"
    }
  ]
}
```

Add your facilitator wallet private key:

```bash
wrangler secret put SIGNER_PRIVATE_KEY
```

Optional: Configure custom RPC endpoints in `wrangler.jsonc`:

```json
{
  "vars": {
    "RPC_URL_BASE": "https://your-base-rpc.com",
    "RPC_URL_BASE_SEPOLIA": "https://your-sepolia-rpc.com"
  }
}
```

## Deployment

Deploy to Cloudflare Workers:

```bash
wrangler deploy
```

Your facilitator URL: `https://<worker-name>.<subdomain>.workers.dev`

## API Reference

### GET /

Health check and capabilities endpoint.

**Response:**

```json
{
  "name": "x402 Facilitator",
  "version": "1.0.0",
  "status": "healthy",
  "endpoints": {
    "verify": "/verify",
    "settle": "/settle",
    "discovery": "/discovery/resources"
  }
}
```

### POST /verify

Validates payment authorization without on-chain settlement.

**Request:**

```json
{
  "x402Version": 1,
  "paymentPayload": { ... },
  "paymentRequirements": { ... }
}
```

**Response:**

```json
{
  "isValid": true,
  "payer": "0x..."
}
```

### POST /settle

Executes on-chain payment settlement.

**Request:**

```json
{
  "x402Version": 1,
  "paymentPayload": { ... },
  "paymentRequirements": { ... }
}
```

**Response:**

```json
{
  "success": true,
  "transaction": "0x...",
  "network": "base",
  "payer": "0x..."
}
```

### GET /discovery/resources

Lists all registered x402-compatible services.

Query parameters:
- `limit`: Maximum results (default: 100, max: 1000)
- `offset`: Pagination offset (default: 0)

**Response:**

```json
{
  "x402Version": 1,
  "items": [
    {
      "resource": "https://api.example.com/endpoint",
      "type": "http",
      "accepts": [...],
      "lastUpdated": "2025-01-28T00:00:00.000Z"
    }
  ],
  "pagination": {
    "limit": 100,
    "offset": 0,
    "total": 42
  }
}
```

### GET /list

Alias for `/discovery/resources`.

## Discovery System

Sellers are automatically registered when their endpoints are used. Discovery catalog features:

- Auto-registration on first payment verification
- 7-day TTL for inactive services
- Debounced updates (1-hour minimum between updates)
- No manual registration required

## Gas Requirements

The facilitator wallet requires ETH on Base for transaction gas:

- Base Sepolia: ~0.00001 ETH per settlement
- Base Mainnet: ~0.00002 ETH per settlement

Obtain testnet ETH: Coinbase Faucet or Base Sepolia Faucet


## Security

- Private keys stored in Cloudflare Workers secrets
- Nonce-based replay attack prevention
- EIP-712 signature verification
- Authorization parameter validation
- Automatic nonce expiration (24 hours for pending, 7 days for confirmed)

## Monitoring

Check facilitator health:

```bash
curl https://your-facilitator.workers.dev/
```

View discovery catalog:

```bash
curl https://your-facilitator.workers.dev/discovery/resources
```

## Support

- x402 Protocol: https://x402.org
- Cloudflare Workers: https://developers.cloudflare.com/workers

## Warning: 
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,

**You are solely responsible for:**

- Securing your private keys
- Any loss of funds
- Understanding the code before using it
- Complying with applicable laws and regulations

## License

MIT
