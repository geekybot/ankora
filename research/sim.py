"""Ankora thesis: re-runnable historical simulation of the live contract on NEAR's daily prices (Binance NEAR/USDT, Oct 2020 to Nov 2026).

    python research/sim.py          # needs numpy, pandas, matplotlib; writes research/charts/*.png and research/results.md

Three questions, each with the bar it must clear (bars from the research rounds, set before the original runs):

1. DIPS. On a lending market with a ~66.5% liquidation line (Rhea's NEAR line), how many liquidations of a passive one-year borrower
   happened on a day when only the intraday low crossed the line and NEAR closed back above the liquidation price? (No bar: a measurement. It is the borrower-side reason to exist.)
2. LENDERS. Run the exact live parameters: plans 30% / 30 days / 9.7%, 40% / 14 days / 10.1%, 50% / 7 days / 11.3%; renewal only at
   50% LTV or below; above it 72 h notice + 48 h grace + a 24 h auction, so the sale lands 6 days after the renewal check. Worst case:
   NO borrower ever pays down, every vault above 50% is auctioned. Bars: Fixed (senior, 6.5%) paid in full in >= 99% of pool-years;
   First-loss (junior, 15% of the pool) mean >= 15% a year and losing money in <= 15% of pool-years.
3. BORROWERS. Same borrowers: how often is each asked to act in a year (Ankora: a renewal above 50%; the 66.5% line: a liquidation)?

Simplifications, all disclosed in THESIS.md: daily closes for Ankora's checks (it reads one price at renewal), daily lows for the
liquidation line; the pool is 90% lent; the senior coupon is paid on the whole senior share (the contract pays it on lent cash only,
which is kinder to First-loss); interest compounds into debt at each renewal; collateral earns 3.4% staking; Ankora keeps 5% of interest.
"""
from pathlib import Path
import numpy as np, pandas as pd

HERE = Path(__file__).parent
df = pd.read_csv(HERE / "data/near_usdt_daily.csv", parse_dates=["date"])
c, lo, dates = df.close.to_numpy(float), df.low.to_numpy(float), df.date.to_numpy()

# live contract parameters (contracts/ankora-core: plans.rs, loans.rs, tranche.rs)
PLANS = [(.30, 30, .097), (.40, 14, .101), (.50, 7, .113)]
RENEW_MAX, SALE_LAG = .50, 6            # 72 h notice + 48 h grace + 24 h auction
SEN, JUN, FEE, UTIL, Y = .065, .15, .05, .90, .034
# the comparison market (Rhea NEAR line, 12-month mean borrow rate)
LIQ, RHEA_RATE = .665, .0891
L0S, OFFS, YEAR = (.20, .25, .30, .35, .40), (0, 7, 14, 21), 365
NDAYS = 21 + YEAR + 30 + SALE_LAG + 1


def ankora_borrower(s, off, L0, cost):
    """One passive borrower from day s+off. Returns (income, loss, debt-days, asked_to_act)."""
    d, Q, Dt = off, 1 / c[s + off], L0
    inc = loss = dd = 0.0
    while True:
        P = c[s + d]
        if d >= off + YEAR:                                   # the year ends: repay, or walk away if underwater
            return inc, loss + max(Dt - Q * P, 0), dd, False
        if Dt / (Q * P) > RENEW_MAX:                          # notice, grace, auction; nobody pays down (worst case)
            return inc, loss + max(Dt - Q * c[s + d + SALE_LAG] * (1 - cost), 0), dd, True
        ltv = Dt / (Q * P)
        _, T, r = next(p for p in PLANS if ltv <= p[0] + 1e-12)
        it = Dt * r * T / YEAR
        inc += it * (1 - FEE); dd += Dt * T / YEAR; Dt += it; Q *= (1 + Y) ** (T / YEAR); d += T


def liquidated_on_line(s, off, L0):
    """Same borrower on a 66.5% liquidation line, priced every day on the low. Returns (liquidated, closed_back_under)."""
    t = np.arange(YEAR + 1); a = s + off
    debt = L0 * np.exp(RHEA_RATE * t / YEAR); g = (1 + Y) ** (t / YEAR)
    low_ltv = debt / (lo[a:a + YEAR + 1] / c[a] * g); close_ltv = debt / (c[a:a + YEAR + 1] / c[a] * g)
    hit = np.nonzero(low_ltv >= LIQ)[0]
    return (False, False) if not len(hit) else (True, close_ltv[hit[0]] < LIQ)


