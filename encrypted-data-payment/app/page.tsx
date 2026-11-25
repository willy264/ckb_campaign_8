'use client';

import { channelFundingGuidance, readFundingCapacity } from '../lib/channel-funding';
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
type Opening = { started: number; stages: Record<string, number> };
type PaymentTiming = { started: number; success?: number; seller?: number; buyer?: number };
const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
const stages = [
  ['NEGOTIATING_FUNDING', '0:03', '0:03'],
  ['COLLABORATING_FUNDING_TX', '0:25', '0:22'],
  ['SIGNING_COMMITMENT', '1:00', '0:27'],
  ['AWAITING_TX_SIGNATURES', '—', '—'],
  ['AWAITING_CHANNEL_READY', '1:46', '1:06'],
  ['CHANNEL_READY', '1:51', '1:57'],
];
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
  const [opening, setOpening] = useState<Partial<Record<Role, Opening>>>({});
  const [timings, setTimings] = useState<Record<string, PaymentTiming>>({});
  const [funding, setFunding] = useState<Partial<Record<Role, string>>>({});
  const [now, setNow] = useState(0);
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

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);

  async function checkFunding(role: Role) {
    const node = nodes.current[role];
    if (!node) return;
    try {
      const balance = await readFundingCapacity(node);
      setFunding(previous => ({ ...previous, [role]: balance > 50_000_000_000n
        ? `Funding confirmed (${ckb(balance.toString())} CKB)`
        : `Awaiting sufficient confirmed funding (${ckb(balance.toString())} CKB)` }));
    } catch {
      setFunding(previous => ({ ...previous, [role]: 'Funding check unavailable. Try again.' }));
    }
  }

  function observeChannel(role: Role, channel: Channel) {
    const state = channel.state.state_name;
    const at = Date.now();
    setOpening(previous => {
      const trace = previous[role];
      if (!trace || trace.stages[state] || trace.stages.CHANNEL_READY) return previous;
      const next = { ...trace, stages: { ...trace.stages, [state]: at } };
      localStorage.setItem(`ckb-opening:${channel.channel_id}`, JSON.stringify(next));
      return { ...previous, [role]: next };
    });
  }

  async function refresh(role: Role) {
    const node = nodes.current[role];
    if (!node) return;
    const channel = await readChannel(node);
    if (channel) observeChannel(role, channel);
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
    const existing = await readChannel(started);
    if (existing) {
      const saved = localStorage.getItem(`ckb-opening:${existing.channel_id}`);
      if (saved) setOpening(previous => ({ ...previous, [role]: JSON.parse(saved) }));
      await started.connectPeer(bottle);
    } else void checkFunding(role);
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
    const started = Date.now();
    let active = true;
    async function watch() {
      while (active) {
        const current = await readChannel(node!).catch(() => undefined);
        if (active && current) observeChannel(role, current);
        await new Promise(resolve => window.setTimeout(resolve, 500));
      }
    }
    if (!channels[role]) setOpening(previous => ({ ...previous, [role]: { started, stages: {} } }));
    void watch();
    let channel;
    try { channel = await connectAndOpenChannel(node); }
    finally { active = false; }
    setChannels((previous) => ({ ...previous, [role]: channel }));
    await refresh(role);
    setStatus(channel && ready(channel) ? 'Channel ready.' : 'Opening submitted. Check channel status after confirmation.');
  }

  useEffect(() => {
    if (!(['buyer', 'seller'] as const).some(role => channels[role] && !ready(channels[role]!))) return;
    let active = true;
    async function watch() {
      while (active) {
        for (const role of ['buyer', 'seller'] as const) {
          if (channels[role] && !ready(channels[role]!)) await refresh(role).catch(() => {});
        }
        await new Promise(resolve => window.setTimeout(resolve, 500));
      }
    }
    void watch();
    return () => { active = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channels.buyer?.state.state_name, channels.seller?.state.state_name]);

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
    const started = Date.now();
    const baseline = { buyer: channels.buyer, seller: channels.seller };
    const timing: PaymentTiming = { started };
    const publish = () => setTimings(previous => ({ ...previous, [chunk.paymentHash]: { ...timing } }));
    publish();
    let active = true;
    async function watchLeg(role: Role) {
      const endpoint = nodes.current[role];
      const before = baseline[role];
      if (!endpoint || !before) return;
      while (active && Date.now() - started < 90_000) {
        const current = await readChannel(endpoint).catch(() => undefined);
        if (active && current && current.channel_id === before.channel_id
          && (BigInt(current.local_balance) - BigInt(before.local_balance)) * (role === 'seller' ? 1n : -1n) >= 100_000_000n
          && !current.pending_tlcs.some(tlc => tlc.payment_hash.toLowerCase() === chunk.paymentHash)) {
          timing[role] = Date.now();
          publish();
          return;
        }
        await new Promise(resolve => window.setTimeout(resolve, 250));
      }
    }
    const legs = Promise.all([watchLeg('seller'), watchLeg('buyer')]);
    try {
    const receipt = await payForOffer(node, chunk, attempted ? chunk.paymentHash : '', hash => {
      const next = attempts.filter(value => value !== chunk.paymentHash);
      if (hash) next.push(hash);
      save({ attemptedPaymentHashes: next, attemptedPaymentHash: '' });
      setAttempts(next);
      updateChunk(chunk, { status: hash ? 'paying' : 'failed' });
    }, chunk.receipt?.status === 'Failed');
    if (receipt.status === 'Success') {
      timing.success = Date.now();
      publish();
    }
    await acceptPayment(chunk, receipt);
    if (receipt.status === 'Success') {
      await Promise.race([legs, new Promise(resolve => window.setTimeout(resolve, 10_000))]);
    }
    await Promise.all([refresh('buyer'), refresh('seller')]);
    } finally { active = false; }
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

  return <><div className="app-scroll"><main>
    <p className="eyebrow">Fiber Testnet</p><h1>Pay as you verify</h1>
    {status && <p className="status" role="status">{status}</p>}{error && <p role="alert">{error}</p>}
    <p>Channel opening baseline · A–B 1:51 · C–B 1:57. The last two stages wait for on-chain funding settlement.</p>
    <h2>Testnet funding and channels</h2>
    <div className="grid">{(['buyer', 'seller'] as const).map((role) => <section className="card" key={role}>
      <h2>{role === 'buyer' ? 'Buyer A' : 'Seller C'}</h2>
      {!addresses[role] && <button disabled={!loaded || busy} onClick={() => void run(() => start(role))}>Start node</button>}
      {addresses[role] && <><code>{addresses[role]}</code><a href="https://faucet.nervos.org" target="_blank" rel="noreferrer">Get Testnet CKB â†—</a>
        {!channels[role] && <><p>{channelFundingGuidance}</p><p>{funding[role] ?? 'Funding status unchecked'}</p><button disabled={busy} onClick={() => void run(() => checkFunding(role))}>Check funding status</button></>}
        <button disabled={busy} onClick={() => void run(() => open(role))}>{channels[role] ? 'Reconnect / check channel' : `Open ${channelFundingCkb} CKB channel`}</button>
        <button disabled={busy} onClick={() => void run(() => refresh(role))}>Refresh channel status</button>
      </>}
      {channels[role] && <><code>{channels[role].state.state_name}</code><p>{role === 'buyer' ? 'B to A · Buyer A' : 'C to B · Seller C'}: {ckb(channels[role].local_balance)} CKB Â· Bottle: {ckb(channels[role].remote_balance)} CKB</p></>}
      {opening[role] && <ChannelTiming trace={opening[role]} role={role} now={now} />}
    </section>)}</div>
    <section className="card"><h2>Liquidity</h2><button disabled={busy || !channels.seller || !ready(channels.seller) || BigInt(channels.seller.local_balance) < 500_000_000n} onClick={() => void run(moveLiquidity)}>Send / check 5 CKB transfer</button></section>
    <section className="card" aria-label="Amortisation">
      <h2>On-chain setup vs off-chain payments</h2>
      {(() => {
        const buyer = opening.buyer;
        const seller = opening.seller;
        const live = buyer?.stages.CHANNEL_READY && seller?.stages.CHANNEL_READY;
        const setup = live ? buyer.stages.CHANNEL_READY - buyer.started + seller.stages.CHANNEL_READY - seller.started : 228_000;
        const settled = chunks.filter(chunk => chunk.receipt?.status === 'Success');
        const durations = settled.flatMap(chunk => {
          const timing = timings[chunk.paymentHash];
          return timing?.success ? [timing.success - timing.started] : [];
        });
        return <>
          <p>One-time setup, summed across both channels · {seconds(setup)} ({live ? 'observed' : 'measured baseline'})</p>
          <p>Off-chain click to Success · {durations.length ? seconds(durations.reduce((sum, ms) => sum + ms, 0) / durations.length) + ' average across ' + durations.length + ' timed purchases' : '3.98–4.54 s measured baseline'}</p>
          <p>{settled.length ? `${seconds(setup / settled.length)} setup per purchase across ${settled.length} completed purchases` : 'Complete a purchase to calculate setup time per purchase.'}</p>
          <table><thead><tr><th>Purchases</th><th>Setup time per purchase</th></tr></thead><tbody>
            {[1, 2, 3, 4].map(count => <tr key={count} aria-current={count === settled.length ? 'true' : undefined}><td>{count}</td><td>{seconds(setup / count)}</td></tr>)}
          </tbody></table>
        </>;
      })()}
    </section>
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
        {timings[chunk.paymentHash] && <PaymentTimeline timing={timings[chunk.paymentHash]} now={now} active={busy && chunk.status === 'paying'} />}
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
  </main></div><SessionStopwatch /></>;
}

