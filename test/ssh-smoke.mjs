#!/usr/bin/env node
/*
 * Smoke test for lib/ssh.js against the real lab server.
 *
 *   node test/ssh-smoke.mjs
 *
 * What it does:
 *   1. loads ssh2 through the resilient loader
 *   2. lists hosts from the DSH SSH Manager + ~/.ssh/config (names/sources only)
 *   3. connects to RTX-PRO-6000-1 and proves host key TOFU persistence
 *   4. reads the remote home directory
 *   5. lists /shared_data_ssd1/huangjh and stats a real entry
 *   6. writes, reads back and deletes its own temp file in that directory
 *   7. disposes the connection and prints a timing table
 *
 * Exit code 0 on success, 1 with a clear message on failure.
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import process from 'node:process';

import { listHosts, loadSsh2, RemoteHost, SshError } from '../lib/ssh.js';

const TARGET_HOST_NAME = 'RTX-PRO-6000-1';
const TARGET_DIR = '/shared_data_ssd1/huangjh';
const KNOWN_HOSTS_FILE = path.join(os.tmpdir(), `dshrw-smoke-known-hosts-${process.pid}.json`);

const timings = [];
let tempFilePath = null;

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function rule(char = '=') {
  console.log(char.repeat(72));
}

function step(number, total, text) {
  console.log(`\n[${number}/${total}] ${text}`);
}

function indicator(ok) {
  return ok ? 'ok  ' : 'fail';
}

function formatMode(mode) {
  return `0${(Number(mode) & 0o7777).toString(8)}`;
}

function formatDate(ms) {
  if (!ms) return '-';
  return new Date(ms).toISOString();
}

async function timed(label, fn) {
  const startedAt = performance.now();
  try {
    const value = await fn();
    timings.push({ label, ms: performance.now() - startedAt, ok: true });
    return value;
  } catch (err) {
    timings.push({ label, ms: performance.now() - startedAt, ok: false });
    throw err;
  }
}

function printTimings() {
  console.log('\nTimings');
  rule('-');
  const width = Math.max(...timings.map((entry) => entry.label.length), 8);
  let total = 0;
  for (const entry of timings) {
    total += entry.ms;
    console.log(`  ${indicator(entry.ok)}  ${entry.label.padEnd(width)}  ${entry.ms.toFixed(1).padStart(8)} ms`);
  }
  console.log(`  ${' '.repeat(6)}${'total'.padEnd(width)}  ${total.toFixed(1).padStart(8)} ms`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  rule();
  console.log('dsh-linked-workspace - SSH smoke test');
  console.log(`node ${process.version} on ${process.platform}; cwd ${process.cwd()}`);
  rule();

  // 1. ssh2 loader ----------------------------------------------------------
  step(1, 7, 'Loading the ssh2 module');
  const ssh2 = await timed('loadSsh2', () => loadSsh2());
  console.log(`      ssh2.Client: ${typeof ssh2.Client === 'function' ? 'available' : 'MISSING'}, utils: ${ssh2.utils ? 'available' : '-'}`);

  // 2. host discovery -------------------------------------------------------
  step(2, 7, 'Listing hosts (SSH Manager first, then ~/.ssh/config)');
  const hosts = await timed('listHosts', () => listHosts());
  for (const hostRecord of hosts) {
    console.log(`      ${hostRecord.name.padEnd(22)} ${hostRecord.source}`);
  }
  console.log(`      ${hosts.length} hosts`);
  if (hosts.length === 0) throw new Error('No SSH hosts were discovered in the SSH Manager store or ~/.ssh/config');

  const target =
    hosts.find((entry) => entry.name === TARGET_HOST_NAME && entry.source === 'ssh-manager') ||
    hosts.find((entry) => entry.name === TARGET_HOST_NAME);
  if (!target) {
    const names = hosts.map((entry) => entry.name).join(', ');
    throw new Error(`Host "${TARGET_HOST_NAME}" is not configured. Available hosts: ${names}`);
  }

  // 3. connect + host key trust --------------------------------------------
  step(3, 7, `Connecting to ${target.name} (${target.username}@${target.host}:${target.port})`);
  const remote = new RemoteHost({
    host: target,
    knownHostsFile: KNOWN_HOSTS_FILE,
    connectTimeoutMs: 20000,
    logger: (level, message) => {
      if (level === 'error') console.log(`      [ssh error] ${message}`);
    },
  });

  try {
    await timed('connect', () => remote.connect());
    console.log(`      connected=${remote.connected} authority=${remote.authority}`);

    const store = JSON.parse(await fs.readFile(KNOWN_HOSTS_FILE, 'utf8'));
    const trust = store.byAuthority && store.byAuthority[remote.authority];
    if (!trust || !trust.fingerprint) throw new Error(`Host key TOFU entry for ${remote.authority} was not persisted to ${KNOWN_HOSTS_FILE}`);
    console.log(`      host key remembered: ${trust.fingerprint} (first seen ${formatDate(trust.firstSeen)})`);

    // A second instance must accept the persisted key instead of re-pinning.
    const second = new RemoteHost({ host: target, knownHostsFile: KNOWN_HOSTS_FILE, connectTimeoutMs: 20000 });
    try {
      await timed('reconnect (trusted key)', () => second.connect());
      console.log('      second connection accepted the stored fingerprint (no mismatch)');
    } finally {
      await second.dispose();
    }

    // 4. home directory -----------------------------------------------------
    step(4, 7, 'Resolving the remote home directory');
    const home = await timed('homeDir', () => remote.homeDir());
    console.log(`      /home reported as ${home}`);

    // 5. directory listing --------------------------------------------------
    step(5, 7, `Listing ${TARGET_DIR}`);
    const listing = await timed('listDir', () => remote.listDir(TARGET_DIR));
    const firstEntries = listing.entries.slice(0, 10);
    console.log(`      ${listing.entries.length} entries (first ${firstEntries.length} shown)`);
    for (const entry of firstEntries) {
      console.log(`        ${entry.type.padEnd(7)} ${String(entry.size).padStart(10)}  ${entry.name}`);
    }

    // Stat a real file: prefer one listed at the top level, otherwise look one
    // level down (the target directory itself often only contains directories).
    let statTarget = firstEntries.find((entry) => entry.type === 'file') || null;
    let statOrigin = 'top-level entry';
    if (!statTarget) {
      // Look one level down in up to four sub-directories for a genuine file.
      const searchDirs = firstEntries.filter((entry) => entry.type === 'dir').slice(0, 4);
      for (const dirEntry of searchDirs) {
        try {
          const subListing = await timed(`listDir ${dirEntry.name}/`, () => remote.listDir(dirEntry.path));
          const subFile = subListing.entries.find((entry) => entry.type === 'file');
          if (subFile) {
            statTarget = subFile;
            statOrigin = `inside ${dirEntry.name}/`;
            break;
          }
        } catch (err) {
          console.log(`      could not list ${dirEntry.path}: ${err.message}`);
        }
      }
    }
    if (statTarget) {
      const stat = await timed('stat', () => remote.stat(statTarget.path));
      console.log(
        `      stat ${statTarget.path} (${statOrigin}): type=${stat.type} size=${stat.size} mode=${formatMode(stat.mode)} mtime=${formatDate(stat.mtime)}`,
      );
      if (stat.type !== 'file') throw new Error(`Expected a regular file from stat, got type "${stat.type}"`);
    } else if (firstEntries[0]) {
      const stat = await timed('stat', () => remote.stat(firstEntries[0].path));
      console.log(
        `      no regular file found; stat of directory ${firstEntries[0].path}: type=${stat.type} size=${stat.size} mode=${formatMode(stat.mode)}`,
      );
    } else {
      console.log('      directory is empty; nothing to stat');
    }

    // 6. own temp file round trip -------------------------------------------
    step(6, 7, 'Writing, reading back and deleting its own temp file');
    const stamp = Date.now();
    tempFilePath = path.posix.join(TARGET_DIR, `.dshrw-smoke-${process.pid}-${stamp}.txt`);
    const payload = `dsh-linked-workspace smoke test ${new Date(stamp).toISOString()}\n`;

    const written = await timed('writeFileAtomic', () => remote.writeFileAtomic(tempFilePath, payload, { mode: 0o600 }));
    console.log(`      wrote ${tempFilePath} (${written.size} bytes)`);
    const writtenStat = await timed('stat (temp file)', () => remote.stat(tempFilePath));
    console.log(`      temp file is a ${writtenStat.type} with mode ${formatMode(writtenStat.mode)} (requested 0600)`);
    if (writtenStat.type !== 'file' || (writtenStat.mode & 0o7777) !== 0o600) {
      throw new Error(`Temp file has unexpected type/mode: type=${writtenStat.type} mode=${formatMode(writtenStat.mode)}`);
    }

    const readBack = await timed('readFile', () => remote.readFile(tempFilePath));
    if (readBack.truncated) throw new Error('Read-back of the temp file was unexpectedly truncated');
    if (readBack.data.toString('utf8') !== payload) {
      throw new Error(`Read-back mismatch: wrote ${Buffer.byteLength(payload)} bytes, read ${readBack.data.length} bytes`);
    }
    console.log(`      read back ${readBack.data.length} bytes: content matches, truncated=${readBack.truncated}`);

    await timed('unlink', () => remote.unlink(tempFilePath));
    tempFilePath = null;
    let gone = false;
    try {
      await remote.stat(path.posix.join(TARGET_DIR, `.dshrw-smoke-${process.pid}-${stamp}.txt`));
    } catch (err) {
      gone = err instanceof SshError && err.code === 'FS_NOT_FOUND';
    }
    if (!gone) throw new Error('Temp file still exists after unlink');
    console.log('      deleted; a follow-up stat reports FS_NOT_FOUND');

    // 7. dispose ------------------------------------------------------------
    step(7, 7, 'Disposing the connection');
    await timed('dispose', () => remote.dispose());
    console.log(`      connected=${remote.connected}`);
  } finally {
    if (tempFilePath) {
      try {
        await remote.unlink(tempFilePath);
        console.log(`      cleanup: removed leftover temp file ${tempFilePath}`);
      } catch {
        console.log(`      cleanup: could not remove ${tempFilePath}`);
      }
    }
    try {
      await remote.dispose();
    } catch {
      /* already disposed */
    }
    await fs.unlink(KNOWN_HOSTS_FILE).catch(() => {});
  }

  printTimings();
  console.log('\nRESULT: smoke test passed');
  return 0;
}

let exitCode = 0;
try {
  exitCode = await main();
} catch (err) {
  exitCode = 1;
  console.error('\nRESULT: smoke test FAILED');
  if (err instanceof SshError) {
    console.error(`  ${err.code} (status ${err.status}): ${err.message}`);
  } else {
    console.error(`  ${err && err.message ? err.message : err}`);
  }
  if (process.env.DSH_DEBUG && err && err.stack) console.error(err.stack);
  if (timings.length > 0) printTimings();
}

process.exitCode = exitCode;
