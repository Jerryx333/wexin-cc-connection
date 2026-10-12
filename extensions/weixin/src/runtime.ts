/**
 * Runtime state for the WeChat channel plugin.
 * Stores per-account connection state and typing ticket caches.
 */

export type AccountStatus = "disconnected" | "connecting" | "connected" | "error";

type AccountState = {
  status: AccountStatus;
  error?: string;
  abortController?: AbortController;
};

const accountStates = new Map<string, AccountState>();

export function getAccountState(accountId: string): AccountState {
  return accountStates.get(accountId) ?? { status: "disconnected" };
}

export function setAccountState(accountId: string, state: Partial<AccountState>): void {
  const existing = accountStates.get(accountId) ?? { status: "disconnected" };
  accountStates.set(accountId, { ...existing, ...state });
}

export function removeAccountState(accountId: string): void {
  const state = accountStates.get(accountId);
  if (state?.abortController) {
    state.abortController.abort();
  }
  accountStates.delete(accountId);
}
