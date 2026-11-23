import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

// В продакшене обязательно задайте JWT_SECRET в переменных окружения
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

export const hashPassword = (password) => bcrypt.hashSync(password, 10);
export const verifyPassword = (password, hash) => bcrypt.compareSync(password, hash);

export function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, SECRET, {
    expiresIn: '30d',
  });
}

export function verifyToken(token) {
  if (!token) return null;
  try {
    return jwt.verify(token, SECRET);
  } catch {
    return null;
  }
}
