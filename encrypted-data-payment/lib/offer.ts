import { bottle } from './fiber';
import type { Channel, FiberBrowserNode } from '@fiber-pay/sdk/browser';
import { encryptChunks, encryptResult, type EncryptedPayload } from './crypto';

export type EncryptedOffer = EncryptedPayload & {
  version: 2;
  cipher: 'AES-256-GCM';
  invoice: string;
  paymentHash: `0x${string}`;
  lastHop: {
    pubkey: `0x${string}`;
    channel_outpoint: `0x${string}`;
    fee_rate: `0x${string}`;
    tlc_expiry_delta: `0x${string}`;
  };
};

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeHexBytes(value: unknown, label: string, bytes?: number) {
  if (typeof value !== 'string') throw new Error(`${label} is missing.`);
  const body = value.trim().replace(/^0x/i, '');
  if (!body || body.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(body)) {
    throw new Error(`${label} must be hexadecimal bytes.`);
  }
  if (bytes !== undefined && body.length !== bytes * 2) {
    throw new Error(`${label} must be ${bytes} bytes.`);
  }
  return `0x${body.toLowerCase()}` as `0x${string}`;
}

function normalizeHexQuantity(value: unknown, label: string) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return `0x${value.toString(16)}` as `0x${string}`;
  }
  if (typeof value !== 'string') throw new Error(`${label} is missing.`);
  const normalized = value.trim();
  if (/^0x[0-9a-f]+$/i.test(normalized)) {
    return `0x${BigInt(normalized).toString(16)}` as `0x${string}`;
  }
  if (/^\d+$/.test(normalized)) {
    return `0x${BigInt(normalized).toString(16)}` as `0x${string}`;
  }
  throw new Error(`${label} must be a non-negative integer.`);
}

function packOutpoint(txHash: `0x${string}`, index: `0x${string}`) {
  const indexValue = BigInt(index);
  if (indexValue > 0xffff_ffffn) throw new Error('Last-hop output index exceeds u32.');
  const indexBytes = indexValue
    .toString(16)
    .padStart(8, '0')
    .match(/../g)
    ?.reverse()
    .join('');
  return `0x${txHash.slice(2)}${indexBytes}` as `0x${string}`;
}

function normalizeOutpoint(value: unknown): EncryptedOffer['lastHop']['channel_outpoint'] {
  if (isJsonObject(value)) {
    return packOutpoint(
      normalizeHexBytes(value.tx_hash ?? value.txHash, 'Last-hop transaction hash', 32),
      normalizeHexQuantity(value.index, 'Last-hop output index'),
    );
  }
  if (typeof value === 'string' && /^0x[0-9a-f]{72}$/i.test(value.trim())) {
    return value.trim().toLowerCase() as `0x${string}`;
  }
  throw new Error('Last-hop channel outpoint is missing or malformed.');
}

function normalizeLastHop(value: unknown): EncryptedOffer['lastHop'] {
  if (!isJsonObject(value)) throw new Error('Last-hop hint is missing.');
  if (normalizeHexBytes(value.pubkey, 'Last-hop public key', 33) !== bottle.pubkey) throw new Error('Last-hop hint must identify Bottle.');
  return {
    pubkey: normalizeHexBytes(value.pubkey, 'Last-hop public key', 33),
    channel_outpoint: normalizeOutpoint(value.channel_outpoint ?? value.channelOutpoint),
    fee_rate: normalizeHexQuantity(value.fee_rate ?? value.feeRate, 'Last-hop fee rate'),
    tlc_expiry_delta: normalizeHexQuantity(
      value.tlc_expiry_delta ?? value.tlcExpiryDelta,
      'Last-hop expiry delta',
    ),
  };
}

export async function createOffer(seller: FiberBrowserNode, sellerChannel: Channel, plaintext: string) {
  if (!sellerChannel.channel_outpoint) {
    throw new Error('Seller channel does not have a confirmed outpoint.');
  }
  const encrypted = await encryptResult(plaintext);
  return JSON.stringify(await invoiceChunk(seller, sellerChannel, encrypted), null, 2);
}

