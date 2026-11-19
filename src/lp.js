// A small dense linear-program solver (primal simplex, Bland's rule), for
// problems that start feasible at x = 0 with every row's slack in the basis:
//
//   minimise c·x  subject to  A x + I s = b,  x, s >= 0,  b >= 0
//
// Each row i has a basic variable to start with: column `start[i]` (a slack
// or an "unmet" variable already among the columns of A). Returns x.
// Sized for tens of rows and a few hundred columns.
export function simplexMin(c, A, b, start, maxIter = 5000) {
  const m = A.length, n = c.length;
  const T = A.map((row, i) => { const r = new Float64Array(n + 1); r.set(row); r[n] = b[i]; return r; });
  const basis = start.slice();
  const z = new Float64Array(n + 1); // reduced costs: z[j] = c_j - c_B B^-1 A_j; z[n] = -objective
  for (let j = 0; j <= n; j++) z[j] = j < n ? c[j] : 0;
  for (let i = 0; i < m; i++) { const cb = c[basis[i]]; if (cb) for (let j = 0; j <= n; j++) z[j] -= cb * T[i][j]; }
  for (let it = 0; it < maxIter; it++) {
    let e = -1;
    for (let j = 0; j < n; j++) if (z[j] < -1e-9) { e = j; break; } // Bland: first improving column
    if (e < 0) break;
    let r = -1, best = Infinity;
    for (let i = 0; i < m; i++) {
      const a = T[i][e];
      if (a > 1e-12) { const ratio = T[i][n] / a; if (ratio < best - 1e-12 || (Math.abs(ratio - best) <= 1e-12 && basis[i] < basis[r])) { best = ratio; r = i; } }
    }
    if (r < 0) break; // unbounded (cannot happen with our bounded rows)
    const pr = T[r], pv = pr[e];
    for (let j = 0; j <= n; j++) pr[j] /= pv;
    for (let i = 0; i < m; i++) {
      if (i === r) continue;
      const f = T[i][e];
      if (f) { const row = T[i]; for (let j = 0; j <= n; j++) row[j] -= f * pr[j]; }
    }
    const f = z[e];
    for (let j = 0; j <= n; j++) z[j] -= f * pr[j];
    basis[r] = e;
  }
  const x = new Float64Array(n);
  for (let i = 0; i < m; i++) x[basis[i]] = T[i][n];
  return x;
}
