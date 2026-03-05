# Backend – Tienda Multitenant

Backend en **Node.js + Express + SQL Server** para la app de tienda multitenant.  
Expone APIs para autenticación, productos, variantes, ventas, clientes, proveedores y repartidores.  
Incluye documentación interactiva con **Scalar** (OpenAPI).

---

## Requisitos

- **Node.js** 20+ (recomendado)
- **SQL Server** accesible (local, Docker o servidor remoto)
- Credenciales de **Firebase** (Storage) si quieres subir imágenes de productos

---

## Instalación

Desde la carpeta raíz del backend:

```bash
cd Backend
npm install
```

Configura tu archivo de entorno:

```bash
# si ya tienes uno en Frontend, puedes copiar la base
cp ../Frontend/.env .env   # o crea Backend/.env manualmente
```

---

## Variables de entorno (`Backend/.env`)

Ejemplo básico:

```env
# Puerto del backend
PORT=3001

# JWT
JWT_SECRET=mi_super_secreto_seguro

# SQL Server
DB_SERVER=localhost
DB_PORT=1433
DB_USER=sa
DB_PASSWORD=MiClaveSegura123
DB_DATABASE=TiendaMultitenant

# Firebase (ejemplo)
FIREBASE_PROJECT_ID=mi-proyecto
FIREBASE_CLIENT_EMAIL=firebase-adminsdk@mi-proyecto.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
FIREBASE_STORAGE_BUCKET=mi-proyecto.appspot.com
```

> **Importante**
>
> - **NO** subas `Backend/.env` ni el JSON de servicio de Firebase a GitHub.  
> - Están ignorados vía `.gitignore`.

---

## Scripts disponibles

Desde `Backend`:

```bash
# Desarrollo con recarga en caliente (tsx)
npm run dev
```

Por defecto, el servidor se levanta en `http://localhost:3001` (según `PORT` y `config.ts`).

---

## Endpoints principales (resumen)

La mayoría de endpoints requieren **JWT Bearer** en el header `Authorization`.

### Salud

- `GET /health`  
  Devuelve estado básico del backend.

- `GET /health/db`  
  Verifica conexión con SQL Server.

### Autenticación

- `POST /auth/login`

Body ejemplo:

```json
{
  "email": "admin@mitienda.com",
  "password": "123456",
  "tiendaSlug": "mi-tienda"
}
```

Respuesta: token JWT + datos de usuario y tienda.

---

### Productos

- `GET /productos`  
  Lista productos (activos e inactivos) ordenados por fecha de creación desc.

- `POST /productos`  
  Crea un producto:

```json
{
  "nombre": "Camiseta básica blanca",
  "codigoInterno": "camiseta-basica-blanca-s",
  "codigoBarras": "7701234567890",
  "proveedorId": 1,
  "categoriaId": 2,
  "descripcion": "Camiseta 100% algodón cuello redondo",
  "costo": 15000,
  "precioDetal": 29900,
  "precioMayor": 25000,
  "stockActual": 50,
  "visible": true
}
```

También hay endpoints para **variantes** (`/productos/variantes`) e **imágenes** de producto (`/productos/:id/imagenes`).

---

### Ventas

- `GET /ventas?desde=2025-01-01&hasta=2025-01-31`  
  Lista ventas por rango de fechas.

- `POST /ventas`

```json
{
  "clienteId": 1,
  "repartidorId": 2,
  "tipoVenta": "DETAL",
  "tipoEntrega": "DOMICILIO",
  "metodoPago": "EFECTIVO",
  "observacion": "Entregar después de las 6 pm",
  "descuentoTotal": 5000,
  "items": [
    { "productoId": 10, "cantidad": 2, "precioUnitario": 29900 },
    { "productoId": 11, "cantidad": 1, "precioUnitario": 49900 }
  ]
}
```

También existen:

- `GET /ventas/:id` – detalle de una venta (cabecera + líneas)
- `PUT /ventas/:id` – actualizar cabecera (tipo, entrega, pago, descuento, observación)
- `DELETE /ventas/:id` – borrar venta y su detalle

---

### Clientes

- `GET /clientes?q=Juan`  
  Lista clientes filtrando por nombre, cédula o celular.

- `POST /clientes`

```json
{
  "cedula": "1234567890",
  "nombre": "Juan Pérez",
  "email": "juan@example.com",
  "celular": "3001234567",
  "direccion": "Calle 123 #45-67",
  "ciudad": "Bogotá"
}
```

Incluye importación masiva desde Excel en `/clientes/import-excel`.

---

### Repartidores

- `GET /repartidores`  
  Lista todos los repartidores de la tienda actual.

- `POST /repartidores`

```json
{
  "nombre": "Carlos López",
  "telefono": "3011234567",
  "documento": "CC 12345678",
  "vehiculo": "Motocicleta",
  "placa": "ABC123",
  "disponible": true,
  "activo": true
}
```

---

### Categorías y Proveedores

- `GET /categorias` – categorías de productos.
- `GET /proveedores` – proveedores activos.

Ambos tienen CRUD básico en el backend.

---

## Documentación interactiva (Scalar)

El backend expone:

- Esquema **OpenAPI**: `GET /openapi.json`
- UI **Scalar**: `GET /docs`

Con el servidor en `http://localhost:3001`:

- Abre `http://localhost:3001/` → redirige a `http://localhost:3001/docs`.
- Desde Scalar puedes:
  - Ver todos los endpoints y sus ejemplos.
  - Probar llamados reales con **“Try it”**.
  - Configurar el header `Authorization: Bearer <tu_token>` para endpoints protegidos.

---

## Notas de seguridad

- Nunca subas a Git:
  - `Backend/.env`
  - `Backend/firebase-service-account.json` (o el JSON de tu service account)
- Usa HTTPS y variables de entorno seguras en producción.

