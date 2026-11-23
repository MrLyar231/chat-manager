import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

export default function ChatWindow({ chat, user, socket, online }) {
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [typingName, setTypingName] = useState(null);
  const bottomRef = useRef(null);
  const typingTimer = useRef(null);

  const addMessage = (msg) =>
    setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));

  useEffect(() => {
    setMessages([]);
    api(`/chats/${chat.id}/messages`).then(setMessages).catch(console.error);
  }, [chat.id]);

  useEffect(() => {
    if (!socket) return;
    const onMessage = (msg) => {
      if (msg.chat_id === chat.id) addMessage(msg);
    };
    const onTyping = ({ userId, username, isTyping }) => {
      if (userId !== user.id) setTypingName(isTyping ? username : null);
    };
    socket.on('message:new', onMessage);
    socket.on('typing', onTyping);
    return () => {
      socket.off('message:new', onMessage);
      socket.off('typing', onTyping);
    };
  }, [socket, chat.id, user.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, typingName]);

  function handleChange(e) {
    const value = e.target.value;
    setText(value);
    socket?.emit('typing', { chatId: chat.id, isTyping: true });
    clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => {
      socket?.emit('typing', { chatId: chat.id, isTyping: false });
    }, 1500);
  }

  async function send(e) {
    e.preventDefault();
    if (!text.trim()) return;
    const value = text;
    setText('');
    clearTimeout(typingTimer.current);
    socket?.emit('typing', { chatId: chat.id, isTyping: false });
    try {
      const msg = await api(`/chats/${chat.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ text: value }),
      });
      addMessage(msg);
    } catch (err) {
      alert(err.message);
    }
  }

  return (
    <div className="chat-window">
      <header className="chat-header">
        <div className="avatar">{chat.is_group ? '👥' : chat.name.charAt(0).toUpperCase()}</div>
        <div>
          <div className="chat-title">{chat.name}</div>
          <div className="chat-subtitle">
            {typingName ? (
              <span className="typing">{typingName} печатает...</span>
            ) : (
              `${chat.members_count || 1} участник(ов)`
            )}
          </div>
        </div>
      </header>

      <div className="messages">
        {messages.length === 0 && (
          <div className="messages-empty">Начните общение — отправьте первое сообщение</div>
        )}
        {messages.map((msg) => {
          const mine = msg.user_id === user.id;
          return (
            <div key={msg.id} className={`bubble-wrap ${mine ? 'mine' : ''}`}>
              <div className="bubble">
                {!mine && <div className="bubble-author">@{msg.username}</div>}
                <div className="bubble-text">{msg.text}</div>
                <div className="bubble-time">{msg.created_at?.slice(11, 16)}</div>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <form className="composer" onSubmit={send}>
        <input
          value={text}
          onChange={handleChange}
          placeholder="Напишите сообщение..."
          maxLength={2000}
        />
        <button type="submit" disabled={!text.trim()}>➤</button>
      </form>
    </div>
  );
}
