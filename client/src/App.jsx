import React, { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { api, setToken, clearToken } from './api.js';
import Auth from './components/Auth.jsx';
import ChatList from './components/ChatList.jsx';
import ChatWindow from './components/ChatWindow.jsx';

export default function App() {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [chats, setChats] = useState([]);
  const [activeChat, setActiveChat] = useState(null);
  const [online, setOnline] = useState([]);
  const [socket, setSocket] = useState(null);

  const loadChats = () => api('/chats').then(setChats).catch(console.error);

  // Проверяем, есть ли сохранённый токен
  useEffect(() => {
    if (!localStorage.getItem('chat_token')) {
      setChecking(false);
      return;
    }
    api('/me')
      .then(setUser)
      .catch(() => clearToken())
      .finally(() => setChecking(false));
  }, []);

  // Подключаем WebSocket после логина
  useEffect(() => {
    if (!user) return;
    loadChats();
    const s = io({ auth: { token: localStorage.getItem('chat_token') } });
    setSocket(s);

    s.on('users:online', setOnline);
    s.on('message:new', (msg) => {
      setChats((prev) => {
        const idx = prev.findIndex((c) => c.id === msg.chat_id);
        if (idx < 0) return prev;
        const updated = {
          ...prev[idx],
          last_message: msg.text,
          last_time: msg.created_at,
        };
        return [updated, ...prev.filter((c) => c.id !== msg.chat_id)];
      });
    });

    return () => {
      s.disconnect();
      setSocket(null);
    };
  }, [user]);

  function handleLogin(data) {
    setToken(data.token);
    setUser(data.user);
  }

  function handleLogout() {
    clearToken();
    setUser(null);
    setChats([]);
    setActiveChat(null);
    setOnline([]);
  }

  if (checking) return <div className="center-screen">Загрузка...</div>;

  if (!user) return <Auth onLogin={handleLogin} />;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div>
            <div className="logo">Chat Manager</div>
            <div className="my-name">@{user.username}</div>
          </div>
          <button className="icon-btn" onClick={handleLogout} title="Выйти">↪</button>
        </div>
        <ChatList
          chats={chats}
          activeChat={activeChat}
          onSelect={setActiveChat}
          onCreated={loadChats}
          online={online}
          myId={user.id}
        />
      </aside>

      <main className="main">
        {activeChat ? (
          <ChatWindow chat={activeChat} user={user} socket={socket} online={online} />
        ) : (
          <div className="empty-state">
            <div className="empty-icon">💬</div>
            <h2>Выберите чат</h2>
            <p>Или создайте новый — общение начнётся сразу.</p>
          </div>
        )}
      </main>
    </div>
  );
}
