'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { githubIdentity, connectGitHub } = require('../lib/github-identity');

test('identity reuses VS Code GitHub sign-in and returns no credentials', async () => {
  const account = { id: 'dynamic-account-id', label: 'signed-in-user' };
  const calls = [];
  const authentication = {
    async getAccounts(provider) { assert.equal(provider, 'github'); return [account]; },
    async getSession(provider, scopes, opts) {
      calls.push({ provider, scopes, opts });
      return { account, accessToken: 'fake-token', id: 'fixture-session' };
    },
  };
  const result = await githubIdentity(authentication);
  assert.deepEqual(result, { status: 'signedIn', id: account.id, label: account.label });
  assert.equal(JSON.stringify(result).includes('fake-token'), false);
  assert.deepEqual(calls, [{ provider: 'github', scopes: ['read:user'], opts: { account, silent: true } }]);
});

test('no signed-in GitHub account does not prompt, request credentials, or invent an identity', async () => {
  let sessionCalls = 0;
  const result = await githubIdentity({
    async getAccounts() { return []; },
    async getSession() { sessionCalls += 1; },
  });
  assert.equal(result.status, 'signedOut');
  assert.equal(sessionCalls, 0);
  assert.equal(result.id, undefined);
});

test('multiple GitHub identities are not silently assigned to Copilot', async () => {
  const accounts = [{ id: 'one', label: 'first' }, { id: 'two', label: 'second' }];
  let selected;
  const authentication = {
    async getAccounts() { return accounts; },
    async getSession(provider, scopes, opts) { selected = opts.account; return { account: selected, accessToken: 'fixture' }; },
  };
  assert.equal((await githubIdentity(authentication)).status, 'ambiguous');
  assert.equal(selected, undefined);
  assert.equal((await githubIdentity(authentication, 'two')).label, 'second');
  assert.deepEqual(selected, accounts[1]);
});

test('the broker cannot switch the selected GitHub account without notice', async () => {
  const authentication = {
    async getAccounts() { return [{ id: 'one', label: 'first' }]; },
    async getSession() { return { account: { id: 'other', label: 'different' }, accessToken: 'fixture' }; },
  };
  await assert.rejects(githubIdentity(authentication), /did not match/);
});

test('explicit account connection uses the native broker, not a PAT or hardcoded username', async () => {
  const account = { id: 'selected-by-user', label: 'chosen-user' };
  const result = await connectGitHub({
    async getSession(provider, scopes, opts) {
      assert.equal(provider, 'github');
      assert.deepEqual(scopes, ['read:user']);
      assert.deepEqual(opts, { account, createIfNone: true });
      return { account, accessToken: 'fixture-token', id: 'fixture-session' };
    },
  }, account);
  assert.deepEqual(result, { status: 'signedIn', id: account.id, label: account.label });
});
