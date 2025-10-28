import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { ethers } from 'ethers';

interface Env {
  SIGNER_PRIVATE_KEY: string;
  NONCES: KVNamespace;
  RPC_URL_BASE?: string;
  RPC_URL_BASE_SEPOLIA?: string;
}




interface PaymentRequirements {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource?: string;
  description?: string;
  mimeType?: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  asset: string;
  outputSchema?: any;
  extra?: {
    name?: string;
    version?: string;
  };
}


interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}


interface SettleResponse {
  success: boolean;
  transaction: string;
  network: string;
  payer: string;
  errorReason?: string;
}

// Discovery Types
interface DiscoveryResource {
  accepts: PaymentRequirements[];
  lastUpdated: string;
  metadata: Record<string, any>;
  resource: string;
  type: string;
  x402Version: number;
}

interface ListDiscoveryResponse {
  x402Version: number;
  items: DiscoveryResource[];
  pagination?: {
    limit: number;
    offset: number;
    total: number;
  };
}

// Network configurations
const NETWORK_CONFIG: Record<string, { 
  chainId: number; 
  name: string;
  usdcAddress: string;
  usdcName: string;
  defaultRpc: string;
}> = {
  'base': { 
    chainId: 8453, 
    name: 'Base Mainnet',
    usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    usdcName: 'USD Coin',
    defaultRpc: 'https://base.llamarpc.com'
  },
  'base-sepolia': { 
    chainId: 84532, 
    name: 'Base Sepolia',
    usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    usdcName: 'USD Coin',
    defaultRpc: 'https://sepolia.base.org'
  }
};

// ERC-3009 TransferWithAuthorization ABI
const TRANSFER_WITH_AUTHORIZATION_ABI = [
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) returns (bool)',
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)'
];

// Helper function to create a safe KV key from resource URL
function getSellerKey(resource: string): string {
  // Use a simple hash-like approach: encode the URL to make it KV-safe
  // We'll use the resource URL directly but replace problematic characters
  const encoded = encodeURIComponent(resource).substring(0, 512); // KV key limit
  return `seller:${encoded}`;
}

// Helper function to register/update a seller in discovery catalog
async function registerSeller(
  kv: KVNamespace,
  paymentRequirements: PaymentRequirements,
  network: string,
  requestId: string
): Promise<void> {
  // Skip if no resource URL provided
  if (!paymentRequirements.resource) {
    console.log(`[${requestId}] No resource URL, skipping seller registration`);
    return;
  }

  const sellerKey = getSellerKey(paymentRequirements.resource);
  
  try {
    const existing = await kv.get(sellerKey, 'json');
    const now = new Date().toISOString();
    
    let discoveryResource: DiscoveryResource;
    
    if (existing) {
      discoveryResource = existing as DiscoveryResource;
      
      // Debounce: only update if lastUpdated is > 1 hour old (reduces KV writes)
      const lastUpdated = new Date(discoveryResource.lastUpdated);
      const oneHourAgo = new Date(Date.now() - 3600000);
      
      if (lastUpdated > oneHourAgo) {
        console.log(`[${requestId}] Seller recently updated, skipping`);
        return;
      }
      
      // Check if this exact payment requirement already exists
      const reqIndex = discoveryResource.accepts.findIndex(req =>
        req.payTo.toLowerCase() === paymentRequirements.payTo.toLowerCase() &&
        req.asset.toLowerCase() === paymentRequirements.asset.toLowerCase() &&
        req.network === network
      );
      
      if (reqIndex >= 0) {
        // Update existing requirement
        discoveryResource.accepts[reqIndex] = paymentRequirements;
      } else {
        // Add new payment requirement for this resource
        discoveryResource.accepts.push(paymentRequirements);
      }
      
      discoveryResource.lastUpdated = now;
    } else {
      // New seller - create discovery resource
      discoveryResource = {
        accepts: [paymentRequirements],
        lastUpdated: now,
        metadata: {},
        resource: paymentRequirements.resource,
        type: 'http',
        x402Version: 1
      };
    }
    
    // Store with 7-day TTL (sellers inactive for 7 days will drop off automatically)
    await kv.put(
      sellerKey,
      JSON.stringify(discoveryResource),
      { expirationTtl: 86400 * 7 }
    );
    
    console.log(`[${requestId}] Registered/updated seller: ${paymentRequirements.resource}`);
  } catch (error) {
    console.error(`[${requestId}] Failed to register seller:`, error);
    // Non-critical error, don't throw
  }
}

