CREATE PROCEDURE sp_ImportarProductoDesdeExcel
    @Tienda_Id UNIQUEIDENTIFIER,
    @Codigo NVARCHAR(50),
    @Nombre NVARCHAR(255),
    @CategoriaNombre NVARCHAR(100),
    @Talla NVARCHAR(50),
    @Color NVARCHAR(50),
    @Stock INT,
    @Costo DECIMAL(18,2),
    @PrecioDetal DECIMAL(18,2),
    @PrecioMayor DECIMAL(18,2),
    @ProveedorNombre NVARCHAR(255),
    @Visible BIT,
    @Descripcion NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON;
    BEGIN TRANSACTION;

    BEGIN TRY
        DECLARE @Categoria_Id INT;
        DECLARE @Proveedor_Id INT;
        DECLARE @Producto_Id INT;

        -- 1. Gestionar Categoría (La busca o la crea si no existe para esa tienda)
        SELECT @Categoria_Id = Id FROM Categorias WHERE Nombre = @CategoriaNombre AND Tienda_Id = @Tienda_Id;
        IF @Categoria_Id IS NULL AND @CategoriaNombre IS NOT NULL
        BEGIN
            INSERT INTO Categorias (Tienda_Id, Nombre, Slug, Visible) 
            VALUES (@Tienda_Id, @CategoriaNombre, LOWER(REPLACE(@CategoriaNombre, ' ', '-')), 1);
            SET @Categoria_Id = SCOPE_IDENTITY();
        END

        -- 2. Gestionar Proveedor (Lo busca o lo crea)
        SELECT @Proveedor_Id = Id FROM Proveedores WHERE Nombre = @ProveedorNombre AND Tienda_Id = @Tienda_Id;
        IF @Proveedor_Id IS NULL AND @ProveedorNombre IS NOT NULL
        BEGIN
            INSERT INTO Proveedores (Tienda_Id, Nombre, Activo) 
            VALUES (@Tienda_Id, @ProveedorNombre, 1);
            SET @Proveedor_Id = SCOPE_IDENTITY();
        END

        -- 3. Gestionar Producto (Si el código existe lo actualiza, si no, lo crea)
        SELECT @Producto_Id = Id FROM Productos WHERE CodigoInterno = @Codigo AND Tienda_Id = @Tienda_Id;

        IF @Producto_Id IS NULL
        BEGIN
            INSERT INTO Productos (Tienda_Id, Nombre, CodigoInterno, Proveedor_Id, Categoria_Id, Descripcion, Costo, PrecioDetal, PrecioMayor, Visible)
            VALUES (@Tienda_Id, @Nombre, @Codigo, @Proveedor_Id, @Categoria_Id, @Descripcion, @Costo, @PrecioDetal, @PrecioMayor, @Visible);
            SET @Producto_Id = SCOPE_IDENTITY();
        END
        ELSE
        BEGIN
            UPDATE Productos SET 
                Nombre = @Nombre, Costo = @Costo, PrecioDetal = @PrecioDetal, 
                PrecioMayor = @PrecioMayor, Categoria_Id = @Categoria_Id, Proveedor_Id = @Proveedor_Id
            WHERE Id = @Producto_Id;
        END

        -- 4. Gestionar Variaciones (Talla y Color)
        -- Insertamos Talla
        IF @Talla IS NOT NULL
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM Producto_Variaciones WHERE Producto_Id = @Producto_Id AND Atributo = 'Talla' AND Valor = @Talla)
                INSERT INTO Producto_Variaciones (Producto_Id, Atributo, Valor, StockActual) VALUES (@Producto_Id, 'Talla', @Talla, @Stock);
            ELSE
                UPDATE Producto_Variaciones SET StockActual = StockActual + @Stock 
                WHERE Producto_Id = @Producto_Id AND Atributo = 'Talla' AND Valor = @Talla;
        END

        -- Insertamos Color
        IF @Color IS NOT NULL
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM Producto_Variaciones WHERE Producto_Id = @Producto_Id AND Atributo = 'Color' AND Valor = @Color)
                INSERT INTO Producto_Variaciones (Producto_Id, Atributo, Valor, StockActual) VALUES (@Producto_Id, 'Color', @Color, @Stock);
            -- No sumamos stock aquí para no duplicar el conteo si ya se sumó en Talla
        END

        -- 5. Actualizar Stock Total en la tabla principal
        UPDATE Productos 
        SET StockActual = (SELECT SUM(StockActual) FROM Producto_Variaciones WHERE Producto_Id = @Producto_Id AND Atributo = 'Talla')
        WHERE Id = @Producto_Id;

        COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        ROLLBACK TRANSACTION;
        THROW;
    END CATCH
END