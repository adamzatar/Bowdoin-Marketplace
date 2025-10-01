// bootstrap placeholder — created by setup script
export type ApiError = Error & { status?: number; data?: unknown };

export async function apiFetch<T = unknown>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    credentials: "include",
    cache: "no-store",
  });

  const isJson =
    res.headers.get("content-type")?.includes("application/json") ?? false;

  if (!res.ok) {
    const err: ApiError = Object.assign(
      new Error(`Request failed: ${res.status}`),
      { status: res.status }
    );
    try {
      err.data = isJson ? await res.json() : await res.text();
    } catch {
      // ignore parse errors
    }
    throw err;
  }

  return (isJson ? res.json() : (res.text() as unknown)) as Promise<T>;
}
