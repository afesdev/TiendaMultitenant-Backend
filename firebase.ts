import admin from 'firebase-admin'

const {
  FIREBASE_TYPE,
  FIREBASE_PROJECT_ID,
  FIREBASE_PRIVATE_KEY_ID,
  FIREBASE_PRIVATE_KEY,
  FIREBASE_CLIENT_EMAIL,
  FIREBASE_CLIENT_ID,
  FIREBASE_AUTH_URI,
  FIREBASE_TOKEN_URI,
  FIREBASE_AUTH_PROVIDER_CERT_URL,
  FIREBASE_CLIENT_CERT_URL,
  FIREBASE_UNIVERSE_DOMAIN,
  FIREBASE_STORAGE_BUCKET,
} = process.env

if (!FIREBASE_PROJECT_ID || !FIREBASE_PRIVATE_KEY || !FIREBASE_CLIENT_EMAIL) {
  throw new Error('Faltan variables de entorno de Firebase')
}

// Construir objeto de service account desde variables de entorno
const serviceAccount: admin.ServiceAccount & { [key: string]: string } = {
  type: FIREBASE_TYPE ?? 'service_account',
  project_id: FIREBASE_PROJECT_ID,
  private_key_id: FIREBASE_PRIVATE_KEY_ID ?? '',
  // Reemplazar los "\n" literales por saltos de línea reales
  private_key: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  client_email: FIREBASE_CLIENT_EMAIL,
  client_id: FIREBASE_CLIENT_ID ?? '',
  auth_uri: FIREBASE_AUTH_URI ?? 'https://accounts.google.com/o/oauth2/auth',
  token_uri: FIREBASE_TOKEN_URI ?? 'https://oauth2.googleapis.com/token',
  auth_provider_x509_cert_url:
    FIREBASE_AUTH_PROVIDER_CERT_URL ??
    'https://www.googleapis.com/oauth2/v1/certs',
  client_x509_cert_url: FIREBASE_CLIENT_CERT_URL ?? '',
  universe_domain: FIREBASE_UNIVERSE_DOMAIN ?? 'googleapis.com',
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: FIREBASE_STORAGE_BUCKET,
  })
}

export const firestore = admin.firestore()
export const storage = admin.storage()

