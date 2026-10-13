import { useEffect, useRef } from 'react';

const params = new URLSearchParams(location.search);
let token = params.get('token') || '';
try { if (token) sessionStorage.setItem('ht', token); else token = sessionStorage.getItem('ht') || ''; } catch { /* ignore */ }
export const TOKEN = token;

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'),
    headers: { 'x-token': TOKEN, 'content-type': 'application/json' },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data as T;
}

export const thumbUrl = (id: number) => `/api/thumb?id=${id}&token=${TOKEN}`;
export const csvUrl = () => `/api/plan/csv?token=${TOKEN}`;

/** Subscribe to server-sent events. Handler is kept fresh without reconnecting. */
export function useEvents(handler: (m: any) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const es = new EventSource(`/api/events?token=${TOKEN}`);
    es.onmessage = (e) => { try { ref.current(JSON.parse(e.data)); } catch { /* ignore */ } };
    return () => es.close();
  }, []);
}
