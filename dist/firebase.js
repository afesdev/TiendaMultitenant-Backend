"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.storage = exports.firestore = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const firebase_admin_1 = __importDefault(require("firebase-admin"));
const { FIREBASE_TYPE, FIREBASE_PROJECT_ID, FIREBASE_PRIVATE_KEY_ID, FIREBASE_PRIVATE_KEY, FIREBASE_CLIENT_EMAIL, FIREBASE_CLIENT_ID, FIREBASE_AUTH_URI, FIREBASE_TOKEN_URI, FIREBASE_AUTH_PROVIDER_CERT_URL, FIREBASE_CLIENT_CERT_URL, FIREBASE_UNIVERSE_DOMAIN, FIREBASE_STORAGE_BUCKET, } = process.env;
let serviceAccount;
if (FIREBASE_PROJECT_ID && FIREBASE_PRIVATE_KEY && FIREBASE_CLIENT_EMAIL) {
    // Modo producción / Render: usar variables de entorno
    serviceAccount = {
        type: FIREBASE_TYPE ?? 'service_account',
        project_id: FIREBASE_PROJECT_ID,
        private_key_id: FIREBASE_PRIVATE_KEY_ID ?? '',
        // Reemplazar los "\n" literales por saltos de línea reales
        private_key: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        client_email: FIREBASE_CLIENT_EMAIL,
        client_id: FIREBASE_CLIENT_ID ?? '',
        auth_uri: FIREBASE_AUTH_URI ?? 'https://accounts.google.com/o/oauth2/auth',
        token_uri: FIREBASE_TOKEN_URI ?? 'https://oauth2.googleapis.com/token',
        auth_provider_x509_cert_url: FIREBASE_AUTH_PROVIDER_CERT_URL ??
            'https://www.googleapis.com/oauth2/v1/certs',
        client_x509_cert_url: FIREBASE_CLIENT_CERT_URL ?? '',
        universe_domain: FIREBASE_UNIVERSE_DOMAIN ?? 'googleapis.com',
    };
}
else {
    // Modo desarrollo local: fallback al archivo JSON
    const serviceAccountPath = node_path_1.default.join(__dirname, 'firebase-service-account.json');
    if (!node_fs_1.default.existsSync(serviceAccountPath)) {
        throw new Error('Faltan variables de entorno de Firebase y no existe firebase-service-account.json');
    }
    const raw = node_fs_1.default.readFileSync(serviceAccountPath, 'utf8');
    serviceAccount = JSON.parse(raw);
}
if (!firebase_admin_1.default.apps.length) {
    firebase_admin_1.default.initializeApp({
        credential: firebase_admin_1.default.credential.cert(serviceAccount),
        storageBucket: FIREBASE_STORAGE_BUCKET ||
            (typeof serviceAccount.project_id === 'string'
                ? `${serviceAccount.project_id}.appspot.com`
                : undefined),
    });
}
exports.firestore = firebase_admin_1.default.firestore();
exports.storage = firebase_admin_1.default.storage();
