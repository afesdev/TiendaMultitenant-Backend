import bcrypt from 'bcryptjs'
import jwt, { type SignOptions, type Secret } from 'jsonwebtoken'
import { config } from './config.js'

const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS ?? 10)
const JWT_SECRET = process.env.JWT_SECRET ?? 'changeme'
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN ?? '1d'

export interface JwtPayload {
  userId: number
  tiendaId: string
  roleId: number
  email: string
  nombre: string
  slug: string
}

export async function hashPassword(plain: string): Promise<string> {
  const salt = await bcrypt.genSalt(BCRYPT_ROUNDS)
  return bcrypt.hash(plain, salt)
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash)
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(
    payload,
    JWT_SECRET as Secret,
    { expiresIn: JWT_EXPIRES_IN as any },
  )
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET as Secret) as JwtPayload
}

