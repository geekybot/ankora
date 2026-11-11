# Ankora UX rationale

## Revision 2 (2026-11-11): one recommendation

- **Recommended:** direction B "Line" with the Ink · Petrol · Lemon palette (60-30-10), plus a landing page in the same system. Why the colours: `COLOUR.md`. Tap counts: `FLOWS.md`.
- **Landing page** (`design/landing/`): copy from `research_docs/ankora-copy.md` section 3. The first screen proves the claim with a drawn price path: a wick crosses a live liquidation line on day 18, and Ankora reads the price only on day 0 and day 30. The Risks and "When Rhea is the better choice" sections stay long on purpose (the pratfall effect: admitting limits raises trust).
- **App:** rebuilt to the v1 contracts and the copy doc's strings (plain NEAR, 1.5 NEAR reserve, plans named by LTV, repay-part/repay-all notices, repay-to-stop auction, claimable surplus, renewal switch confirmed in the wallet, no deposit queue, risk ticks on both tranches).
- **Motion** (Emil Kowalski's rules): one hero entrance (words rise 14 px, 40 ms apart), the price line draws once in 1.6 s, sections fade up once on scroll, buttons press to 0.97. All of it is off under reduced motion.
- **Not done:** Instagram @quanobaai and coolors.co are blocked in the built-in browser; the landing's `Testnet` tag and footer are `[STATUS]` placeholders until testnet is live; the stressed-terms state isn't shown as its own screen.

---

## Revision 1 (2026-11-10)

2026-11-10. Open `design/index.html` for the side-by-side board, or `design/proto/index.html` for the prototype (top bar: switch direction, jump to a state, run a flow and count its taps). Static PNGs of every key screen are in `design/screens/`.

## What the screens are built around

**A Ankora borrower's risk is a date, not a price.** Every lending app leads with a health factor because a price can liquidate you at any minute. On Ankora a price can only matter at the next check, so the top of the loan screen is that date and the sentence "Nothing to do until Thu 10 Dec." The live price and LTV sit below it, labelled "shown for information only".

That single choice does the USP work on screen: the wick scenario (NEAR at $1.60, LTV 56.3%, above the 50% limit) still says "Nothing to do until 25 Nov" and adds one honest line: if the price is still there on that date, you'll get 72 hours to pay down about 500 USDC.

## Hierarchy, top to bottom, on every screen

1. **The one thing you need to know:** the next price check date, the deadline, or the amount you get.
2. **One sentence of why**, in plain words.
3. **Up to three facts**, each with a source in the docs.
4. **One primary action**, docked above the tab bar on a phone, inline on desktop. When there is nothing to do, the dock says so instead of offering a button.

Secondary actions (Repay, Add collateral, "How this can fail") are visibly secondary. Desktop adds a right-hand column with the loan's timeline; it never adds a second primary action.

## Tap counts (measured by the prototype in all three directions)

| Flow | Taps |
|---|---|
| Borrow with LiNEAR, stNEAR or rNEAR | **3** (target ≤ 3) |
| Borrow against native stake, own validator | **6** + about 28 h guided wait |
| See the loan: next check, LTV against limit | **0** (it is the home screen) |
| Switch auto-renew off | 1 |
| Renewal notice, pay down (default) | **2** |
| Renewal notice, let the vault sell / repay | 3 |
| Repay early | 3 |
| Lend, senior | 4 |
| Lend, junior | 6 (one deliberate acknowledgement) |
| Risk | 1 |

Path for each in `FLOWS.md`. Assumption to check in the build: wallets in Wallet Selector show one approval for a batched `signAndSendTransactions`. If one asks per transaction, the LiNEAR flow becomes 5 taps on that wallet.

## How the low tap counts were reached

- **Defaults that need no thinking.** Home preselects the largest staked asset and the safest band at its maximum (30% LTV, 30 days, about 9.7%). Changing it is optional.
- **The home screen changes with state.** No loan: the offer. Loan: the loan. Failed check: the notice. Unstaking: the wait. The user never has to find the screen that matters.
- **The notice preselects the cheapest way out** that the wallet balance can cover (pay 250 USDC to reach 50%), so the default is 2 taps.
- **One wallet approval per outcome.** Price update, collateral transfer and borrow go in one batch.

## What was cut, and why

| Cut | Why |
|---|---|
| One-tap borrow from home (2 taps) | It would sign a loan from a screen the user didn't choose to open. One extra tap buys a deliberate review with the three facts. |
| Health factor, liquidation price, price chart | They describe a risk Ankora doesn't have. Showing them would teach users to watch the price. |
| A separate term picker step | The three bands sit on the amount slider; picking an amount picks the term. |
| Quote locking during the native unstake | A 24 h stale quote turns 40% LTV into 49.4% at the 99th percentile (G4). The borrow step re-prices; the screen says so. |
| Push notifications in v1 | Needs a backend and permission prompts. The wait screen offers a calendar reminder instead, and home opens on the next step. |
| Partial repay, add collateral, 1Click cross-chain deposit, withdraw | Shown as entry points only; not designed in this round. |
| Connect-wallet and first-visit screens | Wallet Selector's own modal; counting starts after connect, as the brief asked. |
| Utilisation, TVL, APY history | No real numbers exist yet. Inventing them would break "every number has a source". |

## States covered

No loan (both collateral types), loan mid-term, loan during a wick, renewal notice, after a paydown (renewed, with next interest added to debt), repaid, native unstake in progress and ready, lend senior and junior, new loans paused by the 3% spot/EMA breaker, new loans paused for junior cover, disabled actions with the reason shown.

## Numbers used

All mechanism numbers come from `research_docs/`: menu 30/30/9.7, 40/14/10.1, 50/7/11.3, limit 50%; 72 h notice, 48 h grace, 24 h auction; unstake about 28 h, 0.017% of stake; senior 6.5%, junior 15–21% est. and its test results; 60–68% wick share; 53–81% vs 55–85% asked to act; Rhea median 7.8%; breaker 3% and 0.37% of hours; junior lock about 36 days. Balances, prices, the account `alex.near` and the validator `northstar.poolv1.near` are fictional demo data and labelled as such.

## Open risks in the design

- **The 50% limit comes from the round 11 menu, which the docs mark "proposed, not yet adopted".** If round 9's 65% line stays, the meter's limit tick and the paydown maths change; the layouts don't.
- **The vault copy says "designed with no upgrade method and no Ankora keys" and carries a "Not yet built or audited" tag.** Remove the tag only when that's true.
- **Spectra Finance:** its site was blocked in the browser pane, so the "doesn't resemble it" check is from memory, not a side-by-side. Worth one look before choosing.

## Process notes

- Skills: gstack upgraded 1.58.5 → 1.99.0 (needed Bun 1.2.5 → 1.4.4); ui-ux-pro-max, emil-design-eng, design-taste-frontend and impeccable updated. Used impeccable (direction roll, operate-mode rules, craft floor, detector: 0 findings at the end) and emil-design-eng (motion). design-shotgun and design-html were not used: the brief needed working HTML in three directions, not image comps.
- impeccable normally interviews for PRODUCT.md and runs a separate reviewer agent. Neither ran here: PRODUCT.md (`design/PRODUCT.md`) was written from the brief and the docs, and the final review was done in this session.