function ChunkResult({ index, text, copy }: { index: number; text: string; copy: (text: string) => void }) {
  const result = useRef<HTMLTextAreaElement>(null);
  return <div className="chunk-result">
    <textarea className="chunk-result-text" ref={result} readOnly aria-label={`Decrypted chunk ${index}`} value={text} />
    <div className="chunk-result-actions"><button onClick={() => {
      const area = result.current;
      if (!area) return;
      area.style.height = '0px';
      area.style.height = `${area.scrollHeight + area.offsetHeight - area.clientHeight}px`;
    }}>Fit to content</button>
    <button onClick={() => copy(text)}>Copy chunk</button></div>
  </div>;
}

function ChannelTiming({ trace, role, now }: { trace: Opening; role: Role; now: number }) {
  const observed = Object.entries(trace.stages).sort((a, b) => a[1] - b[1]);
  const last = observed.at(-1);
  const readyAt = trace.stages.CHANNEL_READY;
  const elapsed = Math.max(0, (readyAt ?? now) - trace.started);
  const expected = role === 'buyer' ? 111_000 : 117_000;
  return <section aria-label="Channel stage timings">
    <h3>Channel stage timings</h3>
    <p>{seconds(elapsed)} elapsed · {readyAt ? 'Ready' : elapsed > expected ? 'Past measured baseline. Check funding confirmation and peer status.' : 'Within measured opening window'}</p>
    <table><thead><tr><th>Stage</th><th>Baseline at</th><th>Observed at</th><th>In stage</th></tr></thead><tbody>
      {stages.map(([stage, buyer, seller]) => {
        const entry = observed.findIndex(([name]) => stage === name);
        const at = trace.stages[stage];
        const end = observed[entry + 1]?.[1] ?? now;
        return <tr key={stage}><td>{stage.toLowerCase().replaceAll('_', ' ')}</td><td>{role === 'buyer' ? buyer : seller}</td>
          <td>{at ? seconds(at - trace.started) : readyAt ? 'Missed by polling' : '—'}</td>
          <td>{at && stage !== 'CHANNEL_READY' ? seconds(Math.max(0, end - at)) : '—'}</td></tr>;
      })}
    </tbody></table>
    {!readyAt && last && <p>Last observed stage {seconds(Math.max(0, now - last[1]))} ago.</p>}
  </section>;
}

