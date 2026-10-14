export interface User {
  id: number;
  email: string;
  name: string;
}

export interface Item {
  id: string;
  name: string;
  minutes: number;
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 204) return undefined as T;
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new ApiError(response.status, payload.error ?? `HTTP ${String(response.status)}`);
  return payload as T;
}

export async function currentUser(): Promise<User | null> {
  try {
    return (await request<{ user: User }>('GET', '/session')).user;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export async function signIn(email: string, password: string): Promise<User> {
  return (await request<{ user: User }>('POST', '/session', { email, password })).user;
}

export function signOut(): Promise<void> {
  return request<undefined>('DELETE', '/session');
}

export function listItems(): Promise<{ items: Item[]; port: number }> {
  return request('GET', '/items');
}

export async function addItem(name: string, minutes: number): Promise<Item> {
  return (await request<{ item: Item }>('POST', '/items', { name, minutes })).item;
}
