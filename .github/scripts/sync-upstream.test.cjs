'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.join(__dirname, 'sync-upstream.sh');
const scratch = process.env.TMPDIR || path.join(os.homedir(), '.hermes', 'cache', 'scratch');

function git(fixture, cwd, ...args) {
  const result = spawnSync('git', args, {
    cwd,
    env: fixture.env,
    encoding: 'utf8',
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `git ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function identity(fixture, cwd) {
  git(fixture, cwd, 'config', 'user.name', 'Sync Test');
  git(fixture, cwd, 'config', 'user.email', 'sync-test@example.invalid');
}

function commit(fixture, cwd, files, message) {
  for (const [name, content] of Object.entries(files)) {
    const destination = path.join(cwd, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  }
  git(fixture, cwd, 'add', '--', ...Object.keys(files));
  git(fixture, cwd, 'commit', '-m', message);
  return git(fixture, cwd, 'rev-parse', 'HEAD');
}

function fixture(t) {
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'netcatty-sync-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  );
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    // Even a broken implementation must not contact a real remote in these tests.
    GIT_ALLOW_PROTOCOL: 'file',
    LC_ALL: 'C',
  });
  const f = {
    root,
    env,
    origin: path.join(root, 'origin.git'),
    upstream: path.join(root, 'upstream.git'),
    repo: path.join(root, 'checkout'),
    upstreamWork: path.join(root, 'upstream-work'),
  };
  const seed = path.join(root, 'seed');
  git(f, root, 'init', '--bare', '--initial-branch=main', f.origin);
  git(f, root, 'init', '--bare', '--initial-branch=main', f.upstream);
  git(f, root, 'init', '--initial-branch=main', seed);
  identity(f, seed);
  f.base = commit(f, seed, { 'shared.txt': 'base\n' }, 'base');
  git(f, seed, 'push', f.origin, 'HEAD:refs/heads/main');
  git(f, seed, 'push', f.upstream, 'HEAD:refs/heads/main');
  git(f, root, 'clone', f.origin, f.repo);
  git(f, root, 'clone', f.upstream, f.upstreamWork);
  identity(f, f.repo);
  identity(f, f.upstreamWork);
  return f;
}

function advanceUpstream(f, files = { 'upstream.txt': 'upstream change\n' }) {
  const sha = commit(f, f.upstreamWork, files, 'upstream change');
  git(f, f.upstreamWork, 'push', 'origin', 'HEAD:refs/heads/main');
  return sha;
}

function originSha(f) {
  return git(f, f.root, '--git-dir', f.origin, 'rev-parse', 'refs/heads/main');
}

function originFile(f, name) {
  return git(f, f.root, '--git-dir', f.origin, 'show', `refs/heads/main:${name}`);
}

function hook(directory, name, body) {
  fs.writeFileSync(path.join(directory, name), `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, {
    mode: 0o755,
  });
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function runSync(f, overrides = {}) {
  const output = path.join(f.root, 'github-output');
  const trace = path.join(f.root, 'git-trace');
  // A missing implementation acts as a no-op so RED is a behavior assertion,
  // not an ENOENT/module-loading failure.
  const args = fs.existsSync(script) ? [script] : ['-c', ':'];
  const result = spawnSync('bash', args, {
    cwd: f.repo,
    env: {
      ...f.env,
      UPSTREAM_URL: f.upstream,
      GITHUB_OUTPUT: output,
      GIT_TRACE: trace,
      ...overrides,
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.error, undefined);
  const outputText = fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '';
  return {
    ...result,
    outputs: Object.fromEntries(outputText.trim().split('\n').filter(Boolean).map((line) => line.split('='))),
    outputText,
    trace: fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8') : '',
  };
}

function succeeded(result, changed, sha) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.outputs.changed, String(changed), 'changed output must describe the actual synchronization');
  assert.equal(result.outputs.sha, sha, 'sha output must match the synchronized commit');
  assert.equal(result.outputText, `changed=${changed}\nsha=${sha}\n`, 'write exactly one complete success result');
}

function failed(result) {
  assert.notEqual(result.status, 0, 'unsafe synchronization must fail');
  assert.equal(result.outputs.changed, undefined, 'failed synchronization must not report a successful changed result');
  assert.equal(result.outputs.sha, undefined, 'failed synchronization must not publish a success SHA');
}

function assertNoCommitOrPush(result) {
  assert.doesNotMatch(result.trace, /built-in: git (?:commit|push)\b/, 'no-op must not commit or attempt a push');
}

test('up-to-date upstream emits changed=false without a commit or push', (t) => {
  const f = fixture(t);
  const beforeCount = git(f, f.repo, 'rev-list', '--count', 'HEAD');
  const result = runSync(f);
  succeeded(result, false, f.base);
  assert.equal(originSha(f), f.base);
  assert.equal(git(f, f.repo, 'rev-parse', 'HEAD'), f.base);
  assert.equal(git(f, f.repo, 'rev-list', '--count', 'HEAD'), beforeCount);
  assertNoCommitOrPush(result);
});

test('fork-only commits already containing upstream remain a no-op', (t) => {
  const f = fixture(t);
  const fork = commit(f, f.repo, { 'fork.txt': 'fork only\n' }, 'fork only');
  git(f, f.repo, 'push', 'origin', 'HEAD:refs/heads/main');
  const result = runSync(f);
  succeeded(result, false, fork);
  assert.equal(originSha(f), fork);
  assert.equal(git(f, f.repo, 'rev-list', '--count', 'HEAD'), '2');
  assertNoCommitOrPush(result);
});

test('upstream fast-forward is pushed to origin/main and returns its exact SHA', (t) => {
  const f = fixture(t);
  const upstream = advanceUpstream(f);
  const result = runSync(f);
  succeeded(result, true, upstream);
  assert.equal(originSha(f), upstream);
  assert.equal(originFile(f, 'upstream.txt'), 'upstream change');
  assert.equal(git(f, f.repo, 'rev-list', '--count', 'HEAD'), '2');
});

test('divergent non-conflicting histories merge with two parents and retain all files', (t) => {
  const f = fixture(t);
  const fork = commit(f, f.repo, { 'fork.txt': 'keep fork content\n' }, 'fork only');
  git(f, f.repo, 'push', 'origin', 'HEAD:refs/heads/main');
  const upstream = advanceUpstream(f);
  const result = runSync(f);
  const merged = git(f, f.repo, 'rev-parse', 'HEAD');
  succeeded(result, true, merged);
  assert.equal(originSha(f), merged);
  assert.equal(git(f, f.repo, 'show', '-s', '--format=%P', merged), `${fork} ${upstream}`);
  assert.equal(originFile(f, 'shared.txt'), 'base');
  assert.equal(originFile(f, 'fork.txt'), 'keep fork content');
  assert.equal(originFile(f, 'upstream.txt'), 'upstream change');
  assert.equal(git(f, f.repo, 'show', '-s', '--format=%an <%ae>', merged),
    'github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>');
});

test('merge conflict fails without changing origin or reporting success', (t) => {
  const f = fixture(t);
  const fork = commit(f, f.repo, { 'shared.txt': 'fork version\n' }, 'fork conflict');
  git(f, f.repo, 'push', 'origin', 'HEAD:refs/heads/main');
  advanceUpstream(f, { 'shared.txt': 'upstream version\n' });
  const result = runSync(f);
  failed(result);
  assert.equal(originSha(f), fork);
  assert.equal(originFile(f, 'shared.txt'), 'fork version');
  assert.equal(git(f, f.repo, 'rev-parse', 'HEAD'), fork);
  assert.doesNotMatch(result.trace, /built-in: git push\b/);
});

test('server push rejection fails and leaves the real origin unchanged', (t) => {
  const f = fixture(t);
  advanceUpstream(f);
  hook(path.join(f.origin, 'hooks'), 'pre-receive', 'printf "test push denied\\n" >&2\nexit 1');
  const result = runSync(f);
  failed(result);
  assert.match(result.stderr, /test push denied/);
  assert.equal(originSha(f), f.base);
});

test('concurrent non-fast-forward push is rejected and preserves the other writer', (t) => {
  const f = fixture(t);
  const writer = path.join(f.root, 'other-writer');
  git(f, f.root, 'clone', f.origin, writer);
  identity(f, writer);
  const concurrent = commit(f, writer, { 'concurrent.txt': 'keep concurrent change\n' }, 'concurrent writer');
  advanceUpstream(f);
  hook(path.join(f.repo, '.git', 'hooks'), 'pre-push',
    `git -C ${shellQuote(writer)} push origin HEAD:refs/heads/main`);
  const result = runSync(f);
  failed(result);
  assert.match(result.stderr, /rejected|failed to push|cannot lock ref/);
  assert.equal(originSha(f), concurrent);
  assert.equal(originFile(f, 'concurrent.txt'), 'keep concurrent change');
});

test('failed upstream fetch stops before merge or push and emits no success', (t) => {
  const f = fixture(t);
  const result = runSync(f, { UPSTREAM_URL: path.join(f.root, 'missing-upstream.git') });
  failed(result);
  assert.equal(originSha(f), f.base);
  assert.equal(git(f, f.repo, 'rev-parse', 'HEAD'), f.base);
  assert.doesNotMatch(result.trace, /built-in: git (?:merge|push)\b/);
});

test('post-push remote SHA mismatch fails instead of advertising a verified change', (t) => {
  const f = fixture(t);
  const writer = path.join(f.root, 'other-writer');
  git(f, f.root, 'clone', f.origin, writer);
  identity(f, writer);
  const concurrent = commit(f, writer, { 'concurrent.txt': 'post-push writer\n' }, 'post-push writer');
  // Make the competing commit available to the bare origin before its hook runs.
  git(f, writer, 'push', 'origin', 'HEAD:refs/heads/concurrent-fixture');
  hook(path.join(f.origin, 'hooks'), 'post-receive',
    `git update-ref refs/heads/main ${shellQuote(concurrent)}`);
  advanceUpstream(f);
  const result = runSync(f);
  failed(result);
  assert.equal(originSha(f), concurrent);
  assert.equal(originFile(f, 'concurrent.txt'), 'post-push writer');
  assert.match(result.trace, /built-in: git ls-remote\b/);
});
