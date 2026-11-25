'use client';

import { channelFundingGuidance } from '../lib/channel-funding';
import { useEffect, useRef, useState } from 'react';
import { scriptToAddress, type Channel, type FiberBrowserNode, type GetPaymentResult } from '@fiber-pay/sdk/browser';
import { decryptResult, toHex } from '../lib/crypto';
import { bottle, channelFundingCkb, connectAndOpenChannel, readChannel, ready, startRole } from '../lib/fiber';
import { createDocumentOffer, parseDocumentOffer, type EncryptedOffer } from '../lib/offer';
import { payForOffer, validateOffer } from '../lib/payment';
import { createBrowserNodeSession } from '../lib/node-session';
import { encryptedSessionKey, encryptedBuyerProfile, encryptedSellerProfile, savedNodeIdentifier, readEncryptedProgress, type EncryptedLessonProgress } from '../lib/progress';

import { splitDocument } from '../lib/chunks';

type Chunk = EncryptedOffer & {
  index: number;
  status: 'locked' | 'paying' | 'unlocked' | 'failed';
  receipt?: GetPaymentResult;
  plaintext?: string;
};

type Role = 'buyer' | 'seller';
const ckb = (value: string) => `${Number(BigInt(value)) / 100_000_000}`;
const sample = [
  'Field notes from a weekend on the river. We logged water levels upstream and compared them with the readings at the footbridge. The goal was to identify which measurements could be repeated reliably by another team.',
  'Our first pass started at dawn. The upstream gauge gave consistent readings across three visits, though the shaded bank was noticeably colder. We marked the gauge position and recorded the time of each observation.',
  'At the footbridge we measured a stronger current after midday. We moved the sampling point a few steps downstream, where the bank was stable and each volunteer could reach the same depth.',
  'For the next visit we will repeat the measurements with a second gauge and share the raw readings. The notes include the site layout, the sampling order, and the conditions at each stop.',
].join('\n\n');

