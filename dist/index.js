"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const express_api_reference_1 = require("@scalar/express-api-reference");
const config_js_1 = require("./config.js");
const db_js_1 = require("./db.js");
const auth_js_1 = require("./auth.js");
const firebase_js_1 = require("./firebase.js");
const openapi_js_1 = require("./openapi.js");
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json({
    limit: '20mb',
}));
app.get('/health', (_req, res) => {
    res.json({
        status: 'ok',
        env: config_js_1.config.nodeEnv,
    });
});
app.get('/health/db', async (_req, res) => {
    const ok = await (0, db_js_1.testConnection)();
    if (!ok) {
        return res.status(500).json({ status: 'error', message: 'No se pudo conectar a la base de datos' });
    }
    return res.json({ status: 'ok', message: 'Conexión a base de datos exitosa' });
});
// Redirigir raíz a la documentación de Scalar
app.get('/', (_req, res) => {
    res.redirect('/docs');
});
// Documento OpenAPI (para Scalar u otros clientes)
app.get('/openapi.json', (_req, res) => {
    res.json(openapi_js_1.openapiDocument);
});
// Documentación interactiva de la API con Scalar
app.use('/docs', (0, express_api_reference_1.apiReference)({
    theme: 'purple',
    layout: 'modern',
    darkMode: true,
    hideDownloadButton: false,
    spec: {
        url: '/openapi.json',
    },
}));
// Ejemplo de endpoint usando la BD (lista las primeras tiendas)
app.get('/tiendas', async (_req, res) => {
    try {
        const pool = await (0, db_js_1.getPool)();
        const result = await pool
            .request()
            .query('SELECT TOP 20 Id, NombreComercial, Slug, EmailContacto, Activo, FechaCreacion FROM Tiendas ORDER BY FechaCreacion DESC');
        res.json(result.recordset);
    }
    catch (error) {
        console.error('[GET /tiendas] Error', error);
        res.status(500).json({ message: 'Error al obtener tiendas' });
    }
});
// Middleware sencillo para extraer el usuario desde el JWT
function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'No autorizado' });
    }
    const token = authHeader.substring('Bearer '.length);
    try {
        const payload = (0, auth_js_1.verifyToken)(token);
        req.user = payload;
        next();
    }
    catch {
        return res.status(401).json({ message: 'Token inválido o expirado' });
    }
}
async function upsertProductoImagenDesdeBase64(productoId, imagenBase64) {
    if (!imagenBase64)
        return null;
    try {
        const bucket = firebase_js_1.storage.bucket();
        const base64Data = imagenBase64.includes(',')
            ? imagenBase64.split(',')[1]
            : imagenBase64;
        const buffer = Buffer.from(base64Data, 'base64');
        if (buffer.length === 0) {
            console.error('[Imagen producto] Base64 inválido o vacío');
            return null;
        }
        const fileName = `product_images/${productoId}-${Date.now()}.jpg`;
        const file = bucket.file(fileName);
        await file.save(buffer, {
            metadata: { contentType: 'image/jpeg' },
            resumable: false,
        });
        let publicUrl;
        try {
            await file.makePublic();
            publicUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(fileName)}?alt=media`;
        }
        catch (makePublicErr) {
            console.warn('[Imagen producto] makePublic falló, usando URL firmada (7 días)', makePublicErr);
            const [signedUrl] = await file.getSignedUrl({
                action: 'read',
                expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
                version: 'v4',
            });
            publicUrl = signedUrl;
        }
        const pool = await (0, db_js_1.getPool)();
        const imgResult = await pool
            .request()
            .input('productoId', productoId)
            .query(`
        SELECT TOP 1 Id
        FROM Producto_Imagenes
        WHERE Producto_Id = @productoId AND EsPrincipal = 1
        ORDER BY Id
      `);
        if (imgResult.recordset.length > 0) {
            const imagenId = imgResult.recordset[0].Id;
            await pool
                .request()
                .input('id', imagenId)
                .input('url', publicUrl)
                .query(`
          UPDATE Producto_Imagenes
          SET Url = @url
          WHERE Id = @id
        `);
        }
        else {
            await pool
                .request()
                .input('productoId', productoId)
                .input('url', publicUrl)
                .query(`
          INSERT INTO Producto_Imagenes (Producto_Id, Url, EsPrincipal, Orden)
          VALUES (@productoId, @url, 1, 0)
        `);
        }
        return publicUrl;
    }
    catch (error) {
        console.error('[Imagen producto] Error al subir imagen a Firebase Storage', error);
        return null;
    }
}
/** Sube una imagen a Firebase e inserta una nueva fila en Producto_Imagenes. */
async function addProductoImagen(productoId, imagenBase64, esPrincipal, orden) {
    try {
        const bucket = firebase_js_1.storage.bucket();
        const base64Data = imagenBase64.includes(',') ? imagenBase64.split(',')[1] : imagenBase64;
        const buffer = Buffer.from(base64Data, 'base64');
        if (buffer.length === 0)
            return null;
        const fileName = `product_images/${productoId}-${Date.now()}-${orden}.jpg`;
        const file = bucket.file(fileName);
        await file.save(buffer, { metadata: { contentType: 'image/jpeg' }, resumable: false });
        let publicUrl;
        try {
            await file.makePublic();
            publicUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(fileName)}?alt=media`;
        }
        catch {
            const [signedUrl] = await file.getSignedUrl({
                action: 'read',
                expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
                version: 'v4',
            });
            publicUrl = signedUrl;
        }
        const pool = await (0, db_js_1.getPool)();
        if (esPrincipal) {
            await pool
                .request()
                .input('productoId', productoId)
                .query(`UPDATE Producto_Imagenes SET EsPrincipal = 0 WHERE Producto_Id = @productoId`);
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
      `);
        const row = result.recordset[0];
        return { id: row.Id, url: row.Url };
    }
    catch (error) {
        console.error('[addProductoImagen] Error', error);
        return null;
    }
}
// Login: recibe email, password y slug de la tienda
app.post('/auth/login', async (req, res) => {
    const { email, password, tiendaSlug } = req.body;
    if (!email || !password || !tiendaSlug) {
        return res.status(400).json({ message: 'email, password y tiendaSlug son obligatorios' });
    }
    try {
        const pool = await (0, db_js_1.getPool)();
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
      `);
        if (result.recordset.length === 0) {
            return res.status(401).json({ message: 'Credenciales inválidas' });
        }
        const row = result.recordset[0];
        if (!row.Activo) {
            return res.status(403).json({ message: 'Usuario inactivo' });
        }
        const passwordOk = await (0, auth_js_1.verifyPassword)(password, row.PasswordHash);
        if (!passwordOk) {
            return res.status(401).json({ message: 'Credenciales inválidas' });
        }
        const payload = {
            userId: row.UserId,
            tiendaId: row.TiendaId,
            roleId: row.RolId,
            email: row.Email,
            nombre: row.Nombre,
            slug: row.Slug,
        };
        const token = (0, auth_js_1.signToken)(payload);
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
        });
    }
    catch (error) {
        console.error('[POST /auth/login] Error', error);
        return res.status(500).json({ message: 'Error al iniciar sesión' });
    }
});
// Registro de usuario en una tienda
app.post('/auth/register', async (req, res) => {
    const { tiendaSlug, nombre, email, password, rolNombre } = req.body;
    if (!tiendaSlug || !nombre || !email || !password) {
        return res.status(400).json({
            message: 'tiendaSlug, nombre, email y password son obligatorios',
        });
    }
    try {
        const pool = await (0, db_js_1.getPool)();
        const request = pool.request();
        // 1. Buscar la tienda por slug
        const tiendaResult = await request.input('slug', tiendaSlug).query(`
      SELECT TOP 1 Id, NombreComercial, Slug
      FROM Tiendas
      WHERE Slug = @slug
    `);
        if (tiendaResult.recordset.length === 0) {
            return res.status(404).json({ message: 'Tienda no encontrada' });
        }
        const tienda = tiendaResult.recordset[0];
        // 2. Rol: si no envían, usamos "Administrador"
        const nombreRol = rolNombre ?? 'Administrador';
        const rolResult = await pool
            .request()
            .input('rolNombre', nombreRol)
            .query(`
        SELECT TOP 1 Id, Nombre
        FROM Roles
        WHERE Nombre = @rolNombre
      `);
        if (rolResult.recordset.length === 0) {
            return res.status(400).json({
                message: `Rol "${nombreRol}" no existe, crea primero los roles básicos`,
            });
        }
        const rol = rolResult.recordset[0];
        // 3. Validar que no exista ya ese email en la tienda
        const existingUser = await pool
            .request()
            .input('tiendaId', tienda.Id)
            .input('email', email)
            .query(`
        SELECT 1
        FROM Usuarios
        WHERE Tienda_Id = @tiendaId AND Email = @email
      `);
        if (existingUser.recordset.length > 0) {
            return res
                .status(409)
                .json({ message: 'Ya existe un usuario con ese email en esta tienda' });
        }
        // 4. Hashear la contraseña
        const passwordHash = await (0, auth_js_1.hashPassword)(password);
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
      `);
        const newUserId = insertResult.recordset[0].Id;
        const payload = {
            userId: newUserId,
            tiendaId: tienda.Id,
            roleId: rol.Id,
            email,
            nombre,
            slug: tienda.Slug,
        };
        const token = (0, auth_js_1.signToken)(payload);
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
        });
    }
    catch (error) {
        console.error('[POST /auth/register] Error', error);
        return res.status(500).json({ message: 'Error al registrar usuario' });
    }
});
// Endpoint para recuperar los datos del usuario autenticado
app.get('/me', authMiddleware, (req, res) => {
    if (!req.user) {
        return res.status(401).json({ message: 'No autorizado' });
    }
    return res.json({ user: req.user });
});
// ==========================
// Utilidades
// ==========================
function slugify(value) {
    return value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}
// ==========================
// Categorías (CRUD básico)
// ==========================
// Listar categorías de la tienda actual
app.get('/categorias', authMiddleware, async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ message: 'No autorizado' });
    }
    try {
        const pool = await (0, db_js_1.getPool)();
        const result = await pool
            .request()
            .input('tiendaId', req.user.tiendaId)
            .query(`
          SELECT Id, Nombre, Slug, CategoriaPadre_Id, Visible
          FROM Categorias
          WHERE Tienda_Id = @tiendaId
          ORDER BY Nombre ASC
        `);
        return res.json(result.recordset);
    }
    catch (error) {
        console.error('[GET /categorias] Error', error);
        return res.status(500).json({ message: 'Error al obtener categorías' });
    }
});
// Crear categoría
app.post('/categorias', authMiddleware, async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ message: 'No autorizado' });
    }
    const { nombre, categoriaPadreId, visible } = req.body;
    if (!nombre) {
        return res.status(400).json({ message: 'nombre es obligatorio' });
    }
    try {
        const pool = await (0, db_js_1.getPool)();
        const generatedSlug = slugify(nombre);
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
        `);
        return res.status(201).json(result.recordset[0]);
    }
    catch (error) {
        console.error('[POST /categorias] Error', error);
        return res.status(500).json({ message: 'Error al crear categoría' });
    }
});
// Actualizar categoría
app.put('/categorias/:id', authMiddleware, async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ message: 'No autorizado' });
    }
    const { id } = req.params;
    const { nombre, categoriaPadreId, visible } = req.body;
    if (!nombre) {
        return res.status(400).json({ message: 'nombre es obligatorio' });
    }
    try {
        const pool = await (0, db_js_1.getPool)();
        const generatedSlug = slugify(nombre);
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
        `);
        if (result.recordset.length === 0) {
            return res.status(404).json({ message: 'Categoría no encontrada' });
        }
        return res.json(result.recordset[0]);
    }
    catch (error) {
        console.error('[PUT /categorias/:id] Error', error);
        return res.status(500).json({ message: 'Error al actualizar categoría' });
    }
});
// Eliminar categoría (borrado físico)
app.delete('/categorias/:id', authMiddleware, async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ message: 'No autorizado' });
    }
    const { id } = req.params;
    try {
        const pool = await (0, db_js_1.getPool)();
        const result = await pool
            .request()
            .input('id', Number(id))
            .input('tiendaId', req.user.tiendaId)
            .query(`
          DELETE FROM Categorias
          WHERE Id = @id AND Tienda_Id = @tiendaId;

          SELECT @@ROWCOUNT AS affected;
        `);
        const affected = result.recordset[0]?.affected;
        if (!affected) {
            return res.status(404).json({ message: 'Categoría no encontrada' });
        }
        return res.json({ message: 'Categoría eliminada' });
    }
    catch (error) {
        console.error('[DELETE /categorias/:id] Error', error);
        return res.status(500).json({ message: 'Error al eliminar categoría' });
    }
});
// ==========================
// Proveedores (CRUD básico)
// ==========================
// Listar proveedores activos de la tienda actual
app.get('/proveedores', authMiddleware, async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ message: 'No autorizado' });
    }
    try {
        const pool = await (0, db_js_1.getPool)();
        const result = await pool
            .request()
            .input('tiendaId', req.user.tiendaId)
            .query(`
          SELECT Id, Nombre, Contacto, Telefono, Email, Activo
          FROM Proveedores
          WHERE Tienda_Id = @tiendaId AND Activo = 1
          ORDER BY Id ASC
        `);
        return res.json(result.recordset);
    }
    catch (error) {
        console.error('[GET /proveedores] Error', error);
        return res.status(500).json({ message: 'Error al obtener proveedores' });
    }
});
// Crear proveedor
app.post('/proveedores', authMiddleware, async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ message: 'No autorizado' });
    }
    const { nombre, contacto, telefono, email, activo } = req.body;
    if (!nombre) {
        return res.status(400).json({ message: 'nombre es obligatorio para el proveedor' });
    }
    try {
        const pool = await (0, db_js_1.getPool)();
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
        `);
        return res.status(201).json(result.recordset[0]);
    }
    catch (error) {
        console.error('[POST /proveedores] Error', error);
        return res.status(500).json({ message: 'Error al crear proveedor' });
    }
});
// Actualizar proveedor
app.put('/proveedores/:id', authMiddleware, async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ message: 'No autorizado' });
    }
    const { id } = req.params;
    const { nombre, contacto, telefono, email, activo } = req.body;
    if (!nombre) {
        return res.status(400).json({ message: 'nombre es obligatorio para el proveedor' });
    }
    try {
        const pool = await (0, db_js_1.getPool)();
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
        `);
        if (result.recordset.length === 0) {
            return res.status(404).json({ message: 'Proveedor no encontrado' });
        }
        return res.json(result.recordset[0]);
    }
    catch (error) {
        console.error('[PUT /proveedores/:id] Error', error);
        return res.status(500).json({ message: 'Error al actualizar proveedor' });
    }
});
// Eliminar proveedor (borrado físico; se desvinculan productos del proveedor)
app.delete('/proveedores/:id', authMiddleware, async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ message: 'No autorizado' });
    }
    const { id } = req.params;
    try {
        const pool = await (0, db_js_1.getPool)();
        await pool
            .request()
            .input('id', Number(id))
            .input('tiendaId', req.user.tiendaId)
            .query(`
          UPDATE Productos SET Proveedor_Id = NULL
          WHERE Proveedor_Id = @id AND Tienda_Id = @tiendaId;
        `);
        const result = await pool
            .request()
            .input('id', Number(id))
            .input('tiendaId', req.user.tiendaId)
            .query(`
          DELETE FROM Proveedores
          OUTPUT DELETED.Id
          WHERE Id = @id AND Tienda_Id = @tiendaId;
        `);
        if (!result.recordset.length) {
            return res.status(404).json({ message: 'Proveedor no encontrado' });
        }
        return res.json({ message: 'Proveedor eliminado' });
    }
    catch (error) {
        console.error('[DELETE /proveedores/:id] Error', error);
        return res.status(500).json({ message: 'Error al eliminar proveedor' });
    }
});
// ==========================
// Productos (CRUD básico)
// ==========================
// Listar productos visibles de la tienda actual
app.get('/productos', authMiddleware, async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ message: 'No autorizado' });
    }
    try {
        const pool = await (0, db_js_1.getPool)();
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
        `);
        return res.json(result.recordset);
    }
    catch (error) {
        console.error('[GET /productos] Error', error);
        return res.status(500).json({ message: 'Error al obtener productos' });
    }
});
// Listar variaciones de productos (talla / color) de la tienda actual
app.get('/productos/variantes', authMiddleware, async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ message: 'No autorizado' });
    }
    try {
        const pool = await (0, db_js_1.getPool)();
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
        `);
        return res.json(result.recordset);
    }
    catch (error) {
        console.error('[GET /productos/variantes] Error', error);
        return res.status(500).json({ message: 'Error al obtener variantes de productos' });
    }
});
// Actualizar una variante de producto
app.put('/productos/variantes/:id', authMiddleware, async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ message: 'No autorizado' });
    }
    const { id } = req.params;
    const { valor, stockActual, precioAdicional, codigoSKU } = req.body;
    try {
        const pool = await (0, db_js_1.getPool)();
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
        `);
        const affected = result.recordset[0]?.affected;
        if (!affected) {
            return res.status(404).json({ message: 'Variante no encontrada' });
        }
        return res.json({ message: 'Variante actualizada' });
    }
    catch (error) {
        console.error('[PUT /productos/variantes/:id] Error', error);
        return res.status(500).json({ message: 'Error al actualizar variante' });
    }
});
// Crear una variante de producto
app.post('/productos/variantes', authMiddleware, async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ message: 'No autorizado' });
    }
    const { productoId, atributo, valor, stockActual, precioAdicional, codigoSKU } = req.body;
    if (!productoId || !atributo || !valor) {
        return res.status(400).json({
            message: 'productoId, atributo y valor son obligatorios para la variante',
        });
    }
    try {
        const pool = await (0, db_js_1.getPool)();
        // Validar que el producto pertenezca a la tienda del usuario
        const prodCheck = await pool
            .request()
            .input('productoId', productoId)
            .input('tiendaId', req.user.tiendaId)
            .query(`
          SELECT 1
          FROM Productos
          WHERE Id = @productoId AND Tienda_Id = @tiendaId
        `);
        if (prodCheck.recordset.length === 0) {
            return res.status(404).json({ message: 'Producto no encontrado para esta tienda' });
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
        `);
        return res.status(201).json({ message: 'Variante creada' });
    }
    catch (error) {
        console.error('[POST /productos/variantes] Error', error);
        return res.status(500).json({ message: 'Error al crear variante' });
    }
});
// Eliminar una variante de producto
app.delete('/productos/variantes/:id', authMiddleware, async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ message: 'No autorizado' });
    }
    const { id } = req.params;
    try {
        const pool = await (0, db_js_1.getPool)();
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
        `);
        const affected = result.recordset[0]?.affected;
        if (!affected) {
            return res.status(404).json({ message: 'Variante no encontrada' });
        }
        return res.json({ message: 'Variante eliminada' });
    }
    catch (error) {
        console.error('[DELETE /productos/variantes/:id] Error', error);
        return res.status(500).json({ message: 'Error al eliminar variante' });
    }
});
// Listar imágenes de un producto
app.get('/productos/:id/imagenes', authMiddleware, async (req, res) => {
    if (!req.user)
        return res.status(401).json({ message: 'No autorizado' });
    const { id } = req.params;
    try {
        const pool = await (0, db_js_1.getPool)();
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
        `);
        return res.json(result.recordset);
    }
    catch (error) {
        console.error('[GET /productos/:id/imagenes] Error', error);
        return res.status(500).json({ message: 'Error al listar imágenes' });
    }
});
// Añadir imagen a un producto
app.post('/productos/:id/imagenes', authMiddleware, async (req, res) => {
    if (!req.user)
        return res.status(401).json({ message: 'No autorizado' });
    const { id } = req.params;
    const { imagenBase64, esPrincipal, orden } = req.body;
    if (!imagenBase64)
        return res.status(400).json({ message: 'imagenBase64 es obligatorio' });
    try {
        const pool = await (0, db_js_1.getPool)();
        const check = await pool
            .request()
            .input('id', Number(id))
            .input('tiendaId', req.user.tiendaId)
            .query(`SELECT 1 FROM Productos WHERE Id = @id AND Tienda_Id = @tiendaId`);
        if (check.recordset.length === 0)
            return res.status(404).json({ message: 'Producto no encontrado' });
        const maxOrden = await pool
            .request()
            .input('productoId', Number(id))
            .query(`SELECT ISNULL(MAX(Orden), -1) + 1 AS NextOrden FROM Producto_Imagenes WHERE Producto_Id = @productoId`);
        const nextOrden = orden ?? maxOrden.recordset[0]?.NextOrden ?? 0;
        const added = await addProductoImagen(Number(id), imagenBase64, !!esPrincipal, nextOrden);
        if (!added)
            return res.status(500).json({ message: 'Error al subir la imagen' });
        return res.status(201).json(added);
    }
    catch (error) {
        console.error('[POST /productos/:id/imagenes] Error', error);
        return res.status(500).json({ message: 'Error al añadir imagen' });
    }
});
// Eliminar imagen de producto
app.delete('/productos/imagenes/:imagenId', authMiddleware, async (req, res) => {
    if (!req.user)
        return res.status(401).json({ message: 'No autorizado' });
    const { imagenId } = req.params;
    try {
        const pool = await (0, db_js_1.getPool)();
        const delResult = await pool
            .request()
            .input('imagenId', Number(imagenId))
            .input('tiendaId', req.user.tiendaId)
            .query(`
          DELETE i
          FROM Producto_Imagenes i
          INNER JOIN Productos p ON i.Producto_Id = p.Id
          WHERE i.Id = @imagenId AND p.Tienda_Id = @tiendaId
        `);
        const affected = delResult.rowsAffected?.[0] ?? 0;
        if (!affected)
            return res.status(404).json({ message: 'Imagen no encontrada' });
        return res.json({ message: 'Imagen eliminada' });
    }
    catch (error) {
        console.error('[DELETE /productos/imagenes/:id] Error', error);
        return res.status(500).json({ message: 'Error al eliminar imagen' });
    }
});
// Marcar imagen como principal
app.put('/productos/imagenes/:imagenId/principal', authMiddleware, async (req, res) => {
    if (!req.user)
        return res.status(401).json({ message: 'No autorizado' });
    const { imagenId } = req.params;
    try {
        const pool = await (0, db_js_1.getPool)();
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
        `);
        const check = await pool
            .request()
            .input('imagenId', Number(imagenId))
            .input('tiendaId', req.user.tiendaId)
            .query(`SELECT i.Id FROM Producto_Imagenes i INNER JOIN Productos p ON i.Producto_Id = p.Id WHERE i.Id = @imagenId AND p.Tienda_Id = @tiendaId`);
        if (check.recordset.length === 0)
            return res.status(404).json({ message: 'Imagen no encontrada' });
        return res.json({ message: 'Imagen principal actualizada' });
    }
    catch (error) {
        console.error('[PUT /productos/imagenes/:id/principal] Error', error);
        return res.status(500).json({ message: 'Error al actualizar imagen principal' });
    }
});
// Crear producto
app.post('/productos', authMiddleware, async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ message: 'No autorizado' });
    }
    const { nombre, codigoInterno, codigoBarras, proveedorId, categoriaId, descripcion, costo, precioDetal, precioMayor, stockActual, visible, } = req.body;
    if (!nombre || !codigoInterno || precioDetal == null) {
        return res.status(400).json({
            message: 'nombre, codigoInterno y precioDetal son obligatorios para el producto',
        });
    }
    try {
        const pool = await (0, db_js_1.getPool)();
        const imagenBase64 = req.body.imagenBase64 ?? null;
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
        `);
        const inserted = result.recordset[0];
        if (imagenBase64) {
            await upsertProductoImagenDesdeBase64(inserted.Id, imagenBase64);
        }
        return res.status(201).json(inserted);
    }
    catch (error) {
        console.error('[POST /productos] Error', error);
        return res.status(500).json({ message: 'Error al crear producto' });
    }
});
// Actualizar producto
app.put('/productos/:id', authMiddleware, async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ message: 'No autorizado' });
    }
    const { id } = req.params;
    const { nombre, codigoInterno, codigoBarras, proveedorId, categoriaId, descripcion, costo, precioDetal, precioMayor, stockActual, visible, } = req.body;
    if (!nombre || !codigoInterno || precioDetal == null) {
        return res.status(400).json({
            message: 'nombre, codigoInterno y precioDetal son obligatorios para el producto',
        });
    }
    try {
        const pool = await (0, db_js_1.getPool)();
        const imagenBase64 = req.body.imagenBase64 ?? null;
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
        `);
        if (result.recordset.length === 0) {
            return res.status(404).json({ message: 'Producto no encontrado' });
        }
        const updated = result.recordset[0];
        if (imagenBase64) {
            await upsertProductoImagenDesdeBase64(updated.Id, imagenBase64);
        }
        return res.json(updated);
    }
    catch (error) {
        console.error('[PUT /productos/:id] Error', error);
        return res.status(500).json({ message: 'Error al actualizar producto' });
    }
});
// Eliminar producto (borrado físico; CASCADE quita imágenes y variaciones)
app.delete('/productos/:id', authMiddleware, async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ message: 'No autorizado' });
    }
    const { id } = req.params;
    try {
        const pool = await (0, db_js_1.getPool)();
        const result = await pool
            .request()
            .input('id', Number(id))
            .input('tiendaId', req.user.tiendaId)
            .query(`
          DELETE FROM Productos
          WHERE Id = @id AND Tienda_Id = @tiendaId;

          SELECT @@ROWCOUNT AS affected;
        `);
        const affected = result.recordset[0]?.affected;
        if (!affected) {
            return res.status(404).json({ message: 'Producto no encontrado' });
        }
        return res.json({ message: 'Producto eliminado' });
    }
    catch (error) {
        console.error('[DELETE /productos/:id] Error', error);
        const msg = error && typeof error.message === 'string'
            ? error.message
            : '';
        if (msg.includes('REFERENCE') || msg.includes('foreign key')) {
            return res.status(409).json({
                message: 'No se puede eliminar: el producto tiene ventas, apartados o movimientos asociados.',
            });
        }
        return res.status(500).json({ message: 'Error al eliminar producto' });
    }
});
// Importar productos desde Excel usando el procedimiento almacenado
app.post('/productos/import-excel', authMiddleware, async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ message: 'No autorizado' });
    }
    const { rows } = req.body;
    if (!rows || !Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ message: 'rows debe ser un arreglo con productos' });
    }
    const results = [];
    try {
        const pool = await (0, db_js_1.getPool)();
        for (let i = 0; i < rows.length; i += 1) {
            const row = rows[i];
            if (!row || !row.Codigo || !row.Nombre) {
                results.push({
                    index: i,
                    ok: false,
                    error: 'Faltan campos obligatorios (Codigo o Nombre)',
                });
                // No detenemos toda la importación por un error de fila
                // continuamos con las demás
                continue;
            }
            const visibleValue = (() => {
                const v = row.Visible;
                if (typeof v === 'boolean')
                    return v;
                if (typeof v === 'number')
                    return v !== 0;
                if (typeof v === 'string') {
                    const norm = v.trim().toLowerCase();
                    if (['1', 'true', 'si', 'sí', 'activo', 'visible'].includes(norm))
                        return true;
                    if (['0', 'false', 'no', 'inactivo', 'oculto'].includes(norm))
                        return false;
                }
                return true;
            })();
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
                    .execute('sp_ImportarProductoDesdeExcel');
                results.push({ index: i, ok: true });
            }
            catch (error) {
                console.error('[POST /productos/import-excel] Error en fila', i, error);
                results.push({
                    index: i,
                    ok: false,
                    error: 'Error al importar esta fila; revisa los datos',
                });
            }
        }
        const okCount = results.filter((r) => r.ok).length;
        const errorCount = results.length - okCount;
        return res.json({
            total: results.length,
            exitosos: okCount,
            conErrores: errorCount,
            detalle: results,
        });
    }
    catch (error) {
        console.error('[POST /productos/import-excel] Error general', error);
        return res.status(500).json({ message: 'Error al importar productos desde Excel' });
    }
});
// Registrar una nueva venta (cabecera + detalle)
app.post('/ventas', authMiddleware, async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ message: 'No autorizado' });
    }
    const { clienteId, repartidorId, tipoVenta, tipoEntrega, metodoPago, observacion, descuentoTotal: descuentoTotalBody, items, } = req.body;
    if (!clienteId || !Array.isArray(items) || items.length === 0) {
        return res
            .status(400)
            .json({ message: 'Cliente e items de la venta son obligatorios.' });
    }
    const lineasValidas = items.every((it) => typeof it.productoId === 'number' &&
        typeof it.cantidad === 'number' &&
        it.cantidad > 0 &&
        typeof it.precioUnitario === 'number' &&
        it.precioUnitario >= 0);
    if (!lineasValidas) {
        return res.status(400).json({ message: 'Los items de la venta no son válidos.' });
    }
    const subtotal = items.reduce((acc, it) => acc + it.cantidad * it.precioUnitario, 0);
    const descuentoTotalRaw = typeof descuentoTotalBody === 'number' && !Number.isNaN(descuentoTotalBody)
        ? descuentoTotalBody
        : 0;
    const descuentoTotal = Math.max(0, Math.min(descuentoTotalRaw, subtotal));
    const total = subtotal - descuentoTotal;
    let tx = null;
    try {
        const pool = await (0, db_js_1.getPool)();
        tx = new db_js_1.sql.Transaction(pool);
        await tx.begin();
        const headerReq = new db_js_1.sql.Request(tx);
        headerReq
            .input('tiendaId', db_js_1.sql.UniqueIdentifier, req.user.tiendaId)
            .input('clienteId', db_js_1.sql.Int, clienteId)
            .input('repartidorId', repartidorId ?? null)
            .input('tipoVenta', tipoVenta ?? null)
            .input('tipoEntrega', tipoEntrega ?? null)
            .input('metodoPago', metodoPago ?? null)
            .input('subtotal', db_js_1.sql.Decimal(18, 2), subtotal)
            .input('descuentoTotal', db_js_1.sql.Decimal(18, 2), descuentoTotal)
            .input('total', db_js_1.sql.Decimal(18, 2), total)
            .input('observacion', observacion ?? null);
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
          Observacion
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
          @observacion
        )
      `);
        const ventaIdRow = headerResult.recordset[0];
        const ventaId = ventaIdRow?.Id;
        if (!ventaId) {
            throw new Error('No se pudo obtener el Id de la venta creada');
        }
        for (const it of items) {
            const detReq = new db_js_1.sql.Request(tx);
            detReq
                .input('ventaId', db_js_1.sql.Int, ventaId)
                .input('productoId', db_js_1.sql.Int, it.productoId)
                .input('cantidad', db_js_1.sql.Int, it.cantidad)
                .input('precioUnitario', db_js_1.sql.Decimal(18, 2), it.precioUnitario);
            await detReq.query(`
          INSERT INTO Venta_Detalle (
            Venta_Id,
            Producto_Id,
            Cantidad,
            PrecioUnitario
          )
          VALUES (
            @ventaId,
            @productoId,
            @cantidad,
            @precioUnitario
          )
        `);
        }
        await tx.commit();
        return res.status(201).json({
            message: 'Venta registrada correctamente',
            ventaId,
            subtotal,
            descuentoTotal,
            total,
        });
    }
    catch (error) {
        if (tx) {
            try {
                await tx.rollback();
            }
            catch {
                // ignore
            }
        }
        console.error('[POST /ventas] Error', error);
        return res.status(500).json({ message: 'Error al registrar la venta' });
    }
});
// Listar clientes de la tienda actual (para selección en panel)
app.get('/clientes', authMiddleware, async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ message: 'No autorizado' });
    }
    const { q } = req.query;
    const search = (q ?? '').trim();
    try {
        const pool = await (0, db_js_1.getPool)();
        const request = pool.request().input('tiendaId', req.user.tiendaId);
        if (search) {
            request.input('search', `%${search}%`);
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
      `);
        return res.json(result.recordset);
    }
    catch (error) {
        console.error('[GET /clientes] Error', error);
        return res.status(500).json({ message: 'Error al obtener clientes' });
    }
});
// Crear cliente desde el panel
app.post('/clientes', authMiddleware, async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ message: 'No autorizado' });
    }
    const { cedula, nombre, email, celular, direccion, ciudad } = req.body;
    if (!cedula || !nombre) {
        return res
            .status(400)
            .json({ message: 'Cédula y nombre son obligatorios para el cliente' });
    }
    try {
        const pool = await (0, db_js_1.getPool)();
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
        `);
        const row = result.recordset[0];
        if (row.Id === -1) {
            return res
                .status(409)
                .json({ message: 'Ya existe un cliente con esa cédula en esta tienda.' });
        }
        return res.status(201).json(row);
    }
    catch (error) {
        console.error('[POST /clientes] Error', error);
        return res.status(500).json({ message: 'Error al crear cliente' });
    }
});
// Actualizar cliente desde el panel
app.put('/clientes/:id', authMiddleware, async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ message: 'No autorizado' });
    }
    const { id } = req.params;
    const { cedula, nombre, email, celular, direccion, ciudad } = req.body;
    if (!cedula || !nombre) {
        return res
            .status(400)
            .json({ message: 'Cédula y nombre son obligatorios para el cliente' });
    }
    try {
        const pool = await (0, db_js_1.getPool)();
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
        `);
        const row = result.recordset[0];
        if (row.Id === -1) {
            return res.status(404).json({ message: 'Cliente no encontrado' });
        }
        if (row.Id === -2) {
            return res
                .status(409)
                .json({ message: 'Ya existe un cliente con esa cédula en esta tienda.' });
        }
        return res.json(row);
    }
    catch (error) {
        console.error('[PUT /clientes/:id] Error', error);
        return res.status(500).json({ message: 'Error al actualizar cliente' });
    }
});
// Eliminar cliente (si no tiene ventas asociadas)
app.delete('/clientes/:id', authMiddleware, async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ message: 'No autorizado' });
    }
    const { id } = req.params;
    try {
        const pool = await (0, db_js_1.getPool)();
        const result = await pool
            .request()
            .input('id', Number(id))
            .input('tiendaId', req.user.tiendaId)
            .query(`
          DELETE FROM Clientes
          OUTPUT DELETED.Id
          WHERE Id = @id AND Tienda_Id = @tiendaId;
        `);
        if (!result.recordset.length) {
            return res.status(404).json({ message: 'Cliente no encontrado' });
        }
        return res.json({ message: 'Cliente eliminado' });
    }
    catch (error) {
        const msg = String(error?.message ?? '').toLowerCase();
        if (msg.includes('reference') || msg.includes('foreign key')) {
            return res.status(409).json({
                message: 'No se puede eliminar: el cliente tiene ventas u otros registros asociados.',
            });
        }
        console.error('[DELETE /clientes/:id] Error', error);
        return res.status(500).json({ message: 'Error al eliminar cliente' });
    }
});
// ==========================
// Repartidores
// ==========================
// Listar repartidores de la tienda actual
app.get('/repartidores', authMiddleware, async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ message: 'No autorizado' });
    }
    try {
        const pool = await (0, db_js_1.getPool)();
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
        `);
        return res.json(result.recordset);
    }
    catch (error) {
        console.error('[GET /repartidores] Error', error);
        return res.status(500).json({ message: 'Error al obtener repartidores' });
    }
});
// Crear repartidor
app.post('/repartidores', authMiddleware, async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ message: 'No autorizado' });
    }
    const { nombre, telefono, documento, vehiculo, placa, disponible, activo } = req.body;
    if (!nombre || !telefono) {
        return res
            .status(400)
            .json({ message: 'Nombre y teléfono son obligatorios para el repartidor' });
    }
    try {
        const pool = await (0, db_js_1.getPool)();
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
        `);
        return res.status(201).json(result.recordset[0]);
    }
    catch (error) {
        console.error('[POST /repartidores] Error', error);
        return res.status(500).json({ message: 'Error al crear repartidor' });
    }
});
// Actualizar repartidor
app.put('/repartidores/:id', authMiddleware, async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ message: 'No autorizado' });
    }
    const { id } = req.params;
    const { nombre, telefono, documento, vehiculo, placa, disponible, activo } = req.body;
    if (!nombre || !telefono) {
        return res
            .status(400)
            .json({ message: 'Nombre y teléfono son obligatorios para el repartidor' });
    }
    try {
        const pool = await (0, db_js_1.getPool)();
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
        `);
        if (!result.recordset.length) {
            return res.status(404).json({ message: 'Repartidor no encontrado' });
        }
        return res.json(result.recordset[0]);
    }
    catch (error) {
        console.error('[PUT /repartidores/:id] Error', error);
        return res.status(500).json({ message: 'Error al actualizar repartidor' });
    }
});
// Eliminar repartidor
app.delete('/repartidores/:id', authMiddleware, async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ message: 'No autorizado' });
    }
    const { id } = req.params;
    try {
        const pool = await (0, db_js_1.getPool)();
        const result = await pool
            .request()
            .input('id', Number(id))
            .input('tiendaId', req.user.tiendaId)
            .query(`
          DELETE FROM Repartidores
          OUTPUT DELETED.Id
          WHERE Id = @id AND Tienda_Id = @tiendaId;
        `);
        if (!result.recordset.length) {
            return res.status(404).json({ message: 'Repartidor no encontrado' });
        }
        return res.json({ message: 'Repartidor eliminado' });
    }
    catch (error) {
        console.error('[DELETE /repartidores/:id] Error', error);
        return res.status(500).json({ message: 'Error al eliminar repartidor' });
    }
});
// Importar clientes desde Excel (estructura: Cédula, Nombre, Celular, Dirección, Fecha Registro)
app.post('/clientes/import-excel', authMiddleware, async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ message: 'No autorizado' });
    }
    const { rows } = req.body;
    if (!rows || !Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ message: 'rows debe ser un arreglo con clientes' });
    }
    const results = [];
    try {
        const pool = await (0, db_js_1.getPool)();
        for (let i = 0; i < rows.length; i += 1) {
            const row = rows[i];
            if (!row || !row.Cedula || !row.Nombre) {
                results.push({
                    index: i,
                    ok: false,
                    error: 'Faltan campos obligatorios (Cédula o Nombre)',
                });
                continue;
            }
            let fecha = null;
            if (row.FechaRegistro) {
                const f = new Date(row.FechaRegistro);
                if (!Number.isNaN(f.getTime())) {
                    fecha = f;
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
            `);
                results.push({ index: i, ok: true });
            }
            catch (error) {
                console.error('[POST /clientes/import-excel] Error en fila', i, error);
                results.push({
                    index: i,
                    ok: false,
                    error: 'Error al importar esta fila; revisa los datos',
                });
            }
        }
        const okCount = results.filter((r) => r.ok).length;
        const errorCount = results.length - okCount;
        return res.json({
            total: results.length,
            exitosos: okCount,
            conErrores: errorCount,
            detalle: results,
        });
    }
    catch (error) {
        console.error('[POST /clientes/import-excel] Error general', error);
        return res.status(500).json({ message: 'Error al importar clientes desde Excel' });
    }
});
// Listar ventas de la tienda actual (resumen)
app.get('/ventas', authMiddleware, async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ message: 'No autorizado' });
    }
    const { desde, hasta } = req.query;
    let desdeDate = null;
    let hastaDate = null;
    try {
        if (desde) {
            const d = new Date(desde);
            if (!Number.isNaN(d.getTime())) {
                desdeDate = d;
            }
        }
        if (hasta) {
            const d = new Date(hasta);
            if (!Number.isNaN(d.getTime())) {
                hastaDate = d;
            }
        }
    }
    catch {
        // Ignorar formatos inválidos y seguir sin filtros de fecha
        desdeDate = null;
        hastaDate = null;
    }
    try {
        const pool = await (0, db_js_1.getPool)();
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
        `);
        return res.json(result.recordset);
    }
    catch (error) {
        console.error('[GET /ventas] Error', error);
        return res.status(500).json({ message: 'Error al obtener ventas' });
    }
});
// Obtener detalle de una venta
app.get('/ventas/:id', authMiddleware, async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ message: 'No autorizado' });
    }
    const { id } = req.params;
    try {
        const ventaId = Number(id);
        if (Number.isNaN(ventaId)) {
            return res.status(400).json({ message: 'Id de venta inválido' });
        }
        const pool = await (0, db_js_1.getPool)();
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
            c.Id AS ClienteId,
            c.Nombre AS ClienteNombre,
            r.Id AS RepartidorId,
            r.Nombre AS RepartidorNombre
          FROM Ventas v
          INNER JOIN Clientes c ON v.Cliente_Id = c.Id
          LEFT JOIN Repartidores r ON v.Repartidor_Id = r.Id
          WHERE v.Id = @id AND v.Tienda_Id = @tiendaId
        `);
        const header = headerResult.recordset[0];
        if (!header) {
            return res.status(404).json({ message: 'Venta no encontrada' });
        }
        const detalleResult = await pool
            .request()
            .input('ventaId', ventaId)
            .query(`
          SELECT
            d.Id,
            d.Producto_Id,
            p.Nombre AS ProductoNombre,
            d.Cantidad,
            d.PrecioUnitario,
            d.Cantidad * d.PrecioUnitario AS Importe
          FROM Venta_Detalle d
          INNER JOIN Productos p ON d.Producto_Id = p.Id
          WHERE d.Venta_Id = @ventaId
          ORDER BY d.Id
        `);
        return res.json({
            cabecera: header,
            detalle: detalleResult.recordset,
        });
    }
    catch (error) {
        console.error('[GET /ventas/:id] Error', error);
        return res.status(500).json({ message: 'Error al obtener detalle de la venta' });
    }
});
// Actualizar cabecera de una venta (tipo, entrega, pago, descuento, observación)
app.put('/ventas/:id', authMiddleware, async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ message: 'No autorizado' });
    }
    const { id } = req.params;
    const { tipoVenta, tipoEntrega, metodoPago, observacion, descuentoTotal } = req.body;
    try {
        const ventaId = Number(id);
        if (Number.isNaN(ventaId)) {
            return res.status(400).json({ message: 'Id de venta inválido' });
        }
        const pool = await (0, db_js_1.getPool)();
        const request = pool
            .request()
            .input('id', ventaId)
            .input('tiendaId', req.user.tiendaId)
            .input('tipoVenta', tipoVenta ?? null)
            .input('tipoEntrega', tipoEntrega ?? null)
            .input('metodoPago', metodoPago ?? null)
            .input('observacion', observacion ?? null)
            .input('descuentoTotal', typeof descuentoTotal === 'number' ? descuentoTotal : null);
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
          Total = @subtotal - @desc
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
          c.Id AS ClienteId,
          c.Nombre AS ClienteNombre,
          r.Id AS RepartidorId,
          r.Nombre AS RepartidorNombre
        FROM Ventas v
        INNER JOIN Clientes c ON v.Cliente_Id = c.Id
        LEFT JOIN Repartidores r ON v.Repartidor_Id = r.Id
        WHERE v.Id = @id AND v.Tienda_Id = @tiendaId;
      `);
        const row = result.recordset[0];
        if (!row || row.Id === -1) {
            return res.status(404).json({ message: 'Venta no encontrada' });
        }
        return res.json(row);
    }
    catch (error) {
        console.error('[PUT /ventas/:id] Error', error);
        return res.status(500).json({ message: 'Error al actualizar venta' });
    }
});
// Eliminar una venta (cabecera + detalle)
app.delete('/ventas/:id', authMiddleware, async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ message: 'No autorizado' });
    }
    const { id } = req.params;
    try {
        const ventaId = Number(id);
        if (Number.isNaN(ventaId)) {
            return res.status(400).json({ message: 'Id de venta inválido' });
        }
        const pool = await (0, db_js_1.getPool)();
        const tx = new db_js_1.sql.Transaction(pool);
        await tx.begin();
        try {
            const reqTx = new db_js_1.sql.Request(tx);
            reqTx.input('id', ventaId).input('tiendaId', req.user.tiendaId);
            await reqTx.query(`
          DELETE FROM Venta_Detalle
          WHERE Venta_Id = @id;

          DELETE FROM Ventas
          WHERE Id = @id AND Tienda_Id = @tiendaId;
        `);
            await tx.commit();
        }
        catch (innerErr) {
            await tx.rollback();
            throw innerErr;
        }
        return res.json({ message: 'Venta eliminada' });
    }
    catch (error) {
        console.error('[DELETE /ventas/:id] Error', error);
        return res.status(500).json({ message: 'Error al eliminar venta' });
    }
});
// ==========================
// ENDPOINTS PÚBLICOS (Ecommerce)
// ==========================
// Obtener información de la tienda por slug
app.get('/public/tiendas/:slug', async (req, res) => {
    const { slug } = req.params;
    try {
        const pool = await (0, db_js_1.getPool)();
        const result = await pool
            .request()
            .input('slug', slug)
            .query(`
        SELECT Id, NombreComercial, Slug, Configuracion
        FROM Tiendas
        WHERE Slug = @slug AND Activo = 1
      `);
        if (result.recordset.length === 0) {
            return res.status(404).json({ message: 'Tienda no encontrada' });
        }
        const tienda = result.recordset[0];
        if (tienda.Configuracion) {
            tienda.Configuracion = JSON.parse(tienda.Configuracion);
        }
        res.json(tienda);
    }
    catch (error) {
        console.error('[GET /public/tiendas/:slug] Error', error);
        res.status(500).json({ message: 'Error al obtener la tienda' });
    }
});
// Listar categorías visibles de una tienda
app.get('/public/tiendas/:slug/categorias', async (req, res) => {
    const { slug } = req.params;
    try {
        const pool = await (0, db_js_1.getPool)();
        const result = await pool
            .request()
            .input('slug', slug)
            .query(`
        SELECT c.Id, c.Nombre, c.Slug, c.CategoriaPadre_Id
        FROM Categorias c
        INNER JOIN Tiendas t ON c.Tienda_Id = t.Id
        WHERE t.Slug = @slug AND c.Visible = 1
        ORDER BY c.Nombre ASC
      `);
        res.json(result.recordset);
    }
    catch (error) {
        console.error('[GET /public/tiendas/:slug/categorias] Error', error);
        res.status(500).json({ message: 'Error al obtener categorías' });
    }
});
// Listar productos visibles de una tienda
app.get('/public/tiendas/:slug/productos', async (req, res) => {
    const { slug } = req.params;
    const { categoria, buscar } = req.query;
    try {
        const pool = await (0, db_js_1.getPool)();
        const request = pool.request().input('slug', slug);
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
    `;
        if (categoria) {
            request.input('catSlug', categoria);
            query += ` AND EXISTS (SELECT 1 FROM Categorias c2 WHERE c2.Id = p.Categoria_Id AND c2.Slug = @catSlug)`;
        }
        if (buscar) {
            request.input('buscarTerm', `%${buscar}%`);
            query += ` AND (p.Nombre LIKE @buscarTerm OR p.Descripcion LIKE @buscarTerm OR p.CodigoInterno LIKE @buscarTerm)`;
        }
        query += ` ORDER BY p.FechaCreacion DESC`;
        const result = await request.query(query);
        res.json(result.recordset);
    }
    catch (error) {
        console.error('[GET /public/tiendas/:slug/productos] Error', error);
        res.status(500).json({ message: 'Error al obtener productos' });
    }
});
// Obtener detalle de un producto (incluye variaciones e imágenes)
app.get('/public/productos/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const productoId = Number(id);
        if (isNaN(productoId)) {
            return res.status(400).json({ message: 'ID de producto inválido' });
        }
        const pool = await (0, db_js_1.getPool)();
        // 1. Datos básicos
        const productResult = await pool.request()
            .input('id', productoId)
            .query(`
        SELECT p.*, c.Nombre AS CategoriaNombre
        FROM Productos p
        LEFT JOIN Categorias c ON p.Categoria_Id = c.Id
        WHERE p.Id = @id AND p.Visible = 1
      `);
        if (productResult.recordset.length === 0) {
            return res.status(404).json({ message: 'Producto no encontrado' });
        }
        const producto = productResult.recordset[0];
        // 2. Imágenes
        const imagesResult = await pool.request()
            .input('id', productoId)
            .query(`SELECT Id, Url, EsPrincipal, Orden FROM Producto_Imagenes WHERE Producto_Id = @id ORDER BY EsPrincipal DESC, Orden ASC`);
        producto.Imagenes = imagesResult.recordset;
        // 3. Variaciones
        const variationsResult = await pool.request()
            .input('id', productoId)
            .query(`SELECT Id, Atributo, Valor, PrecioAdicional, StockActual, CodigoSKU FROM Producto_Variaciones WHERE Producto_Id = @id`);
        producto.Variaciones = variationsResult.recordset;
        res.json(producto);
    }
    catch (error) {
        console.error('[GET /public/productos/:id] Error', error);
        res.status(500).json({ message: 'Error al obtener el detalle del producto' });
    }
});
// Crear un pedido (Checkout público)
app.post('/public/pedidos', async (req, res) => {
    const { tiendaSlug, cliente, // { cedula, nombre, email, celular, direccion, ciudad }
    carrito, // [ { productoId, varianteId, cantidad, precioUnitario, observacion } ]
    metodoPago, tipoEntrega, observacionGeneral } = req.body;
    if (!tiendaSlug || !cliente || !carrito || carrito.length === 0) {
        return res.status(400).json({ message: 'Datos incompletos para procesar el pedido' });
    }
    try {
        const pool = await (0, db_js_1.getPool)();
        // 1. Validar Tienda
        const tiendaResult = await pool.request()
            .input('slug', tiendaSlug)
            .query('SELECT Id FROM Tiendas WHERE Slug = @slug AND Activo = 1');
        if (tiendaResult.recordset.length === 0) {
            return res.status(404).json({ message: 'Tienda no encontrada' });
        }
        const tiendaId = tiendaResult.recordset[0].Id;
        // 2. Upsert Cliente
        const clienteResult = await pool.request()
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
      `);
        const clienteId = clienteResult.recordset[0].Id;
        // 3. Calcular Totales y crear Venta
        const subtotal = carrito.reduce((acc, item) => acc + (item.cantidad * item.precioUnitario), 0);
        const total = subtotal; // Por ahora sin impuestos ni descuentos adicionales desde el front
        const ventaResult = await pool.request()
            .input('tiendaId', tiendaId)
            .input('clienteId', clienteId)
            .input('tipoVenta', 'Online')
            .input('tipoEntrega', tipoEntrega || 'Domicilio')
            .input('metodoPago', metodoPago || 'Efectivo')
            .input('subtotal', subtotal)
            .input('total', total)
            .input('observacion', observacionGeneral || null)
            .query(`
        INSERT INTO Ventas (Tienda_Id, Cliente_Id, TipoVenta, TipoEntrega, MetodoPago, Subtotal, Total, Observacion)
        VALUES (@tiendaId, @clienteId, @tipoVenta, @tipoEntrega, @metodoPago, @subtotal, @total, @observacion);
        SELECT SCOPE_IDENTITY() AS Id;
      `);
        const ventaId = ventaResult.recordset[0].Id;
        // 4. Insertar Detalle y descontar stock (simplificado)
        for (const item of carrito) {
            await pool.request()
                .input('ventaId', ventaId)
                .input('productoId', item.productoId)
                .input('cantidad', item.cantidad)
                .input('precioUnitario', item.precioUnitario)
                .query(`
          INSERT INTO Venta_Detalle (Venta_Id, Producto_Id, Cantidad, PrecioUnitario)
          VALUES (@ventaId, @productoId, @cantidad, @precioUnitario);
          
          UPDATE Productos 
          SET StockActual = StockActual - @cantidad 
          WHERE Id = @productoId;
        `);
            if (item.varianteId) {
                await pool.request()
                    .input('varianteId', item.varianteId)
                    .input('cantidad', item.cantidad)
                    .query('UPDATE Producto_Variaciones SET StockActual = StockActual - @cantidad WHERE Id = @varianteId');
            }
        }
        res.json({ message: 'Pedido creado exitosamente', pedidoId: ventaId });
    }
    catch (error) {
        console.error('[POST /public/pedidos] Error', error);
        res.status(500).json({ message: 'Error al procesar el pedido' });
    }
});
app.listen(config_js_1.config.port, () => {
    console.log(`Servidor backend escuchando en http://localhost:${config_js_1.config.port}`);
});