const app = new Hono<{ Bindings: Env }>();

// Configure middleware
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'X-Request-ID']
}));

app.use('*', logger());

app.use('*', async (c, next) => {
  const requestId = c.req.header('X-Request-ID') || crypto.randomUUID();
  c.set('requestId', requestId);
  c.header('X-Request-ID', requestId);
  await next();
});

// Health check endpoint
app.get('/', (c) => {
  return c.json({
    name: 'x402 Facilitator',
    version: '1.0.0',
    status: 'healthy',
    endpoints: {
      verify: '/verify',
      settle: '/settle',
      discovery: '/discovery/resources',
      list: '/list'
    },
    networks: ['base', 'base-sepolia'],
    schemes: ['exact']
  });
});

// Discovery endpoint - list all registered sellers
app.get('/discovery/resources', async (c) => {
  const requestId = c.get('requestId');
  
  try {
    console.log(`[${requestId}] Processing discovery list request`);
    
    // Parse query parameters for pagination
    const limit = Math.min(parseInt(c.req.query('limit') || '100'), 1000);
    const offset = parseInt(c.req.query('offset') || '0');
    
    // List all seller keys from KV
    const listResult = await c.env.NONCES.list({ 
      prefix: 'seller:',
      limit: 1000 // KV list limit
    });
    
    // Fetch all seller resources
    const resources: DiscoveryResource[] = [];
    
    for (const key of listResult.keys) {
      try {
        const data = await c.env.NONCES.get(key.name, 'json');
        if (data) {
          resources.push(data as DiscoveryResource);
        }
      } catch (error) {
        console.error(`[${requestId}] Failed to parse seller data for ${key.name}`);
      }
    }
    
    // Sort by lastUpdated (most recent first)
    resources.sort((a, b) => 
      new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime()
    );
    
    // Apply pagination
    const total = resources.length;
    const paginatedResources = resources.slice(offset, offset + limit);
    
    const response: ListDiscoveryResponse = {
      x402Version: 1,
      items: paginatedResources,
      pagination: {
        limit,
        offset,
        total
      }
    };
    
    return c.json(response);
    
  } catch (error: any) {
    console.error(`[${requestId}] Discovery list error:`, error);
    return c.json({
      x402Version: 1,
      items: [],
      pagination: { limit: 0, offset: 0, total: 0 }
    }, 500);
  }
});

// Alias for /list endpoint
app.get('/list', async (c) => {
  const requestId = c.get('requestId');
  console.log(`[${requestId}] Redirecting /list to /discovery/resources`);
  
  // Forward to discovery/resources
  const url = new URL(c.req.url);
  url.pathname = '/discovery/resources';
  
  return c.redirect(url.toString());
});

// Get RPC URL for network
function getRpcUrl(env: Env, network: string): string {
  if (network === 'base') {
    return env.RPC_URL_BASE || NETWORK_CONFIG[network].defaultRpc;
  } else if (network === 'base-sepolia') {
    return env.RPC_URL_BASE_SEPOLIA || NETWORK_CONFIG[network].defaultRpc;
  }
  throw new Error(`Unsupported network: ${network}`);
}