export async function createChunkInvoices(seller: FiberBrowserNode, channel: Channel, chunks: string[]) {
  const offers = [];
  for (const encrypted of await encryptChunks(chunks)) {
    offers.push(await invoiceChunk(seller, channel, encrypted));
  }
  return offers;
}

async function invoiceChunk(seller: FiberBrowserNode, sellerChannel: Channel, encrypted: Awaited<ReturnType<typeof encryptResult>>) {
  if (!sellerChannel.channel_outpoint) throw new Error('Seller channel does not have a confirmed outpoint.');
  const invoice = await seller.newInvoice({
    amount: '0x5f5e100', // 1 CKB
    currency: 'Fibt',
    payment_preimage: encrypted.key,
    hash_algorithm: 'sha256',
    allow_trampoline_routing: true,
    description: 'Encrypted data payment tutorial',
    expiry: '0xe10',
  });
  const offer: EncryptedOffer = {
    version: 2,
    cipher: 'AES-256-GCM',
    ...encrypted.payload,
    invoice: invoice.invoice_address,
    paymentHash: invoice.invoice.data.payment_hash,
    lastHop: {
      pubkey: sellerChannel.pubkey,
      channel_outpoint: normalizeOutpoint(sellerChannel.channel_outpoint),
      fee_rate: normalizeHexQuantity(
        sellerChannel.tlc_fee_proportional_millionths,
        'Last-hop fee rate',
      ),
      tlc_expiry_delta: normalizeHexQuantity(
        sellerChannel.tlc_expiry_delta,
        'Last-hop expiry delta',
      ),
    },
  };
  return offer;
}

export function parseOffer(value: string) {
  const offer: unknown = JSON.parse(value);
  if (!isJsonObject(offer) || offer.version !== 2 || offer.cipher !== 'AES-256-GCM') {
    throw new Error('Create a fresh version 2 AES-256-GCM encrypted offer.');
  }
  if (typeof offer.invoice !== 'string' || !offer.invoice.toLowerCase().startsWith('fibt')) {
    throw new Error('Encrypted offer is missing a Fiber testnet Invoice.');
  }
  return {
    version: 2,
    cipher: 'AES-256-GCM',
    ciphertext: normalizeHexBytes(offer.ciphertext, 'Ciphertext'),
    iv: normalizeHexBytes(offer.iv, 'AES-GCM IV', 12),
    invoice: offer.invoice,
    paymentHash: normalizeHexBytes(offer.paymentHash, 'Invoice payment hash', 32),
    lastHop: normalizeLastHop(offer.lastHop),
  } satisfies EncryptedOffer;
}

export async function createDocumentOffer(seller: FiberBrowserNode, channel: Channel, chunks: string[], preview: string) {
  const invoices = await createChunkInvoices(seller, channel, chunks);
  return JSON.stringify({
    version: 3,
    cipher: 'AES-256-GCM',
    preview,
    chunks: invoices.map(({ version, cipher, ...chunk }, offset) => ({ index: offset + 1, ...chunk })),
  }, null, 2);
}

export function parseDocumentOffer(value: string) {
  const document: unknown = JSON.parse(value);
  if (isJsonObject(document) && document.version === 2) {
    return { preview: '', chunks: [{ index: 1, ...parseOffer(value) }] };
  }
  if (!isJsonObject(document) || document.version !== 3 || document.cipher !== 'AES-256-GCM'
    || typeof document.preview !== 'string' || !Array.isArray(document.chunks)
    || document.chunks.length < 1 || document.chunks.length > 100) {
    throw new Error('Enter a valid chunked AES-256-GCM offer.');
  }
  const hashes = new Set<string>();
  const ivs = new Set<string>();
  const chunks = document.chunks.map((chunk: unknown, offset: number) => {
    if (!isJsonObject(chunk) || chunk.index !== offset + 1) throw new Error('Invalid chunk index.');
    const offer = parseOffer(JSON.stringify({ ...chunk, version: 2, cipher: document.cipher }));
    if (hashes.has(offer.paymentHash) || ivs.has(offer.iv)) throw new Error('Duplicate chunk payment hash or IV.');
    hashes.add(offer.paymentHash);
    ivs.add(offer.iv);
    return { index: offset + 1, ...offer };
  });
  return { preview: document.preview, chunks };
}
