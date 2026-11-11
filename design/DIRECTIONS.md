# Three directions for Ankora

2026-11-10. Pick one. All three share the same screens, navigation and controls, so the tap counts in `FLOWS.md` are identical across them. What changes is type, colour, density and one signature move, which is all a working app should take from a visual world.

## What all three refuse

- **The DeFi default:** near-black ground, neon accent, glass cards, a big APY number, a health-factor gauge. That is Rhea's and every lending market's screen, and its health gauge is exactly the thing Ankora removes.
- **The calm-finance opposite:** cream paper, serif display, terracotta accent.
- **Spectra Finance:** I could not open spectra.finance from the browser pane (blocked by site permissions), so this is from what I know of it: a dark UI with violet and prism/spectrum motifs. None of the three uses a spectrum, prism, rainbow gradient, or violet on dark. "Ankora" is never drawn as light or a spectrum.

## Shared system (all directions)

| Token | Value |
|---|---|
| Spacing | 4 px base: 4, 8, 12, 16, 20, 24, 32, 40, 56 |
| Type scale | fixed rem, ratio about 1.2: 12, 13, 15 (body), 17, 20, 24, 30, 40; display numerals 56–112 |
| Touch target | 48 px minimum, primary action 56 px |
| Layout | phone: one column, primary action docked above the tab bar. Desktop ≥ 960 px: nav rail, task column (max 480 px), context column showing the loan's timeline |
| Colour space | OKLCH; no pure black or white; neutrals tinted to each direction's hue |
| State colour | danger (renewal notice, overdue) and warning (price would fail a check today) only; never decorative |
| Motion | `--ease-out: cubic-bezier(0.23,1,0.32,1)`, `--ease-drawer: cubic-bezier(0.32,0.72,0,1)`. Press 120 ms scale 0.97. Sheets 360 ms drawer curve, exit 200 ms. Nothing over 300 ms except the one signature moment. `prefers-reduced-motion` keeps fades and drops movement |
| Icons | one authored 24 px set, 1.75 stroke, round caps |

## A. Due Date

**Thesis.** A Ankora loan works like a library loan: a due date, automatic renewal, a notice if something is wrong, grace, a late fee. So the loan is shown as its due-date slip. The screen leads with a date, never a price.

**World.** Cool white paper, stamp-pad ultramarine ink, vermilion only for "overdue". Ruled slip rows; each event in the loan's life is a stamped date.

| Role | Token |
|---|---|
| Ground / second layer / surface | `oklch(0.975 0.005 262)` / `oklch(0.948 0.011 262)` / `oklch(0.993 0.003 262)` |
| Ink (primary, stamps) | `oklch(0.46 0.2 263)` |
| Text / secondary | `oklch(0.21 0.03 264)` / `oklch(0.45 0.03 264)` |
| Overdue / warning | `oklch(0.55 0.21 27)` / `oklch(0.6 0.14 65)` |
| Type | Schibsted Grotesk (UI, all weights); Martian Mono, condensed width, for every date and amount |
| Radius | 8 / 12 / 16 |

**Signature move.** The next price check is a stamped date (`10 DEC`) at display size, with a strip of one cell per day of the term under it, filled as days pass. Past events are solid stamps, future ones outlined, a notice is a vermilion stamp.

**Motion.** A new date lands like a stamp: 1.06 → 1 scale, blur 2 px → 0, 220 ms ease-out. Screens cross-fade with a 6 px rise.

**Raises from the roll** (disciplines borrowed from rejected alternatives, not their looks):
- *From the acetate manual:* one layer above the page at a time. Rank comes from layering, never from more boxes.
- *From the dance score:* length is duration. The day strip has exactly as many cells as the term has days; the notice timeline draws 72 h, 48 h and 24 h to scale.
- *From the spectrogram rail:* state is form, not just hue. Done is solid, scheduled is outlined, overdue is solid vermilion with an icon, so nothing relies on colour alone.
- *From the ticket wallet:* nothing disappears, it cancels. A repaid loan stays in history, stamped REPAID.

