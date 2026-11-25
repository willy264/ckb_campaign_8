# Pay as you verify recording

Save the recording as `docs/pay-as-you-verify-demo.mp4`. Start after funding and channel setup, with both channels ready and enough inbound liquidity for two payments. Keep the recording silent. Cut payment waits as needed to stay near 2 minutes 10 seconds.

1. **10 seconds.** Show Buyer A and Seller C together with both CHANNEL_READY labels and their balances.
2. **12 seconds.** Show the Seller textarea with the four-paragraph sample, Chunk count 4, and Preview length 200.
3. **15 seconds.** Click Encrypt & create chunk invoices. Copy the generated offer and show the formatted JSON with its preview and four indexed entries. Collapse each JSON entry if needed to fit all four in view.
4. **13 seconds.** Paste the offer into Received offer and click Validate offer. Show the opening, zero paid, and all four locked rows.
5. **10 seconds.** Click Decrypt without key on chunk 1. Frame the rejection message and the zero-paid total with the locked rows.
6. **15 seconds.** Click Pay 1 CKB on chunk 1 and wait for settlement. Open its Payment receipt and show the amount, routing fee, and full hash.
7. **12 seconds.** Show the unlocked chunk 1 heading and readable text in the Buyer panel. Keep chunk 2 visible below.
8. **15 seconds.** Click Pay 1 CKB on chunk 2. After settlement, open its Payment receipt and show its amount, fee, and hash.
9. **14 seconds.** Show both unlocked headings, chunk 2 text, and the updated paid amount with two unlocked and two left.
10. **14 seconds.** End on an overview with chunks 1 and 2 unlocked and chunks 3 and 4 locked. Leave both remaining pay buttons untouched.
