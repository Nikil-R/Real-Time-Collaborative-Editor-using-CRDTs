/** Typed client for the workspace REST API (docs/04-PROTOCOL.md section 8). */
import { API_URL } from "./config";
import { getName } from "./identity";

export interface FileInfo {
  id: string;
  name: string;
  created_at: string | null;
}

export interface ProjectInfo {
  id: string;
  name: string;
  files: FileInfo[];
}

export interface ActivityEvent {
  id: number;
  ts: string;
  actor: string;
  kind: "edit" | "file_created" | "file_renamed" | "file_deleted";
  file_id: string | null;
  file_name: string | null;
  count: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  try {
    headers["X-Actor"] = encodeURIComponent(getName());
  } catch {
    /* no localStorage during server rendering */
  }
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) {
    let message = `request failed (${res.status})`;
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body.detail === "string") message = body.detail;
    } catch {
      /* keep the generic message */
    }
    throw new ApiError(res.status, message);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const api = {
  createProject: (name: string) =>
    request<ProjectInfo>("/api/projects", { method: "POST", body: JSON.stringify({ name }) }),
  getProject: (id: string) => request<ProjectInfo>(`/api/projects/${id}`),
  createFile: (projectId: string, name: string) =>
    request<FileInfo>(`/api/projects/${projectId}/files`, {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  renameFile: (projectId: string, fileId: string, name: string) =>
    request<FileInfo>(`/api/projects/${projectId}/files/${fileId}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),
  deleteFile: (projectId: string, fileId: string) =>
    request<void>(`/api/projects/${projectId}/files/${fileId}`, { method: "DELETE" }),
  claimSeed: (fileId: string) =>
    request<{ text: string | null }>(`/api/files/${fileId}/claim-seed`, { method: "POST" }),
};