export default function Page() {
  const nodes = useRef<Partial<Record<Role, FiberBrowserNode>>>({});
  const sessions = useRef<Partial<Record<Role, ReturnType<typeof createBrowserNodeSession>>>>({});
  const progress = useRef<EncryptedLessonProgress | null>(null);
  const locked = useRef(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [addresses, setAddresses] = useState<Partial<Record<Role, string>>>({});
  const [connected, setConnected] = useState<Partial<Record<Role, boolean>>>({});
  const [channels, setChannels] = useState<Partial<Record<Role, Channel>>>({});
  const [plaintext, setPlaintext] = useState(sample);
  const [generated, setGenerated] = useState('');
  const [received, setReceived] = useState('');
  const [count, setCount] = useState(4);
  const [previewLength, setPreviewLength] = useState(200);
  const [preview, setPreview] = useState('');
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [attempts, setAttempts] = useState<string[]>([]);
  const [tested, setTested] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const saved = readEncryptedProgress(localStorage, localStorage) ?? readEncryptedProgress(sessionStorage, localStorage);
    progress.current = saved;
    if (saved) { setGenerated(saved.generatedOffer); setReceived(saved.buyerOfferText); setAttempts(saved.attemptedPaymentHashes ?? (saved.attemptedPaymentHash ? [saved.attemptedPaymentHash] : [])); setTested(saved.triedWithoutKey); }
    setLoaded(true);
    const owned = sessions.current;
    const stop = () => { for (const session of Object.values(owned)) void session.stop().catch(() => {}); };
    window.addEventListener('pagehide', stop);
    return () => { window.removeEventListener('pagehide', stop); stop(); nodes.current = {}; sessions.current = {}; };
  }, []);

  function save(update: Partial<EncryptedLessonProgress>) {
    const buyerId = savedNodeIdentifier(localStorage, encryptedBuyerProfile);
    const sellerId = savedNodeIdentifier(localStorage, encryptedSellerProfile);
    if (!buyerId || !sellerId) throw new Error('Start both saved nodes before continuing.');
    const next = { version: 1 as const, buyerId, sellerId, generatedOffer: '', buyerOfferText: '', attemptedPaymentHash: '', triedWithoutKey: false, ...progress.current, ...update };
    localStorage.setItem(encryptedSessionKey, JSON.stringify(next));
    progress.current = next;
  }

  async function run(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try { await action(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Action failed. Check status before retrying a transfer.'); }
    finally { locked.current = false; setBusy(false); }
  }

  async function refresh(role: Role) {
    const node = nodes.current[role];
    if (!node) return;
    const channel = await readChannel(node);
    const { peers } = await node.listPeers();
    setConnected((previous) => ({ ...previous, [role]: peers.some(peer => peer.pubkey.replace(/^0x/i, '').toLowerCase() === bottle.pubkey.slice(2)) }));
    setChannels((previous) => ({ ...previous, [role]: channel }));
  }

  async function start(role: Role) {
    if (nodes.current[role]) return;
    const session = sessions.current[role] ??= createBrowserNodeSession();
    let started: FiberBrowserNode | undefined;
    await session.start(role === 'buyer' ? encryptedBuyerProfile : encryptedSellerProfile, async (track) => {
      started = await startRole(role, track);
    });
    if (!started) return;
    nodes.current[role] = started;
    const info = await started.nodeInfo();
    setAddresses((previous) => ({ ...previous, [role]: scriptToAddress(info.default_funding_lock_script, 'testnet') }));
    if (await readChannel(started)) await started.connectPeer(bottle);
    await refresh(role);
  }

  useEffect(() => {
    if (addresses.buyer && received && !chunks.length && progress.current?.buyerOfferText === received) {
      const retry = window.setInterval(() => {
        if (locked.current) return;
        window.clearInterval(retry);
        void run(validate);
      }, 100);
      return () => window.clearInterval(retry);
    }
    // Restore once when the buyer node becomes available.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addresses.buyer]);

  async function open(role: Role) {
    const node = nodes.current[role];
    if (!node) return;
    const channel = await connectAndOpenChannel(node);
    setChannels((previous) => ({ ...previous, [role]: channel }));
    await refresh(role);
    setStatus(channel && ready(channel) ? 'Channel ready.' : 'Opening submitted. Check channel status after confirmation.');
  }

  async function moveLiquidity() {
    const node = nodes.current.seller;
    if (!node) return;
    const id = savedNodeIdentifier(localStorage, encryptedSellerProfile);
    const storageKey = `fiber-docs:encrypted-inbound:${id}`;
    const existing = sessionStorage.getItem(storageKey);
    if (existing === 'submitting') throw new Error('Transfer outcome unknown. Review payment history before sending again.');
    let result: GetPaymentResult;
    if (existing) result = await node.getPayment({ payment_hash: existing as `0x${string}` });
    else {
      sessionStorage.setItem(storageKey, 'submitting');
      result = await node.sendPayment({ target_pubkey: bottle.pubkey, amount: '0x1dcd65000', keysend: true });
      sessionStorage.setItem(storageKey, result.payment_hash);
    }
    if (!['Success', 'Failed'].includes(result.status)) result = await node.waitForPayment(result.payment_hash, { timeout: 60_000, interval: 1_000 });
    if (result.status === 'Failed') sessionStorage.removeItem(storageKey);
    setStatus(`Liquidity transfer: ${result.status}`);
    await refresh('seller');
  }

  async function makeOffer() {
    if (!nodes.current.seller || !channels.seller || !routeReady || generated || attempts.length) return;
    if (!Number.isSafeInteger(previewLength) || previewLength < 0) throw new Error('Enter a non-negative preview length.');
    const parts = splitDocument(plaintext, count);
    const opening = Array.from(plaintext.trim()).slice(0, previewLength).join('');
    const value = await createDocumentOffer(nodes.current.seller, channels.seller, parts, opening);
    save({ generatedOffer: value });
    setGenerated(value);
    setStatus('Chunk invoices created.');
  }

  async function validate() {
    const node = nodes.current.buyer;
    if (!node) return;
    const parsed = parseDocumentOffer(received);
    if (attempts.some(hash => !parsed.chunks.some(chunk => chunk.paymentHash === hash.toLowerCase()))) {
      throw new Error('Restore the offer for the previous payments.');
    }
    for (const chunk of parsed.chunks) await validateOffer(node, chunk);
    save({ buyerOfferText: received });
    setPreview(parsed.preview);
    setChunks(parsed.chunks.map(chunk => ({
      ...chunk,
      status: attempts.includes(chunk.paymentHash) ? 'paying' : 'locked',
    })));
    setStatus('Offer validated.');
    for (const chunk of parsed.chunks) {
      if (!attempts.includes(chunk.paymentHash)) continue;
      try { await checkPayment({ ...chunk, status: 'paying' }); }
      catch { setError('A saved payment could not be restored. Use Check payment status to try again.'); }
    }
  }

  async function testLock(chunk: Chunk) {
    try { await decryptResult(chunk, toHex(crypto.getRandomValues(new Uint8Array(32)))); }
    catch {
      save({ triedWithoutKey: true });
      setTested(true);
      setStatus('Decryption rejected: key unavailable.');
    }
  }

  function updateChunk(chunk: Chunk, update: Partial<Chunk>) {
    setChunks(previous => previous.map(item => item.index === chunk.index ? { ...item, ...update } : item));
  }

  async function pay(chunk: Chunk) {
    const node = nodes.current.buyer;
    if (!node || !tested || !routeReady) return;
    const attempted = attempts.includes(chunk.paymentHash);
    const receipt = await payForOffer(node, chunk, attempted ? chunk.paymentHash : '', hash => {
      const next = attempts.filter(value => value !== chunk.paymentHash);
      if (hash) next.push(hash);
      save({ attemptedPaymentHashes: next, attemptedPaymentHash: '' });
      setAttempts(next);
      updateChunk(chunk, { status: hash ? 'paying' : 'failed' });
    }, chunk.receipt?.status === 'Failed');
    await acceptPayment(chunk, receipt);
    await Promise.all([refresh('buyer'), refresh('seller')]);
  }

  async function acceptPayment(chunk: Chunk, receipt: GetPaymentResult) {
    updateChunk(chunk, { receipt, status: receipt.status === 'Failed' ? 'failed' : 'paying' });
    setStatus(`Chunk ${chunk.index} payment: ${receipt.status}`);
    if (receipt.status === 'Failed') setError(receipt.failed_error ?? 'Payment failed.');
    if (receipt.status !== 'Success') return;
    if (receipt.payment_hash.toLowerCase() !== chunk.paymentHash || !receipt.payment_preimage) {
      throw new Error('The receipt did not return the expected payment preimage.');
    }
    const plaintext = await decryptResult(chunk, receipt.payment_preimage);
    updateChunk(chunk, { status: 'unlocked', plaintext });
  }

  async function checkPayment(chunk: Chunk) {
    const node = nodes.current.buyer;
    if (!node) return;
    await acceptPayment(chunk, await node.getPayment({ payment_hash: chunk.paymentHash }));
  }

  const routeReady = Boolean(connected.buyer && connected.seller && channels.buyer && ready(channels.buyer) && BigInt(channels.buyer.local_balance) >= 100_000_000n && channels.seller && ready(channels.seller) && BigInt(channels.seller.remote_balance) >= 100_000_000n);

  const unlocked = chunks.filter(chunk => chunk.status === 'unlocked').length;
  const paid = chunks.reduce((total, chunk) => chunk.receipt?.status === 'Success'
    ? total + 100_000_000n + BigInt(chunk.receipt.fee) : total, 0n);

  return <main>
    <p className="eyebrow">Fiber Testnet</p><h1>Pay as you verify</h1>
    {status && <p className="status" role="status">{status}</p>}{error && <p role="alert">{error}</p>}
    <div className="grid">{(['buyer', 'seller'] as const).map((role) => <section className="card" key={role}>
      <h2>{role === 'buyer' ? 'Buyer A' : 'Seller C'}</h2>
      {!addresses[role] && <button disabled={!loaded || busy} onClick={() => void run(() => start(role))}>Start node</button>}
      {addresses[role] && <><code>{addresses[role]}</code><a href="https://faucet.nervos.org" target="_blank" rel="noreferrer">Get Testnet CKB â†—</a>
        {!channels[role] && <p>{channelFundingGuidance}</p>}
        <button disabled={busy} onClick={() => void run(() => open(role))}>{channels[role] ? 'Reconnect / check channel' : `Open ${channelFundingCkb} CKB channel`}</button>
        <button disabled={busy} onClick={() => void run(() => refresh(role))}>Refresh channel status</button>
      </>}
      {channels[role] && <><code>{channels[role].state.state_name}</code><p>{role}: {ckb(channels[role].local_balance)} CKB Â· Bottle: {ckb(channels[role].remote_balance)} CKB</p></>}
    </section>)}</div>
    <section className="card"><h2>Liquidity</h2><button disabled={busy || !channels.seller || !ready(channels.seller) || BigInt(channels.seller.local_balance) < 500_000_000n} onClick={() => void run(moveLiquidity)}>Send / check 5 CKB transfer</button></section>
    <div className="grid exchange"><section className="card"><h2>Seller</h2>
      <textarea aria-label="Seller result" disabled={busy || Boolean(generated)} value={plaintext} onChange={e => setPlaintext(e.target.value)} />
      <label>Chunk count <input type="number" min={1} max={100} value={count} disabled={busy || Boolean(generated)} onChange={e => setCount(e.target.valueAsNumber)} /></label>
      <label>Preview length <input type="number" min={0} value={previewLength} disabled={busy || Boolean(generated)} onChange={e => setPreviewLength(e.target.valueAsNumber)} /></label>
      <button disabled={busy || !routeReady || !plaintext.trim() || Boolean(generated || attempts.length)} onClick={() => void run(makeOffer)}>Encrypt & create chunk invoices</button>
      <textarea aria-label="Generated offer" readOnly value={generated} />
      <button disabled={!generated || busy} onClick={() => void run(async () => { await navigator.clipboard.writeText(generated); setStatus('Offer copied.'); })}>Copy offer</button>
    </section><section className="card"><h2>Buyer</h2>
      <textarea aria-label="Received offer" disabled={busy || Boolean(chunks.length || attempts.length)} value={received} onChange={e => { setReceived(e.target.value); setTested(false); }} />
      <button disabled={busy || !received || !addresses.buyer || Boolean(chunks.length)} onClick={() => void run(validate)}>Validate offer</button>
      {chunks.length > 0 && <><h3>Preview</h3><pre>{preview || 'No preview'}</pre></>}
      {chunks.length > 0 && <p>{ckb(paid.toString())} CKB paid (including fees) · {unlocked} unlocked · {chunks.length - unlocked} left</p>}
      {chunks.map(chunk => <article key={chunk.paymentHash}>
        <h3>Chunk {chunk.index} · {chunk.status}</h3>
        {!tested && chunk.index === 1 && <button disabled={busy} onClick={() => void run(() => testLock(chunk))}>Decrypt without key</button>}
        {(chunk.status === 'locked' || chunk.status === 'failed') && <button disabled={busy || !tested || !routeReady} onClick={() => void run(() => pay(chunk))}>Pay 1 CKB</button>}
        {chunk.receipt?.status === 'Success' && <details>
          <summary>Payment receipt</summary>
          <p>Amount 1 CKB · Fee {ckb(chunk.receipt.fee)} CKB</p>
          <code>{chunk.receipt.payment_hash}</code>
        </details>}
        {chunk.status === 'unlocked' && <ChunkResult index={chunk.index} text={chunk.plaintext ?? ''} copy={text => void run(async () => { await navigator.clipboard.writeText(text); setStatus('Chunk copied.'); })} />}
        {chunk.status === 'paying' && <button disabled={busy} onClick={() => void run(() => checkPayment(chunk))}>Check payment status</button>}
      </article>)}
    </section></div>
    {(generated || received) && chunks.every(chunk => chunk.receipt?.status === 'Success' || !attempts.includes(chunk.paymentHash) || chunk.status === 'failed')
      && (chunks.length > 0 || attempts.length === 0) && <button disabled={busy} onClick={() => void run(async () => {
        save({ generatedOffer: '', buyerOfferText: '', attemptedPaymentHash: '', attemptedPaymentHashes: [], triedWithoutKey: false });
        setGenerated(''); setReceived(''); setChunks([]); setAttempts([]); setTested(false); setPreview('');
      })}>Start another offer</button>}
  </main>;
}

function ChunkResult({ index, text, copy }: { index: number; text: string; copy: (text: string) => void }) {
  const result = useRef<HTMLTextAreaElement>(null);
  return <div>
    <textarea ref={result} readOnly aria-label={`Decrypted chunk ${index}`} value={text} />
    <button onClick={() => {
      const area = result.current;
      if (!area) return;
      area.style.height = '0px';
      area.style.height = `${area.scrollHeight + area.offsetHeight - area.clientHeight}px`;
    }}>Fit to content</button>
    <button onClick={() => copy(text)}>Copy chunk</button>
  </div>;
}
