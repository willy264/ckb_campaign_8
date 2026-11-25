# Pay as you verify

A Build on CKB Campaign #8 Advanced Quest submission. Buy a document one chunk at a time over Fiber on CKB Testnet.

## Why

The original flow releases a key when the buyer pays for the entire document. Successful decryption establishes that the key works for the ciphertext. The buyer still has to judge the value of the content. Here, a clear-text opening and independently payable chunks let the buyer read as they go and stop spending whenever they choose. The supplied measurements put channel readiness near two minutes per channel and payment Success near four seconds. Setup is paid once in time, and each later purchase adds only its off-chain payment time. [Fiber tutorial](https://www.fiber.world/docs/build/encrypted-data-payment)

## What changed

- The seller sets a chunk count and preview length, defaulting to four chunks and 200 characters.
- The splitter prefers paragraph breaks, then sentence boundaries, and uses whitespace when more breaks are needed.
- Each chunk gets independently sampled AES key material and its own IV.
- The JSON offer contains the opening preview and indexed ciphertext, IV, hash, and invoice entries.
- Each buyer row pays separately, unlocks in place, and shows its receipt. The buyer panel counts paid CKB, unlocked chunks, and chunks left.

- The buyer can resize, fit, and copy decrypted text. Saved nodes restore purchased chunks after reload.
- Funding cards show each address and its confirmed funding status. Timers show observed channel stages, endpoint balance settlement, and setup time per purchase.

## What is unchanged

The starter handles node startup, faucet funding, channel opening, and routing through Bottle on Testnet. Each invoice costs 1 CKB and commits to the SHA-256 hash of the AES-256-GCM key. Settlement releases that key as the payment preimage.

## Measured baseline

| Measurement | Baseline |
|---|---|
| A–B channel | 0:03 negotiating → 0:25 → 1:00 → 1:46 awaiting ready → 1:51 ready |
| C–B channel | 0:03 → 0:22 → 0:27 → 1:06 → 1:57 both ready |
| Short payment | 1.88 s pending, 3.98 s Success, 7.11 s both legs settled |
| Long payment | 2.48 s pending, 4.54 s Success |
| Settlement gap | About 3.1 s, C to B first, then B to A |

The final two channel stages wait for on-chain funding settlement. A–B reached the 1:00 observation at one minute, while C–B reached its third observation at 0:27. Text length does not affect the payment payload, which carries the key.

## Run locally

Use Node.js 22.18 or newer and npm. From the cloned repository root, run

```sh
cd encrypted-data-payment
npm install
npm run dev
```

Open http://localhost:3001 in a browser with Web Locks and SharedArrayBuffer. Keep the same browser profile and one app tab so you can reuse saved nodes. [CKB Testnet faucet](https://faucet.nervos.org)

## Try the flow

1. Start Buyer A and Seller C. Fund each node's displayed Testnet address with enough for a 500 CKB channel and its on-chain fee.
2. Open each channel and refresh until both show `CHANNEL_READY`. Check Bottleâ€™s balance on the seller channel. Use the starterâ€™s **Send / check 5 CKB transfer** if inbound liquidity is needed.
3. Keep the sample document or paste your own. Set the chunk count and preview length, then click **Encrypt & create chunk invoices**.
4. Copy the JSON into **Received offer** and click **Validate offer**. Check the preview and the four locked rows.
5. Click **Decrypt without key** on chunk 1 and confirm the rejection.
6. Pay for chunk 1, open its receipt, and read the unlocked text. Repeat for chunk 2.
7. Review the two leg timings and the amortisation panel. Resize an unlocked result or click **Fit to content**, then try **Copy chunk**.
8. Stop with chunks 3 and 4 locked. If a payment is pending or the page was refreshed, validate the saved offer and use **Check payment status** to recover its receipt and text.

## What it does not do

Content quality, authorship, and the relationship between the preview and the paid text depend on the seller. The app has no refunds or dispute process. The clear-text opening can overlap paid chunk text. The demo uses Testnet only. Funding status reflects confirmed spendable capacity. Channel timings can miss brief stages between polls. Leg times come from local channel balance observations and have polling and RPC latency. Reopening a saved browser profile recovers purchased text from Fiber receipts. Payment timing observations are for the current page session.

## Fees

At 0.001 CKB routing fee per payment, the cost is 1.001 CKB per chunk or 1.004 CKB for all four. After two payments the expected total is 2.002 CKB. The app sums actual fees reported by Fiber, which can vary.

## Demo

[Capture shot list](docs/screenshots/SHOTLIST.md) Â· [Recording script](docs/RECORDING.md) Â· [Demo recording, pending capture](docs/pay-as-you-verify-demo.mp4)

![both channels ready with stage timings](docs/screenshots/01-both-channels-ready-with-stage-timings.png)

![seller document and chunk count](docs/screenshots/02-seller-document-and-chunk-count.png)

![offer json four chunks](docs/screenshots/03-offer-json-four-chunks.png)

![buyer preview and four locked chunks](docs/screenshots/04-buyer-preview-and-four-locked-chunks.png)

![decrypt attempt rejected before payment](docs/screenshots/05-decrypt-attempt-rejected-before-payment.png)

![chunk 1 payment receipt fee and hash](docs/screenshots/06-chunk-1-payment-receipt-fee-and-hash.png)

![chunk 1 unlocked and readable](docs/screenshots/07-chunk-1-unlocked-and-readable.png)

![chunk 2 payment receipt two legs timed](docs/screenshots/08-chunk-2-payment-receipt-two-legs-timed.png)

![chunk 2 unlocked running total updated](docs/screenshots/09-chunk-2-unlocked-running-total-updated.png)

![amortisation panel setup vs payment](docs/screenshots/10-amortisation-panel-setup-vs-payment.png)

![resizable result area with long text](docs/screenshots/11-resizable-result-area-with-long-text.png)

![stopped two unlocked two still locked](docs/screenshots/12-stopped-two-unlocked-two-still-locked.png)
