"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.storage = exports.firestore = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const firebase_admin_1 = __importDefault(require("firebase-admin"));
// Ruta al archivo de credenciales de servicio (compatible con CommonJS)
const serviceAccountPath = node_path_1.default.join(__dirname, 'firebase-service-account.json');
const raw = node_fs_1.default.readFileSync(serviceAccountPath, 'utf8');
const serviceAccount = JSON.parse(raw);
if (!firebase_admin_1.default.apps.length) {
    firebase_admin_1.default.initializeApp({
        credential: firebase_admin_1.default.credential.cert(serviceAccount),
        storageBucket: 'mishell-boutique-admin.firebasestorage.app',
    });
}
exports.firestore = firebase_admin_1.default.firestore();
exports.storage = firebase_admin_1.default.storage();
