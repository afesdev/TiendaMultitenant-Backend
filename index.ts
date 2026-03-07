import express from 'express'
import cors from 'cors'
import { apiReference } from '@scalar/express-api-reference'
import { config } from './config.js'
import { testConnection, getPool, sql } from './db.js'
import { verifyPassword, signToken, verifyToken, JwtPayload, hashPassword } from './auth.js'
import { storage } from './firebase.js'
import { openapiDocument } from './openapi.js'

const app = express()

app.use(cors())
app.use(
  express.json({
    limit: '20mb',
  }),
)

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    env: config.nodeEnv,
  })
})

app.get('/health/db', async (_req, res) => {
  const ok = await testConnection()
  if (!ok) {
    return res.status(500).json({ status: 'error', message: 'No se pudo conectar a la base de datos' })
  }

  return res.json({ status: 'ok', message: 'Conexión a base de datos exitosa' })
})

// Redirigir raíz a la documentación de Scalar
app.get('/', (_req, res) => {
  res.redirect('/docs')
})

// Documento OpenAPI (para Scalar u otros clientes)
app.get('/openapi.json', (_req, res) => {
  res.json(openapiDocument)
})

// Documentación interactiva de la API con Scalar
app.use(
  '/docs',
  apiReference({
    theme: 'purple',
    layout: 'modern',
    darkMode: true,
    hideDownloadButton: false,
    spec: {
      url: '/openapi.json',
    },
  }),
)

// Ejemplo de endpoint usando la BD (lista las primeras tiendas)
app.get('/tiendas', async (_req, res) => {
  try {
    const pool = await getPool()
    const result = await pool
      .request()
      .query('SELECT TOP 20 Id, NombreComercial, Slug, EmailContacto, Activo, FechaCreacion FROM Tiendas ORDER BY FechaCreacion DESC')

    res.json(result.recordset)
  } catch (error) {
    console.error('[GET /tiendas] Error', error)
    res.status(500).json({ message: 'Error al obtener tiendas' })
  }
})

// Middleware sencillo para extraer el usuario desde el JWT
function authMiddleware(
  req: express.Request & { user?: JwtPayload },
  res: express.Response,
  next: express.NextFunction,
) {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'No autorizado' })
  }

  const token = authHeader.substring('Bearer '.length)

  try {
    const payload = verifyToken(token)
    req.user = payload
    next()
  } catch {
    return res.status(401).json({ message: 'Token inválido o expirado' })
  }
}

async function upsertProductoImagenDesdeBase64(
  productoId: number,
  imagenBase64?: string | null,
): Promise<string | null> {
  if (!imagenBase64) return null

  try {
    const bucket = storage.bucket()

    const base64Data = imagenBase64.includes(',')
      ? imagenBase64.split(',')[1]!
      : imagenBase64

    const buffer = Buffer.from(base64Data, 'base64')
    if (buffer.length === 0) {
      console.error('[Imagen producto] Base64 inválido o vacío')
      return null
    }

    const fileName = `product_images/${productoId}-${Date.now()}.jpg`
    const file = bucket.file(fileName)

    await file.save(buffer, {
      metadata: { contentType: 'image/jpeg' },
      resumable: false,
    })

    let publicUrl: string
    try {
      await file.makePublic()
      publicUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(fileName)}?alt=media`
    } catch (makePublicErr) {
      console.warn('[Imagen producto] makePublic falló, usando URL firmada (7 días)', makePublicErr)
      const [signedUrl] = await file.getSignedUrl({
        action: 'read',
        expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        version: 'v4',
      })
      publicUrl = signedUrl
    }

    const pool = await getPool()

    const imgResult = await pool
      .request()
      .input('productoId', productoId)
      .query(`
        SELECT TOP 1 Id
        FROM Producto_Imagenes
        WHERE Producto_Id = @productoId AND EsPrincipal = 1
        ORDER BY Id
      `)

    if (imgResult.recordset.length > 0) {
      const imagenId = imgResult.recordset[0].Id as number
      await pool
        .request()
        .input('id', imagenId)
        .input('url', publicUrl)
        .query(`
          UPDATE Producto_Imagenes
          SET Url = @url
          WHERE Id = @id
        `)
    } else {
      await pool
        .request()
        .input('productoId', productoId)
        .input('url', publicUrl)
        .query(`
          INSERT INTO Producto_Imagenes (Producto_Id, Url, EsPrincipal, Orden)
          VALUES (@productoId, @url, 1, 0)
        `)
    }

    return publicUrl
  } catch (error) {
    console.error('[Imagen producto] Error al subir imagen a Firebase Storage', error)
    return null
  }
}

/** Sube una imagen a Firebase e inserta una nueva fila en Producto_Imagenes. */
async function addProductoImagen(
  productoId: number,
  imagenBase64: string,
  esPrincipal: boolean,
  orden: number,
): Promise<{ id: number; url: string } | null> {
  try {
    const bucket = storage.bucket()
    const base64Data = imagenBase64.includes(',') ? imagenBase64.split(',')[1]! : imagenBase64
    const buffer = Buffer.from(base64Data, 'base64')
    if (buffer.length === 0) return null

    const fileName = `product_images/${productoId}-${Date.now()}-${orden}.jpg`
    const file = bucket.file(fileName)
    await file.save(buffer, { metadata: { contentType: 'image/jpeg' }, resumable: false })

    let publicUrl: string
    try {
      await file.makePublic()
      publicUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(fileName)}?alt=media`
    } catch {
      const [signedUrl] = await file.getSignedUrl({
        action: 'read',
        expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        version: 'v4',
      })
      publicUrl = signedUrl
    }

    const pool = await getPool()
    if (esPrincipal) {
      await pool
        .request()
        .input('productoId', productoId)
        .query(`UPDATE Producto_Imagenes SET EsPrincipal = 0 WHERE Producto_Id = @productoId`)
    }
    const result = await pool
      .request()
      .input('productoId', productoId)
      .input('url', publicUrl)
      .input('esPrincipal', esPrincipal ? 1 : 0)
      .input('orden', orden)
      .query(`
        INSERT INTO Producto_Imagenes (Producto_Id, Url, EsPrincipal, Orden)
        OUTPUT INSERTED.Id, INSERTED.Url
        VALUES (@productoId, @url, @esPrincipal, @orden)
      `)
    const row = result.recordset[0] as { Id: number; Url: string }
    return { id: row.Id, url: row.Url }
  } catch (error) {
    console.error('[addProductoImagen] Error', error)
    return null
  }
}

// Login: recibe email, password y slug de la tienda
app.post('/auth/login', async (req, res) => {
  const { email, password, tiendaSlug } = req.body as {
    email?: string
    password?: string
    tiendaSlug?: string
  }

  if (!email || !password || !tiendaSlug) {
    return res.status(400).json({ message: 'email, password y tiendaSlug son obligatorios' })
  }

  try {
    const pool = await getPool()
    const result = await pool
      .request()
      .input('email', email)
      .input('slug', tiendaSlug)
      .query(`
        SELECT TOP 1
          u.Id AS UserId,
          u.Nombre,
          u.Email,
          u.PasswordHash,
          u.Activo,
          t.Id AS TiendaId,
          t.NombreComercial,
          t.Slug,
          r.Id AS RolId,
          r.Nombre AS RolNombre
        FROM Usuarios u
        INNER JOIN Tiendas t ON u.Tienda_Id = t.Id
        INNER JOIN Roles r ON u.Rol_Id = r.Id
        WHERE t.Slug = @slug AND u.Email = @email
      `)

    if (result.recordset.length === 0) {
      return res.status(401).json({ message: 'Credenciales inválidas' })
    }

    const row = result.recordset[0] as {
      UserId: number
      Nombre: string
      Email: string
      PasswordHash: string
      Activo: boolean
      TiendaId: string
      NombreComercial: string
      Slug: string
      RolId: number
      RolNombre: string
    }

    if (!row.Activo) {
      return res.status(403).json({ message: 'Usuario inactivo' })
    }

    const passwordOk = await verifyPassword(password, row.PasswordHash)
    if (!passwordOk) {
      return res.status(401).json({ message: 'Credenciales inválidas' })
    }

    const payload: JwtPayload = {
      userId: row.UserId,
      tiendaId: row.TiendaId,
      roleId: row.RolId,
      email: row.Email,
      nombre: row.Nombre,
      slug: row.Slug,
    }

    const token = signToken(payload)

    return res.json({
      token,
      user: {
        id: row.UserId,
        nombre: row.Nombre,
        email: row.Email,
        rolId: row.RolId,
        rolNombre: row.RolNombre,
      },
      tienda: {
        id: row.TiendaId,
        nombreComercial: row.NombreComercial,
        slug: row.Slug,
      },
    })
  } catch (error) {
    console.error('[POST /auth/login] Error', error)
    return res.status(500).json({ message: 'Error al iniciar sesión' })
  }
})

// Registro de usuario en una tienda
app.post('/auth/register', async (req, res) => {
  const { tiendaSlug, nombre, email, password, rolNombre } = req.body as {
    tiendaSlug?: string
    nombre?: string
    email?: string
    password?: string
    rolNombre?: string
  }

  if (!tiendaSlug || !nombre || !email || !password) {
    return res.status(400).json({
      message: 'tiendaSlug, nombre, email y password son obligatorios',
    })
  }

  try {
    const pool = await getPool()
    const request = pool.request()

    // 1. Buscar la tienda por slug
    const tiendaResult = await request.input('slug', tiendaSlug).query(`
      SELECT TOP 1 Id, NombreComercial, Slug
      FROM Tiendas
      WHERE Slug = @slug
    `)

    if (tiendaResult.recordset.length === 0) {
      return res.status(404).json({ message: 'Tienda no encontrada' })
    }

    const tienda = tiendaResult.recordset[0] as {
      Id: string
      NombreComercial: string
      Slug: string
    }

    // 2. Rol: si no envían, usamos "Administrador"
    const nombreRol = rolNombre ?? 'Administrador'
    const rolResult = await pool
      .request()
      .input('rolNombre', nombreRol)
      .query(`
        SELECT TOP 1 Id, Nombre
        FROM Roles
        WHERE Nombre = @rolNombre
      `)

    if (rolResult.recordset.length === 0) {
      return res.status(400).json({
        message: `Rol "${nombreRol}" no existe, crea primero los roles básicos`,
      })
    }

    const rol = rolResult.recordset[0] as {
      Id: number
      Nombre: string
    }

    // 3. Validar que no exista ya ese email en la tienda
    const existingUser = await pool
      .request()
      .input('tiendaId', tienda.Id)
      .input('email', email)
      .query(`
        SELECT 1
        FROM Usuarios
        WHERE Tienda_Id = @tiendaId AND Email = @email
      `)

    if (existingUser.recordset.length > 0) {
      return res
        .status(409)
        .json({ message: 'Ya existe un usuario con ese email en esta tienda' })
    }

    // 4. Hashear la contraseña
    const passwordHash = await hashPassword(password)

    // 5. Insertar el usuario y devolver sus datos
    const insertResult = await pool
      .request()
      .input('tiendaId', tienda.Id)
      .input('rolId', rol.Id)
      .input('nombre', nombre)
      .input('email', email)
      .input('passwordHash', passwordHash)
      .query(`
        INSERT INTO Usuarios (Tienda_Id, Rol_Id, Nombre, Email, PasswordHash, Activo)
        OUTPUT INSERTED.Id
        VALUES (@tiendaId, @rolId, @nombre, @email, @passwordHash, 1)
      `)

    const newUserId = insertResult.recordset[0].Id as number

    const payload: JwtPayload = {
      userId: newUserId,
      tiendaId: tienda.Id,
      roleId: rol.Id,
      email,
      nombre,
      slug: tienda.Slug,
    }

    const token = signToken(payload)

    return res.status(201).json({
      token,
      user: {
        id: newUserId,
        nombre,
        email,
        rolId: rol.Id,
        rolNombre: rol.Nombre,
      },
      tienda: {
        id: tienda.Id,
        nombreComercial: tienda.NombreComercial,
        slug: tienda.Slug,
      },
    })
  } catch (error) {
    console.error('[POST /auth/register] Error', error)
    return res.status(500).json({ message: 'Error al registrar usuario' })
  }
})

// Endpoint para recuperar los datos del usuario autenticado
app.get(
  '/me',
  authMiddleware,
  (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    return res.json({ user: req.user })
  },
)

// ==========================
// Utilidades
// ==========================

function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// ==========================
// Categorías (CRUD básico)
// ==========================

// Listar categorías de la tienda actual
app.get(
  '/categorias',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    try {
      const pool = await getPool()
      const result = await pool
        .request()
        .input('tiendaId', req.user.tiendaId)
        .query(`
          SELECT Id, Nombre, Slug, CategoriaPadre_Id, Visible
          FROM Categorias
          WHERE Tienda_Id = @tiendaId
          ORDER BY Nombre ASC
        `)

      return res.json(result.recordset)
    } catch (error) {
      console.error('[GET /categorias] Error', error)
      return res.status(500).json({ message: 'Error al obtener categorías' })
    }
  },
)

// Crear categoría
app.post(
  '/categorias',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    const { nombre, categoriaPadreId, visible } = req.body as {
      nombre?: string
      categoriaPadreId?: number | null
      visible?: boolean
    }

    if (!nombre) {
      return res.status(400).json({ message: 'nombre es obligatorio' })
    }

    try {
      const pool = await getPool()
      const generatedSlug = slugify(nombre)
      const result = await pool
        .request()
        .input('tiendaId', req.user.tiendaId)
        .input('nombre', nombre)
        .input('slug', generatedSlug)
        .input('categoriaPadreId', categoriaPadreId ?? null)
        .input('visible', visible ?? true)
        .query(`
          INSERT INTO Categorias (Tienda_Id, Nombre, Slug, CategoriaPadre_Id, Visible)
          OUTPUT INSERTED.Id, INSERTED.Nombre, INSERTED.Slug, INSERTED.CategoriaPadre_Id, INSERTED.Visible
          VALUES (@tiendaId, @nombre, @slug, @categoriaPadreId, @visible)
        `)

      return res.status(201).json(result.recordset[0])
    } catch (error) {
      console.error('[POST /categorias] Error', error)
      return res.status(500).json({ message: 'Error al crear categoría' })
    }
  },
)

// Actualizar categoría
app.put(
  '/categorias/:id',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    const { id } = req.params
    const { nombre, categoriaPadreId, visible } = req.body as {
      nombre?: string
      categoriaPadreId?: number | null
      visible?: boolean
    }

    if (!nombre) {
      return res.status(400).json({ message: 'nombre es obligatorio' })
    }

    try {
      const pool = await getPool()
      const generatedSlug = slugify(nombre)
      const result = await pool
        .request()
        .input('id', Number(id))
        .input('tiendaId', req.user.tiendaId)
        .input('nombre', nombre)
        .input('slug', generatedSlug)
        .input('categoriaPadreId', categoriaPadreId ?? null)
        .input('visible', visible ?? true)
        .query(`
          UPDATE Categorias
          SET Nombre = @nombre,
              Slug = @slug,
              CategoriaPadre_Id = @categoriaPadreId,
              Visible = @visible
          WHERE Id = @id AND Tienda_Id = @tiendaId;

          SELECT Id, Nombre, Slug, CategoriaPadre_Id, Visible
          FROM Categorias
          WHERE Id = @id AND Tienda_Id = @tiendaId;
        `)

      if (result.recordset.length === 0) {
        return res.status(404).json({ message: 'Categoría no encontrada' })
      }

      return res.json(result.recordset[0])
    } catch (error) {
      console.error('[PUT /categorias/:id] Error', error)
      return res.status(500).json({ message: 'Error al actualizar categoría' })
    }
  },
)

// Eliminar categoría (borrado físico)
app.delete(
  '/categorias/:id',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    const { id } = req.params

    try {
      const pool = await getPool()
      const result = await pool
        .request()
        .input('id', Number(id))
        .input('tiendaId', req.user.tiendaId)
        .query(`
          DELETE FROM Categorias
          WHERE Id = @id AND Tienda_Id = @tiendaId;

          SELECT @@ROWCOUNT AS affected;
        `)

      const affected = result.recordset[0]?.affected as number
      if (!affected) {
        return res.status(404).json({ message: 'Categoría no encontrada' })
      }

      return res.json({ message: 'Categoría eliminada' })
    } catch (error) {
      console.error('[DELETE /categorias/:id] Error', error)
      return res.status(500).json({ message: 'Error al eliminar categoría' })
    }
  },
)

// ==========================
// Proveedores (CRUD básico)
// ==========================

// Listar proveedores activos de la tienda actual
app.get(
  '/proveedores',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    try {
      const pool = await getPool()
      const result = await pool
        .request()
        .input('tiendaId', req.user.tiendaId)
        .query(`
          SELECT Id, Nombre, Contacto, Telefono, Email, Activo
          FROM Proveedores
          WHERE Tienda_Id = @tiendaId AND Activo = 1
          ORDER BY Id ASC
        `)

      return res.json(result.recordset)
    } catch (error) {
      console.error('[GET /proveedores] Error', error)
      return res.status(500).json({ message: 'Error al obtener proveedores' })
    }
  },
)

// Crear proveedor
app.post(
  '/proveedores',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    const { nombre, contacto, telefono, email, activo } = req.body as {
      nombre?: string
      contacto?: string
      telefono?: string
      email?: string
      activo?: boolean
    }

    if (!nombre) {
      return res.status(400).json({ message: 'nombre es obligatorio para el proveedor' })
    }

    try {
      const pool = await getPool()
      const result = await pool
        .request()
        .input('tiendaId', req.user.tiendaId)
        .input('nombre', nombre)
        .input('contacto', contacto ?? null)
        .input('telefono', telefono ?? null)
        .input('email', email ?? null)
        .input('activo', activo ?? true)
        .query(`
          INSERT INTO Proveedores (Tienda_Id, Nombre, Contacto, Telefono, Email, Activo)
          OUTPUT INSERTED.Id, INSERTED.Nombre, INSERTED.Contacto, INSERTED.Telefono, INSERTED.Email, INSERTED.Activo
          VALUES (@tiendaId, @nombre, @contacto, @telefono, @email, @activo)
        `)

      return res.status(201).json(result.recordset[0])
    } catch (error) {
      console.error('[POST /proveedores] Error', error)
      return res.status(500).json({ message: 'Error al crear proveedor' })
    }
  },
)