def pool_year(s, cost):
    inc = loss = dd = 0.0; asked = []
    for L0 in L0S:
        for off in OFFS:
            i, l_, d_, a = ankora_borrower(s, off, L0, cost); inc += i; loss += l_; dd += d_; asked.append(a)
    pool = (inc - loss) / dd * UTIL
    jun = max((pool - (1 - JUN) * SEN) / JUN, -1.0)
    return pool, jun, np.mean(asked)


starts = np.arange(0, len(c) - NDAYS, 7)
in_crash = (dates[starts] >= np.datetime64("2021-01-01")) & (dates[starts] <= np.datetime64("2022-12-31"))
rows, series = [], {}
for cost in (.05, .10, .25):
    res = np.array([pool_year(s, cost) for s in starts])
    pool, jun, asked = res[:, 0], res[:, 1], res[:, 2]
    senior_full = jun > -1                                  # junior not wiped out means senior was paid in full
    series[cost] = (jun, senior_full)
    for tag, m in (("all weekly starts", np.ones(len(starts), bool)), ("2021-22 crash", in_crash)):
        rows.append((cost, tag, m.sum(), senior_full[m].mean(), jun[m].mean(), (jun[m] < 0).mean(), jun[m].min(), asked[m].mean()))

# intraday dips and forced events, every start day, the same borrower grid
dip = {}
for L0 in (.30, .40, .50):
    liq = [liquidated_on_line(s, 0, L0) for s in range(0, len(c) - YEAR - 31)]
    n_liq = sum(a for a, _ in liq); dip[L0] = (n_liq / len(liq), sum(b for a, b in liq if a) / max(n_liq, 1))
act_line, act_ank = [], []
for L0 in L0S:
    act_line.append(np.mean([liquidated_on_line(s, 0, L0)[0] for s in starts]))
    act_ank.append(np.mean([ankora_borrower(s, 0, L0, .10)[3] for s in starts]))

# ---------- results.md ----------
out = ["# Simulation results", "", "Generated by `python research/sim.py`. Read [THESIS.md](THESIS.md) for what each number means.", "",
       "## Lenders: the live contract, nobody ever pays down (worst case)", "",
       "| Auction discount | Window | Pool-years | Fixed paid in full | First-loss mean a year | First-loss losing years | First-loss worst year | Borrowers auctioned |",
       "|---|---|---|---|---|---|---|---|"]
for cost, tag, n, sf, jm, jl, jw, a in rows:
    out.append(f"| {cost:.0%} | {tag} | {n} | {sf*100:.1f}% | {jm*100:.1f}% | {jl*100:.1f}% | {jw*100:.0f}% | {a*100:.0f}% |")
out += ["", "Bars: Fixed paid in full >= 99%, First-loss mean >= 15%, First-loss losing <= 15% of pool-years.", "",
        "## Borrowers on a 66.5% liquidation line, priced daily on the low (every start day)", "",
        "| Start LTV | Liquidated within a year | Of those, on a day NEAR closed back above the liquidation price |", "|---|---|---|"]
for L0, (p, w) in dip.items():
    out.append(f"| {L0:.0%} | {p*100:.0f}% | {w*100:.0f}% |")
out += ["", "## How often a passive borrower is asked to act within a year (weekly starts)", "",
        "| Start LTV | 66.5% line: liquidated | Ankora: renewal above 50% |", "|---|---|---|"]
for L0, a, b in zip(L0S, act_line, act_ank):
    out.append(f"| {L0:.0%} | {a*100:.0f}% | {b*100:.0f}% |")
(HERE / "results.md").write_text("\n".join(out) + "\n")
print("\n".join(out))

# ---------- charts ----------
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
INK, MUTED, ACC, RED, GRID = "#18181b", "#71717a", "#e07b1a", "#dc2626", "#e4e4e7"
plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 11, "axes.edgecolor": GRID, "axes.labelcolor": INK, "xtick.color": MUTED,
                     "ytick.color": MUTED, "axes.spines.top": False, "axes.spines.right": False, "axes.grid": True, "axes.axisbelow": True, "grid.color": GRID,
                     "grid.linewidth": .6, "figure.dpi": 110})
CH = HERE / "charts"; CH.mkdir(exist_ok=True)