// Verify payment authorization
app.post('/verify', async (c) => {
  const requestId = c.get('requestId');
  
  try {
    const body = await c.req.json();
    console.log(`[${requestId}] Processing verify request`);
    
    const { paymentPayload, paymentRequirements } = body;
    
    if (!paymentPayload || !paymentRequirements) {
      return c.json<VerifyResponse>({
        isValid: false,
        invalidReason: 'missing_payload_or_requirements'
      });
    }
    
    const payload = paymentPayload.payload;
    const authorization = payload.authorization;
    
    // Validate scheme
    if (paymentPayload.scheme !== 'exact' || paymentRequirements.scheme !== 'exact') {
      return c.json<VerifyResponse>({
        isValid: false,
        invalidReason: 'unsupported_scheme',
        payer: authorization.from
      });
    }
    
    // Validate network
    const networkConfig = NETWORK_CONFIG[paymentPayload.network];
    if (!networkConfig) {
      return c.json<VerifyResponse>({
        isValid: false,
        invalidReason: 'invalid_network',
        payer: authorization.from
      });
    }
    
    // Get EIP-712 domain parameters
    const name = paymentRequirements.extra?.name || networkConfig.usdcName;
    const version = paymentRequirements.extra?.version || '2';
    
    // Validate recipient address
    if (authorization.to.toLowerCase() !== paymentRequirements.payTo.toLowerCase()) {
      return c.json<VerifyResponse>({
        isValid: false,
        invalidReason: 'invalid_exact_evm_payload_recipient_mismatch',
        payer: authorization.from
      });
    }
    
    // Validate USDC contract address
    if (paymentRequirements.asset.toLowerCase() !== networkConfig.usdcAddress.toLowerCase()) {
      return c.json<VerifyResponse>({
        isValid: false,
        invalidReason: 'invalid_asset_address',
        payer: authorization.from
      });
    }
    
    // Validate authorization timing
    const currentTime = Math.floor(Date.now() / 1000);
    
    if (BigInt(authorization.validBefore) < BigInt(currentTime + 6)) {
      return c.json<VerifyResponse>({
        isValid: false,
        invalidReason: 'invalid_exact_evm_payload_authorization_valid_before',
        payer: authorization.from
      });
    }
    
    if (BigInt(authorization.validAfter) > BigInt(currentTime)) {
      return c.json<VerifyResponse>({
        isValid: false,
        invalidReason: 'invalid_exact_evm_payload_authorization_valid_after',
        payer: authorization.from
      });
    }
    
    // Validate amount
    if (BigInt(authorization.value) < BigInt(paymentRequirements.maxAmountRequired)) {
      return c.json<VerifyResponse>({
        isValid: false,
        invalidReason: 'invalid_exact_evm_payload_authorization_value',
        payer: authorization.from
      });
    }
    
    // Verify EIP-712 signature
    const domain = {
      name,
      version,
      chainId: networkConfig.chainId,
      verifyingContract: paymentRequirements.asset
    };
    
    const types = {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' }
      ]
    };
    
    const message = {
      from: authorization.from,
      to: authorization.to,
      value: authorization.value,
      validAfter: authorization.validAfter,
      validBefore: authorization.validBefore,
      nonce: authorization.nonce
    };
    
    try {
      const recoveredAddress = ethers.verifyTypedData(
        domain,
        types,
        message,
        payload.signature
      );
      
      if (recoveredAddress.toLowerCase() !== authorization.from.toLowerCase()) {
        return c.json<VerifyResponse>({
          isValid: false,
          invalidReason: 'invalid_exact_evm_payload_signature',
          payer: authorization.from
        });
      }
    } catch (e) {
      console.error(`[${requestId}] Signature verification failed:`, e);
      return c.json<VerifyResponse>({
        isValid: false,
        invalidReason: 'invalid_exact_evm_payload_signature',
        payer: authorization.from
      });
    }
    
    // Check nonce usage
    const nonceKey = `nonce:${paymentPayload.network}:${authorization.nonce}`;
    const usedNonce = await c.env.NONCES.get(nonceKey);
    
    if (usedNonce) {
      return c.json<VerifyResponse>({
        isValid: false,
        invalidReason: 'nonce_already_used',
        payer: authorization.from
      });
    }
    
    // Optional on-chain validations
    try {
      const rpcUrl = getRpcUrl(c.env, paymentPayload.network);
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      provider._getConnection().timeout = 5000;
      
      const contract = new ethers.Contract(
        paymentRequirements.asset,
        TRANSFER_WITH_AUTHORIZATION_ABI,
        provider
      );
      
      // Check balance
      try {
        const balance = await contract.balanceOf(authorization.from);
        if (balance < BigInt(paymentRequirements.maxAmountRequired)) {
          return c.json<VerifyResponse>({
            isValid: false,
            invalidReason: 'insufficient_funds',
            payer: authorization.from
          });
        }
      } catch (e) {
        console.log(`[${requestId}] Balance check failed (non-critical)`);
      }
      
      // Check authorization state on-chain
      try {
        const authState = await contract.authorizationState(
          authorization.from,
          authorization.nonce
        );
        
        if (authState) {
          return c.json<VerifyResponse>({
            isValid: false,
            invalidReason: 'authorization_already_used',
            payer: authorization.from
          });
        }
      } catch (e) {
        console.log(`[${requestId}] Authorization state check failed (non-critical)`);
      }
    } catch (e) {
      console.log(`[${requestId}] RPC validation skipped`);
    }
    
    // Register this seller in the discovery catalog (async, non-blocking)
    c.executionCtx.waitUntil(
      registerSeller(c.env.NONCES, paymentRequirements, paymentPayload.network, requestId)
    );
    
    return c.json<VerifyResponse>({
      isValid: true,
      payer: authorization.from
    });
    
  } catch (error: any) {
    console.error(`[${requestId}] Verification error:`, error);
    return c.json<VerifyResponse>({
      isValid: false,
      invalidReason: 'internal_error'
    }, 500);
  }
});