// Actualizar proveedor
app.put(
  '/proveedores/:id',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    const { id } = req.params
    const { nombre, contacto, telefono, email, activo } = req.body as {
      nombre?: string
      contacto?: string
      telefono?: string
      email?: string
      activo?: boolean
    }

    if (!nombre) {
      return res.status(400).json({ message: 'nombre es obligatorio para el proveedor' })
    }

    try {
      const pool = await getPool()
      const result = await pool
        .request()
        .input('id', Number(id))
        .input('tiendaId', req.user.tiendaId)
        .input('nombre', nombre)
        .input('contacto', contacto ?? null)
        .input('telefono', telefono ?? null)
        .input('email', email ?? null)
        .input('activo', activo ?? true)
        .query(`
          UPDATE Proveedores
          SET Nombre = @nombre,
              Contacto = @contacto,
              Telefono = @telefono,
              Email = @email,
              Activo = @activo
          WHERE Id = @id AND Tienda_Id = @tiendaId;

          SELECT Id, Nombre, Contacto, Telefono, Email, Activo
          FROM Proveedores
          WHERE Id = @id AND Tienda_Id = @tiendaId;
        `)

      if (result.recordset.length === 0) {
        return res.status(404).json({ message: 'Proveedor no encontrado' })
      }

      return res.json(result.recordset[0])
    } catch (error) {
      console.error('[PUT /proveedores/:id] Error', error)
      return res.status(500).json({ message: 'Error al actualizar proveedor' })
    }
  },
)

// Eliminar proveedor (borrado físico; se desvinculan productos del proveedor)
app.delete(
  '/proveedores/:id',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    const { id } = req.params

    try {
      const pool = await getPool()
      await pool
        .request()
        .input('id', Number(id))
        .input('tiendaId', req.user.tiendaId)
        .query(`
          UPDATE Productos SET Proveedor_Id = NULL
          WHERE Proveedor_Id = @id AND Tienda_Id = @tiendaId;
        `)

      const result = await pool
        .request()
        .input('id', Number(id))
        .input('tiendaId', req.user.tiendaId)
        .query(`
          DELETE FROM Proveedores
          OUTPUT DELETED.Id
          WHERE Id = @id AND Tienda_Id = @tiendaId;
        `)

      if (!result.recordset.length) {
        return res.status(404).json({ message: 'Proveedor no encontrado' })
      }

      return res.json({ message: 'Proveedor eliminado' })
    } catch (error) {
      console.error('[DELETE /proveedores/:id] Error', error)
      return res.status(500).json({ message: 'Error al eliminar proveedor' })
    }
  },
)

// ==========================
// Productos (CRUD básico)
// ==========================

// Listar productos visibles de la tienda actual
app.get(
  '/productos',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    try {
      const pool = await getPool()
      const result = await pool
        .request()
        .input('tiendaId', req.user.tiendaId)
        .query(`
          SELECT
            p.Id,
            p.Nombre,
            p.CodigoInterno,
            p.CodigoBarras,
            p.Descripcion,
            p.Costo,
            p.PrecioDetal,
            p.PrecioMayor,
            p.StockActual,
            p.Visible,
            p.Categoria_Id,
            c.Nombre AS CategoriaNombre,
            p.Proveedor_Id,
            pr.Nombre AS ProveedorNombre,
            img.Url AS ImagenUrl,
            p.FechaCreacion,
            p.FechaModificacion
          FROM Productos p
          LEFT JOIN Categorias c ON p.Categoria_Id = c.Id
          LEFT JOIN Proveedores pr ON p.Proveedor_Id = pr.Id
          OUTER APPLY (
            SELECT TOP 1 Url
            FROM Producto_Imagenes
            WHERE Producto_Id = p.Id AND EsPrincipal = 1
            ORDER BY Id
          ) img
          WHERE p.Tienda_Id = @tiendaId
          ORDER BY p.FechaCreacion DESC, p.Nombre
        `)

      const productos = result.recordset as Array<{ Id: number; PrecioDetal: number }>
      const itemsConPromo = await calcularPrecioConPromo(
        pool,
        req.user.tiendaId,
        productos.map((p) => ({
          productoId: p.Id,
          varianteId: null as number | null,
          cantidad: 1,
          precioBase: p.PrecioDetal,
        })),
      )
      const mapaPromo = new Map(itemsConPromo.map((i) => [i.productoId, i]))

      const recordset = result.recordset as Array<Record<string, unknown>>
      for (const row of recordset) {
        const promo = mapaPromo.get(row.Id as number)
        row.PrecioOferta = promo ? promo.precioFinal : (row.PrecioDetal as number)
        row.TieneOferta = promo ? promo.descuentoAplicado > 0 : false
      }

      return res.json(recordset)
    } catch (error) {
      console.error('[GET /productos] Error', error)
      return res.status(500).json({ message: 'Error al obtener productos' })
    }
  },
)

// Listar variaciones de productos (talla / color) de la tienda actual
app.get(
  '/productos/variantes',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    try {
      const pool = await getPool()
      const result = await pool
        .request()
        .input('tiendaId', req.user.tiendaId)
        .query(`
          SELECT
            v.Id,
            v.Producto_Id,
            p.Nombre AS ProductoNombre,
            p.CodigoInterno,
            v.Atributo,
            v.Valor,
            v.PrecioAdicional,
            v.StockActual,
            v.CodigoSKU
          FROM Producto_Variaciones v
          INNER JOIN Productos p ON v.Producto_Id = p.Id
          WHERE p.Tienda_Id = @tiendaId
          ORDER BY p.FechaCreacion DESC, p.Nombre, v.Atributo, v.Valor
        `)

      return res.json(result.recordset)
    } catch (error) {
      console.error('[GET /productos/variantes] Error', error)
      return res.status(500).json({ message: 'Error al obtener variantes de productos' })
    }
  },
)

// Actualizar una variante de producto
app.put(
  '/productos/variantes/:id',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    const { id } = req.params
    const { valor, stockActual, precioAdicional, codigoSKU } = req.body as {
      valor?: string
      stockActual?: number
      precioAdicional?: number
      codigoSKU?: string | null
    }

    try {
      const pool = await getPool()
      const result = await pool
        .request()
        .input('id', Number(id))
        .input('tiendaId', req.user.tiendaId)
        .input('valor', valor ?? null)
        .input('stockActual', stockActual ?? null)
        .input('precioAdicional', precioAdicional ?? null)
        .input('codigoSKU', codigoSKU ?? null)
        .query(`
          UPDATE v
          SET
            Valor = COALESCE(@valor, v.Valor),
            StockActual = COALESCE(@stockActual, v.StockActual),
            PrecioAdicional = COALESCE(@precioAdicional, v.PrecioAdicional),
            CodigoSKU = @codigoSKU
          FROM Producto_Variaciones v
          INNER JOIN Productos p ON v.Producto_Id = p.Id
          WHERE v.Id = @id AND p.Tienda_Id = @tiendaId;

          SELECT @@ROWCOUNT AS affected;
        `)

      const affected = result.recordset[0]?.affected as number
      if (!affected) {
        return res.status(404).json({ message: 'Variante no encontrada' })
      }

      return res.json({ message: 'Variante actualizada' })
    } catch (error) {
      console.error('[PUT /productos/variantes/:id] Error', error)
      return res.status(500).json({ message: 'Error al actualizar variante' })
    }
  },
)

// Crear una variante de producto
app.post(
  '/productos/variantes',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    const { productoId, atributo, valor, stockActual, precioAdicional, codigoSKU } = req.body as {
      productoId?: number
      atributo?: string
      valor?: string
      stockActual?: number
      precioAdicional?: number
      codigoSKU?: string | null
    }

    if (!productoId || !atributo || !valor) {
      return res.status(400).json({
        message: 'productoId, atributo y valor son obligatorios para la variante',
      })
    }

    try {
      const pool = await getPool()

      // Validar que el producto pertenezca a la tienda del usuario
      const prodCheck = await pool
        .request()
        .input('productoId', productoId)
        .input('tiendaId', req.user.tiendaId)
        .query(`
          SELECT 1
          FROM Productos
          WHERE Id = @productoId AND Tienda_Id = @tiendaId
        `)

      if (prodCheck.recordset.length === 0) {
        return res.status(404).json({ message: 'Producto no encontrado para esta tienda' })
      }

      await pool
        .request()
        .input('productoId', productoId)
        .input('atributo', atributo)
        .input('valor', valor)
        .input('stockActual', stockActual ?? 0)
        .input('precioAdicional', precioAdicional ?? 0)
        .input('codigoSKU', codigoSKU ?? null)
        .query(`
          INSERT INTO Producto_Variaciones (
            Producto_Id,
            Atributo,
            Valor,
            PrecioAdicional,
            StockActual,
            CodigoSKU
          )
          VALUES (@productoId, @atributo, @valor, @precioAdicional, @stockActual, @codigoSKU);
        `)

      return res.status(201).json({ message: 'Variante creada' })
    } catch (error) {
      console.error('[POST /productos/variantes] Error', error)
      return res.status(500).json({ message: 'Error al crear variante' })
    }
  },
)

// Eliminar una variante de producto
app.delete(
  '/productos/variantes/:id',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    const { id } = req.params

    try {
      const pool = await getPool()
      const result = await pool
        .request()
        .input('id', Number(id))
        .input('tiendaId', req.user.tiendaId)
        .query(`
          DELETE v
          FROM Producto_Variaciones v
          INNER JOIN Productos p ON v.Producto_Id = p.Id
          WHERE v.Id = @id AND p.Tienda_Id = @tiendaId;

          SELECT @@ROWCOUNT AS affected;
        `)

      const affected = result.recordset[0]?.affected as number
      if (!affected) {
        return res.status(404).json({ message: 'Variante no encontrada' })
      }

      return res.json({ message: 'Variante eliminada' })
    } catch (error) {
      console.error('[DELETE /productos/variantes/:id] Error', error)
      return res.status(500).json({ message: 'Error al eliminar variante' })
    }
  },
)

// Listar imágenes de un producto
app.get(
  '/productos/:id/imagenes',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) return res.status(401).json({ message: 'No autorizado' })
    const { id } = req.params
    try {
      const pool = await getPool()
      const result = await pool
        .request()
        .input('id', Number(id))
        .input('tiendaId', req.user.tiendaId)
        .query(`
          SELECT i.Id, i.Url, i.EsPrincipal, i.Orden
          FROM Producto_Imagenes i
          INNER JOIN Productos p ON i.Producto_Id = p.Id
          WHERE p.Id = @id AND p.Tienda_Id = @tiendaId
          ORDER BY i.EsPrincipal DESC, i.Orden ASC, i.Id ASC
        `)
      return res.json(result.recordset)
    } catch (error) {
      console.error('[GET /productos/:id/imagenes] Error', error)
      return res.status(500).json({ message: 'Error al listar imágenes' })
    }
  },
)

// Añadir imagen a un producto
app.post(
  '/productos/:id/imagenes',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) return res.status(401).json({ message: 'No autorizado' })
    const { id } = req.params
    const { imagenBase64, esPrincipal, orden } = req.body as {
      imagenBase64?: string
      esPrincipal?: boolean
      orden?: number
    }
    if (!imagenBase64) return res.status(400).json({ message: 'imagenBase64 es obligatorio' })
    try {
      const pool = await getPool()
      const check = await pool
        .request()
        .input('id', Number(id))
        .input('tiendaId', req.user.tiendaId)
        .query(`SELECT 1 FROM Productos WHERE Id = @id AND Tienda_Id = @tiendaId`)
      if (check.recordset.length === 0) return res.status(404).json({ message: 'Producto no encontrado' })

      const maxOrden = await pool
        .request()
        .input('productoId', Number(id))
        .query(`SELECT ISNULL(MAX(Orden), -1) + 1 AS NextOrden FROM Producto_Imagenes WHERE Producto_Id = @productoId`)
      const nextOrden = orden ?? (maxOrden.recordset[0]?.NextOrden as number) ?? 0

      const added = await addProductoImagen(Number(id), imagenBase64, !!esPrincipal, nextOrden)
      if (!added) return res.status(500).json({ message: 'Error al subir la imagen' })
      return res.status(201).json(added)
    } catch (error) {
      console.error('[POST /productos/:id/imagenes] Error', error)
      return res.status(500).json({ message: 'Error al añadir imagen' })
    }
  },
)

// Eliminar imagen de producto
app.delete(
  '/productos/imagenes/:imagenId',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) return res.status(401).json({ message: 'No autorizado' })
    const { imagenId } = req.params
    try {
      const pool = await getPool()
      const delResult = await pool
        .request()
        .input('imagenId', Number(imagenId))
        .input('tiendaId', req.user.tiendaId)
        .query(`
          DELETE i
          FROM Producto_Imagenes i
          INNER JOIN Productos p ON i.Producto_Id = p.Id
          WHERE i.Id = @imagenId AND p.Tienda_Id = @tiendaId
        `)
      const affected = (delResult.rowsAffected as number[])?.[0] ?? 0
      if (!affected) return res.status(404).json({ message: 'Imagen no encontrada' })
      return res.json({ message: 'Imagen eliminada' })
    } catch (error) {
      console.error('[DELETE /productos/imagenes/:id] Error', error)
      return res.status(500).json({ message: 'Error al eliminar imagen' })
    }
  },
)

// Marcar imagen como principal
app.put(
  '/productos/imagenes/:imagenId/principal',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) return res.status(401).json({ message: 'No autorizado' })
    const { imagenId } = req.params
    try {
      const pool = await getPool()
      await pool
        .request()
        .input('imagenId', Number(imagenId))
        .input('tiendaId', req.user.tiendaId)
        .query(`
          UPDATE i SET i.EsPrincipal = 0
          FROM Producto_Imagenes i
          INNER JOIN Productos p ON i.Producto_Id = p.Id
          WHERE p.Tienda_Id = @tiendaId
          UPDATE i SET i.EsPrincipal = 1
          FROM Producto_Imagenes i
          INNER JOIN Productos p ON i.Producto_Id = p.Id
          WHERE i.Id = @imagenId AND p.Tienda_Id = @tiendaId
        `)
      const check = await pool
        .request()
        .input('imagenId', Number(imagenId))
        .input('tiendaId', req.user.tiendaId)
        .query(`SELECT i.Id FROM Producto_Imagenes i INNER JOIN Productos p ON i.Producto_Id = p.Id WHERE i.Id = @imagenId AND p.Tienda_Id = @tiendaId`)
      if (check.recordset.length === 0) return res.status(404).json({ message: 'Imagen no encontrada' })
      return res.json({ message: 'Imagen principal actualizada' })
    } catch (error) {
      console.error('[PUT /productos/imagenes/:id/principal] Error', error)
      return res.status(500).json({ message: 'Error al actualizar imagen principal' })
    }
  },
)

// Crear producto
app.post(
  '/productos',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    const {
      nombre,
      codigoInterno,
      codigoBarras,
      proveedorId,
      categoriaId,
      descripcion,
      costo,
      precioDetal,
      precioMayor,
      stockActual,
      visible,
    } = req.body as {
      nombre?: string
      codigoInterno?: string
      codigoBarras?: string
      proveedorId?: number | null
      categoriaId?: number | null
      descripcion?: string
      costo?: number
      precioDetal?: number
      precioMayor?: number | null
      stockActual?: number
      visible?: boolean
      imagenBase64?: string | null
    }

    if (!nombre || !codigoInterno || precioDetal == null) {
      return res.status(400).json({
        message: 'nombre, codigoInterno y precioDetal son obligatorios para el producto',
      })
    }

    try {
      const pool = await getPool()
      const imagenBase64 = (req.body as { imagenBase64?: string | null }).imagenBase64 ?? null
      const result = await pool
        .request()
        .input('tiendaId', req.user.tiendaId)
        .input('nombre', nombre)
        .input('codigoInterno', codigoInterno)
        .input('codigoBarras', codigoBarras ?? null)
        .input('proveedorId', proveedorId ?? null)
        .input('categoriaId', categoriaId ?? null)
        .input('descripcion', descripcion ?? null)
        .input('costo', costo ?? 0)
        .input('precioDetal', precioDetal)
        .input('precioMayor', precioMayor ?? null)
        .input('stockActual', stockActual ?? 0)
        .input('visible', visible ?? true)
        .query(`
          INSERT INTO Productos (
            Tienda_Id,
            Nombre,
            CodigoInterno,
            CodigoBarras,
            Proveedor_Id,
            Categoria_Id,
            Descripcion,
            Costo,
            PrecioDetal,
            PrecioMayor,
            StockActual,
            Visible
          )
          OUTPUT 
            INSERTED.Id,
            INSERTED.Nombre,
            INSERTED.CodigoInterno,
            INSERTED.CodigoBarras,
            INSERTED.Costo,
            INSERTED.PrecioDetal,
            INSERTED.PrecioMayor,
            INSERTED.StockActual,
            INSERTED.Visible,
            INSERTED.Categoria_Id,
            INSERTED.Proveedor_Id,
            INSERTED.FechaCreacion,
            INSERTED.FechaModificacion
          VALUES (
            @tiendaId,
            @nombre,
            @codigoInterno,
            @codigoBarras,
            @proveedorId,
            @categoriaId,
            @descripcion,
            @costo,
            @precioDetal,
            @precioMayor,
            @stockActual,
            @visible
          )
        `)

      const inserted = result.recordset[0]

      if (imagenBase64) {
        await upsertProductoImagenDesdeBase64(inserted.Id as number, imagenBase64)
      }

      return res.status(201).json(inserted)
    } catch (error) {
      console.error('[POST /productos] Error', error)
      return res.status(500).json({ message: 'Error al crear producto' })
    }
  },
)

