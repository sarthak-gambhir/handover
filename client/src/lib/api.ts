import { normalizeSlug } from "./slug";

export interface PublicMember {
  user_id: string;
  display_name: string;
  is_owner: boolean;
  online: boolean;
  // Base64 SPKI of the member's ECDH public key, used to wrap the bucket
  // content key for them. Absent until the member's socket has identified.
  pubkey?: string;
}

export interface PublicBucketEntry {
  id: string;
  name: string;
  size: number;
  content_type: string;
  uploader_id: string;
  created_at: number;
}

export interface InviteSummary {
  code: string;
  created_at: number;
  expires_at: number;
}

export interface Snapshot {
  slug: string;
  owner_user_id: string;
  knocking_paused: boolean;
  frozen: boolean;
  you: PublicMember;
  members: PublicMember[];
  bucket: PublicBucketEntry[];
}

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    let code = `http_${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) code = body.error;
    } catch {
      // ignore non-JSON error bodies
    }
    throw new ApiError(res.status, code);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  createSession(display_name: string) {
    return request<{ slug: string; owner_user_id: string }>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ display_name }),
    });
  },

  knock(slug: string, display_name: string) {
    return request<{ knock_id: string }>(
      `/api/sessions/${normalizeSlug(slug)}/knock`,
      {
        method: "POST",
        body: JSON.stringify({ display_name }),
      }
    );
  },

  cancelKnock(slug: string, knock_id: string) {
    return request<void>(
      `/api/sessions/${normalizeSlug(slug)}/knock/${encodeURIComponent(knock_id)}`,
      { method: "DELETE" }
    );
  },

  createInvite(slug: string) {
    return request<{ code: string; expires_at: number }>(
      `/api/sessions/${normalizeSlug(slug)}/invites`,
      { method: "POST" }
    );
  },

  listInvites(slug: string) {
    return request<{ invites: InviteSummary[]; cap: number }>(
      `/api/sessions/${normalizeSlug(slug)}/invites`
    );
  },

  revokeInvite(slug: string, code: string) {
    return request<void>(
      `/api/sessions/${normalizeSlug(slug)}/invites/${encodeURIComponent(code)}`,
      { method: "DELETE" }
    );
  },

  redeemInvite(slug: string, code: string, display_name: string) {
    return request<{ slug: string; owner_user_id: string; user_id: string }>(
      `/api/sessions/${normalizeSlug(slug)}/invites/${encodeURIComponent(code)}`,
      { method: "POST", body: JSON.stringify({ display_name }) }
    );
  },

  snapshot(slug: string) {
    return request<Snapshot>(`/api/sessions/${normalizeSlug(slug)}`);
  },

  deleteFile(slug: string, id: string) {
    return request<void>(`/api/sessions/${normalizeSlug(slug)}/files/${id}`, {
      method: "DELETE",
    });
  },

  deleteOrphanedFiles(slug: string) {
    return request<{ removed: number }>(
      `/api/sessions/${normalizeSlug(slug)}/orphaned-files`,
      {
        method: "DELETE",
      }
    );
  },

  deleteMemberFiles(slug: string, user_id: string) {
    return request<{ removed: number }>(
      `/api/sessions/${normalizeSlug(slug)}/members/${encodeURIComponent(user_id)}/files`,
      { method: "DELETE" }
    );
  },

  turn(slug: string) {
    return request<{ iceServers: RTCIceServer[] }>(
      `/api/turn?slug=${encodeURIComponent(normalizeSlug(slug))}`
    );
  },

  downloadUrl(slug: string, id: string): string {
    return `/api/sessions/${normalizeSlug(slug)}/files/${id}`;
  },
};
