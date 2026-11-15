/**
 * A tiny test harness. No dependencies — Node's own assert would do, but this
 * prints a readable report and keeps every check on one line.
 */

let passed = 0
let failed = 0
const failures = []
let currentSuite = ''

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const OFF = '\x1b[0m'

export function suite(name) {
  currentSuite = name
  console.log(`\n${BOLD}${name}${OFF}`)
}

function record(ok, label, detail) {
  if (ok) {
    passed++
    console.log(`  ${GREEN}pass${OFF} ${label}`)
  } else {
    failed++
    failures.push(`${currentSuite} → ${label}: ${detail}`)
    console.log(`  ${RED}FAIL${OFF} ${label}`)
    console.log(`       ${DIM}${detail}${OFF}`)
  }
}

/** Deep-ish equality via JSON, which is plenty for the values under test. */
export function equal(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  record(ok, label, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

export function close(label, actual, expected, tolerance = 1e-9) {
  const ok = Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance
  record(ok, label, `got ${actual}, want ${expected} +/- ${tolerance}`)
}

export function truthy(label, value, detail = 'expected a truthy value') {
  record(Boolean(value), label, `${detail} (got ${JSON.stringify(value)})`)
}

/** Renders a component and fails on NaN/undefined/Infinity leaking into markup. */
export function rendersCleanly(label, render) {
  try {
    const html = render()
    const bad = html.match(/.{0,60}(NaN|undefined|Infinity).{0,60}/)
    record(!bad, label, bad ? `output contains: ...${bad[0]}...` : '')
  } catch (error) {
    record(false, label, `threw: ${error.message}`)
  }
}

export function report() {
  const total = passed + failed
  console.log(`\n${BOLD}${'-'.repeat(58)}${OFF}`)
  if (failed === 0) {
    console.log(`${GREEN}${BOLD}All ${total} checks passed.${OFF}\n`)
  } else {
    console.log(`${RED}${BOLD}${failed} of ${total} checks FAILED:${OFF}`)
    for (const line of failures) console.log(`  ${RED}·${OFF} ${line}`)
    console.log()
  }
  return failed === 0 ? 0 : 1
}