// Actualizar producto
app.put(
  '/productos/:id',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    const { id } = req.params
    const {
      nombre,
      codigoInterno,
      codigoBarras,
      proveedorId,
      categoriaId,
      descripcion,
      costo,
      precioDetal,
      precioMayor,
      stockActual,
      visible,
    } = req.body as {
      nombre?: string
      codigoInterno?: string
      codigoBarras?: string
      proveedorId?: number | null
      categoriaId?: number | null
      descripcion?: string
      costo?: number
      precioDetal?: number
      precioMayor?: number | null
      stockActual?: number
      visible?: boolean
      imagenBase64?: string | null
    }

    if (!nombre || !codigoInterno || precioDetal == null) {
      return res.status(400).json({
        message: 'nombre, codigoInterno y precioDetal son obligatorios para el producto',
      })
    }

    try {
      const pool = await getPool()
      const imagenBase64 = (req.body as { imagenBase64?: string | null }).imagenBase64 ?? null
      const result = await pool
        .request()
        .input('id', Number(id))
        .input('tiendaId', req.user.tiendaId)
        .input('nombre', nombre)
        .input('codigoInterno', codigoInterno)
        .input('codigoBarras', codigoBarras ?? null)
        .input('proveedorId', proveedorId ?? null)
        .input('categoriaId', categoriaId ?? null)
        .input('descripcion', descripcion ?? null)
        .input('costo', costo ?? 0)
        .input('precioDetal', precioDetal)
        .input('precioMayor', precioMayor ?? null)
        .input('stockActual', stockActual ?? 0)
        .input('visible', visible ?? true)
        .query(`
          UPDATE Productos
          SET Nombre = @nombre,
              CodigoInterno = @codigoInterno,
              CodigoBarras = @codigoBarras,
              Proveedor_Id = @proveedorId,
              Categoria_Id = @categoriaId,
              Descripcion = @descripcion,
              Costo = @costo,
              PrecioDetal = @precioDetal,
              PrecioMayor = @precioMayor,
              StockActual = @stockActual,
              Visible = @visible,
              FechaModificacion = SYSDATETIME()
          WHERE Id = @id AND Tienda_Id = @tiendaId;

          SELECT
            Id,
            Nombre,
            CodigoInterno,
            CodigoBarras,
            Descripcion,
            Costo,
            PrecioDetal,
            PrecioMayor,
            StockActual,
            Visible,
            Categoria_Id,
            Proveedor_Id,
            FechaCreacion,
            FechaModificacion
          FROM Productos
          WHERE Id = @id AND Tienda_Id = @tiendaId;
        `)

      if (result.recordset.length === 0) {
        return res.status(404).json({ message: 'Producto no encontrado' })
      }

      const updated = result.recordset[0]

      if (imagenBase64) {
        await upsertProductoImagenDesdeBase64(updated.Id as number, imagenBase64)
      }

      return res.json(updated)
    } catch (error) {
      console.error('[PUT /productos/:id] Error', error)
      return res.status(500).json({ message: 'Error al actualizar producto' })
    }
  },
)

// Eliminar producto (borrado físico; CASCADE quita imágenes y variaciones)
app.delete(
  '/productos/:id',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    const { id } = req.params

    try {
      const pool = await getPool()
      const result = await pool
        .request()
        .input('id', Number(id))
        .input('tiendaId', req.user.tiendaId)
        .query(`
          DELETE FROM Productos
          WHERE Id = @id AND Tienda_Id = @tiendaId;

          SELECT @@ROWCOUNT AS affected;
        `)

      const affected = result.recordset[0]?.affected as number
      if (!affected) {
        return res.status(404).json({ message: 'Producto no encontrado' })
      }

      return res.json({ message: 'Producto eliminado' })
    } catch (error: unknown) {
      console.error('[DELETE /productos/:id] Error', error)
      const msg = error && typeof (error as { message?: string }).message === 'string'
        ? (error as { message: string }).message
        : ''
      if (msg.includes('REFERENCE') || msg.includes('foreign key')) {
        return res.status(409).json({
          message: 'No se puede eliminar: el producto tiene ventas, apartados o movimientos asociados.',
        })
      }
      return res.status(500).json({ message: 'Error al eliminar producto' })
    }
  },
)

// Obtener detalle completo de un producto con imágenes, variantes y estadísticas
app.get(
  '/productos/:id/detalle',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    const { id } = req.params
    const productoId = Number(id)
    if (Number.isNaN(productoId)) {
      return res.status(400).json({ message: 'Id de producto inválido' })
    }

    try {
      const pool = await getPool()

      const prodResult = await pool
        .request()
        .input('productoId', productoId)
        .input('tiendaId', req.user.tiendaId)
        .query(`
          SELECT
            p.Id,
            p.Nombre,
            p.CodigoInterno,
            p.CodigoBarras,
            p.Descripcion,
            p.Costo,
            p.PrecioDetal,
            p.PrecioMayor,
            p.StockActual,
            p.Visible,
            p.Categoria_Id,
            c.Nombre AS CategoriaNombre,
            p.Proveedor_Id,
            pr.Nombre AS ProveedorNombre,
            pr.Contacto AS ProveedorContacto,
            pr.Telefono AS ProveedorTelefono,
            pr.Email AS ProveedorEmail,
            p.FechaCreacion,
            p.FechaModificacion
          FROM Productos p
          LEFT JOIN Categorias c ON p.Categoria_Id = c.Id
          LEFT JOIN Proveedores pr ON p.Proveedor_Id = pr.Id
          WHERE p.Id = @productoId AND p.Tienda_Id = @tiendaId
        `)

      const producto = prodResult.recordset[0]
      if (!producto) {
        return res.status(404).json({ message: 'Producto no encontrado' })
      }

      const imagenesResult = await pool
        .request()
        .input('productoId', productoId)
        .query(`
          SELECT Id, Url, EsPrincipal, Orden
          FROM Producto_Imagenes
          WHERE Producto_Id = @productoId
          ORDER BY EsPrincipal DESC, Orden ASC, Id ASC
        `)

      const variantesResult = await pool
        .request()
        .input('productoId', productoId)
        .query(`
          SELECT Id, Atributo, Valor, PrecioAdicional, StockActual, CodigoSKU
          FROM Producto_Variaciones
          WHERE Producto_Id = @productoId
          ORDER BY Atributo, Valor
        `)

      const statsVentas = await pool
        .request()
        .input('productoId', productoId)
        .input('tiendaId', req.user.tiendaId)
        .query(`
          SELECT
            ISNULL(SUM(d.Cantidad), 0) AS TotalVendido,
            ISNULL(SUM(d.Cantidad * d.PrecioUnitario), 0) AS IngresosVentas,
            COUNT(DISTINCT d.Venta_Id) AS CountVentas
          FROM Venta_Detalle d
          INNER JOIN Ventas v ON d.Venta_Id = v.Id
          WHERE d.Producto_Id = @productoId AND v.Tienda_Id = @tiendaId
        `)

      const statsApartados = await pool
        .request()
        .input('productoId', productoId)
        .input('tiendaId', req.user.tiendaId)
        .query(`
          SELECT
            ISNULL(SUM(ad.Cantidad), 0) AS TotalApartado,
            COUNT(DISTINCT ad.Apartado_Id) AS CountApartados
          FROM Apartados_Detalle ad
          INNER JOIN Apartados a ON ad.Apartado_Id = a.Id
          WHERE ad.Producto_Id = @productoId AND a.Tienda_Id = @tiendaId
        `)

      const movimientosResult = await pool
        .request()
        .input('productoId', productoId)
        .input('tiendaId', req.user.tiendaId)
        .query(`
          SELECT TOP 20
            m.Id,
            m.Fecha,
            m.TipoMovimiento,
            m.Cantidad,
            m.Motivo,
            v.Atributo AS VarianteAtributo,
            v.Valor AS VarianteValor
          FROM Movimientos_Inventario m
          LEFT JOIN Producto_Variaciones v ON m.Variacion_Id = v.Id
          WHERE m.Producto_Id = @productoId AND m.Tienda_Id = @tiendaId
          ORDER BY m.Fecha DESC, m.Id DESC
        `)

      const promocionesResult = await pool
        .request()
        .input('productoId', productoId)
        .input('tiendaId', req.user.tiendaId)
        .query(`
          SELECT pr.Id, pr.Nombre, pr.TipoDescuento, pr.ValorDescuento, pr.FechaInicio, pr.FechaFin, pr.Activo
          FROM Promocion_Productos pp
          INNER JOIN Promociones pr ON pp.Promocion_Id = pr.Id
          WHERE pp.Producto_Id = @productoId AND pr.Tienda_Id = @tiendaId
          ORDER BY pr.FechaInicio DESC
        `)

      const ultimasVentasResult = await pool
        .request()
        .input('productoId', productoId)
        .input('tiendaId', req.user.tiendaId)
        .query(`
          SELECT TOP 10
            v.Id AS VentaId,
            v.Fecha,
            v.Total,
            c.Nombre AS ClienteNombre,
            d.Cantidad,
            d.PrecioUnitario,
            d.Cantidad * d.PrecioUnitario AS Importe
          FROM Venta_Detalle d
          INNER JOIN Ventas v ON d.Venta_Id = v.Id
          INNER JOIN Clientes c ON v.Cliente_Id = c.Id
          WHERE d.Producto_Id = @productoId AND v.Tienda_Id = @tiendaId
          ORDER BY v.Fecha DESC, v.Id DESC
        `)

      const sv = statsVentas.recordset[0]
      const sa = statsApartados.recordset[0]

      return res.json({
        producto,
        imagenes: imagenesResult.recordset,
        variantes: variantesResult.recordset,
        estadisticas: {
          totalVendido: Number(sv?.TotalVendido ?? 0),
          ingresosVentas: Number(sv?.IngresosVentas ?? 0),
          countVentas: Number(sv?.CountVentas ?? 0),
          totalApartado: Number(sa?.TotalApartado ?? 0),
          countApartados: Number(sa?.CountApartados ?? 0),
        },
        movimientosRecientes: movimientosResult.recordset,
        promociones: promocionesResult.recordset,
        ultimasVentas: ultimasVentasResult.recordset,
      })
    } catch (error) {
      console.error('[GET /productos/:id/detalle] Error', error)
      return res.status(500).json({ message: 'Error al obtener detalle del producto' })
    }
  },
)

// Importar productos desde Excel usando el procedimiento almacenado
app.post(
  '/productos/import-excel',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    const { rows } = req.body as {
      rows?: {
        Codigo?: string
        Nombre?: string
        Categoria?: string | null
        Talla?: string | null
        Color?: string | null
        Stock?: number | null
        Costo?: number | null
        PrecioDetal?: number | null
        PrecioMayor?: number | null
        Proveedor?: string | null
        Visible?: boolean | string | number | null
        Descripcion?: string | null
      }[]
    }

    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ message: 'rows debe ser un arreglo con productos' })
    }

    const results: { index: number; ok: boolean; error?: string }[] = []

    try {
      const pool = await getPool()

      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i]
        if (!row || !row.Codigo || !row.Nombre) {
          results.push({
            index: i,
            ok: false,
            error: 'Faltan campos obligatorios (Codigo o Nombre)',
          })
          // No detenemos toda la importación por un error de fila
          // continuamos con las demás
          continue
        }

        const visibleValue = (() => {
          const v = row.Visible
          if (typeof v === 'boolean') return v
          if (typeof v === 'number') return v !== 0
          if (typeof v === 'string') {
            const norm = v.trim().toLowerCase()
            if (['1', 'true', 'si', 'sí', 'activo', 'visible'].includes(norm)) return true
            if (['0', 'false', 'no', 'inactivo', 'oculto'].includes(norm)) return false
          }
          return true
        })()

        try {
          await pool
            .request()
            .input('Tienda_Id', req.user.tiendaId)
            .input('Codigo', row.Codigo)
            .input('Nombre', row.Nombre)
            .input('CategoriaNombre', row.Categoria ?? null)
            .input('Talla', row.Talla ?? null)
            .input('Color', row.Color ?? null)
            .input('Stock', row.Stock ?? 0)
            .input('Costo', row.Costo ?? 0)
            .input('PrecioDetal', row.PrecioDetal ?? 0)
            .input('PrecioMayor', row.PrecioMayor ?? 0)
            .input('ProveedorNombre', row.Proveedor ?? null)
            .input('Visible', visibleValue)
            .input('Descripcion', row.Descripcion ?? null)
            .execute('sp_ImportarProductoDesdeExcel')

          results.push({ index: i, ok: true })
        } catch (error) {
          console.error('[POST /productos/import-excel] Error en fila', i, error)
          results.push({
            index: i,
            ok: false,
            error: 'Error al importar esta fila; revisa los datos',
          })
        }
      }

      const okCount = results.filter((r) => r.ok).length
      const errorCount = results.length - okCount

      return res.json({
        total: results.length,
        exitosos: okCount,
        conErrores: errorCount,
        detalle: results,
      })
    } catch (error) {
      console.error('[POST /productos/import-excel] Error general', error)
      return res.status(500).json({ message: 'Error al importar productos desde Excel' })
    }
  },
)

// Registrar una nueva venta (cabecera + detalle)
app.post(
  '/ventas',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    const {
      clienteId,
      repartidorId,
      tipoVenta,
      tipoEntrega,
      metodoPago,
      observacion,
      descuentoTotal: descuentoTotalBody,
      items,
    } = req.body as {
      clienteId: number
      repartidorId?: number | null
      tipoVenta?: string
      tipoEntrega?: string
      metodoPago?: string
      observacion?: string
      descuentoTotal?: number
      items: {
        productoId: number
        cantidad: number
        precioUnitario: number
        varianteId?: number | null
      }[]
    }

    if (!clienteId || !Array.isArray(items) || items.length === 0) {
      return res
        .status(400)
        .json({ message: 'Cliente e items de la venta son obligatorios.' })
    }

    const lineasValidas = items.every(
      (it) =>
        typeof it.productoId === 'number' &&
        typeof it.cantidad === 'number' &&
        it.cantidad > 0 &&
        typeof it.precioUnitario === 'number' &&
        it.precioUnitario >= 0,
    )

    if (!lineasValidas) {
      return res.status(400).json({ message: 'Los items de la venta no son válidos.' })
    }

    const tipoVentaPrecio = tipoVenta === 'MAYORISTA' ? 'MAYORISTA' : 'DETAL'

    let tx: sql.Transaction | null = null

    try {
      const pool = await getPool()

      // Obtener precios base y validar stock antes de la transacción
      const productosMap = new Map<
        number,
        { Nombre: string; PrecioDetal: number; PrecioMayor: number | null; StockActual: number }
      >()
      const variantesMap = new Map<
        number,
        { Atributo: string; Valor: string; PrecioAdicional: number; StockActual: number; Producto_Id: number }
      >()

      for (const it of items) {
        const prodRes = await pool
          .request()
          .input('productoId', it.productoId)
          .input('tiendaId', req.user.tiendaId)
          .query(`
            SELECT Id, Nombre, PrecioDetal, PrecioMayor, StockActual
            FROM Productos
            WHERE Id = @productoId AND Tienda_Id = @tiendaId
          `)
        const prod = prodRes.recordset[0] as
          | { Id: number; Nombre: string; PrecioDetal: number; PrecioMayor: number | null; StockActual: number }
          | undefined
        if (!prod) {
          return res.status(400).json({ message: `Producto ${it.productoId} no encontrado o no pertenece a la tienda.` })
        }
        productosMap.set(it.productoId, prod)

        let stockDisponible = prod.StockActual ?? 0
        let precioBase = tipoVentaPrecio === 'MAYORISTA' && prod.PrecioMayor != null ? prod.PrecioMayor : prod.PrecioDetal
        let varianteDesc: string | null = null

        if (it.varianteId != null) {
          const varRes = await pool
            .request()
            .input('varianteId', it.varianteId)
            .input('productoId', it.productoId)
            .query(`
              SELECT Id, Atributo, Valor, PrecioAdicional, StockActual, Producto_Id
              FROM Producto_Variaciones
              WHERE Id = @varianteId AND Producto_Id = @productoId
            `)
          const vari = varRes.recordset[0] as
            | { Atributo: string; Valor: string; PrecioAdicional: number; StockActual: number; Producto_Id: number }
            | undefined
          if (!vari) {
            return res.status(400).json({ message: `Variante ${it.varianteId} no encontrada para el producto.` })
          }
          variantesMap.set(it.varianteId, vari)
          stockDisponible = vari.StockActual ?? 0
          varianteDesc = `${vari.Atributo}: ${vari.Valor}`
          precioBase += vari.PrecioAdicional ?? 0
        }

        if (stockDisponible < it.cantidad) {
          const productoNombre = prod.Nombre ?? `Producto #${it.productoId}`
          const descripcion = varianteDesc
            ? `${productoNombre} (${varianteDesc})`
            : productoNombre
          return res.status(400).json({
            message: `Stock insuficiente para "${descripcion}". Disponible: ${stockDisponible}, solicitado: ${it.cantidad}.`,
            code: 'STOCK_INSUFICIENTE',
            productoId: it.productoId,
            varianteId: it.varianteId ?? null,
            productoNombre,
            varianteDesc,
            stockDisponible,
            cantidadSolicitada: it.cantidad,
          })
        }
      }

      // Calcular precios con promociones
      const itemsConPrecioBase = items.map((it) => {
        const prod = productosMap.get(it.productoId)!
        let base = tipoVentaPrecio === 'MAYORISTA' && prod.PrecioMayor != null ? prod.PrecioMayor : prod.PrecioDetal
        if (it.varianteId != null) {
          const vari = variantesMap.get(it.varianteId)!
          base += vari.PrecioAdicional ?? 0
        }
        return { productoId: it.productoId, varianteId: it.varianteId ?? null, cantidad: it.cantidad, precioBase: base }
      })
      const itemsConPromo = await calcularPrecioConPromo(pool, req.user.tiendaId, itemsConPrecioBase)

      // Usar precioFinal (con oferta) para cada item; validar que precioUnitario del cliente no supere precio base
      for (let i = 0; i < items.length; i++) {
        const it = items[i]
        const precioBaseItem = itemsConPrecioBase[i].precioBase
        if (it.precioUnitario > precioBaseItem) {
          return res.status(400).json({
            message: `El precio unitario del producto ${it.productoId} no puede superar el precio base (${precioBaseItem}).`,
          })
        }
      }
      const itemsProcesados = items.map((it, idx) => ({
        ...it,
        precioUnitario: itemsConPromo[idx].precioFinal,
      }))

      const subtotal = itemsProcesados.reduce(
        (acc, it) => acc + it.cantidad * it.precioUnitario,
        0,
      )
      const descuentoTotalRaw =
        typeof descuentoTotalBody === 'number' && !Number.isNaN(descuentoTotalBody)
          ? descuentoTotalBody
          : 0
      const descuentoTotal = Math.max(0, Math.min(descuentoTotalRaw, subtotal))
      const total = subtotal - descuentoTotal
      tx = new sql.Transaction(pool)
      await tx.begin()

      const estadoVenta = (req.body as { estado?: string }).estado ?? 'Pendiente'

      const headerReq = new sql.Request(tx)
      headerReq
        .input('tiendaId', sql.UniqueIdentifier, req.user.tiendaId)
        .input('clienteId', sql.Int, clienteId)
        .input('repartidorId', repartidorId ?? null)
        .input('tipoVenta', tipoVenta ?? null)
        .input('tipoEntrega', tipoEntrega ?? null)
        .input('metodoPago', metodoPago ?? null)
        .input('subtotal', sql.Decimal(18, 2), subtotal)
        .input('descuentoTotal', sql.Decimal(18, 2), descuentoTotal)
        .input('total', sql.Decimal(18, 2), total)
        .input('observacion', observacion ?? null)
        .input('estado', estadoVenta)

      const headerResult = await headerReq.query(`
        INSERT INTO Ventas (
          Tienda_Id,
          Cliente_Id,
          Repartidor_Id,
          Fecha,
          TipoVenta,
          TipoEntrega,
          MetodoPago,
          Subtotal,
          DescuentoTotal,
          Total,
          Observacion,
          Estado
        )
        OUTPUT INSERTED.Id
        VALUES (
          @tiendaId,
          @clienteId,
          @repartidorId,
          GETDATE(),
          @tipoVenta,
          @tipoEntrega,
          @metodoPago,
          @subtotal,
          @descuentoTotal,
          @total,
          @observacion,
          @estado
        )
      `)

      const ventaIdRow = headerResult.recordset[0] as { Id: number }
      const ventaId = ventaIdRow?.Id
      if (!ventaId) {
        throw new Error('No se pudo obtener el Id de la venta creada')
      }

      for (const it of itemsProcesados) {
        // Insertar detalle de la venta
        const detReq = new sql.Request(tx)
        detReq
          .input('ventaId', sql.Int, ventaId)
          .input('productoId', sql.Int, it.productoId)
          .input('cantidad', sql.Int, it.cantidad)
          .input('precioUnitario', sql.Decimal(18, 2), it.precioUnitario)
          .input('varianteId', sql.Int, it.varianteId ?? null)

        await detReq.query(`
          INSERT INTO Venta_Detalle (
            Venta_Id,
            Producto_Id,
            Cantidad,
            PrecioUnitario,
            Variante_Id
          )
          VALUES (
            @ventaId,
            @productoId,
            @cantidad,
            @precioUnitario,
            @varianteId
          )
        `)

        // Actualizar stock del producto
        const stockProdReq = new sql.Request(tx)
        stockProdReq
          .input('productoId', sql.Int, it.productoId)
          .input('cantidad', sql.Int, it.cantidad)

        await stockProdReq.query(`
          UPDATE Productos
          SET StockActual = ISNULL(StockActual, 0) - @cantidad
          WHERE Id = @productoId
        `)

        // Actualizar stock de la variante (si aplica)
        if (it.varianteId != null) {
          const stockVarReq = new sql.Request(tx)
          stockVarReq
            .input('varianteId', sql.Int, it.varianteId)
            .input('cantidad', sql.Int, it.cantidad)

          await stockVarReq.query(`
            UPDATE Producto_Variaciones
            SET StockActual = ISNULL(StockActual, 0) - @cantidad
            WHERE Id = @varianteId
          `)
        }

        // Registrar movimiento de inventario (SALIDA)
        const movReq = new sql.Request(tx)
        movReq
          .input('tiendaId', sql.UniqueIdentifier, req.user.tiendaId)
          .input('productoId', sql.Int, it.productoId)
          .input('variacionId', sql.Int, it.varianteId ?? null)
          .input('cantidad', sql.Int, it.cantidad)
          .input('motivo', sql.NVarChar, `Venta #${ventaId}`)

        await movReq.query(`
          INSERT INTO Movimientos_Inventario (
            Tienda_Id,
            Producto_Id,
            Variacion_Id,
            TipoMovimiento,
            Cantidad,
            Motivo,
            Fecha
          )
          VALUES (
            @tiendaId,
            @productoId,
            @variacionId,
            'SALIDA',
            @cantidad,
            @motivo,
            GETDATE()
          )
        `)
      }

      await tx.commit()

      return res.status(201).json({
        message: 'Venta registrada correctamente',
        ventaId,
        subtotal,
        descuentoTotal,
        total,
      })
    } catch (error) {
      if (tx) {
        try {
          await tx.rollback()
        } catch {
          // ignore
        }
      }
      console.error('[POST /ventas] Error', error)
      return res.status(500).json({ message: 'Error al registrar la venta' })
    }
  },
)

