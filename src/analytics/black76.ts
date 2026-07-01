/**
 * Black-76 options pricer, greeks, and implied-volatility solver (options on FUTURES).
 *
 * Node port of the market-data skill's Python `scripts/greeks.py` (Black-76 branch), the
 * reference implementation. Databento returns NO greeks/IV for futures options, so they are
 * computed here for the live futures-options smile.
 *
 * Conventions (match greeks.py):
 *  - rates / vols are decimals per year (0.05 = 5%, 0.20 = 20%); T is years (calendar).
 *  - delta is w.r.t. the FUTURE price; theta is per YEAR; vega/rho per 1.00 (per 100 pts).
 *  - The IV solver warm-starts from `guess` (e.g. the previous tick's IV) so a per-tick
 *    re-solve on a live chain converges in 1-2 Newton steps instead of the cold ~5.
 */

const INV_SQRT_2PI = 1 / Math.sqrt(2 * Math.PI);

/** erf via Abramowitz & Stegun 7.1.26 (|error| <= 1.5e-7; odd by construction, so
 *  N(x) + N(-x) === 1 exactly). Swap for a higher-precision routine if a tighter match to
 *  the machine-precision Python `math.erf` reference is ever needed. */
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  const y = 1 - poly * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function normPdf(x: number): number {
  return INV_SQRT_2PI * Math.exp(-0.5 * x * x);
}

export interface Greeks {
  price: number;
  delta: number;
  gamma: number;
  vega: number; // per 1.00 vol (per 100 vol pts); /100 for per vol point
  theta: number; // per YEAR; /365 for per calendar day
  rho: number; // per 1.00 rate; /100 for per 1% rate
  d1: number;
  d2: number;
}

export interface Black76Opts {
  r?: number; // risk-free rate (default 0)
  isCall?: boolean; // default true
}

/** Price + greeks of an option on a future F (Black-76). */
export function black76(F: number, K: number, T: number, sigma: number, opts: Black76Opts = {}): Greeks {
  const r = opts.r ?? 0;
  const isCall = opts.isCall ?? true;
  if (F <= 0 || K <= 0 || T <= 0 || sigma <= 0) {
    throw new Error('black76: F, K, T, sigma must be positive');
  }
  const DF = Math.exp(-r * T);
  const sqrtT = Math.sqrt(T);
  const v = sigma * sqrtT;
  const d1 = (Math.log(F / K) + 0.5 * sigma * sigma * T) / v;
  const d2 = d1 - v;
  const sign = isCall ? 1 : -1;
  const nd1 = normPdf(d1);

  const price = DF * sign * (F * normCdf(sign * d1) - K * normCdf(sign * d2));
  const delta = sign * DF * normCdf(sign * d1);
  const gamma = (DF * nd1) / (F * sigma * sqrtT);
  const vega = DF * F * nd1 * sqrtT;
  const theta = -(F * DF * nd1 * sigma) / (2 * sqrtT) + r * price; // b76: only DF & d1/d2 depend on T
  const rho = -T * price; // b76: dPrice/dr = -T * price (only DF depends on r)

  return { price, delta, gamma, vega, theta, rho, d1, d2 };
}

export interface ImpliedVolOpts extends Black76Opts {
  F: number; // forward / futures price (required for Black-76)
  tol?: number; // price tolerance (default 1e-8)
  maxIter?: number; // default 100
  guess?: number | null; // warm-start seed (e.g. previous tick's IV); ignored if out of bracket
}

export interface IvResult {
  sigma: number | null; // null when there is no solution (price below intrinsic)
  iters: number; // Newton/bisection iterations used (0 on the short-circuits)
}

/**
 * Solve implied vol from a market price (Newton step with a bisection fallback, bracketed
 * on [1e-6, 5.0]). Pass `guess` to warm-start the solve; an out-of-bracket guess is ignored.
 */
export function impliedVol(price: number, K: number, T: number, opts: ImpliedVolOpts): IvResult {
  const { F } = opts;
  const r = opts.r ?? 0;
  const isCall = opts.isCall ?? true;
  const tol = opts.tol ?? 1e-8;
  const maxIter = opts.maxIter ?? 100;
  let lo = 1e-6;
  let hi = 5.0;

  const priceAt = (sig: number) => black76(F, K, T, sig, { r, isCall }).price;

  if (price <= priceAt(lo)) return { sigma: null, iters: 0 };
  if (price >= priceAt(hi)) return { sigma: hi, iters: 0 };

  let sig = opts.guess != null && lo < opts.guess && opts.guess < hi ? opts.guess : 0.2;
  for (let i = 1; i <= maxIter; i++) {
    const g = black76(F, K, T, sig, { r, isCall });
    const diff = g.price - price;
    if (Math.abs(diff) < tol) return { sigma: sig, iters: i };
    const vega = g.vega > 1e-12 ? g.vega : 1e-12;
    let next = sig - diff / vega;
    if (!(lo < next && next < hi)) {
      // Newton left the bracket -> bisection
      if (diff > 0) hi = sig;
      else lo = sig;
      next = 0.5 * (lo + hi);
    } else {
      if (diff > 0) hi = sig;
      else lo = sig;
    }
    sig = next;
  }
  return { sigma: sig, iters: maxIter };
}
