"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.hashPassword = hashPassword;
exports.verifyPassword = verifyPassword;
exports.signToken = signToken;
exports.verifyToken = verifyToken;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS ?? 10);
const JWT_SECRET = process.env.JWT_SECRET ?? 'changeme';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN ?? '1d';
async function hashPassword(plain) {
    const salt = await bcryptjs_1.default.genSalt(BCRYPT_ROUNDS);
    return bcryptjs_1.default.hash(plain, salt);
}
async function verifyPassword(plain, hash) {
    return bcryptjs_1.default.compare(plain, hash);
}
function signToken(payload) {
    return jsonwebtoken_1.default.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}
function verifyToken(token) {
    return jsonwebtoken_1.default.verify(token, JWT_SECRET);
}
