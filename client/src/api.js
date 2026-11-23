const getToken = () => localStorage.getItem('chat_token');

export async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
      ...options.headers,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Ошибка запроса');
  return data;
}

export const setToken = (token) => localStorage.setItem('chat_token', token);
export const clearToken = () => localStorage.removeItem('chat_token');
