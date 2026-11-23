import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function ChatList({ chats, activeChat, onSelect, onCreated, online, myId }) {
  const [showModal, setShowModal] = useState(false);
  const [name, setName] = useState('');
  const [users, setUsers] = useState([]);
  const [selected, setSelected] = useState([]);

  useEffect(() => {
    if (showModal) api('/users').then(setUsers).catch(console.error);
  }, [showModal]);

  async function create(e) {
    e.preventDefault();
    try {
      await api('/chats', {
        method: 'POST',
        body: JSON.stringify({ name, memberIds: selected }),
      });
      setName('');
      setSelected([]);
      setShowModal(false);
      onCreated();
    } catch (err) {
      alert(err.message);
    }
  }

  function toggle(id) {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  return (
    <>
      <button className="new-chat" onClick={() => setShowModal(true)}>+ Новый чат</button>

      <div className="chat-list">
        {chats.map((chat) => (
          <button
            key={chat.id}
            className={`chat-item ${activeChat?.id === chat.id ? 'active' : ''}`}
            onClick={() => onSelect(chat)}
          >
            <div className="avatar">
              {chat.is_group ? '👥' : chat.name.charAt(0).toUpperCase()}
            </div>
            <div className="chat-info">
              <div className="chat-name">{chat.name}</div>
              <div className="chat-preview">
                {chat.last_message || 'Сообщений пока нет'}
              </div>
            </div>
            {chat.last_time && (
              <div className="chat-time">{chat.last_time.slice(11, 16)}</div>
            )}
          </button>
        ))}
      </div>

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={create}>
            <h3>Новый чат</h3>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Название чата"
              maxLength={40}
            />
            <div className="modal-subtitle">Участники:</div>
            <div className="user-picker">
              {users.length === 0 && <div className="muted">Пока нет других пользователей</div>}
              {users.map((u) => (
                <label key={u.id} className="user-row">
                  <input
                    type="checkbox"
                    checked={selected.includes(u.id)}
                    onChange={() => toggle(u.id)}
                  />
                  <span>@{u.username}</span>
                  {online.includes(u.id) && <span className="dot" title="в сети" />}
                </label>
              ))}
            </div>
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={() => setShowModal(false)}>
                Отмена
              </button>
              <button type="submit" disabled={!name.trim()}>Создать</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