// Listar clientes de la tienda actual (para selección en panel)
app.get(
  '/clientes',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    const { q } = req.query as { q?: string }
    const search = (q ?? '').trim()

    try {
      const pool = await getPool()
      const request = pool.request().input('tiendaId', req.user.tiendaId)

      if (search) {
        request.input('search', `%${search}%`)
      }

      const result = await request.query(`
        SELECT TOP 100
          Id,
          Cedula,
          Nombre,
          Email,
          Celular,
          Direccion,
          Ciudad,
          FechaRegistro
        FROM Clientes
        WHERE Tienda_Id = @tiendaId
          ${search ? 'AND (Nombre LIKE @search OR Cedula LIKE @search OR Celular LIKE @search)' : ''}
        ORDER BY FechaRegistro DESC, Id DESC
      `)

      return res.json(result.recordset)
    } catch (error) {
      console.error('[GET /clientes] Error', error)
      return res.status(500).json({ message: 'Error al obtener clientes' })
    }
  },
)

// Crear cliente desde el panel
app.post(
  '/clientes',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    const { cedula, nombre, email, celular, direccion, ciudad } = req.body as {
      cedula?: string
      nombre?: string
      email?: string
      celular?: string
      direccion?: string
      ciudad?: string
    }

    if (!cedula || !nombre) {
      return res
        .status(400)
        .json({ message: 'Cédula y nombre son obligatorios para el cliente' })
    }

    try {
      const pool = await getPool()
      const result = await pool
        .request()
        .input('tiendaId', req.user.tiendaId)
        .input('cedula', cedula.trim())
        .input('nombre', nombre.trim())
        .input('email', email?.trim() || null)
        .input('celular', celular?.trim() || null)
        .input('direccion', direccion?.trim() || null)
        .input('ciudad', ciudad?.trim() || null)
        .query(`
          BEGIN TRY
            INSERT INTO Clientes (Tienda_Id, Cedula, Nombre, Email, Celular, Direccion, Ciudad)
            OUTPUT INSERTED.Id, INSERTED.Cedula, INSERTED.Nombre, INSERTED.Email, INSERTED.Celular, INSERTED.Direccion, INSERTED.Ciudad, INSERTED.FechaRegistro
            VALUES (@tiendaId, @cedula, @nombre, @email, @celular, @direccion, @ciudad);
          END TRY
          BEGIN CATCH
            IF ERROR_MESSAGE() LIKE '%UQ_Cliente_Por_Tienda%'
            BEGIN
              SELECT -1 AS Id;
            END
            ELSE
            BEGIN
              THROW;
            END
          END CATCH
        `)

      const row = result.recordset[0] as
        | {
            Id: number
            Cedula: string
            Nombre: string
            Email: string | null
            Celular: string | null
            Direccion: string | null
            Ciudad: string | null
            FechaRegistro: Date
          }
        | { Id: -1 }

      if (row.Id === -1) {
        return res
          .status(409)
          .json({ message: 'Ya existe un cliente con esa cédula en esta tienda.' })
      }

      return res.status(201).json(row)
    } catch (error) {
      console.error('[POST /clientes] Error', error)
      return res.status(500).json({ message: 'Error al crear cliente' })
    }
  },
)

// Actualizar cliente desde el panel
app.put(
  '/clientes/:id',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    const { id } = req.params
    const { cedula, nombre, email, celular, direccion, ciudad } = req.body as {
      cedula?: string
      nombre?: string
      email?: string
      celular?: string
      direccion?: string
      ciudad?: string
    }

    if (!cedula || !nombre) {
      return res
        .status(400)
        .json({ message: 'Cédula y nombre son obligatorios para el cliente' })
    }

    try {
      const pool = await getPool()
      const result = await pool
        .request()
        .input('id', Number(id))
        .input('tiendaId', req.user.tiendaId)
        .input('cedula', cedula.trim())
        .input('nombre', nombre.trim())
        .input('email', email?.trim() || null)
        .input('celular', celular?.trim() || null)
        .input('direccion', direccion?.trim() || null)
        .input('ciudad', ciudad?.trim() || null)
        .query(`
          BEGIN TRY
            UPDATE Clientes
            SET
              Cedula = @cedula,
              Nombre = @nombre,
              Email = @email,
              Celular = @celular,
              Direccion = @direccion,
              Ciudad = @ciudad
            WHERE Id = @id AND Tienda_Id = @tiendaId;

            IF @@ROWCOUNT = 0
            BEGIN
              SELECT -1 AS Id;
              RETURN;
            END

            SELECT Id, Cedula, Nombre, Email, Celular, Direccion, Ciudad, FechaRegistro
            FROM Clientes
            WHERE Id = @id AND Tienda_Id = @tiendaId;
          END TRY
          BEGIN CATCH
            IF ERROR_MESSAGE() LIKE '%UQ_Cliente_Por_Tienda%'
            BEGIN
              SELECT -2 AS Id;
            END
            ELSE
            BEGIN
              THROW;
            END
          END CATCH
        `)

      const row = result.recordset[0] as
        | {
            Id: number
            Cedula: string
            Nombre: string
            Email: string | null
            Celular: string | null
            Direccion: string | null
            Ciudad: string | null
            FechaRegistro: Date
          }
        | { Id: -1 }
        | { Id: -2 }

      if (row.Id === -1) {
        return res.status(404).json({ message: 'Cliente no encontrado' })
      }
      if (row.Id === -2) {
        return res
          .status(409)
          .json({ message: 'Ya existe un cliente con esa cédula en esta tienda.' })
      }

      return res.json(row)
    } catch (error) {
      console.error('[PUT /clientes/:id] Error', error)
      return res.status(500).json({ message: 'Error al actualizar cliente' })
    }
  },
)

// Eliminar cliente (si no tiene ventas asociadas)
app.delete(
  '/clientes/:id',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    const { id } = req.params

    try {
      const pool = await getPool()
      const result = await pool
        .request()
        .input('id', Number(id))
        .input('tiendaId', req.user.tiendaId)
        .query(`
          DELETE FROM Clientes
          OUTPUT DELETED.Id
          WHERE Id = @id AND Tienda_Id = @tiendaId;
        `)

      if (!result.recordset.length) {
        return res.status(404).json({ message: 'Cliente no encontrado' })
      }

      return res.json({ message: 'Cliente eliminado' })
    } catch (error: any) {
      const msg = String(error?.message ?? '').toLowerCase()
      if (msg.includes('reference') || msg.includes('foreign key')) {
        return res.status(409).json({
          message:
            'No se puede eliminar: el cliente tiene ventas u otros registros asociados.',
        })
      }
      console.error('[DELETE /clientes/:id] Error', error)
      return res.status(500).json({ message: 'Error al eliminar cliente' })
    }
  },
)

// ==========================
// Repartidores
// ==========================

// Listar repartidores de la tienda actual
app.get(
  '/repartidores',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    try {
      const pool = await getPool()
      const result = await pool
        .request()
        .input('tiendaId', req.user.tiendaId)
        .query(`
          SELECT
            Id,
            Nombre,
            Telefono,
            DocumentoIdentidad,
            Vehiculo,
            Placa,
            Disponible,
            Activo,
            FechaRegistro
          FROM Repartidores
          WHERE Tienda_Id = @tiendaId
          ORDER BY FechaRegistro DESC, Id DESC
        `)

      return res.json(result.recordset)
    } catch (error) {
      console.error('[GET /repartidores] Error', error)
      return res.status(500).json({ message: 'Error al obtener repartidores' })
    }
  },
)

// Crear repartidor
app.post(
  '/repartidores',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    const { nombre, telefono, documento, vehiculo, placa, disponible, activo } = req.body as {
      nombre?: string
      telefono?: string
      documento?: string
      vehiculo?: string
      placa?: string
      disponible?: boolean
      activo?: boolean
    }

    if (!nombre || !telefono) {
      return res
        .status(400)
        .json({ message: 'Nombre y teléfono son obligatorios para el repartidor' })
    }

    try {
      const pool = await getPool()
      const result = await pool
        .request()
        .input('tiendaId', req.user.tiendaId)
        .input('nombre', nombre.trim())
        .input('telefono', telefono.trim())
        .input('documento', documento?.trim() || null)
        .input('vehiculo', vehiculo?.trim() || null)
        .input('placa', placa?.trim() || null)
        .input('disponible', disponible ?? true)
        .input('activo', activo ?? true)
        .query(`
          INSERT INTO Repartidores (
            Tienda_Id,
            Nombre,
            Telefono,
            DocumentoIdentidad,
            Vehiculo,
            Placa,
            Disponible,
            Activo
          )
          OUTPUT INSERTED.Id, INSERTED.Nombre, INSERTED.Telefono, INSERTED.DocumentoIdentidad, INSERTED.Vehiculo, INSERTED.Placa, INSERTED.Disponible, INSERTED.Activo, INSERTED.FechaRegistro
          VALUES (
            @tiendaId,
            @nombre,
            @telefono,
            @documento,
            @vehiculo,
            @placa,
            @disponible,
            @activo
          );
        `)

      return res.status(201).json(result.recordset[0])
    } catch (error) {
      console.error('[POST /repartidores] Error', error)
      return res.status(500).json({ message: 'Error al crear repartidor' })
    }
  },
)

// Actualizar repartidor
app.put(
  '/repartidores/:id',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    const { id } = req.params
    const { nombre, telefono, documento, vehiculo, placa, disponible, activo } = req.body as {
      nombre?: string
      telefono?: string
      documento?: string
      vehiculo?: string
      placa?: string
      disponible?: boolean
      activo?: boolean
    }

    if (!nombre || !telefono) {
      return res
        .status(400)
        .json({ message: 'Nombre y teléfono son obligatorios para el repartidor' })
    }

    try {
      const pool = await getPool()
      const result = await pool
        .request()
        .input('id', Number(id))
        .input('tiendaId', req.user.tiendaId)
        .input('nombre', nombre.trim())
        .input('telefono', telefono.trim())
        .input('documento', documento?.trim() || null)
        .input('vehiculo', vehiculo?.trim() || null)
        .input('placa', placa?.trim() || null)
        .input('disponible', disponible ?? true)
        .input('activo', activo ?? true)
        .query(`
          UPDATE Repartidores
          SET
            Nombre = @nombre,
            Telefono = @telefono,
            DocumentoIdentidad = @documento,
            Vehiculo = @vehiculo,
            Placa = @placa,
            Disponible = @disponible,
            Activo = @activo
          WHERE Id = @id AND Tienda_Id = @tiendaId;

          SELECT
            Id,
            Nombre,
            Telefono,
            DocumentoIdentidad,
            Vehiculo,
            Placa,
            Disponible,
            Activo,
            FechaRegistro
          FROM Repartidores
          WHERE Id = @id AND Tienda_Id = @tiendaId;
        `)

      if (!result.recordset.length) {
        return res.status(404).json({ message: 'Repartidor no encontrado' })
      }

      return res.json(result.recordset[0])
    } catch (error) {
      console.error('[PUT /repartidores/:id] Error', error)
      return res.status(500).json({ message: 'Error al actualizar repartidor' })
    }
  },
)

// Eliminar repartidor
app.delete(
  '/repartidores/:id',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    const { id } = req.params

    try {
      const pool = await getPool()
      const result = await pool
        .request()
        .input('id', Number(id))
        .input('tiendaId', req.user.tiendaId)
        .query(`
          DELETE FROM Repartidores
          OUTPUT DELETED.Id
          WHERE Id = @id AND Tienda_Id = @tiendaId;
        `)

      if (!result.recordset.length) {
        return res.status(404).json({ message: 'Repartidor no encontrado' })
      }

      return res.json({ message: 'Repartidor eliminado' })
    } catch (error) {
      console.error('[DELETE /repartidores/:id] Error', error)
      return res.status(500).json({ message: 'Error al eliminar repartidor' })
    }
  },
)

// Importar clientes desde Excel (estructura: Cédula, Nombre, Celular, Dirección, Fecha Registro)
app.post(
  '/clientes/import-excel',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    const { rows } = req.body as {
      rows?: {
        Cedula?: string
        Nombre?: string
        Celular?: string | null
        Direccion?: string | null
        FechaRegistro?: string | null
      }[]
    }

    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ message: 'rows debe ser un arreglo con clientes' })
    }

    const results: { index: number; ok: boolean; error?: string }[] = []

    try {
      const pool = await getPool()

      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i]
        if (!row || !row.Cedula || !row.Nombre) {
          results.push({
            index: i,
            ok: false,
            error: 'Faltan campos obligatorios (Cédula o Nombre)',
          })
          continue
        }

        let fecha: Date | null = null
        if (row.FechaRegistro) {
          const f = new Date(row.FechaRegistro)
          if (!Number.isNaN(f.getTime())) {
            fecha = f
          }
        }

        try {
          await pool
            .request()
            .input('tiendaId', req.user.tiendaId)
            .input('cedula', row.Cedula.trim())
            .input('nombre', row.Nombre.trim())
            .input('celular', row.Celular ?? null)
            .input('direccion', row.Direccion ?? null)
            .input('fechaRegistro', fecha)
            .query(`
              IF EXISTS (SELECT 1 FROM Clientes WHERE Tienda_Id = @tiendaId AND Cedula = @cedula)
              BEGIN
                UPDATE Clientes
                SET
                  Nombre = @nombre,
                  Celular = @celular,
                  Direccion = @direccion,
                  FechaRegistro = COALESCE(@fechaRegistro, FechaRegistro)
                WHERE Tienda_Id = @tiendaId AND Cedula = @cedula;
              END
              ELSE
              BEGIN
                INSERT INTO Clientes (Tienda_Id, Cedula, Nombre, Celular, Direccion, FechaRegistro)
                VALUES (
                  @tiendaId,
                  @cedula,
                  @nombre,
                  @celular,
                  @direccion,
                  COALESCE(@fechaRegistro, GETDATE())
                );
              END
            `)

          results.push({ index: i, ok: true })
        } catch (error) {
          console.error('[POST /clientes/import-excel] Error en fila', i, error)
          results.push({
            index: i,
            ok: false,
            error: 'Error al importar esta fila; revisa los datos',
          })
        }
      }

      const okCount = results.filter((r) => r.ok).length
      const errorCount = results.length - okCount

      return res.json({
        total: results.length,
        exitosos: okCount,
        conErrores: errorCount,
        detalle: results,
      })
    } catch (error) {
      console.error('[POST /clientes/import-excel] Error general', error)
      return res.status(500).json({ message: 'Error al importar clientes desde Excel' })
    }
  },
)

