"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const firebase_js_1 = require("./firebase.js");
const db_js_1 = require("./db.js");
async function syncImages() {
    const pool = await (0, db_js_1.getPool)();
    console.log('[Sync] Leyendo productos desde Firebase...');
    const snapshot = await firebase_js_1.firestore.collection('productos').get();
    console.log(`[Sync] Encontrados ${snapshot.size} documentos en colección "productos"`);
    let processed = 0;
    let updated = 0;
    let skipped = 0;
    for (const doc of snapshot.docs) {
        const data = doc.data();
        const codigo = data.codigo?.trim();
        const imagenUrl = data.imagenUrl?.trim();
        if (!codigo || !imagenUrl) {
            skipped += 1;
            continue;
        }
        try {
            // Buscar el producto en SQL por su código interno
            const prodResult = await pool
                .request()
                .input('codigo', codigo)
                .query(`
          SELECT Id
          FROM Productos
          WHERE CodigoInterno = @codigo
        `);
            if (prodResult.recordset.length === 0) {
                console.warn(`[Sync] Producto con codigo "${codigo}" no existe en SQL, se omite`);
                skipped += 1;
                continue;
            }
            const productoId = prodResult.recordset[0].Id;
            // Ver si ya hay una imagen principal
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
                    .input('url', imagenUrl)
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
                    .input('url', imagenUrl)
                    .query(`
            INSERT INTO Producto_Imagenes (Producto_Id, Url, EsPrincipal, Orden)
            VALUES (@productoId, @url, 1, 0)
          `);
            }
            processed += 1;
            updated += 1;
        }
        catch (error) {
            console.error(`[Sync] Error procesando producto codigo="${codigo}"`, error);
            skipped += 1;
        }
    }
    console.log(`[Sync] Finalizado. Procesados=${processed}, Actualizados=${updated}, Omitidos=${skipped}`);
}
syncImages()
    .then(() => {
    console.log('[Sync] Proceso completado correctamente.');
    process.exit(0);
})
    .catch((error) => {
    console.error('[Sync] Error general en la sincronización', error);
    process.exit(1);
});
