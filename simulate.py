"""
MilestoneVault agent-based simulation.

Compares three funding mechanisms under adversarial creators/verifiers:
  A  Upfront payout            (Kickstarter-style: creator gets 100% at funding)
  B  Single-verifier milestones (naive milestone escrow, no dispute/refund path)
  C  MilestoneVault             (tranche cap + challenge window + random reviewer
                                 panel + appeal + auto-refund on lapse)

Metrics (per campaign, % of funds raised):
  loss      = funds paid to creator for work NOT delivered (gross, bond credit ignored)
  stranded  = funds locked forever with no path back to backers
  wrongful  = honest creators wrongly denied (fraction of honest campaigns)

All assumptions are explicit parameters; this is a model, not empirical data.
"""
import random, json, csv, sys
import numpy as np

N = 4
TRANCHES = [0.15, 0.25, 0.30, 0.30]          # tranche 1 capped at 15%
MIX = {"honest": 0.65, "fraud": 0.20, "abandon": 0.15}

P_APPROVE_REAL = 0.98     # honest verifier approves real work
P_REJECT_FAKE = 0.90      # honest verifier rejects fake work
P_REV_CORRECT = 0.85      # honest reviewer votes correctly (per vote)
P_FALSE_CHALLENGE = 0.05  # malicious/mistaken challenge of an honest milestone
P_APPEAL_WRONG = 0.60     # a wrongly-released fake milestone gets appealed
P_APPEAL_HONEST = 0.80    # wrongly-denied honest creator appeals
PANEL, APPEAL_PANEL = 5, 11
WINDOW_D, PANEL_D, APPEAL_D = 3, 7, 7


def draw_type(rng):
    r = rng.random(); acc = 0
    for k, p in MIX.items():
        acc += p
        if r < acc:
            return k
    return "honest"


def panel_vote(rng, size, c, fake):
    """True => panel APPROVES the milestone. Corrupt reviewers collude with the
    creator on fake work and (worst case) against honest creators."""
    corrupt = rng.binomial(size, c)
    honest = size - corrupt
    correct = rng.binomial(honest, P_REV_CORRECT)
    if fake:   # fake work: approve votes = corrupt + honest who erred
        approve = corrupt + (honest - correct)
    else:      # real work: approve votes = honest who were correct
        approve = correct
    return approve > size / 2


def sim_A(rng, t, k):
    if t == "honest":
        return 0.0, 0.0, False
    if t == "fraud":
        return 100.0, 0.0, False
    return 100.0 * (1 - sum(TRANCHES[:k])), 0.0, False


def sim_B(rng, t, k, pc):
    corrupt = rng.random() < pc
    paid_fake = 0.0; stranded = 0.0; denied = False
    if t == "honest":
        for i in range(N):
            if corrupt or rng.random() < P_APPROVE_REAL:
                continue
            denied = True
            stranded = 100.0 * sum(TRANCHES[i:])
            break
        return 0.0, stranded, denied
    if t == "fraud":
        for i in range(N):
            if corrupt or rng.random() > P_REJECT_FAKE:
                paid_fake += 100.0 * TRANCHES[i]
            else:
                stranded = 100.0 * sum(TRANCHES[i:])
                break
        return paid_fake, stranded, False
    # abandon: k real milestones, then stops; no refund path -> remaining stranded
    stranded = 100.0 * sum(TRANCHES[k:])
    return 0.0, stranded, False


def sim_C(rng, t, k, c, q):
    """Returns (loss, stranded, wrongful_denial, added_delay_days)."""
    delay = 0
    if t == "honest":
        for i in range(N):
            delay += WINDOW_D
            if rng.random() < P_FALSE_CHALLENGE:
                delay += PANEL_D
                if panel_vote(rng, PANEL, c, fake=False):
                    continue
                if rng.random() < P_APPEAL_HONEST:
                    delay += APPEAL_D
                    if panel_vote(rng, APPEAL_PANEL, c, fake=False):
                        continue
                return 0.0, 0.0, True, delay
        return 0.0, 0.0, False, delay
    if t == "fraud":
        paid = 0.0
        for i in range(N):
            amt = 100.0 * TRANCHES[i]
            if rng.random() >= q:            # nobody challenges -> optimistic release
                paid += amt; continue
            if not panel_vote(rng, PANEL, c, fake=True):
                break                        # rejected -> refund remaining
            if rng.random() < P_APPEAL_WRONG and not panel_vote(rng, APPEAL_PANEL, c, fake=True):
                break
            paid += amt
        return paid, 0.0, False, 0
    # abandon: k real milestones then lapse -> auto-refund remaining
    return 0.0, 0.0, False, 0


def run(n, c, q, seed):
    rng = np.random.default_rng(seed)
    pyr = random.Random(seed)
    acc = {m: dict(loss=0.0, stranded=0.0, den=0, hon=0) for m in "ABC"}
    delay_sum = 0; delay_n = 0
    for _ in range(n):
        t = draw_type(pyr)
        k = pyr.randint(0, N - 1)
        la, sa, da = sim_A(rng, t, k)
        lb, sb, db = sim_B(rng, t, k, c)
        lc, sc, dc, dl = sim_C(rng, t, k, c, q)
        for m, (l, s, d) in zip("ABC", [(la, sa, da), (lb, sb, db), (lc, sc, dc)]):
            acc[m]["loss"] += l; acc[m]["stranded"] += s
            if t == "honest":
                acc[m]["hon"] += 1; acc[m]["den"] += int(d)
        if t == "honest":
            delay_sum += dl; delay_n += 1
    out = {}
    for m in "ABC":
        out[m] = dict(loss_pct=acc[m]["loss"] / (100.0 * n) * 100,
                      stranded_pct=acc[m]["stranded"] / (100.0 * n) * 100,
                      wrongful_denial_pct=acc[m]["den"] / max(1, acc[m]["hon"]) * 100)
    out["C"]["avg_added_delay_days"] = delay_sum / max(1, delay_n)
    return out


if __name__ == "__main__":
    n = 100_000
    rows = []
    # Sweep 1: corrupt fraction (verifier prob for B, reviewer share for C), q fixed
    for c in [0.0, 0.1, 0.2, 0.3, 0.4]:
        r = run(n, c, 0.8, 7)
        rows.append(dict(sweep="corrupt", c=c, q=0.8, **{f"{m}_{k}": v for m in "ABC" for k, v in r[m].items()}))
    # Sweep 2: challenge probability q, c fixed at 0.2
    for q in [0.2, 0.4, 0.6, 0.8, 0.95]:
        r = run(n, 0.2, q, 11)
        rows.append(dict(sweep="challenge", c=0.2, q=q, **{f"{m}_{k}": v for m in "ABC" for k, v in r[m].items()}))
    keys = sorted({k for r in rows for k in r})
    with open("results.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=keys); w.writeheader(); w.writerows(rows)
    json.dump(rows, open("results.json", "w"), indent=1)
    for r in rows:
        print(r["sweep"], "c=%.2f q=%.2f" % (r["c"], r["q"]),
              "| loss A/B/C = %.1f / %.1f / %.1f" % (r["A_loss_pct"], r["B_loss_pct"], r["C_loss_pct"]),
              "| stranded B/C = %.1f / %.1f" % (r["B_stranded_pct"], r["C_stranded_pct"]),
              "| wrongful B/C = %.2f / %.2f" % (r["B_wrongful_denial_pct"], r["C_wrongful_denial_pct"]),
              "| delayC = %.1f" % r["C_avg_added_delay_days"])