// Top productos más vendidos (para dashboard)
app.get(
  '/dashboard/top-productos',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    const limit = Math.min(Number(req.query.limit) || 10, 20)

    try {
      const pool = await getPool()
      const result = await pool
        .request()
        .input('tiendaId', sql.UniqueIdentifier, req.user.tiendaId)
        .input('limit', sql.Int, limit)
        .query(`
          SELECT TOP (@limit)
            p.Id AS Producto_Id,
            p.Nombre AS ProductoNombre,
            p.CodigoInterno,
            SUM(d.Cantidad) AS TotalVendido,
            SUM(d.Cantidad * d.PrecioUnitario) AS Ingresos
          FROM Venta_Detalle d
          INNER JOIN Ventas v ON d.Venta_Id = v.Id
          INNER JOIN Productos p ON d.Producto_Id = p.Id
          WHERE v.Tienda_Id = @tiendaId
          GROUP BY p.Id, p.Nombre, p.CodigoInterno
          ORDER BY SUM(d.Cantidad) DESC
        `)

      const rows = result.recordset
      return res.json(rows)
    } catch (error) {
      console.error('[GET /dashboard/top-productos] Error', error)
      return res.status(500).json({ message: 'Error al obtener top productos' })
    }
  },
)

// Listar ventas de la tienda actual (resumen)
app.get(
  '/ventas',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    const { desde, hasta } = req.query as { desde?: string; hasta?: string }

    let desdeDate: Date | null = null
    let hastaDate: Date | null = null

    try {
      if (desde) {
        const d = new Date(desde)
        if (!Number.isNaN(d.getTime())) {
          desdeDate = d
        }
      }
      if (hasta) {
        const d = new Date(hasta)
        if (!Number.isNaN(d.getTime())) {
          hastaDate = d
        }
      }
    } catch {
      // Ignorar formatos inválidos y seguir sin filtros de fecha
      desdeDate = null
      hastaDate = null
    }

    try {
      const pool = await getPool()
      const result = await pool
        .request()
        .input('tiendaId', req.user.tiendaId)
        .input('desde', desdeDate)
        .input('hasta', hastaDate)
        .query(`
          SELECT
            v.Id,
            v.Fecha,
            v.TipoVenta,
            v.TipoEntrega,
            v.MetodoPago,
            v.Subtotal,
            v.DescuentoTotal,
            v.Total,
            v.Observacion,
            v.Estado,
            c.Id AS ClienteId,
            c.Nombre AS ClienteNombre,
            r.Id AS RepartidorId,
            r.Nombre AS RepartidorNombre
          FROM Ventas v
          INNER JOIN Clientes c ON v.Cliente_Id = c.Id
          LEFT JOIN Repartidores r ON v.Repartidor_Id = r.Id
          WHERE v.Tienda_Id = @tiendaId
            AND (@desde IS NULL OR v.Fecha >= @desde)
            AND (@hasta IS NULL OR v.Fecha < DATEADD(DAY, 1, @hasta))
          ORDER BY v.Fecha DESC, v.Id DESC
        `)

      return res.json(result.recordset)
    } catch (error) {
      console.error('[GET /ventas] Error', error)
      return res.status(500).json({ message: 'Error al obtener ventas' })
    }
  },
)

// Obtener detalle de una venta
app.get(
  '/ventas/:id',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    const { id } = req.params

    try {
      const ventaId = Number(id)
      if (Number.isNaN(ventaId)) {
        return res.status(400).json({ message: 'Id de venta inválido' })
      }

      const pool = await getPool()

      const headerResult = await pool
        .request()
        .input('id', ventaId)
        .input('tiendaId', req.user.tiendaId)
        .query(`
          SELECT TOP 1
            v.Id,
            v.Fecha,
            v.TipoVenta,
            v.TipoEntrega,
            v.MetodoPago,
            v.Subtotal,
            v.DescuentoTotal,
            v.Total,
            v.Observacion,
            v.Estado,
            c.Id AS ClienteId,
            c.Nombre AS ClienteNombre,
            r.Id AS RepartidorId,
            r.Nombre AS RepartidorNombre
          FROM Ventas v
          INNER JOIN Clientes c ON v.Cliente_Id = c.Id
          LEFT JOIN Repartidores r ON v.Repartidor_Id = r.Id
          WHERE v.Id = @id AND v.Tienda_Id = @tiendaId
        `)

      const header = headerResult.recordset[0]
      if (!header) {
        return res.status(404).json({ message: 'Venta no encontrada' })
      }

      const detalleResult = await pool
        .request()
        .input('ventaId', ventaId)
        .query(`
          SELECT
            d.Id,
            d.Producto_Id,
            p.Nombre AS ProductoNombre,
            p.CodigoInterno,
            p.CodigoBarras,
            img.Url AS ImagenUrl,
            d.Variante_Id,
            v.Atributo AS VarianteAtributo,
            v.Valor AS VarianteValor,
            v.CodigoSKU AS VarianteCodigoSKU,
            v.PrecioAdicional AS VariantePrecioAdicional,
            d.Cantidad,
            d.PrecioUnitario,
            d.Cantidad * d.PrecioUnitario AS Importe
          FROM Venta_Detalle d
          INNER JOIN Productos p ON d.Producto_Id = p.Id
          LEFT JOIN Producto_Variaciones v ON d.Variante_Id = v.Id
          OUTER APPLY (
            SELECT TOP 1 Url
            FROM Producto_Imagenes
            WHERE Producto_Id = p.Id AND EsPrincipal = 1
            ORDER BY Id
          ) img
          WHERE d.Venta_Id = @ventaId
          ORDER BY d.Id
        `)

      return res.json({
        cabecera: header,
        detalle: detalleResult.recordset,
      })
    } catch (error) {
      console.error('[GET /ventas/:id] Error', error)
      return res.status(500).json({ message: 'Error al obtener detalle de la venta' })
    }
  },
)

// Listar movimientos de inventario de la tienda actual
app.get(
  '/movimientos-inventario',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    try {
      const pool = await getPool()
      const result = await pool
        .request()
        .input('tiendaId', req.user.tiendaId)
        .query(`
          SELECT
            m.Id,
            m.Fecha,
            m.TipoMovimiento,
            m.Cantidad,
            m.Motivo,
            m.Producto_Id,
            p.Nombre AS ProductoNombre,
            p.CodigoInterno,
            p.CodigoBarras,
            img.Url AS ImagenUrl,
            m.Variacion_Id AS Variante_Id,
            v.Atributo AS VarianteAtributo,
            v.Valor AS VarianteValor,
            v.CodigoSKU AS VarianteCodigoSKU
          FROM Movimientos_Inventario m
          INNER JOIN Productos p ON m.Producto_Id = p.Id
          LEFT JOIN Producto_Variaciones v ON m.Variacion_Id = v.Id
          OUTER APPLY (
            SELECT TOP 1 Url
            FROM Producto_Imagenes
            WHERE Producto_Id = p.Id AND EsPrincipal = 1
            ORDER BY Id
          ) img
          WHERE m.Tienda_Id = @tiendaId
          ORDER BY m.Fecha DESC, m.Id DESC
        `)

      return res.json(result.recordset)
    } catch (error) {
      console.error('[GET /movimientos-inventario] Error', error)
      return res.status(500).json({ message: 'Error al obtener movimientos de inventario' })
    }
  },
)

// Actualizar cabecera de una venta (tipo, entrega, pago, descuento, observación)
app.put(
  '/ventas/:id',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    const { id } = req.params
    const { tipoVenta, tipoEntrega, metodoPago, observacion, descuentoTotal, estado } = req.body as {
      tipoVenta?: string
      tipoEntrega?: string
      metodoPago?: string
      observacion?: string
      descuentoTotal?: number
      estado?: string
    }

    try {
      const ventaId = Number(id)
      if (Number.isNaN(ventaId)) {
        return res.status(400).json({ message: 'Id de venta inválido' })
      }

      const pool = await getPool()
      const request = pool
        .request()
        .input('id', ventaId)
        .input('tiendaId', req.user.tiendaId)
        .input('tipoVenta', tipoVenta ?? null)
        .input('tipoEntrega', tipoEntrega ?? null)
        .input('metodoPago', metodoPago ?? null)
        .input('observacion', observacion ?? null)
        .input('descuentoTotal', typeof descuentoTotal === 'number' ? descuentoTotal : null)
        .input('estado', estado ?? null)

      const result = await request.query(`
        DECLARE @subtotal DECIMAL(18,2);
        SELECT @subtotal = Subtotal
        FROM Ventas
        WHERE Id = @id AND Tienda_Id = @tiendaId;

        IF @subtotal IS NULL
        BEGIN
          SELECT -1 AS Id;
          RETURN;
        END

        DECLARE @desc DECIMAL(18,2) =
          CASE
            WHEN @descuentoTotal IS NULL OR @descuentoTotal < 0 THEN 0
            WHEN @descuentoTotal > @subtotal THEN @subtotal
            ELSE @descuentoTotal
          END;

        UPDATE Ventas
        SET
          TipoVenta = COALESCE(@tipoVenta, TipoVenta),
          TipoEntrega = COALESCE(@tipoEntrega, TipoEntrega),
          MetodoPago = COALESCE(@metodoPago, MetodoPago),
          Observacion = COALESCE(@observacion, Observacion),
          DescuentoTotal = @desc,
          Total = @subtotal - @desc,
          Estado = COALESCE(@estado, Estado)
        WHERE Id = @id AND Tienda_Id = @tiendaId;

        IF @@ROWCOUNT = 0
        BEGIN
          SELECT -1 AS Id;
          RETURN;
        END

        SELECT
          v.Id,
          v.Fecha,
          v.TipoVenta,
          v.TipoEntrega,
          v.MetodoPago,
          v.Subtotal,
          v.DescuentoTotal,
          v.Total,
          v.Observacion,
          v.Estado,
          c.Id AS ClienteId,
          c.Nombre AS ClienteNombre,
          r.Id AS RepartidorId,
          r.Nombre AS RepartidorNombre
        FROM Ventas v
        INNER JOIN Clientes c ON v.Cliente_Id = c.Id
        LEFT JOIN Repartidores r ON v.Repartidor_Id = r.Id
        WHERE v.Id = @id AND v.Tienda_Id = @tiendaId;
      `)

      const row = result.recordset[0] as
        | {
            Id: number
            Fecha: Date
            TipoVenta: string | null
            TipoEntrega: string | null
            MetodoPago: string | null
            Subtotal: number
            DescuentoTotal: number
            Total: number
            Observacion: string | null
            Estado: string | null
            ClienteId: number
            ClienteNombre: string
            RepartidorId: number | null
            RepartidorNombre: string | null
          }
        | { Id: -1 }

      if (!row || row.Id === -1) {
        return res.status(404).json({ message: 'Venta no encontrada' })
      }

      return res.json(row)
    } catch (error) {
      console.error('[PUT /ventas/:id] Error', error)
      return res.status(500).json({ message: 'Error al actualizar venta' })
    }
  },
)

// Eliminar una venta (cabecera + detalle)
app.delete(
  '/ventas/:id',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    const { id } = req.params

    try {
      const ventaId = Number(id)
      if (Number.isNaN(ventaId)) {
        return res.status(400).json({ message: 'Id de venta inválido' })
      }

      const pool = await getPool()
      const tx = new sql.Transaction(pool)
      await tx.begin()

      try {
        const reqTx = new sql.Request(tx)
        reqTx.input('id', ventaId).input('tiendaId', req.user.tiendaId)

        await reqTx.query(`
          DELETE FROM Venta_Detalle
          WHERE Venta_Id = @id;

          DELETE FROM Ventas
          WHERE Id = @id AND Tienda_Id = @tiendaId;
        `)

        await tx.commit()
      } catch (innerErr) {
        await tx.rollback()
        throw innerErr
      }

      return res.json({ message: 'Venta eliminada' })
    } catch (error) {
      console.error('[DELETE /ventas/:id] Error', error)
      return res.status(500).json({ message: 'Error al eliminar venta' })
    }
  },
)

// ==========================
// APARTADOS (Panel)
// ==========================

// Listar apartados de la tienda actual (resumen)
app.get(
  '/apartados',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    try {
      const pool = await getPool()
      const result = await pool
        .request()
        .input('tiendaId', req.user.tiendaId)
        .query(`
          SELECT
            a.Id,
            a.FechaCreacion,
            a.FechaVencimiento,
            a.Total,
            a.Abonado,
            a.Saldo,
            CASE
              WHEN a.Estado = 'Pendiente' AND a.FechaVencimiento < GETDATE() THEN 'Vencido'
              ELSE a.Estado
            END AS Estado,
            c.Id AS ClienteId,
            c.Nombre AS ClienteNombre,
            c.Cedula AS ClienteCedula,
            c.Celular AS ClienteCelular
          FROM Apartados a
          INNER JOIN Clientes c ON a.Cliente_Id = c.Id
          WHERE a.Tienda_Id = @tiendaId
          ORDER BY a.FechaCreacion DESC, a.Id DESC
        `)

      return res.json(result.recordset)
    } catch (error) {
      console.error('[GET /apartados] Error', error)
      return res.status(500).json({ message: 'Error al obtener apartados' })
    }
  },
)

// Obtener detalle de un apartado (cabecera + detalle + pagos)
app.get(
  '/apartados/:id',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    const { id } = req.params

    try {
      const apartadoId = Number(id)
      if (Number.isNaN(apartadoId)) {
        return res.status(400).json({ message: 'Id de apartado inválido' })
      }

      const pool = await getPool()

      const headerResult = await pool
        .request()
        .input('id', apartadoId)
        .input('tiendaId', req.user.tiendaId)
        .query(`
          SELECT TOP 1
            a.Id,
            a.FechaCreacion,
            a.FechaVencimiento,
            a.Total,
            a.Abonado,
            a.Saldo,
            CASE
              WHEN a.Estado = 'Pendiente' AND a.FechaVencimiento < GETDATE() THEN 'Vencido'
              ELSE a.Estado
            END AS Estado,
            c.Id AS ClienteId,
            c.Nombre AS ClienteNombre,
            c.Cedula AS ClienteCedula,
            c.Email AS ClienteEmail,
            c.Celular AS ClienteCelular,
            c.Direccion AS ClienteDireccion,
            c.Ciudad AS ClienteCiudad
          FROM Apartados a
          INNER JOIN Clientes c ON a.Cliente_Id = c.Id
          WHERE a.Id = @id AND a.Tienda_Id = @tiendaId
        `)

      const header = headerResult.recordset[0]
      if (!header) {
        return res.status(404).json({ message: 'Apartado no encontrado' })
      }

      const detalleResult = await pool
        .request()
        .input('apartadoId', apartadoId)
        .query(`
          SELECT
            d.Id,
            d.Apartado_Id,
            d.Producto_Id,
            p.Nombre AS ProductoNombre,
            p.CodigoInterno,
            p.CodigoBarras,
            img.Url AS ImagenUrl,
            d.Variante_Id,
            v.Atributo AS VarianteAtributo,
            v.Valor AS VarianteValor,
            v.CodigoSKU AS VarianteCodigoSKU,
            d.Cantidad,
            d.PrecioVenta,
            d.Cantidad * d.PrecioVenta AS Importe
          FROM Apartados_Detalle d
          INNER JOIN Productos p ON d.Producto_Id = p.Id
          LEFT JOIN Producto_Variaciones v ON d.Variante_Id = v.Id
          OUTER APPLY (
            SELECT TOP 1 Url
            FROM Producto_Imagenes
            WHERE Producto_Id = p.Id AND EsPrincipal = 1
            ORDER BY Id
          ) img
          WHERE d.Apartado_Id = @apartadoId
          ORDER BY d.Id
        `)

      const pagosResult = await pool
        .request()
        .input('apartadoId', apartadoId)
        .query(`
          SELECT
            Id,
            Apartado_Id,
            FechaPago,
            Monto,
            MetodoPago,
            Referencia,
            Notas
          FROM Apartado_Pagos
          WHERE Apartado_Id = @apartadoId
          ORDER BY FechaPago DESC, Id DESC
        `)

      return res.json({
        cabecera: header,
        detalle: detalleResult.recordset,
        pagos: pagosResult.recordset,
      })
    } catch (error) {
      console.error('[GET /apartados/:id] Error', error)
      return res.status(500).json({ message: 'Error al obtener detalle del apartado' })
    }
  },
)

