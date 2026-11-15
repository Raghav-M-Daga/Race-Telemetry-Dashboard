#!/usr/bin/env node
/**
 * Test runner.
 *
 *   npm test           unit tests, then live tests if the server is reachable
 *   npm run test:unit  unit tests only (never needs the server)
 *   npm run test:live  live tests only (requires the PER server on :8081)
 *
 * Node cannot import .jsx directly, so each test file is bundled in memory with
 * esbuild first — the same transform Vite applies in the browser — and the
 * bundle is written next to the source, run, and deleted.
 */

import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import http from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SERVER_ENDPOINT } from '../src/config.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const TEST_DIR = join(ROOT, 'test')

const args = process.argv.slice(2)
const wantsUnit = args.includes('--unit') || !args.some((a) => a === '--live')
const wantsLive = args.includes('--live') || !args.some((a) => a === '--unit')

/** Bundle one test file to a temporary .mjs and return its path. */
async function bundle(entry) {
  const outfile = join(TEST_DIR, `.${entry.replace(/\.mjs$/, '')}.bundle.mjs`)
  await build({
    entryPoints: [join(TEST_DIR, entry)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    jsx: 'automatic',
    // CSS imports exist only for the browser; they carry nothing a test needs.
    loader: { '.css': 'empty' },
    // Left external so the test runs against the installed React, not a copy.
    external: ['react', 'react-dom', 'react-dom/server', 'esbuild'],
    logLevel: 'warning',
  })
  return outfile
}

function run(file) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [file], { stdio: 'inherit' })
    child.on('close', (code) => resolvePromise(code ?? 1))
  })
}

/** Is the PER server up? Used to skip the live suite gracefully. */
function serverIsReachable() {
  return new Promise((resolvePromise) => {
    const request = http.get(SERVER_ENDPOINT, (response) => {
      request.destroy()
      resolvePromise(response.statusCode === 200)
    })
    request.on('error', () => resolvePromise(false))
    request.setTimeout(2500, () => { request.destroy(); resolvePromise(false) })
  })
}

async function runSuite(entry, title) {
  console.log(`\n\x1b[1m\x1b[7m ${title} \x1b[0m`)
  let outfile
  try {
    outfile = await bundle(entry)
    return await run(outfile)
  } catch (error) {
    console.error(`\x1b[31mCould not build ${entry}:\x1b[0m ${error.message}`)
    return 1
  } finally {
    if (outfile) await rm(outfile, { force: true })
  }
}

let exitCode = 0

if (wantsUnit) {
  exitCode = (await runSuite('engine.test.mjs', 'ENGINE — PHASE 1 VALIDATION')) || exitCode
  exitCode = (await runSuite('unit.test.mjs', 'WIDGET UNIT TESTS')) || exitCode
}

if (wantsLive) {
  const reachable = await serverIsReachable()
  if (reachable) {
    exitCode = (await runSuite('live.test.mjs', 'LIVE TESTS (real server)')) || exitCode
  } else if (args.includes('--live')) {
    console.error(`\n\x1b[31mThe PER server is not reachable at ${SERVER_ENDPOINT}.\x1b[0m`)
    console.error('Start it from the repository root, then try again:')
    console.error('  uvicorn server.server:app --host 0.0.0.0 --port 8081\n')
    exitCode = 1
  } else {
    console.log(`\n\x1b[2mSkipping live tests — no server at ${SERVER_ENDPOINT}.`)
    console.log('Start it and re-run to include them: npm run test:live\x1b[0m\n')
  }
}

process.exit(exitCode)
