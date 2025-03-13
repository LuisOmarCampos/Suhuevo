import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
/* consts */
import { rounds } from '@app/constants/auth.constants'
import { customLog } from './util.util'
import { RefreshTokenModel } from '@app/repositories/mongoose/models/refreshtoken.model'

export function generatePasswordHash(password: string): string {
  const salt: string = bcrypt.genSaltSync(rounds)
  const hash: string = bcrypt.hashSync(password, salt)
  return hash
}

export function comparePassword(password: string, hashPassword: string): boolean {
  return bcrypt.compareSync(password, hashPassword)
}

export const generateUserToken = async (user: any) => {
  const token = jwt.sign(
    { id: user._id.toString(), role: user.roleId.toString() },
    process.env.JWT_SECRET || "supersecreto",
    { expiresIn: "1h" }
  );

  customLog("🔵 Token generado:", token);

  const refreshToken = jwt.sign(
    { id: user._id.toString(), sessionId: new Date().getTime().toString() }, // 🔹 Se agrega un `sessionId` único
    process.env.JWT_REFRESH_SECRET || "refreshsupersecreto",
    { expiresIn: "7d" }
  );

  // ✅ Insertar un nuevo refreshToken en la BD sin eliminar otros tokens del usuario
  await RefreshTokenModel.create({
    userId: user._id,
    token: refreshToken,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  });

  customLog("🔵 RefreshToken generado y almacenado en la BD:", refreshToken);

  return { token, refreshToken, expiresIn: 3600, refreshExpiresIn: 604800 };
};





export function verifyUserToken<T>(token: string): T {
  return jwt.verify(token, process.env.USER_JWT_SIGNATURE ?? '') as T
}