// Crear apartado (cabecera + detalle + (opcional) pago inicial) + movimiento inventario (SALIDA) y descuento de stock
app.post(
  '/apartados',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    const { clienteId, fechaVencimiento, items, pagoInicial } = req.body as {
      clienteId?: number
      fechaVencimiento?: string
      items?: Array<{ productoId: number; cantidad: number; precioVenta: number; varianteId?: number | null }>
      pagoInicial?: { monto: number; metodoPago: string; referencia?: string; notas?: string } | null
    }

    if (!clienteId || !fechaVencimiento || !items || items.length === 0) {
      return res.status(400).json({ message: 'Datos incompletos para crear el apartado' })
    }

    const vencDate = new Date(fechaVencimiento)
    if (Number.isNaN(vencDate.getTime())) {
      return res.status(400).json({ message: 'Fecha de vencimiento inválida' })
    }

    const subtotal = items.reduce((acc, it) => acc + it.cantidad * it.precioVenta, 0)
    if (subtotal <= 0) {
      return res.status(400).json({ message: 'Total inválido' })
    }

    let tx: sql.Transaction | null = null

    try {
      const pool = await getPool()
      tx = new sql.Transaction(pool)
      await tx.begin()

      // Validar stock (producto base) antes de descontar
      for (const it of items) {
        const stockRes = await new sql.Request(tx)
          .input('productoId', sql.Int, it.productoId)
          .input('tiendaId', sql.UniqueIdentifier, req.user.tiendaId)
          .query(`
            SELECT TOP 1 StockActual
            FROM Productos
            WHERE Id = @productoId AND Tienda_Id = @tiendaId
          `)
        const row = stockRes.recordset[0] as { StockActual: number } | undefined
        const stock = row?.StockActual ?? 0
        if (it.cantidad <= 0) {
          throw new Error('Cantidad inválida en un ítem del apartado')
        }
        if (stock < it.cantidad) {
          throw new Error('Stock insuficiente para crear el apartado')
        }
      }

      // 1) Crear cabecera
      const headerRes = await new sql.Request(tx)
        .input('tiendaId', sql.UniqueIdentifier, req.user.tiendaId)
        .input('clienteId', sql.Int, clienteId)
        .input('fechaVenc', sql.DateTime, vencDate)
        .input('total', sql.Decimal(18, 2), subtotal)
        .query(`
          INSERT INTO Apartados (
            Tienda_Id,
            Cliente_Id,
            FechaCreacion,
            FechaVencimiento,
            Total,
            Abonado,
            Estado
          )
          OUTPUT INSERTED.Id
          VALUES (
            @tiendaId,
            @clienteId,
            GETDATE(),
            @fechaVenc,
            @total,
            0,
            'Pendiente'
          )
        `)

      const apartadoId = (headerRes.recordset[0] as { Id: number } | undefined)?.Id
      if (!apartadoId) {
        throw new Error('No se pudo obtener el Id del apartado creado')
      }

      // 2) Insertar detalle + descontar stock + movimiento inventario (SALIDA)
      for (const it of items) {
        const detReq = new sql.Request(tx)
        detReq
          .input('apartadoId', sql.Int, apartadoId)
          .input('productoId', sql.Int, it.productoId)
          .input('cantidad', sql.Int, it.cantidad)
          .input('precioVenta', sql.Decimal(18, 2), it.precioVenta)
          .input('varianteId', sql.Int, it.varianteId ?? null)

        await detReq.query(`
          INSERT INTO Apartados_Detalle (
            Apartado_Id,
            Producto_Id,
            Cantidad,
            PrecioVenta,
            Variante_Id
          )
          VALUES (
            @apartadoId,
            @productoId,
            @cantidad,
            @precioVenta,
            @varianteId
          )
        `)

        await new sql.Request(tx)
          .input('productoId', sql.Int, it.productoId)
          .input('cantidad', sql.Int, it.cantidad)
          .query(`
            UPDATE Productos
            SET StockActual = ISNULL(StockActual, 0) - @cantidad
            WHERE Id = @productoId
          `)

        if (it.varianteId != null) {
          await new sql.Request(tx)
            .input('varianteId', sql.Int, it.varianteId)
            .input('cantidad', sql.Int, it.cantidad)
            .query(`
              UPDATE Producto_Variaciones
              SET StockActual = ISNULL(StockActual, 0) - @cantidad
              WHERE Id = @varianteId
            `)
        }

        await new sql.Request(tx)
          .input('tiendaId', sql.UniqueIdentifier, req.user.tiendaId)
          .input('productoId', sql.Int, it.productoId)
          .input('variacionId', sql.Int, it.varianteId ?? null)
          .input('cantidad', sql.Int, it.cantidad)
          .input('motivo', sql.NVarChar, `Apartado #${apartadoId}`)
          .query(`
            INSERT INTO Movimientos_Inventario (
              Tienda_Id,
              Producto_Id,
              Variacion_Id,
              TipoMovimiento,
              Cantidad,
              Motivo,
              Fecha
            )
            VALUES (
              @tiendaId,
              @productoId,
              @variacionId,
              'SALIDA',
              @cantidad,
              @motivo,
              GETDATE()
            )
          `)
      }

      // 3) Pago inicial (opcional)
      if (pagoInicial && typeof pagoInicial.monto === 'number' && pagoInicial.monto > 0) {
        const monto = pagoInicial.monto

        await new sql.Request(tx)
          .input('apartadoId', sql.Int, apartadoId)
          .input('monto', sql.Decimal(18, 2), monto)
          .input('metodoPago', sql.NVarChar, pagoInicial.metodoPago)
          .input('referencia', sql.NVarChar, pagoInicial.referencia ?? null)
          .input('notas', sql.NVarChar, pagoInicial.notas ?? null)
          .query(`
            INSERT INTO Apartado_Pagos (
              Apartado_Id,
              FechaPago,
              Monto,
              MetodoPago,
              Referencia,
              Notas
            )
            VALUES (
              @apartadoId,
              GETDATE(),
              @monto,
              @metodoPago,
              @referencia,
              @notas
            )
          `)

        await new sql.Request(tx)
          .input('apartadoId', sql.Int, apartadoId)
          .input('monto', sql.Decimal(18, 2), monto)
          .query(`
            UPDATE Apartados
            SET Abonado = ISNULL(Abonado, 0) + @monto
            WHERE Id = @apartadoId;

            UPDATE Apartados
            SET Estado = CASE WHEN Abonado >= Total THEN 'Completado' ELSE Estado END
            WHERE Id = @apartadoId;
          `)
      }

      await tx.commit()
      return res.status(201).json({ message: 'Apartado creado correctamente', apartadoId })
    } catch (error) {
      if (tx) {
        try {
          await tx.rollback()
        } catch {
          // ignore
        }
      }
      const msg = error instanceof Error ? error.message : 'Error al crear apartado'
      console.error('[POST /apartados] Error', error)
      return res.status(500).json({ message: msg })
    }
  },
)

// Agregar pago a un apartado y actualizar abonado/estado
app.post(
  '/apartados/:id/pagos',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    const { id } = req.params
    const { monto, metodoPago, referencia, notas } = req.body as {
      monto?: number
      metodoPago?: string
      referencia?: string
      notas?: string
    }

    const apartadoId = Number(id)
    if (Number.isNaN(apartadoId)) {
      return res.status(400).json({ message: 'Id de apartado inválido' })
    }
    if (typeof monto !== 'number' || Number.isNaN(monto) || monto <= 0) {
      return res.status(400).json({ message: 'Monto inválido' })
    }
    if (!metodoPago) {
      return res.status(400).json({ message: 'Método de pago requerido' })
    }

    let tx: sql.Transaction | null = null
    try {
      const pool = await getPool()
      tx = new sql.Transaction(pool)
      await tx.begin()

      const existsRes = await new sql.Request(tx)
        .input('id', sql.Int, apartadoId)
        .input('tiendaId', sql.UniqueIdentifier, req.user.tiendaId)
        .query(`
          SELECT TOP 1 Id, Total, Abonado
          FROM Apartados
          WHERE Id = @id AND Tienda_Id = @tiendaId
        `)

      const row = existsRes.recordset[0] as { Id: number; Total: number; Abonado: number } | undefined
      if (!row) {
        await tx.rollback()
        return res.status(404).json({ message: 'Apartado no encontrado' })
      }

      await new sql.Request(tx)
        .input('apartadoId', sql.Int, apartadoId)
        .input('monto', sql.Decimal(18, 2), monto)
        .input('metodoPago', sql.NVarChar, metodoPago)
        .input('referencia', sql.NVarChar, referencia ?? null)
        .input('notas', sql.NVarChar, notas ?? null)
        .query(`
          INSERT INTO Apartado_Pagos (
            Apartado_Id,
            FechaPago,
            Monto,
            MetodoPago,
            Referencia,
            Notas
          )
          VALUES (
            @apartadoId,
            GETDATE(),
            @monto,
            @metodoPago,
            @referencia,
            @notas
          )
        `)

      await new sql.Request(tx)
        .input('apartadoId', sql.Int, apartadoId)
        .input('monto', sql.Decimal(18, 2), monto)
        .query(`
          UPDATE Apartados
          SET Abonado = ISNULL(Abonado, 0) + @monto
          WHERE Id = @apartadoId;

          UPDATE Apartados
          SET Estado = CASE WHEN Abonado >= Total THEN 'Completado' ELSE Estado END
          WHERE Id = @apartadoId;
        `)

      await tx.commit()
      return res.json({ message: 'Pago registrado correctamente' })
    } catch (error) {
      if (tx) {
        try {
          await tx.rollback()
        } catch {
          // ignore
        }
      }
      console.error('[POST /apartados/:id/pagos] Error', error)
      return res.status(500).json({ message: 'Error al registrar pago' })
    }
  },
)

// Eliminar un pago de apartado y ajustar Abonado/Estado
app.delete(
  '/apartados/:id/pagos/:pagoId',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    const { id, pagoId } = req.params
    const apartadoId = Number(id)
    const pagoIdNum = Number(pagoId)

    if (Number.isNaN(apartadoId) || Number.isNaN(pagoIdNum)) {
      return res.status(400).json({ message: 'Ids inválidos' })
    }

    let tx: sql.Transaction | null = null
    try {
      const pool = await getPool()
      tx = new sql.Transaction(pool)
      await tx.begin()

      // Obtener monto del pago y validar que el apartado pertenece a la tienda
      const infoRes = await new sql.Request(tx)
        .input('pagoId', sql.Int, pagoIdNum)
        .input('apartadoId', sql.Int, apartadoId)
        .input('tiendaId', sql.UniqueIdentifier, req.user.tiendaId)
        .query(`
          SELECT TOP 1
            p.Id,
            p.Monto,
            a.Id AS ApartadoId,
            a.Total,
            a.Abonado
          FROM Apartado_Pagos p
          INNER JOIN Apartados a ON p.Apartado_Id = a.Id
          WHERE p.Id = @pagoId AND p.Apartado_Id = @apartadoId AND a.Tienda_Id = @tiendaId
        `)

      const row = infoRes.recordset[0] as
        | { Id: number; Monto: number; ApartadoId: number; Total: number; Abonado: number }
        | undefined
      if (!row) {
        await tx.rollback()
        return res.status(404).json({ message: 'Pago no encontrado para este apartado' })
      }

      const monto = row.Monto ?? 0

      await new sql.Request(tx)
        .input('pagoId', sql.Int, pagoIdNum)
        .query(`
          DELETE FROM Apartado_Pagos
          WHERE Id = @pagoId;
        `)

      await new sql.Request(tx)
        .input('apartadoId', sql.Int, apartadoId)
        .input('monto', sql.Decimal(18, 2), monto)
        .query(`
          UPDATE Apartados
          SET Abonado = CASE
                WHEN ISNULL(Abonado, 0) - @monto < 0 THEN 0
                ELSE ISNULL(Abonado, 0) - @monto
              END
          WHERE Id = @apartadoId;

          UPDATE Apartados
          SET Estado = CASE WHEN Abonado >= Total THEN 'Completado' ELSE 'Pendiente' END
          WHERE Id = @apartadoId;
        `)

      await tx.commit()
      return res.json({ message: 'Pago eliminado correctamente' })
    } catch (error) {
      if (tx) {
        try {
          await tx.rollback()
        } catch {
          // ignore
        }
      }
      console.error('[DELETE /apartados/:id/pagos/:pagoId] Error', error)
      return res.status(500).json({ message: 'Error al eliminar pago' })
    }
  },
)

// Actualizar un apartado (estado y/o fecha de vencimiento)
app.put(
  '/apartados/:id',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    const { id } = req.params
    const { estado, fechaVencimiento } = req.body as { estado?: string; fechaVencimiento?: string }

    const apartadoId = Number(id)
    if (Number.isNaN(apartadoId)) {
      return res.status(400).json({ message: 'Id de apartado inválido' })
    }

    let vencDate: Date | null = null
    if (fechaVencimiento) {
      const d = new Date(fechaVencimiento)
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({ message: 'Fecha de vencimiento inválida' })
      }
      vencDate = d
    }

    const allowed = new Set(['Pendiente', 'Completado', 'Vencido'])
    if (estado != null && !allowed.has(estado)) {
      return res.status(400).json({ message: 'Estado inválido' })
    }

    try {
      const pool = await getPool()
      const result = await pool
        .request()
        .input('id', sql.Int, apartadoId)
        .input('tiendaId', sql.UniqueIdentifier, req.user.tiendaId)
        .input('estado', sql.NVarChar, estado ?? null)
        .input('fechaVenc', sql.DateTime, vencDate)
        .query(`
          UPDATE Apartados
          SET
            Estado = COALESCE(@estado, Estado),
            FechaVencimiento = COALESCE(@fechaVenc, FechaVencimiento)
          WHERE Id = @id AND Tienda_Id = @tiendaId;

          IF @@ROWCOUNT = 0
          BEGIN
            SELECT -1 AS Id;
            RETURN;
          END

          SELECT
            a.Id,
            a.FechaCreacion,
            a.FechaVencimiento,
            a.Total,
            a.Abonado,
            a.Saldo,
            CASE
              WHEN a.Estado = 'Pendiente' AND a.FechaVencimiento < GETDATE() THEN 'Vencido'
              ELSE a.Estado
            END AS Estado
          FROM Apartados a
          WHERE a.Id = @id AND a.Tienda_Id = @tiendaId;
        `)

      const row = result.recordset[0] as { Id: number } | undefined
      if (!row || row.Id === -1) {
        return res.status(404).json({ message: 'Apartado no encontrado' })
      }

      return res.json(row)
    } catch (error) {
      console.error('[PUT /apartados/:id] Error', error)
      return res.status(500).json({ message: 'Error al actualizar apartado' })
    }
  },
)

// Eliminar un apartado (cabecera, detalle y pagos)
app.delete(
  '/apartados/:id',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    const { id } = req.params
    const apartadoId = Number(id)
    if (Number.isNaN(apartadoId)) {
      return res.status(400).json({ message: 'Id de apartado inválido' })
    }

    let tx: sql.Transaction | null = null
    try {
      const pool = await getPool()
      tx = new sql.Transaction(pool)
      await tx.begin()

      const reqTx = new sql.Request(tx)
      reqTx.input('id', sql.Int, apartadoId).input('tiendaId', sql.UniqueIdentifier, req.user.tiendaId)

      await reqTx.query(`
        DELETE FROM Apartados_Detalle
        WHERE Apartado_Id = @id;

        DELETE FROM Apartados
        WHERE Id = @id AND Tienda_Id = @tiendaId;
      `)

      await tx.commit()
      return res.json({ message: 'Apartado eliminado' })
    } catch (error) {
      if (tx) {
        try {
          await tx.rollback()
        } catch {
          // ignore
        }
      }
      console.error('[DELETE /apartados/:id] Error', error)
      return res.status(500).json({ message: 'Error al eliminar apartado' })
    }
  },
)

// ==========================
// PROMOCIONES (Panel)
// ==========================

// Listar promociones de la tienda actual
app.get(
  '/promociones',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    try {
      const pool = await getPool()
      const result = await pool
        .request()
        .input('tiendaId', req.user.tiendaId)
        .query(`
          SELECT
            Id,
            Nombre,
            Descripcion,
            TipoDescuento,
            ValorDescuento,
            TipoAplicacion,
            MinCantidad,
            MinTotal,
            AplicaSobre,
            FechaInicio,
            FechaFin,
            Activo
          FROM Promociones
          WHERE Tienda_Id = @tiendaId
          ORDER BY Activo DESC, FechaInicio DESC, Id DESC
        `)

      return res.json(result.recordset)
    } catch (error) {
      console.error('[GET /promociones] Error', error)
      return res.status(500).json({ message: 'Error al obtener promociones' })
    }
  },
)

// Obtener detalle de una promoción (cabecera + productos asociados)
app.get(
  '/promociones/:id',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    const { id } = req.params
    const promoId = Number(id)
    if (Number.isNaN(promoId)) {
      return res.status(400).json({ message: 'Id de promoción inválido' })
    }

    try {
      const pool = await getPool()

      const headerResult = await pool
        .request()
        .input('id', sql.Int, promoId)
        .input('tiendaId', sql.UniqueIdentifier, req.user.tiendaId)
        .query(`
          SELECT TOP 1
            Id,
            Nombre,
            Descripcion,
            TipoDescuento,
            ValorDescuento,
            TipoAplicacion,
            MinCantidad,
            MinTotal,
            AplicaSobre,
            FechaInicio,
            FechaFin,
            Activo
          FROM Promociones
          WHERE Id = @id AND Tienda_Id = @tiendaId
        `)

      const header = headerResult.recordset[0]
      if (!header) {
        return res.status(404).json({ message: 'Promoción no encontrada' })
      }

      const productosResult = await pool
        .request()
        .input('promoId', sql.Int, promoId)
        .query(`
          SELECT
            pp.Id,
            pp.Producto_Id,
            p.Nombre AS ProductoNombre,
            p.CodigoInterno,
            pp.Variante_Id,
            v.Atributo AS VarianteAtributo,
            v.Valor AS VarianteValor,
            v.CodigoSKU AS VarianteCodigoSKU
          FROM Promocion_Productos pp
          INNER JOIN Productos p ON pp.Producto_Id = p.Id
          LEFT JOIN Producto_Variaciones v ON pp.Variante_Id = v.Id
          WHERE pp.Promocion_Id = @promoId
          ORDER BY pp.Id
        `)

      return res.json({
        cabecera: header,
        productos: productosResult.recordset,
      })
    } catch (error) {
      console.error('[GET /promociones/:id] Error', error)
      return res.status(500).json({ message: 'Error al obtener detalle de la promoción' })
    }
  },
)

