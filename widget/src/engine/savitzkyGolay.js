/**
 * Savitzky-Golay smoothing and differentiation.
 *
 * A least-squares polynomial is fitted over a sliding window and evaluated (or
 * differentiated) at its centre. Because the fit is linear in the samples, the
 * whole operation collapses to a single fixed convolution kernel.
 *
 * WHY THIS AND NOT A FINITE DIFFERENCE
 *
 * Differentiating this log's velocity naively produced accelerations of
 * +/-35 m/s2 — over 3 g, and physically impossible for the car. The SG
 * derivative of the same signal gives p1/p99 of -6.6/+5.6 m/s2 with a peak of
 * 11.5, and widening the window from 31 to 201 samples moves p1 by only
 * 0.26 m/s2. That stability is the test that matters: it says the estimate is
 * converged, not merely smoothed until it looks calm.
 *
 * PHASE
 *
 * A centred SG kernel is symmetric, so it has zero phase lag — but it needs
 * samples from the future. That is legal here because coaching output is
 * emitted at the END of a lap, over a completed buffer. The live layer, which
 * cannot see ahead, must use `filterCausal` and accept the stated group delay.
 */

/**
 * Convolution kernel for the `deriv`-th derivative.
 *
 * Rows of the pseudo-inverse of the Vandermonde matrix give the polynomial
 * coefficients as linear combinations of the samples; row `deriv` times
 * `deriv!` and divided by the spacing gives that derivative at the centre.
 */
export function savitzkyGolayKernel(window, order, deriv, spacing) {
  if (window % 2 === 0) throw new Error('Savitzky-Golay window must be odd')
  if (order >= window) throw new Error('Polynomial order must be below the window length')

  const half = (window - 1) / 2
  // Vandermonde: A[i][j] = z_i^j for z from -half..half
  const A = []
  for (let i = -half; i <= half; i++) {
    const row = new Array(order + 1)
    let power = 1
    for (let j = 0; j <= order; j++) { row[j] = power; power *= i }
    A.push(row)
  }

  // Normal equations: (AᵀA) c = Aᵀ y. Solve for the row we need rather than
  // forming the full pseudo-inverse — (order+1) is at most 4 or 5 here.
  const n = order + 1
  const AtA = Array.from({ length: n }, () => new Array(n).fill(0))
  for (let j = 0; j < n; j++) {
    for (let k = 0; k < n; k++) {
      let sum = 0
      for (let i = 0; i < window; i++) sum += A[i][j] * A[i][k]
      AtA[j][k] = sum
    }
  }
  const inverse = invertMatrix(AtA)

  let factorial = 1
  for (let i = 2; i <= deriv; i++) factorial *= i
  const scale = factorial / spacing ** deriv

  const kernel = new Array(window)
  for (let i = 0; i < window; i++) {
    let value = 0
    for (let k = 0; k < n; k++) value += inverse[deriv][k] * A[i][k]
    kernel[i] = value * scale
  }
  return kernel
}

/** Gauss-Jordan inversion. Matrices here are at most 5x5. */
function invertMatrix(matrix) {
  const n = matrix.length
  const a = matrix.map((row, i) => [
    ...row,
    ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  ])
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row
    }
    if (Math.abs(a[pivot][col]) < 1e-12) throw new Error('Singular matrix in SG kernel')
    ;[a[col], a[pivot]] = [a[pivot], a[col]]
    const d = a[col][col]
    for (let j = 0; j < 2 * n; j++) a[col][j] /= d
    for (let row = 0; row < n; row++) {
      if (row === col) continue
      const factor = a[row][col]
      if (factor === 0) continue
      for (let j = 0; j < 2 * n; j++) a[row][j] -= factor * a[col][j]
    }
  }
  return a.map((row) => row.slice(n))
}

/**
 * Apply a centred SG filter. Edges are handled by reflecting the signal about
 * its endpoints, which avoids the ramp a zero-pad would fabricate there.
 */
export function savitzkyGolay(values, { window = 31, order = 3, deriv = 0, spacing = 0.01 } = {}) {
  const n = values.length
  if (n === 0) return []
  // Fall back gracefully on a series shorter than the window.
  let win = window
  if (win > n) win = n % 2 === 1 ? n : n - 1
  if (win < order + 2) {
    return deriv === 0 ? [...values] : new Array(n).fill(0)
  }

  const kernel = savitzkyGolayKernel(win, order, deriv, spacing)
  const half = (win - 1) / 2
  const out = new Array(n)
  for (let i = 0; i < n; i++) {
    let sum = 0
    for (let k = -half; k <= half; k++) {
      // Reflect: index -1 maps to 1, index n maps to n-2.
      let index = i + k
      if (index < 0) index = -index
      if (index >= n) index = 2 * (n - 1) - index
      if (index < 0) index = 0
      sum += values[index] * kernel[k + half]
    }
    out[i] = sum
  }
  return out
}

/**
 * Causal (one-sided) SG, for the live layer where future samples do not exist.
 * The polynomial is evaluated at the trailing edge of the window instead of its
 * centre, which removes the need to look ahead at the cost of noisier output.
 */
export function filterCausal(values, { window = 31, order = 3, deriv = 0, spacing = 0.01 } = {}) {
  const n = values.length
  if (n === 0) return []
  const win = Math.min(window, n % 2 === 1 ? n : n - 1)
  if (win < order + 2) return deriv === 0 ? [...values] : new Array(n).fill(0)

  // Build a kernel that evaluates at z = +half (the newest sample).
  const half = (win - 1) / 2
  const base = savitzkyGolayKernel(win, order, 0, spacing)
  void base
  const A = []
  for (let i = -half; i <= half; i++) {
    const row = new Array(order + 1)
    let power = 1
    for (let j = 0; j <= order; j++) { row[j] = power; power *= i }
    A.push(row)
  }
  const nCoeff = order + 1
  const AtA = Array.from({ length: nCoeff }, () => new Array(nCoeff).fill(0))
  for (let j = 0; j < nCoeff; j++) {
    for (let k = 0; k < nCoeff; k++) {
      let sum = 0
      for (let i = 0; i < win; i++) sum += A[i][j] * A[i][k]
      AtA[j][k] = sum
    }
  }
  const inverse = invertMatrix(AtA)

  // Evaluate the fitted polynomial (or its derivative) at z = half.
  const evalPowers = new Array(nCoeff).fill(0)
  for (let j = deriv; j < nCoeff; j++) {
    let coefficient = 1
    for (let d = 0; d < deriv; d++) coefficient *= j - d
    evalPowers[j] = coefficient * half ** (j - deriv)
  }

  const kernel = new Array(win).fill(0)
  for (let i = 0; i < win; i++) {
    let value = 0
    for (let j = 0; j < nCoeff; j++) {
      let inner = 0
      for (let k = 0; k < nCoeff; k++) inner += inverse[j][k] * A[i][k]
      value += evalPowers[j] * inner
    }
    kernel[i] = value / spacing ** deriv
  }

  const out = new Array(n)
  for (let i = 0; i < n; i++) {
    let sum = 0
    for (let k = 0; k < win; k++) {
      const index = Math.max(0, i - (win - 1) + k)
      sum += values[index] * kernel[k]
    }
    out[i] = sum
  }
  return out
}

/** Group delay of the causal filter, in seconds — the honest cost of no lookahead. */
export function causalGroupDelaySeconds(window, spacing) {
  return ((window - 1) / 2) * spacing
}