**Honest risk.** Library and stamp references can read nostalgic; the build has to stay crisp (no ink texture, no rotation, no paper grain) or it slides back toward "2010".

## B. Line

**Thesis.** A loan is a train line. It only stops at stations, and stations are the only places a price is read. Between stations nothing can stop it, which is the wick argument drawn as a map.

**World.** A night network map: blue-black ground, flat transit colours, white station rings. Each band on the menu is a line with its own colour.

| Role | Token |
|---|---|
| Ground / second layer / surface | `oklch(0.17 0.012 248)` / `oklch(0.2 0.014 248)` / `oklch(0.235 0.016 248)` |
| Text / secondary | `oklch(0.96 0.006 248)` / `oklch(0.77 0.012 248)` |
| 30 line (30 days) | `oklch(0.74 0.13 240)` blue |
| 40 line (14 days) | `oklch(0.86 0.15 92)` yellow |
| 50 line (7 days) | `oklch(0.73 0.17 50)` orange |
| Notice branch | `oklch(0.66 0.2 25)` red, dashed until active |
| Type | Archivo variable: width 100 for UI, width 82 semibold for station names, tabular numerals |
| Radius | pills for actions, 14 for panels |

**Signature move.** The loan's term drawn as a line in its band colour: borrowed station, a "you are here" ring at today's position, the price-check station, then "renews". From the check station a dashed red branch shows the notice path (notice 72 h, grace 48 h, auction 24 h); it lights only if a check fails.

**Motion.** The line draws on once when a loan starts (stroke 600 ms ease-out). The "you are here" ring breathes three times, then stops. Screens slide 12 px in the direction of travel.

**Scene.** Dark is chosen for the moment the product earns its keep: a holder checking their phone at 1 am in a crash, at low brightness.

**Honest risk.** Dark plus bright colours sits closest to the DeFi default; it holds only if the colours stay flat (no glow) and the line map does the work.

## C. Next

**Thesis.** Airport signs show the one decision ahead and nothing else. Ankora's ADHD rule is the same rule, so the app is signed like a concourse: a single yellow band is always the next thing to do.

**World.** Light concourse grey, signal yellow reserved for the next step and nothing else, black panels with white pictograms, monumental numerals.

| Role | Token |
|---|---|
| Ground / second layer / surface | `oklch(0.94 0.004 250)` / `oklch(0.905 0.005 250)` / `oklch(0.985 0.002 250)` |
| Sign yellow / ink on yellow | `oklch(0.87 0.175 93)` / `oklch(0.2 0.02 90)` |
| Panel black / text | `oklch(0.21 0.008 250)` / `oklch(0.19 0.01 250)` |
| Danger | `oklch(0.56 0.21 27)` |
| Type | Atkinson Hyperlegible Next (built for legibility at a glance) for everything; Atkinson Hyperlegible Mono for numerals |
| Radius | 4 / 6: signs are square-cornered |

**Signature move.** The next-step band: full-width yellow, black pictogram square on the left, one line of text, an arrow. On the loan screen the number of days to the price check is set at gate-number scale (112 px). When nothing needs doing the band turns grey and says so.

**Motion.** The band's text changes with a split-flap: each character flips in, 12 ms stagger, 180 ms. Screens cut without fades, as signs do.

**Honest risk.** Yellow and black is also Binance's palette. It stays distinct only while yellow is a ground with black type, never yellow text on black, and only for the next step.

## The pick

If I had to ship one, **B. Line**: it is the only direction where the signature move *is* the USP (stations are the only places a price is read). Its risk is familiarity: dark crypto screens are the category default, and it has to earn its place by the map, not the palette. **A** is the strongest fit for the renewal mechanics (due date, renewal, notice, grace, late fee map one to one). **C** is the strongest fit for the ADHD rule.