// Crear promoción (cabecera + productos asociados)
app.post(
  '/promociones',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    const {
      nombre,
      descripcion,
      tipoDescuento,
      valorDescuento,
      tipoAplicacion,
      minCantidad,
      minTotal,
      aplicaSobre,
      fechaInicio,
      fechaFin,
      activo,
      productos,
    } = req.body as {
      nombre?: string
      descripcion?: string
      tipoDescuento?: string
      valorDescuento?: number
      tipoAplicacion?: string
      minCantidad?: number | null
      minTotal?: number | null
      aplicaSobre?: string | null
      fechaInicio?: string
      fechaFin?: string
      activo?: boolean
      productos?: Array<{ productoId: number; varianteId?: number | null }>
    }

    if (!nombre || !tipoDescuento || typeof valorDescuento !== 'number' || !fechaInicio || !fechaFin) {
      return res.status(400).json({ message: 'Datos incompletos para crear la promoción' })
    }
    if (!Array.isArray(productos) || productos.length === 0) {
      return res.status(400).json({ message: 'La promoción debe tener al menos un producto asociado' })
    }

    const allowedTipo = new Set(['PORCENTAJE', 'FIJO'])
    if (!allowedTipo.has(tipoDescuento)) {
      return res.status(400).json({ message: 'Tipo de descuento inválido' })
    }

    const inicioDate = new Date(fechaInicio)
    const finDate = new Date(fechaFin)
    if (Number.isNaN(inicioDate.getTime()) || Number.isNaN(finDate.getTime())) {
      return res.status(400).json({ message: 'Fechas de promoción inválidas' })
    }

    let tx: sql.Transaction | null = null
    try {
      const pool = await getPool()
      tx = new sql.Transaction(pool)
      await tx.begin()

      const headerReq = new sql.Request(tx)
      headerReq
        .input('tiendaId', sql.UniqueIdentifier, req.user.tiendaId)
        .input('nombre', sql.NVarChar, nombre)
        .input('descripcion', sql.NVarChar, descripcion ?? null)
        .input('tipoDescuento', sql.NVarChar, tipoDescuento)
        .input('valorDescuento', sql.Decimal(18, 2), valorDescuento)
        .input('tipoAplicacion', sql.NVarChar, tipoAplicacion ?? 'PRODUCTO')
        .input('minCantidad', sql.Int, typeof minCantidad === 'number' ? minCantidad : null)
        .input('minTotal', sql.Decimal(18, 2), typeof minTotal === 'number' ? minTotal : null)
        .input('aplicaSobre', sql.NVarChar, aplicaSobre ?? null)
        .input('fechaInicio', sql.DateTime, inicioDate)
        .input('fechaFin', sql.DateTime, finDate)
        .input('activo', sql.Bit, activo ?? true)

      const headerResult = await headerReq.query(`
        INSERT INTO Promociones (
          Tienda_Id,
          Nombre,
          Descripcion,
          TipoDescuento,
          ValorDescuento,
          TipoAplicacion,
          MinCantidad,
          MinTotal,
          AplicaSobre,
          FechaInicio,
          FechaFin,
          Activo
        )
        OUTPUT INSERTED.Id
        VALUES (
          @tiendaId,
          @nombre,
          @descripcion,
          @tipoDescuento,
          @valorDescuento,
          @tipoAplicacion,
          @minCantidad,
          @minTotal,
          @aplicaSobre,
          @fechaInicio,
          @fechaFin,
          @activo
        )
      `)

      const promoId = (headerResult.recordset[0] as { Id: number } | undefined)?.Id
      if (!promoId) {
        throw new Error('No se pudo obtener el Id de la promoción creada')
      }

      for (const it of productos) {
        const prodReq = new sql.Request(tx)
        prodReq
          .input('promoId', sql.Int, promoId)
          .input('productoId', sql.Int, it.productoId)
          .input('varianteId', sql.Int, it.varianteId ?? null)

        await prodReq.query(`
          INSERT INTO Promocion_Productos (
            Promocion_Id,
            Producto_Id,
            Variante_Id
          )
          VALUES (
            @promoId,
            @productoId,
            @varianteId
          )
        `)
      }

      await tx.commit()
      return res.status(201).json({ message: 'Promoción creada correctamente', promocionId: promoId })
    } catch (error) {
      if (tx) {
        try {
          await tx.rollback()
        } catch {
          // ignore
        }
      }
      console.error('[POST /promociones] Error', error)
      const msg = error instanceof Error ? error.message : 'Error al crear la promoción'
      return res.status(500).json({ message: msg })
    }
  },
)

// Actualizar promoción (cabecera + productos asociados - reemplazo completo)
app.put(
  '/promociones/:id',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    const { id } = req.params
    const promoId = Number(id)
    if (Number.isNaN(promoId)) {
      return res.status(400).json({ message: 'Id de promoción inválido' })
    }

    const {
      nombre,
      descripcion,
      tipoDescuento,
      valorDescuento,
      tipoAplicacion,
      minCantidad,
      minTotal,
      aplicaSobre,
      fechaInicio,
      fechaFin,
      activo,
      productos,
    } = req.body as {
      nombre?: string
      descripcion?: string
      tipoDescuento?: string
      valorDescuento?: number
      tipoAplicacion?: string
      minCantidad?: number | null
      minTotal?: number | null
      aplicaSobre?: string | null
      fechaInicio?: string
      fechaFin?: string
      activo?: boolean
      productos?: Array<{ productoId: number; varianteId?: number | null }>
    }

    if (!nombre || !tipoDescuento || typeof valorDescuento !== 'number' || !fechaInicio || !fechaFin) {
      return res.status(400).json({ message: 'Datos incompletos para actualizar la promoción' })
    }
    if (!Array.isArray(productos) || productos.length === 0) {
      return res.status(400).json({ message: 'La promoción debe tener al menos un producto asociado' })
    }

    const allowedTipo = new Set(['PORCENTAJE', 'FIJO'])
    if (!allowedTipo.has(tipoDescuento)) {
      return res.status(400).json({ message: 'Tipo de descuento inválido' })
    }

    const inicioDate = new Date(fechaInicio)
    const finDate = new Date(fechaFin)
    if (Number.isNaN(inicioDate.getTime()) || Number.isNaN(finDate.getTime())) {
      return res.status(400).json({ message: 'Fechas de promoción inválidas' })
    }

    let tx: sql.Transaction | null = null
    try {
      const pool = await getPool()
      tx = new sql.Transaction(pool)
      await tx.begin()

      const updateReq = new sql.Request(tx)
      updateReq
        .input('id', sql.Int, promoId)
        .input('tiendaId', sql.UniqueIdentifier, req.user.tiendaId)
        .input('nombre', sql.NVarChar, nombre)
        .input('descripcion', sql.NVarChar, descripcion ?? null)
        .input('tipoDescuento', sql.NVarChar, tipoDescuento)
        .input('valorDescuento', sql.Decimal(18, 2), valorDescuento)
        .input('tipoAplicacion', sql.NVarChar, tipoAplicacion ?? 'PRODUCTO')
        .input('minCantidad', sql.Int, typeof minCantidad === 'number' ? minCantidad : null)
        .input('minTotal', sql.Decimal(18, 2), typeof minTotal === 'number' ? minTotal : null)
        .input('aplicaSobre', sql.NVarChar, aplicaSobre ?? null)
        .input('fechaInicio', sql.DateTime, inicioDate)
        .input('fechaFin', sql.DateTime, finDate)
        .input('activo', sql.Bit, activo ?? true)

      const updateResult = await updateReq.query(`
        UPDATE Promociones
        SET
          Nombre = @nombre,
          Descripcion = @descripcion,
          TipoDescuento = @tipoDescuento,
          ValorDescuento = @valorDescuento,
          TipoAplicacion = @tipoAplicacion,
          MinCantidad = @minCantidad,
          MinTotal = @minTotal,
          AplicaSobre = @aplicaSobre,
          FechaInicio = @fechaInicio,
          FechaFin = @fechaFin,
          Activo = @activo
        WHERE Id = @id AND Tienda_Id = @tiendaId;

        SELECT @@ROWCOUNT AS Affected;
      `)

      const affected = (updateResult.recordset[0] as { Affected: number } | undefined)?.Affected ?? 0
      if (affected === 0) {
        throw new Error('Promoción no encontrada o no pertenece a esta tienda')
      }

      // Reemplazar productos asociados
      await new sql.Request(tx)
        .input('promoId', sql.Int, promoId)
        .query(`
          DELETE FROM Promocion_Productos
          WHERE Promocion_Id = @promoId;
        `)

      for (const it of productos) {
        const prodReq = new sql.Request(tx)
        prodReq
          .input('promoId', sql.Int, promoId)
          .input('productoId', sql.Int, it.productoId)
          .input('varianteId', sql.Int, it.varianteId ?? null)

        await prodReq.query(`
          INSERT INTO Promocion_Productos (
            Promocion_Id,
            Producto_Id,
            Variante_Id
          )
          VALUES (
            @promoId,
            @productoId,
            @varianteId
          )
        `)
      }

      await tx.commit()
      return res.json({ message: 'Promoción actualizada correctamente' })
    } catch (error) {
      if (tx) {
        try {
          await tx.rollback()
        } catch {
          // ignore
        }
      }
      console.error('[PUT /promociones/:id] Error', error)
      const msg = error instanceof Error ? error.message : 'Error al actualizar la promoción'
      return res.status(500).json({ message: msg })
    }
  },
)

// Eliminar promoción (cabecera + productos asociados por ON DELETE CASCADE)
app.delete(
  '/promociones/:id',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    const { id } = req.params
    const promoId = Number(id)
    if (Number.isNaN(promoId)) {
      return res.status(400).json({ message: 'Id de promoción inválido' })
    }

    try {
      const pool = await getPool()
      const result = await pool
        .request()
        .input('id', sql.Int, promoId)
        .input('tiendaId', sql.UniqueIdentifier, req.user.tiendaId)
        .query(`
          DELETE FROM Promociones
          WHERE Id = @id AND Tienda_Id = @tiendaId;

          SELECT @@ROWCOUNT AS Affected;
        `)

      const affected = (result.recordset[0] as { Affected: number } | undefined)?.Affected ?? 0
      if (affected === 0) {
        return res.status(404).json({ message: 'Promoción no encontrada' })
      }

      return res.json({ message: 'Promoción eliminada' })
    } catch (error) {
      console.error('[DELETE /promociones/:id] Error', error)
      return res.status(500).json({ message: 'Error al eliminar promoción' })
    }
  },
)

// ==========================
// ENDPOINTS PÚBLICOS (Ecommerce)
// ==========================

// Obtener información de la tienda por slug
app.get('/public/tiendas/:slug', async (req, res) => {
  const { slug } = req.params
  try {
    const pool = await getPool()
    const result = await pool
      .request()
      .input('slug', slug)
      .query(`
        SELECT Id, NombreComercial, Slug, Configuracion
        FROM Tiendas
        WHERE Slug = @slug AND Activo = 1
      `)

    if (result.recordset.length === 0) {
      return res.status(404).json({ message: 'Tienda no encontrada' })
    }

    const tienda = result.recordset[0]
    if (tienda.Configuracion) {
      tienda.Configuracion = JSON.parse(tienda.Configuracion)
    }

    res.json(tienda)
  } catch (error) {
    console.error('[GET /public/tiendas/:slug] Error', error)
    res.status(500).json({ message: 'Error al obtener la tienda' })
  }
})

// Helper: calcular precio con promociones para un item
type PromoRow = {
  Id: number
  TipoDescuento: string
  ValorDescuento: number
  MinCantidad: number | null
  MinTotal: number | null
  Producto_Id: number
  Variante_Id: number | null
}

async function calcularPrecioConPromo(
  pool: sql.ConnectionPool,
  tiendaId: string,
  items: Array<{ productoId: number; varianteId?: number | null; cantidad: number; precioBase: number }>,
): Promise<Array<{ productoId: number; varianteId?: number | null; cantidad: number; precioBase: number; precioFinal: number; descuentoAplicado: number }>> {
  const promosResult = await pool
    .request()
    .input('tiendaId', sql.UniqueIdentifier, tiendaId)
    .query(`
      SELECT
        p.Id,
        p.TipoDescuento,
        p.ValorDescuento,
        p.MinCantidad,
        p.MinTotal,
        pp.Producto_Id,
        pp.Variante_Id
      FROM Promociones p
      INNER JOIN Promocion_Productos pp ON p.Id = pp.Promocion_Id
      WHERE p.Tienda_Id = @tiendaId
        AND p.Activo = 1
        AND p.FechaInicio <= GETDATE()
        AND p.FechaFin >= GETDATE()
    `)

  const promos = promosResult.recordset as PromoRow[]

  return items.map((item) => {
    const base = typeof item.precioBase === 'number' ? item.precioBase : 0
    let mejorPrecio = base
    let mejorDescuento = 0

    const aplicables = promos.filter((p) => {
      if (p.Producto_Id !== item.productoId) return false
      if (p.Variante_Id != null && item.varianteId != null && p.Variante_Id !== item.varianteId) {
        return false
      }
      if (p.Variante_Id != null && item.varianteId == null) return false
      if (p.MinCantidad != null && item.cantidad < p.MinCantidad) return false
      return true
    })

    for (const promo of aplicables) {
      let precioPromo = base
      if (promo.TipoDescuento === 'PORCENTAJE') {
        const desc = (base * promo.ValorDescuento) / 100
        precioPromo = base - desc
      } else if (promo.TipoDescuento === 'FIJO') {
        precioPromo = base - promo.ValorDescuento
      }
      if (precioPromo < 0) precioPromo = 0

      if (precioPromo < mejorPrecio) {
        mejorPrecio = precioPromo
        mejorDescuento = base - precioPromo
      }
    }

    return {
      ...item,
      precioFinal: mejorPrecio,
      descuentoAplicado: mejorDescuento,
    }
  })
}

// Calcular promociones para una lista de ítems del carrito
app.post('/public/promociones/calcular', async (req, res) => {
  const { tiendaSlug, items } = req.body as {
    tiendaSlug?: string
    items?: Array<{
      productoId: number
      varianteId?: number | null
      cantidad: number
      precioBase: number
    }>
  }

  if (!tiendaSlug || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'Datos incompletos para calcular promociones' })
  }

  try {
    const pool = await getPool()

    // Resolver tienda
    const tiendaResult = await pool
      .request()
      .input('slug', sql.NVarChar, tiendaSlug)
      .query(`
        SELECT Id
        FROM Tiendas
        WHERE Slug = @slug AND Activo = 1
      `)

    const tiendaRow = tiendaResult.recordset[0] as { Id: string } | undefined
    if (!tiendaRow) {
      return res.status(404).json({ message: 'Tienda no encontrada' })
    }

    const tiendaId = tiendaRow.Id

    const salida = await calcularPrecioConPromo(pool, tiendaId, items)
    return res.json(salida)
  } catch (error) {
    console.error('[POST /public/promociones/calcular] Error', error)
    return res.status(500).json({ message: 'Error al calcular promociones' })
  }
})

// Obtener datos de la tienda actual (panel)
app.get(
  '/tienda',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    try {
      const pool = await getPool()
      const result = await pool
        .request()
        .input('tiendaId', req.user.tiendaId)
        .query(`
          SELECT Id, NombreComercial, Slug, EmailContacto, Configuracion, Activo, FechaCreacion
          FROM Tiendas
          WHERE Id = @tiendaId
        `)

      if (result.recordset.length === 0) {
        return res.status(404).json({ message: 'Tienda no encontrada' })
      }

      const tienda = result.recordset[0] as {
        Id: string
        NombreComercial: string
        Slug: string
        EmailContacto: string
        Configuracion: string | null
        Activo: boolean
        FechaCreacion: Date
      }

      let configuracionParsed: unknown = null
      if (tienda.Configuracion) {
        try {
          configuracionParsed = JSON.parse(tienda.Configuracion)
        } catch {
          configuracionParsed = null
        }
      }

      return res.json({
        id: tienda.Id,
        nombreComercial: tienda.NombreComercial,
        slug: tienda.Slug,
        emailContacto: tienda.EmailContacto,
        configuracion: configuracionParsed,
        activo: tienda.Activo,
        fechaCreacion: tienda.FechaCreacion,
      })
    } catch (error) {
      console.error('[GET /tienda] Error', error)
      return res.status(500).json({ message: 'Error al obtener datos de la tienda' })
    }
  },
)

// Actualizar datos básicos de la tienda actual (panel)
app.put(
  '/tienda',
  authMiddleware,
  async (req: express.Request & { user?: JwtPayload }, res: express.Response) => {
    if (!req.user) {
      return res.status(401).json({ message: 'No autorizado' })
    }

    const { nombreComercial, slug, emailContacto, configuracion } = req.body as {
      nombreComercial?: string
      slug?: string
      emailContacto?: string
      configuracion?: unknown
    }

    if (!nombreComercial || !slug || !emailContacto) {
      return res.status(400).json({
        message: 'nombreComercial, slug y emailContacto son obligatorios',
      })
    }

    let configuracionJson: string | null = null
    if (configuracion != null) {
      try {
        configuracionJson = JSON.stringify(configuracion)
      } catch {
        return res.status(400).json({ message: 'Configuración inválida (no es JSON serializable)' })
      }
    }

    try {
      const pool = await getPool()
      const request = pool
        .request()
        .input('tiendaId', req.user.tiendaId)
        .input('nombreComercial', nombreComercial)
        .input('slug', slug)
        .input('emailContacto', emailContacto)
        .input('configuracion', configuracionJson)

      // Validar que el slug no se repita en otra tienda
      const slugResult = await request.query(`
        IF EXISTS (
          SELECT 1 FROM Tiendas
          WHERE Slug = @slug AND Id <> @tiendaId
        )
        BEGIN
          SELECT 1 AS SlugEnUso;
        END
        ELSE
        BEGIN
          SELECT 0 AS SlugEnUso;
        END
      `)

      const slugEnUso = slugResult.recordset[0]?.SlugEnUso === 1
      if (slugEnUso) {
        return res.status(409).json({ message: 'El slug ya está en uso por otra tienda' })
      }

      const updateResult = await pool
        .request()
        .input('tiendaId', req.user.tiendaId)
        .input('nombreComercial', nombreComercial)
        .input('slug', slug)
        .input('emailContacto', emailContacto)
        .input('configuracion', configuracionJson)
        .query(`
          UPDATE Tiendas
          SET
            NombreComercial = @nombreComercial,
            Slug = @slug,
            EmailContacto = @emailContacto,
            Configuracion = @configuracion
          WHERE Id = @tiendaId
        `)

      if (updateResult.rowsAffected[0] === 0) {
        return res.status(404).json({ message: 'Tienda no encontrada' })
      }

      return res.json({ message: 'Tienda actualizada correctamente' })
    } catch (error) {
      console.error('[PUT /tienda] Error', error)
      return res.status(500).json({ message: 'Error al actualizar la tienda' })
    }
  },
)

