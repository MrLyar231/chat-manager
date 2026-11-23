import React, { useState } from 'react';
import { api } from '../api.js';

export default function Auth({ onLogin }) {
  const [mode, setMode] = useState('register'); // register | login
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');

    if (mode === 'register' && password !== confirm) {
      setError('Пароли не совпадают');
      return;
    }

    setLoading(true);
    try {
      const data = await api(`/${mode}`, {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      onLogin(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const isRegister = mode === 'register';

  return (
    <div className="center-screen">
      <form className="login-card" onSubmit={submit}>
        <div className="login-logo">💬</div>
        <h1>Chat Manager</h1>

        <div className="auth-tabs">
          <button
            type="button"
            className={isRegister ? 'active' : ''}
            onClick={() => { setMode('register'); setError(''); }}
          >
            Регистрация
          </button>
          <button
            type="button"
            className={!isRegister ? 'active' : ''}
            onClick={() => { setMode('login'); setError(''); }}
          >
            Вход
          </button>
        </div>

        <div className="field">
          <span>@</span>
          <input
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="юзернейм"
            maxLength={32}
            autoComplete="username"
          />
        </div>

        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Пароль (минимум 6 символов)"
          maxLength={100}
          autoComplete={isRegister ? 'new-password' : 'current-password'}
        />

        {isRegister && (
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Повторите пароль"
            maxLength={100}
            autoComplete="new-password"
          />
        )}

        <div className="hint">
          Юзернейм: 5–32 символа, латиница, цифры и _
        </div>

        {error && <div className="error">{error}</div>}

        <button type="submit" disabled={loading || !username.trim() || !password}>
          {loading ? 'Подождите...' : isRegister ? 'Создать аккаунт' : 'Войти'}
        </button>
      </form>
    </div>
  );
}