function PaymentTimeline({ timing, now, active }: { timing: PaymentTiming; now: number; active: boolean }) {
  const mark = (at?: number) => at ? seconds(at - timing.started) : 'Awaiting observation';
  return <section aria-label="Payment timing">
    <p>Click to Success · {timing.success ? mark(timing.success) : active ? seconds(Math.max(0, now - timing.started)) : 'Success not observed'}</p>
    <p>C to B · {mark(timing.seller)}<br />B to A · {mark(timing.buyer)}<br />
      Settlement gap · {timing.seller && timing.buyer ? seconds(Math.abs(timing.buyer - timing.seller)) : 'Awaiting both legs'}</p>
    <p>Measured baseline · Pending 1.88–2.48 s · Success 3.98–4.54 s · Both legs 7.11 s on payment 1 · Gap about 3.1 s.</p>
  </section>;
}

function SessionStopwatch() {
  const output = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let frame: number;
    const format = (value: number) => String(value).padStart(2, '0');
    function tick(elapsed: number) {
      const hundredths = Math.floor(elapsed / 10);
      const hours = Math.floor(hundredths / 360000);
      const minutes = Math.floor(hundredths / 6000) % 60;
      const seconds = Math.floor(hundredths / 100) % 60;
      const time = `${format(hours)}:${format(minutes)}:${format(seconds)}.${format(hundredths % 100)}`;
      if (output.current && output.current.textContent !== time) output.current.textContent = time;
      frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  return <aside className="session-stopwatch" aria-label="Session stopwatch">
    <span ref={output} role="timer" aria-live="off">00:00:00.00</span>
    <div aria-hidden="true"><span>hr</span><span>min</span><span>sec</span></div>
  </aside>;
}