// Listar categorías visibles de una tienda
app.get('/public/tiendas/:slug/categorias', async (req, res) => {
  const { slug } = req.params
  try {
    const pool = await getPool()
    const result = await pool
      .request()
      .input('slug', slug)
      .query(`
        SELECT c.Id, c.Nombre, c.Slug, c.CategoriaPadre_Id
        FROM Categorias c
        INNER JOIN Tiendas t ON c.Tienda_Id = t.Id
        WHERE t.Slug = @slug AND c.Visible = 1
        ORDER BY c.Nombre ASC
      `)

    res.json(result.recordset)
  } catch (error) {
    console.error('[GET /public/tiendas/:slug/categorias] Error', error)
    res.status(500).json({ message: 'Error al obtener categorías' })
  }
})

// Listar productos visibles de una tienda
app.get('/public/tiendas/:slug/productos', async (req, res) => {
  const { slug } = req.params
  const { categoria, buscar, promocion } = req.query

  try {
    const pool = await getPool()
    const request = pool.request().input('slug', slug)

    let query = `
      SELECT
        p.Id,
        p.Nombre,
        p.CodigoInterno,
        p.Descripcion,
        p.PrecioDetal,
        p.PrecioMayor,
        p.StockActual,
        c.Nombre AS CategoriaNombre,
        c.Slug AS CategoriaSlug,
        (
          SELECT TOP 1 Url
          FROM Producto_Imagenes
          WHERE Producto_Id = p.Id
          ORDER BY EsPrincipal DESC, Orden ASC, Id ASC
        ) AS ImagenPrincipal,
        (
          SELECT STUFF((
            SELECT DISTINCT ',' + Valor
            FROM Producto_Variaciones
            WHERE Producto_Id = p.Id AND Atributo = 'Talla'
            FOR XML PATH('')), 1, 1, '')
        ) AS Tallas,
        (
          SELECT STUFF((
            SELECT DISTINCT ',' + Valor
            FROM Producto_Variaciones
            WHERE Producto_Id = p.Id AND Atributo = 'Color'
            FOR XML PATH('')), 1, 1, '')
        ) AS Colores
      FROM Productos p
      INNER JOIN Tiendas t ON p.Tienda_Id = t.Id
      LEFT JOIN Categorias c ON p.Categoria_Id = c.Id
      WHERE t.Slug = @slug AND p.Visible = 1
    `

    if (categoria) {
      request.input('catSlug', categoria)
      query += ` AND EXISTS (SELECT 1 FROM Categorias c2 WHERE c2.Id = p.Categoria_Id AND c2.Slug = @catSlug)`
    }

    if (buscar) {
      request.input('buscarTerm', `%${buscar}%`)
      query += ` AND (p.Nombre LIKE @buscarTerm OR p.Descripcion LIKE @buscarTerm OR p.CodigoInterno LIKE @buscarTerm)`
    }

    query += ` ORDER BY p.FechaCreacion DESC`

    const result = await request.query(query)
    const recordset = result.recordset as Array<{ Id: number; PrecioDetal: number }>

    // Obtener tiendaId para calcular promociones
    const tiendaRow = await pool
      .request()
      .input('slug', slug)
      .query('SELECT Id FROM Tiendas WHERE Slug = @slug AND Activo = 1')
    const tiendaId = (tiendaRow.recordset[0] as { Id: string } | undefined)?.Id
    if (tiendaId) {
      const itemsConPromo = await calcularPrecioConPromo(
        pool,
        tiendaId,
        recordset.map((p) => ({
          productoId: p.Id,
          varianteId: null as number | null,
          cantidad: 1,
          precioBase: p.PrecioDetal,
        })),
      )
      const mapaPromo = new Map(itemsConPromo.map((i) => [i.productoId, i]))
      for (const row of recordset) {
        const promo = mapaPromo.get(row.Id)
        ;(row as Record<string, unknown>).PrecioOferta = promo ? promo.precioFinal : row.PrecioDetal
        ;(row as Record<string, unknown>).TieneOferta = promo ? promo.descuentoAplicado > 0 : false
      }
    } else {
      for (const row of recordset) {
        ;(row as Record<string, unknown>).PrecioOferta = row.PrecioDetal
        ;(row as Record<string, unknown>).TieneOferta = false
      }
    }

    // Filtrar solo productos con oferta si ?promocion=1
    let resultado = recordset
    if (promocion === '1' || promocion === 'true') {
      resultado = recordset.filter((r) => (r as Record<string, unknown>).TieneOferta === true)
    }

    res.json(resultado)
  } catch (error) {
    console.error('[GET /public/tiendas/:slug/productos] Error', error)
    res.status(500).json({ message: 'Error al obtener productos' })
  }
})

// Obtener detalle de un producto (incluye variaciones e imágenes)
app.get('/public/productos/:id', async (req, res) => {
  const { id } = req.params
  try {
    const productoId = Number(id)
    if (isNaN(productoId)) {
      return res.status(400).json({ message: 'ID de producto inválido' })
    }

    const pool = await getPool()
    
    // 1. Datos básicos
    const productResult = await pool.request()
      .input('id', productoId)
      .query(`
        SELECT p.*, c.Nombre AS CategoriaNombre
        FROM Productos p
        LEFT JOIN Categorias c ON p.Categoria_Id = c.Id
        WHERE p.Id = @id AND p.Visible = 1
      `)

    if (productResult.recordset.length === 0) {
      return res.status(404).json({ message: 'Producto no encontrado' })
    }

    const producto = productResult.recordset[0]

    // 2. Imágenes
    const imagesResult = await pool.request()
      .input('id', productoId)
      .query(`SELECT Id, Url, EsPrincipal, Orden FROM Producto_Imagenes WHERE Producto_Id = @id ORDER BY EsPrincipal DESC, Orden ASC`)
    
    producto.Imagenes = imagesResult.recordset

    // 3. Variaciones
    const variationsResult = await pool.request()
      .input('id', productoId)
      .query(`SELECT Id, Atributo, Valor, PrecioAdicional, StockActual, CodigoSKU FROM Producto_Variaciones WHERE Producto_Id = @id`)
    
    const variaciones = variationsResult.recordset as Array<{ Id: number; PrecioAdicional: number }>
    const tiendaIdProd = (await pool.request().input('id', productoId).query('SELECT Tienda_Id FROM Productos WHERE Id = @id')).recordset[0] as { Tienda_Id: string } | undefined
    const tiendaId = tiendaIdProd?.Tienda_Id

    if (tiendaId) {
      const precioBase = producto.PrecioDetal
      const itemsPromo = [
        { productoId, varianteId: null as number | null, cantidad: 1, precioBase },
        ...variaciones.map((v) => ({
          productoId,
          varianteId: v.Id as number,
          cantidad: 1,
          precioBase: precioBase + (v.PrecioAdicional ?? 0),
        })),
      ]
      const conPromo = await calcularPrecioConPromo(pool, tiendaId, itemsPromo)
      producto.PrecioOferta = conPromo[0]?.precioFinal ?? precioBase
      producto.TieneOferta = (conPromo[0]?.descuentoAplicado ?? 0) > 0
      for (let i = 0; i < variaciones.length; i++) {
        const v = variaciones[i] as Record<string, unknown>
        v.PrecioOferta = conPromo[i + 1]?.precioFinal ?? precioBase + (variaciones[i].PrecioAdicional ?? 0)
        v.TieneOferta = (conPromo[i + 1]?.descuentoAplicado ?? 0) > 0
      }
    } else {
      producto.PrecioOferta = producto.PrecioDetal
      producto.TieneOferta = false
      for (const v of variaciones) {
        ;(v as Record<string, unknown>).PrecioOferta = producto.PrecioDetal + (v.PrecioAdicional ?? 0)
        ;(v as Record<string, unknown>).TieneOferta = false
      }
    }

    producto.Variaciones = variaciones

    res.json(producto)
  } catch (error) {
    console.error('[GET /public/productos/:id] Error', error)
    res.status(500).json({ message: 'Error al obtener el detalle del producto' })
  }
})

// Crear un pedido (Checkout público)
app.post('/public/pedidos', async (req, res) => {
  const {
    tiendaSlug,
    cliente, // { cedula, nombre, email, celular, direccion, ciudad }
    carrito, // [ { productoId, varianteId, cantidad, precioUnitario, observacion } ]
    metodoPago,
    tipoEntrega,
    observacionGeneral
  } = req.body

  if (!tiendaSlug || !cliente || !carrito || carrito.length === 0) {
    return res.status(400).json({ message: 'Datos incompletos para procesar el pedido' })
  }

  const itemsValidos = carrito.every(
    (it: unknown) =>
      it &&
      typeof (it as { productoId?: unknown }).productoId === 'number' &&
      typeof (it as { cantidad?: unknown }).cantidad === 'number' &&
      (it as { cantidad: number }).cantidad > 0
  )
  if (!itemsValidos) {
    return res.status(400).json({ message: 'Items del carrito inválidos. Se requiere productoId y cantidad > 0.' })
  }

  let tx: sql.Transaction | null = null

  try {
    const pool = await getPool()

    // 1. Validar Tienda (antes de la transacción)
    const tiendaResult = await pool
      .request()
      .input('slug', tiendaSlug)
      .query('SELECT Id FROM Tiendas WHERE Slug = @slug AND Activo = 1')

    if (tiendaResult.recordset.length === 0) {
      return res.status(404).json({ message: 'Tienda no encontrada' })
    }
    const tiendaId = tiendaResult.recordset[0].Id

    // 2. Validar productos, stock y calcular precios con promociones
    const productosMap = new Map<number, { Nombre: string; PrecioDetal: number; StockActual: number }>()
    const variantesMap = new Map<number, { Atributo: string; Valor: string; PrecioAdicional: number; StockActual: number; Producto_Id: number }>()

    for (const it of carrito as Array<{ productoId: number; varianteId?: number | null; cantidad: number }>) {
      const prodRes = await pool
        .request()
        .input('productoId', it.productoId)
        .input('tiendaId', tiendaId)
        .query(`
          SELECT Id, Nombre, PrecioDetal, StockActual
          FROM Productos
          WHERE Id = @productoId AND Tienda_Id = @tiendaId AND Visible = 1
        `)
      const prod = prodRes.recordset[0] as { Nombre: string; PrecioDetal: number; StockActual: number } | undefined
      if (!prod) {
        return res.status(400).json({ message: `Producto ${it.productoId} no encontrado o no disponible.` })
      }
      productosMap.set(it.productoId, prod)

      let stockDisponible = prod.StockActual ?? 0
      let precioBase = prod.PrecioDetal

      if (it.varianteId != null) {
        const varRes = await pool
          .request()
          .input('varianteId', it.varianteId)
          .input('productoId', it.productoId)
          .query(`
            SELECT Id, Atributo, Valor, PrecioAdicional, StockActual, Producto_Id
            FROM Producto_Variaciones
            WHERE Id = @varianteId AND Producto_Id = @productoId
          `)
        const vari = varRes.recordset[0] as { Atributo: string; Valor: string; PrecioAdicional: number; StockActual: number; Producto_Id: number } | undefined
        if (!vari) {
          return res.status(400).json({ message: `Variante ${it.varianteId} no encontrada para el producto.` })
        }
        variantesMap.set(it.varianteId, vari)
        stockDisponible = vari.StockActual ?? 0
        precioBase += vari.PrecioAdicional ?? 0
      }

      if (stockDisponible < it.cantidad) {
        const productoNombre = prod.Nombre ?? `Producto #${it.productoId}`
        const variante = it.varianteId != null ? variantesMap.get(it.varianteId) : undefined
        const varianteDesc = variante ? ` (${variante.Atributo}: ${variante.Valor})` : ''
        const descripcion = `${productoNombre}${varianteDesc}`
        return res.status(400).json({
          message: `Stock insuficiente para "${descripcion}". Disponible: ${stockDisponible}, solicitado: ${it.cantidad}.`,
        })
      }
    }

    const itemsConPrecioBase = (carrito as Array<{ productoId: number; varianteId?: number | null; cantidad: number }>).map((it) => {
      const prod = productosMap.get(it.productoId)!
      let base = prod.PrecioDetal
      if (it.varianteId != null) {
        const vari = variantesMap.get(it.varianteId)!
        base += vari.PrecioAdicional ?? 0
      }
      return { productoId: it.productoId, varianteId: it.varianteId ?? null, cantidad: it.cantidad, precioBase: base }
    })
    const itemsConPromo = await calcularPrecioConPromo(pool, tiendaId, itemsConPrecioBase)

    const carritoProcesado = (carrito as Array<{ productoId: number; varianteId?: number | null; cantidad: number; observacion?: string }>).map((it, idx) => ({
      ...it,
      precioUnitario: itemsConPromo[idx].precioFinal,
    }))

    tx = new sql.Transaction(pool)
    await tx.begin()

    // 3. Upsert Cliente
    const clienteResult = await new sql.Request(tx)
      .input('tiendaId', tiendaId)
      .input('cedula', cliente.cedula)
      .input('nombre', cliente.nombre)
      .input('email', cliente.email || null)
      .input('celular', cliente.celular || null)
      .input('direccion', cliente.direccion || null)
      .input('ciudad', cliente.ciudad || null)
      .query(`
        IF EXISTS (SELECT 1 FROM Clientes WHERE Tienda_Id = @tiendaId AND Cedula = @cedula)
        BEGIN
          UPDATE Clientes 
          SET Nombre = @nombre, Email = @email, Celular = @celular, Direccion = @direccion, Ciudad = @ciudad
          WHERE Tienda_Id = @tiendaId AND Cedula = @cedula;
          SELECT Id FROM Clientes WHERE Tienda_Id = @tiendaId AND Cedula = @cedula;
        END
        ELSE
        BEGIN
          INSERT INTO Clientes (Tienda_Id, Cedula, Nombre, Email, Celular, Direccion, Ciudad)
          VALUES (@tiendaId, @cedula, @nombre, @email, @celular, @direccion, @ciudad);
          SELECT SCOPE_IDENTITY() AS Id;
        END
      `)
    
    const clienteId = clienteResult.recordset[0].Id

    // 4. Calcular Totales y crear Venta (usando precios con oferta)
    const subtotal = carritoProcesado.reduce((acc: number, item: { cantidad: number; precioUnitario: number }) => acc + (item.cantidad * item.precioUnitario), 0)
    const total = subtotal

    const ventaResult = await new sql.Request(tx)
      .input('tiendaId', tiendaId)
      .input('clienteId', clienteId)
      .input('tipoVenta', 'Online')
      .input('tipoEntrega', tipoEntrega || 'Domicilio')
      .input('metodoPago', metodoPago || 'Efectivo')
      .input('subtotal', subtotal)
      .input('total', total)
      .input('observacion', observacionGeneral || null)
      .query(`
        INSERT INTO Ventas (Tienda_Id, Cliente_Id, TipoVenta, TipoEntrega, MetodoPago, Subtotal, Total, Observacion, Estado)
        VALUES (@tiendaId, @clienteId, @tipoVenta, @tipoEntrega, @metodoPago, @subtotal, @total, @observacion, 'Pendiente');
        SELECT SCOPE_IDENTITY() AS Id;
      `)
    
    const ventaId = ventaResult.recordset[0].Id

    // 5. Insertar Detalle y descontar stock
    for (const item of carritoProcesado) {
      await new sql.Request(tx)
        .input('ventaId', ventaId)
        .input('productoId', item.productoId)
        .input('cantidad', item.cantidad)
        .input('precioUnitario', item.precioUnitario)
        .input('varianteId', item.varianteId ?? null)
        .query(`
          INSERT INTO Venta_Detalle (Venta_Id, Producto_Id, Cantidad, PrecioUnitario, Variante_Id)
          VALUES (@ventaId, @productoId, @cantidad, @precioUnitario, @varianteId);
          
          UPDATE Productos 
          SET StockActual = StockActual - @cantidad 
          WHERE Id = @productoId;
        `)

      // Registrar movimiento de inventario (SALIDA) para pedidos online
      await new sql.Request(tx)
        .input('tiendaId', tiendaId)
        .input('productoId', item.productoId)
        .input('variacionId', item.varianteId ?? null)
        .input('cantidad', item.cantidad)
        .input('motivo', sql.NVarChar, `Pedido Online #${ventaId}`)
        .query(`
          INSERT INTO Movimientos_Inventario (
            Tienda_Id,
            Producto_Id,
            Variacion_Id,
            TipoMovimiento,
            Cantidad,
            Motivo,
            Fecha
          )
          VALUES (
            @tiendaId,
            @productoId,
            @variacionId,
            'SALIDA',
            @cantidad,
            @motivo,
            GETDATE()
          )
        `)
      
      if (item.varianteId) {
        await new sql.Request(tx)
          .input('varianteId', item.varianteId)
          .input('cantidad', item.cantidad)
          .query('UPDATE Producto_Variaciones SET StockActual = StockActual - @cantidad WHERE Id = @varianteId')
      }
    }

    await tx.commit()
    res.json({ message: 'Pedido creado exitosamente', pedidoId: ventaId })
  } catch (error) {
    console.error('[POST /public/pedidos] Error', error)
    if (tx) {
      try {
        await tx.rollback()
      } catch {
        // ignore
      }
    }
    res.status(500).json({ message: 'Error al procesar el pedido' })
  }
})

app.listen(config.port, () => {
  console.log(`Servidor backend escuchando en http://localhost:${config.port}`)
})