# 1. intraday dips
fig, ax = plt.subplots(figsize=(8, 4.2))
xs = np.arange(3); liq = [dip[k][0] * 100 for k in dip]; wk = [dip[k][0] * dip[k][1] * 100 for k in dip]
ax.bar(xs, liq, .55, color=GRID, label="Liquidated within a year")
ax.bar(xs, wk, .55, color=ACC, label="...on a day NEAR closed back above the liquidation price")
for x_, a, b in zip(xs, liq, wk):
    ax.text(x_, a + 1.5, f"{a:.0f}%", ha="center", color=INK, fontsize=11)
    ax.text(x_, b / 2, f"{b / a * 100:.0f}% of them", ha="center", color="white", fontsize=10, fontweight="bold")
ax.set_xticks(xs, [f"Start at {k:.0%} LTV" for k in dip]); ax.set_ylim(0, 100); ax.set_ylabel("% of start days, Oct 2020 to Nov 2025")
ax.set_title("A 66.5% liquidation line, priced every day on NEAR's low", loc="left", fontsize=13, color=INK)
ax.legend(frameon=False, loc="upper left", fontsize=10); fig.tight_layout(); fig.savefig(CH / "dips.png"); plt.close(fig)

# 2. lenders through the cycle
sd = pd.to_datetime(dates[starts]); dts = pd.to_datetime(dates)
fig, (a1, a2) = plt.subplots(2, 1, figsize=(10, 6.4), sharex=True, gridspec_kw={"height_ratios": [1, 1.4]})
a1.plot(dts, c, color=INK, lw=1.1); a1.set_yscale("log"); a1.set_ylabel("NEAR / USDT (log)")
a1.set_title("First-loss return for a pool started each week. Live contract, nobody ever pays down", loc="left", fontsize=12.5, color=INK)
for cost, col in ((.10, ACC), (.25, RED)):
    jun, sf = series[cost]
    a2.plot(sd, jun * 100, color=col, lw=1.6, label=f"Auction sells {cost:.0%} under market: Fixed paid in full in {sf.mean()*100:.0f}% of pool-years")
a2.axhline(15, color=MUTED, lw=1, ls="--"); a2.text(sd[-1], 17, "15% bar", ha="right", color=MUTED, fontsize=9)
a2.axhline(0, color=INK, lw=.8); a2.set_ylim(-40, 42)
a2.set_ylabel("First-loss, next 12 months"); a2.yaxis.set_major_formatter(lambda v, _: f"{v:.0f}%")
a2.legend(frameon=False, loc="upper left", fontsize=9.5); a2.text(sd[-1], -38, "Axis cut at -40%: the 25% case loses everything in its worst weeks", ha="right", fontsize=8.5, color=MUTED)
a2.set_xlim(sd[0], dts[-1]); fig.tight_layout(); fig.savefig(CH / "lenders.png"); plt.close(fig)

# 3. rate surface (round 11b output: Merton jump-diffusion fitted on 2020-26, 2-day / 5% sale friction, 90% utilisation)
L = ["30%", "40%", "50%", "60%", "65%"]; T = ["3 days", "7 days", "14 days", "30 days"]
R = np.array([[7.6, 7.6, 7.6, 9.8], [7.6, 8.8, 10.1, 13.7], [10.3, 11.4, 14.0, 22.1], [15.0, 17.6, 25.1, 40.3], [20.5, 25.5, 37.3, 54.2]])
LIVE = {(0, 3), (1, 2), (2, 1)}
fig, ax = plt.subplots(figsize=(8, 4.4))
im = ax.imshow(np.minimum(R, 30), cmap="Oranges", aspect="auto", vmin=5, vmax=30)
for i in range(5):
    for j in range(4):
        ax.text(j, i, f"{R[i, j]:.1f}%", ha="center", va="center", fontsize=11, color="white" if R[i, j] > 20 else INK,
                fontweight="bold" if (i, j) in LIVE else "normal")
        if (i, j) in LIVE: ax.add_patch(plt.Rectangle((j - .48, i - .46), .96, .92, fill=False, ec=INK, lw=2))
ax.set_xticks(range(4), T); ax.set_yticks(range(5), [f"{x} LTV" for x in L]); ax.grid(False)
ax.set_title("Fair yearly rate when the price is read only at renewal (boxed: live plans)", loc="left", fontsize=12, color=INK)
fig.tight_layout(); fig.savefig(CH / "rates.png"); plt.close(fig)
print("charts:", ", ".join(p.name for p in sorted(CH.glob("*.png"))))
