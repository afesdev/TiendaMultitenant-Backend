import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

import admin from 'firebase-admin'

// Ruta al archivo de credenciales de servicio
const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const serviceAccountPath = path.join(__dirname, 'firebase-service-account.json')

const raw = fs.readFileSync(serviceAccountPath, 'utf8')
const serviceAccount = JSON.parse(raw) as admin.ServiceAccount

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: 'mishell-boutique-admin.firebasestorage.app',
  })
}

export const firestore = admin.firestore()
export const storage = admin.storage()

