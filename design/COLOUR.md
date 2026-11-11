# Ankora colour system: 60-30-10

2026-11-11. Applies to the landing page (`design/landing/`) and the app (`design/proto/`, direction B "Line", palette `petrol`).

## The pick: Ink · Petrol · Lemon

| Role | Share | Name | Hex | OKLCH | Where it goes |
|---|---|---|---|---|---|
| Main | 60% | Ink | `#0b0f18` | `oklch(0.17 0.02 262)` | Page and app ground |
| Second | 30% | Petrol | `#003f50` | `oklch(0.34 0.065 222)` | Panels, bands, nav and tab bar, the loan line |
| Loud | 10% | Lemon | `#f8e533` | `oklch(0.91 0.18 103)` | The one next action, "you are here", the selected plan. Nothing else |
| Text | – | Porcelain | `#f0f4f7` | `oklch(0.965 0.006 250)` | Body text on Ink and Petrol |
| Danger | outside the split | Crimson | `#f93f4e` | `oklch(0.65 0.22 22)` | Notice, auction, loss. Never decorative |
| Warning | outside the split | Orange | `#f79643` | `oklch(0.76 0.15 58)` | "The price would fail a check today" (wick state) |

Open it in Coolors: [Ink · Petrol · Lemon](https://coolors.co/0b0f18-003f50-f8e533-f0f4f7-f93f4e). Alternates: [Day](https://coolors.co/f0f4f7-003f50-f8e533-0f141d-d4212d) (Porcelain 60 · Petrol 30 · Lemon 10, for daytime or print) and [Cobalt](https://coolors.co/080d18-142f72-ff8d39-f1f3f8-f83154) (Ink · Cobalt · Tangerine). All three are wired into the prototype's palette switch.

## Why these three

1. **Trust comes from fit and darkness more than from hue.** Labrecque & Milne (2012) link blue to competence and show that saturation and lightness shift brand personality. Bottomley & Doyle (2006) find colours are judged by fit: functional products suit functional colours. Lending is functional, so the main and second colours are dark, low-chroma blue and blue-green.
2. **Blue alone no longer stands out.** FXC Intelligence found blue in 63% of 144 payments brands, and as the primary colour in 42%. Petrol sits in the trusted blue family without being "fintech blue".
3. **The category clichés are close by.** ui-ux-pro-max's "Fintech/Crypto" default is gold on slate with purple. Navy plus gold is the finance reflex, and neon on black is the crypto reflex. Ink plus Petrol plus Lemon avoids all three, but only if Lemon stays a small, flat signal (no glow, no gradients, no gold).
4. **Lemon is the ADHD rule made visible.** On any screen, the one lemon thing is what you do next. It never marks a warning, so it can't be confused with crimson danger or orange warning.
5. **No Rhea or NEAR mint, no Spectra violet.** Green-teal brights and violet/prism looks are kept out.

## Contrast (WCAG 2.x, measured)

| Pair | Ratio | Use |
|---|---|---|
| Porcelain on Ink | 17.3:1 | Body text |
| Porcelain on Petrol | 10.4:1 | Text in panels |
| Secondary text on Petrol | 7.5:1 | Captions in panels |
| Tertiary text on Petrol | 5.4:1 | Smallest labels |
| Ink on Lemon | 14.5:1 | Text on the main button |
| Lemon on Ink | 14.8:1 | The "you are here" dot, links |
| Ink on Crimson | 5.3:1 | Text on danger buttons (white was 3.2:1, so it's ink) |

**Rule:** on the Day ground, Lemon is 1.2:1 against Porcelain. It may only be a filled button with Ink text there, never text or an outline.

## Rules for building

- Count it per screen. If more than one element is Lemon and they ask for different actions, one is wrong.
- Petrol is a surface, not an accent: panels, bands, the tab bar, the loan line. Don't use it for text on Ink (it's too dark).
- Danger and warning are state, not brand. They don't count toward the 60-30-10.
- Tokens live in `design/proto/palettes.css` and at the top of `design/landing/index.html`. In Next.js, map them to CSS custom properties (or a Tailwind theme) with the same names: `--main`, `--second`, `--loud`, `--loud-ink`.

## Not done

- Instagram @quanobaai: blocked by the app's site permissions in the built-in browser (so was coolors.co). To pull palettes from it, drop screenshots into `design/inspo/` and they can be sampled.
- Colour-blind check: the states don't rely on hue alone (icons and text carry them), but no simulator pass has been run.

Sources: [Labrecque & Milne 2012](https://link.springer.com/content/pdf/10.1007/s11747-010-0245-y.pdf), [Bottomley & Doyle 2006](https://orca.cardiff.ac.uk/id/eprint/2579/), [FXC Intelligence on blue in payments branding](https://www.fxcintel.com/research/reports/ct-blue-dominate-payments-industry-branding).
