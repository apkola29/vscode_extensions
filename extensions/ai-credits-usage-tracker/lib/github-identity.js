'use strict';

const SCOPES = ['read:user'];

async function githubIdentity(authentication, preferredAccountId) {
  const accounts = await authentication.getAccounts('github');
  const account = preferredAccountId
    ? accounts.find((a) => a.id === preferredAccountId)
    : accounts.length === 1 ? accounts[0] : undefined;
  if (!account) {
    return {
      status: accounts.length > 1 ? 'ambiguous' : 'signedOut',
      label: accounts.length > 1 ? 'Select the GitHub account you use with Copilot' : 'No GitHub sign-in available in this window',
    };
  }
  const session = await authentication.getSession('github', SCOPES, { account, silent: true });
  if (session && session.account.id !== account.id) throw new Error('GitHub sign-in did not match the selected account');
  // Return only account metadata. Authentication secrets never enter a worker, webview, settings, or log.
  return { status: 'signedIn', id: account.id, label: account.label };
}

async function connectGitHub(authentication, account) {
  const session = await authentication.getSession('github', SCOPES, { account, createIfNone: true });
  if (!session) throw new Error('GitHub sign-in was not completed');
  if (account && session.account.id !== account.id) throw new Error('GitHub sign-in did not match the selected account');
  return { status: 'signedIn', id: session.account.id, label: session.account.label };
}

module.exports = { githubIdentity, connectGitHub };
