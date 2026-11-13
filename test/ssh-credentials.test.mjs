// Credential store: makes `~/.ssh/config` hosts usable without dsh-ssh-tunnel.
//
// The plugin keeps its own secrets file next to its other data. These tests pin
// down the two rules that matter: a stored password turns an otherwise
// unusable config host into a usable one, and the secret never leaks into a
// host record returned to the client.

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listHosts, readLocalCredentials, writeLocalCredential } from '../lib/ssh.js'

const root = await mkdtemp(join(tmpdir(), 'dsh-lw-cred-'))
const homeDir = join(root, 'home')
const sshDir = join(homeDir, '.ssh')
const dataDir = join(root, 'ssh-tunnel') // deliberately absent: no SSH Manager
const credentialFile = join(root, 'data', 'ssh-credentials.json')
const keyFile = join(sshDir, 'id_test')

try {
  await mkdir(sshDir, { recursive: true })
  await writeFile(keyFile, '-----BEGIN OPENSSH PRIVATE KEY-----\nnot a real key\n-----END OPENSSH PRIVATE KEY-----\n', 'utf8')
  await writeFile(join(sshDir, 'config'), [
    'Host with-key',
    '  HostName 10.0.0.21',
    '  User dev',
    '  Port 22',
    `  IdentityFile "${keyFile}"`,
    '',
    'Host no-key',
    '  HostName 10.0.0.22',
    '  User dev',
    '  Port 2222',
    '',
  ].join('\n'), 'utf8')

  const before = await listHosts({ homeDir, dataDir, credentialFile })
  const withKey = before.find((host) => host.id === 'sshconfig:with-key')
  const noKey = before.find((host) => host.id === 'sshconfig:no-key')
  assert.ok(withKey, 'the IdentityFile host is discovered')
  assert.ok(noKey, 'the key-less host is discovered')
  assert.equal(withKey.authType, 'privateKey')
  assert.equal(withKey.hasCredential, true)
  assert.equal(noKey.authType, 'agent', 'without a key the host falls back to agent')
  assert.equal(noKey.hasCredential, false, 'and it is not usable yet')
  assert.equal(noKey.hasStoredPassword, undefined)

  assert.equal(await writeLocalCredential(credentialFile, 'sshconfig:no-key', { password: 'p@ss word' }), true)
  assert.equal(existsSync(credentialFile), true)
  const rawStore = JSON.parse(await readFile(credentialFile, 'utf8'))
  assert.equal(rawStore.version, 1)
  assert.equal(rawStore.byHostId['sshconfig:no-key'].password, 'p@ss word')

  const after = await listHosts({ homeDir, dataDir, credentialFile })
  const noKeyAfter = after.find((host) => host.id === 'sshconfig:no-key')
  assert.equal(noKeyAfter.authType, 'password', 'a stored password becomes the auth type')
  assert.equal(noKeyAfter.hasCredential, true, 'and makes the host selectable')
  assert.equal(noKeyAfter.hasStoredPassword, true)

  const withKeyAfter = after.find((host) => host.id === 'sshconfig:with-key')
  assert.equal(withKeyAfter.authType, 'privateKey', 'a usable key still wins over a stored password')
  assert.equal(withKeyAfter.hasStoredPassword, undefined)

  // No record, and no API payload, may carry the secret itself.
  assert.equal(JSON.stringify(after).includes('p@ss word'), false, 'host records never include the password')

  // Editing keeps the entry; clearing removes it and restores the old state.
  await writeLocalCredential(credentialFile, 'sshconfig:no-key', { password: 'second' })
  assert.equal((await readLocalCredentials(credentialFile))['sshconfig:no-key'].password, 'second')
  assert.equal(await writeLocalCredential(credentialFile, 'sshconfig:no-key', null), false)
  assert.deepEqual(await readLocalCredentials(credentialFile), {})
  const cleared = (await listHosts({ homeDir, dataDir, credentialFile })).find((host) => host.id === 'sshconfig:no-key')
  assert.equal(cleared.authType, 'agent')
  assert.equal(cleared.hasCredential, false)

  // An unknown id is rejected instead of silently writing a broken entry.
  await assert.rejects(() => writeLocalCredential(credentialFile, '   ', { password: 'x' }), /host id is required/)

  console.log('PASS — local SSH credential store')
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
