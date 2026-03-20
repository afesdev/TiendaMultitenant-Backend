USE TiendaMultitenant;
GO

-- 1. Tabla de cabecera de promociones
IF OBJECT_ID('Promociones', 'U') IS NULL
BEGIN
    CREATE TABLE Promociones (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        Tienda_Id UNIQUEIDENTIFIER NOT NULL,
        Nombre NVARCHAR(200) NOT NULL,
        Descripcion NVARCHAR(MAX) NULL,

        -- Tipo de descuento: 'PORCENTAJE', 'FIJO'
        TipoDescuento NVARCHAR(20) NOT NULL,

        -- Valor del descuento:
        --  - Si PORCENTAJE -> 10 = 10%
        --  - Si FIJO       -> monto en COP
        ValorDescuento DECIMAL(18,2) NOT NULL,

        -- Cómo se aplica: por ahora 'PRODUCTO' (individual / varios productos)
        TipoAplicacion NVARCHAR(20) NOT NULL DEFAULT 'PRODUCTO',

        -- Opcionales / reglas
        MinCantidad INT NULL,              -- mín. cantidad por producto
        MinTotal DECIMAL(18,2) NULL,       -- mín. total del carrito (si se usa)
        AplicaSobre NVARCHAR(20) NULL,     -- 'DETAL', 'MAYORISTA', 'AMBOS'

        FechaInicio DATETIME NOT NULL,
        FechaFin DATETIME NOT NULL,
        Activo BIT NOT NULL DEFAULT 1,

        CONSTRAINT FK_Promociones_Tienda FOREIGN KEY (Tienda_Id) REFERENCES Tiendas(Id)
    );

    CREATE INDEX IX_Promociones_Tienda_Fecha
        ON Promociones (Tienda_Id, Activo, FechaInicio, FechaFin);
END
GO

-- 2. Tabla de productos asociados a una promoción
IF OBJECT_ID('Promocion_Productos', 'U') IS NULL
BEGIN
    CREATE TABLE Promocion_Productos (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        Promocion_Id INT NOT NULL,
        Producto_Id INT NOT NULL,
        Variante_Id INT NULL, -- opcional: promo solo para una variante específica

        CONSTRAINT FK_PromoProd_Promocion FOREIGN KEY (Promocion_Id) REFERENCES Promociones(Id) ON DELETE CASCADE,
        CONSTRAINT FK_PromoProd_Producto FOREIGN KEY (Producto_Id) REFERENCES Productos(Id),
        CONSTRAINT FK_PromoProd_Variante FOREIGN KEY (Variante_Id) REFERENCES Producto_Variaciones(Id)
    );

    CREATE INDEX IX_PromoProd_Promo ON Promocion_Productos (Promocion_Id);
    CREATE INDEX IX_PromoProd_Producto_Variante ON Promocion_Productos (Producto_Id, Variante_Id);
END
GO

