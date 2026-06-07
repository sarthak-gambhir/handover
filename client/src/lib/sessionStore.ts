// In-memory, per-load session hints. The session_token is NEVER stored here —
// it lives only in the HttpOnly `st_<slug>` cookie. `tab_id` persists across a
// page refresh via sessionStorage so reconnects from the same tab are treated
// as resumption, not a second-tab collision.

import { randomId } from './id';

const TAB_KEY = 'handover_tab_id';

interface SessionState {
  slug: string | null;
  user_id: string | null;
  display_name: string | null;
  is_owner: boolean;
  knock_id: string | null;
}

const state: SessionState = {
  slug: null,
  user_id: null,
  display_name: null,
  is_owner: false,
  knock_id: null,
};

export const sessionStore = {
  get tabId(): string {
    let id = sessionStorage.getItem(TAB_KEY);
    if (!id) {
      id = randomId();
      sessionStorage.setItem(TAB_KEY, id);
    }
    return id;
  },

  get(): Readonly<SessionState> {
    return state;
  },

  set(patch: Partial<SessionState>): void {
    Object.assign(state, patch);
  },

  reset(): void {
    state.slug = null;
    state.user_id = null;
    state.display_name = null;
    state.is_owner = false;
    state.knock_id = null;
  },
};