// Settle payment on-chain
app.post('/settle', async (c) => {
  const requestId = c.get('requestId');
  
  try {
    const body = await c.req.json();
    console.log(`[${requestId}] Processing settle request`);
    
    const { paymentPayload, paymentRequirements } = body;
    
    if (!paymentPayload || !paymentRequirements) {
      return c.json<SettleResponse>({
        success: false,
        errorReason: 'missing_payload_or_requirements',
        transaction: '',
        network: '',
        payer: ''
      });
    }
    
    const payload = paymentPayload.payload;
    const authorization = payload.authorization;
    
    // Prevent replay attacks
    const nonceKey = `nonce:${paymentPayload.network}:${authorization.nonce}`;
    const existing = await c.env.NONCES.get(nonceKey);
    
    if (existing) {
      return c.json<SettleResponse>({
        success: false,
        errorReason: 'nonce_already_used',
        transaction: '',
        network: paymentPayload.network,
        payer: authorization.from
      });
    }
    
    // Mark nonce as pending
    await c.env.NONCES.put(
      nonceKey,
      JSON.stringify({
        status: 'pending',
        requestId,
        timestamp: Date.now()
      }),
      { expirationTtl: 86400 }
    );
    
    try {
      const rpcUrl = getRpcUrl(c.env, paymentPayload.network);
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const signer = new ethers.Wallet(c.env.SIGNER_PRIVATE_KEY, provider);
      
      const contract = new ethers.Contract(
        paymentRequirements.asset,
        TRANSFER_WITH_AUTHORIZATION_ABI,
        signer
      );
      
      // Parse signature for contract call
      const sig = payload.signature.startsWith('0x') 
        ? payload.signature.slice(2) 
        : payload.signature;
      
      let tx;
      
      if (sig.length === 130) {
        // Use v, r, s format
        const r = '0x' + sig.slice(0, 64);
        const s = '0x' + sig.slice(64, 128);
        const v = parseInt(sig.slice(128, 130), 16);
        
        tx = await contract.transferWithAuthorization(
          authorization.from,
          authorization.to,
          authorization.value,
          authorization.validAfter,
          authorization.validBefore,
          authorization.nonce,
          v, r, s
        );
      } else {
        // Use packed signature format
        tx = await contract.transferWithAuthorization(
          authorization.from,
          authorization.to,
          authorization.value,
          authorization.validAfter,
          authorization.validBefore,
          authorization.nonce,
          payload.signature
        );
      }
      
      console.log(`[${requestId}] Transaction submitted: ${tx.hash}`);
      
      const receipt = await tx.wait(1);
      
      if (receipt.status !== 1) {
        await c.env.NONCES.delete(nonceKey);
        return c.json<SettleResponse>({
          success: false,
          errorReason: 'invalid_transaction_state',
          transaction: tx.hash,
          network: paymentPayload.network,
          payer: authorization.from
        });
      }
      
      // Mark nonce as confirmed
      await c.env.NONCES.put(
        nonceKey,
        JSON.stringify({
          status: 'confirmed',
          requestId,
          txHash: tx.hash,
          blockNumber: receipt.blockNumber,
          timestamp: Date.now()
        }),
        { expirationTtl: 86400 * 7 }
      );
      
      // Refresh seller registration in discovery catalog (successful payment = active seller)
      c.executionCtx.waitUntil(
        registerSeller(c.env.NONCES, paymentRequirements, paymentPayload.network, requestId)
      );
      
      return c.json<SettleResponse>({
        success: true,
        transaction: tx.hash,
        network: paymentPayload.network,
        payer: authorization.from
      });
      
    } catch (error: any) {
      await c.env.NONCES.delete(nonceKey);
      console.error(`[${requestId}] Settlement failed:`, error);
      
      return c.json<SettleResponse>({
        success: false,
        errorReason: error.message || 'settlement_failed',
        transaction: '',
        network: paymentPayload.network,
        payer: authorization.from
      });
    }
    
  } catch (error: any) {
    console.error(`[${requestId}] Settlement error:`, error);
    return c.json<SettleResponse>({
      success: false,
      errorReason: 'internal_error',
      transaction: '',
      network: '',
      payer: ''
    }, 500);
  }
});

export default app;