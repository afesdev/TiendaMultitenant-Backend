CREATE DATABASE TiendaMultitenant

USE TiendaMultitenant

-- 1. Crear los Roles primero
CREATE TABLE Roles (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    Nombre NVARCHAR(50) NOT NULL,
    Descripcion NVARCHAR(255)
);

-- Insertamos los bùsicos de una vez
INSERT INTO Roles (Nombre, Descripcion) VALUES 
('Administrador', 'Acceso total a la tienda'),
('Vendedor', 'Solo puede registrar ventas y ver clientes'),
('Bodeguero', 'Solo puede gestionar productos y movimientos de inventario');

CREATE TABLE Tiendas (
    Id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    NombreComercial NVARCHAR(255) NOT NULL,
    Slug NVARCHAR(100) NOT NULL UNIQUE,
    EmailContacto NVARCHAR(255) NOT NULL,
    
    -- Usamos NVARCHAR(MAX) para JSON en SQL Server
    -- Se puede agregar un CHECK para validar que el JSON sea correcto
    Configuracion NVARCHAR(MAX) CHECK (ISJSON(Configuracion) > 0), 
    
    Activo BIT DEFAULT 1,
    FechaCreacion DATETIME DEFAULT GETDATE()
);

-- 2. Crear los Usuarios
CREATE TABLE Usuarios (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    Tienda_Id UNIQUEIDENTIFIER NOT NULL,
    Rol_Id INT NOT NULL,
    Nombre NVARCHAR(255) NOT NULL,
    Email NVARCHAR(255) NOT NULL,
    PasswordHash NVARCHAR(MAX) NOT NULL,
    Activo BIT DEFAULT 1,
    UltimoAcceso DATETIME NULL,
    FechaCreacion DATETIME DEFAULT GETDATE(),

    CONSTRAINT FK_Usuarios_Tienda FOREIGN KEY (Tienda_Id) REFERENCES Tiendas(Id),
    CONSTRAINT FK_Usuarios_Rol FOREIGN KEY (Rol_Id) REFERENCES Roles(Id),
    
    -- El mismo email no puede repetirse en la misma TIENDA
    CONSTRAINT UQ_Email_Por_Tienda UNIQUE (Tienda_Id, Email)
);

CREATE TABLE Proveedores (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    Tienda_Id UNIQUEIDENTIFIER NOT NULL,
    Nombre NVARCHAR(255) NOT NULL,
    Contacto NVARCHAR(255),
    Telefono NVARCHAR(20),
    Email NVARCHAR(255),
    Activo BIT DEFAULT 1,

    CONSTRAINT FK_Proveedores_Tienda FOREIGN KEY (Tienda_Id) REFERENCES Tiendas(Id)
);

CREATE TABLE Categorias (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    Tienda_Id UNIQUEIDENTIFIER NOT NULL,
    Nombre NVARCHAR(100) NOT NULL,
    Slug NVARCHAR(150) NOT NULL,
    CategoriaPadre_Id INT NULL,
    Visible BIT DEFAULT 1,
    
    CONSTRAINT FK_Categorias_Tienda FOREIGN KEY (Tienda_Id) REFERENCES Tiendas(Id),
    CONSTRAINT FK_Categorias_Padre FOREIGN KEY (CategoriaPadre_Id) REFERENCES Categorias(Id)
);

CREATE TABLE Productos (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    Tienda_Id UNIQUEIDENTIFIER NOT NULL,
    Nombre NVARCHAR(255) NOT NULL,
    CodigoInterno NVARCHAR(50) NOT NULL,
    CodigoBarras NVARCHAR(100) NULL,
    Proveedor_Id INT NULL,
    Categoria_Id INT NULL,
    Descripcion NVARCHAR(MAX) NULL,
    Costo DECIMAL(18,2) DEFAULT 0.00,
    PrecioDetal DECIMAL(18,2) NOT NULL,
    PrecioMayor DECIMAL(18,2) NULL,
    StockActual INT DEFAULT 0,
    Visible BIT DEFAULT 1,
    FechaCreacion DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    FechaModificacion DATETIME2 NULL,
    CONSTRAINT FK_Productos_Tienda FOREIGN KEY (Tienda_Id) REFERENCES Tiendas(Id),
    CONSTRAINT FK_Productos_Proveedor FOREIGN KEY (Proveedor_Id) REFERENCES Proveedores(Id),
    CONSTRAINT FK_Productos_Categoria FOREIGN KEY (Categoria_Id) REFERENCES Categorias(Id)
);

CREATE TABLE Producto_Imagenes (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    Producto_Id INT NOT NULL,
    Url NVARCHAR(500) NOT NULL,
    EsPrincipal BIT DEFAULT 0,
    Orden INT DEFAULT 0,
    FechaCarga DATETIME DEFAULT GETDATE(),
    CONSTRAINT FK_Imagenes_Producto FOREIGN KEY (Producto_Id) REFERENCES Productos(Id) ON DELETE CASCADE
);

CREATE TABLE Producto_Variaciones (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    Producto_Id INT NOT NULL,
    Atributo NVARCHAR(50) NOT NULL, -- 'Color', 'Talla'
    Valor NVARCHAR(50) NOT NULL,
    PrecioAdicional DECIMAL(18,2) DEFAULT 0.00,
    StockActual INT DEFAULT 0,
    CodigoSKU NVARCHAR(50),
    CONSTRAINT FK_Variaciones_Producto FOREIGN KEY (Producto_Id) REFERENCES Productos(Id) ON DELETE CASCADE
);

CREATE TABLE Repartidores (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    Tienda_Id UNIQUEIDENTIFIER NOT NULL,
    Nombre NVARCHAR(255) NOT NULL,
    Telefono NVARCHAR(20) NOT NULL,
    DocumentoIdentidad NVARCHAR(50),
    Vehiculo NVARCHAR(50), -- Ej: 'Motocicleta', 'Bicicleta'
    Placa NVARCHAR(20),
    Disponible BIT DEFAULT 1,
    Activo BIT DEFAULT 1,
    FechaRegistro DATETIME DEFAULT GETDATE(),

    CONSTRAINT FK_Repartidores_Tienda FOREIGN KEY (Tienda_Id) REFERENCES Tiendas(Id)
);

CREATE TABLE Clientes (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    Tienda_Id UNIQUEIDENTIFIER NOT NULL,
    Cedula NVARCHAR(20) NOT NULL,
    Nombre NVARCHAR(255) NOT NULL,
    Email NVARCHAR(255),
    Celular NVARCHAR(20),
    Direccion NVARCHAR(MAX),
    Ciudad NVARCHAR(100),
    FechaRegistro DATETIME DEFAULT GETDATE(),

    -- Relaciones y Restricciones
    CONSTRAINT FK_Clientes_Tienda FOREIGN KEY (Tienda_Id) REFERENCES Tiendas(Id),
    
    -- Un cliente (por cùdula) solo puede existir una vez por cada tienda
    CONSTRAINT UQ_Cliente_Por_Tienda UNIQUE (Tienda_Id, Cedula)
);

-- 1. Cabecera de Venta
CREATE TABLE Ventas (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    Tienda_Id UNIQUEIDENTIFIER NOT NULL,
    Cliente_Id INT NOT NULL,
    Repartidor_Id INT NULL,
    Fecha DATETIME DEFAULT GETDATE(),
    TipoVenta NVARCHAR(20),
    TipoEntrega NVARCHAR(20),
    MetodoPago NVARCHAR(20),
    Subtotal DECIMAL(18,2) NOT NULL,
    DescuentoTotal DECIMAL(18,2) DEFAULT 0,
    Total DECIMAL(18,2) NOT NULL,
    Observacion NVARCHAR(MAX),

    CONSTRAINT FK_Ventas_Tienda FOREIGN KEY (Tienda_Id) REFERENCES Tiendas(Id),
    CONSTRAINT FK_Ventas_Cliente FOREIGN KEY (Cliente_Id) REFERENCES Clientes(Id),
    CONSTRAINT FK_Ventas_Repartidor FOREIGN KEY (Repartidor_Id) REFERENCES Repartidores(Id)
);

-- 2. Detalle de la Venta
CREATE TABLE Venta_Detalle (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    Venta_Id INT NOT NULL,
    Producto_Id INT NOT NULL,
    Cantidad INT NOT NULL,
    PrecioUnitario DECIMAL(18,2) NOT NULL,
    Variante_Id INT NULL,

    CONSTRAINT FK_Detalle_Venta FOREIGN KEY (Venta_Id) REFERENCES Ventas(Id),
    CONSTRAINT FK_Detalle_Producto FOREIGN KEY (Producto_Id) REFERENCES Productos(Id),
    CONSTRAINT FK_Detalle_Variante FOREIGN KEY (Variante_Id) REFERENCES Producto_Variaciones(Id)
);

-- 1. Cabecera del Apartado
CREATE TABLE Apartados (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    Tienda_Id UNIQUEIDENTIFIER NOT NULL,
    Cliente_Id INT NOT NULL,
    FechaCreacion DATETIME DEFAULT GETDATE(),
    FechaVencimiento DATETIME NOT NULL,
    Total DECIMAL(18,2) NOT NULL,
    Abonado DECIMAL(18,2) DEFAULT 0,
    Saldo AS (Total - Abonado), -- Columna calculada automùticamente
    Estado NVARCHAR(20) DEFAULT 'Pendiente', -- PENDIENTE, COMPLETADO, VENCIDO

    CONSTRAINT FK_Apartados_Tienda FOREIGN KEY (Tienda_Id) REFERENCES Tiendas(Id),
    CONSTRAINT FK_Apartados_Cliente FOREIGN KEY (Cliente_Id) REFERENCES Clientes(Id),
    CONSTRAINT CHK_Fechas_Apartado CHECK (FechaVencimiento > FechaCreacion)
);

-- 2. Detalle de los productos en el Apartado
CREATE TABLE Apartados_Detalle (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    Apartado_Id INT NOT NULL,
    Producto_Id INT NOT NULL,
    Cantidad INT NOT NULL,
    PrecioVenta DECIMAL(18,2) NOT NULL,

    CONSTRAINT FK_Detalle_Apartado FOREIGN KEY (Apartado_Id) REFERENCES Apartados(Id),
    CONSTRAINT FK_Detalle_Apartado_Producto FOREIGN KEY (Producto_Id) REFERENCES Productos(Id)
);

CREATE TABLE Apartado_Pagos (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    Apartado_Id INT NOT NULL,
    FechaPago DATETIME DEFAULT GETDATE(),
    Monto DECIMAL(18,2) NOT NULL,
    MetodoPago NVARCHAR(50) NOT NULL,
    Referencia NVARCHAR(100) NULL, -- Opcional: Nùmero de transferencia
    Notas NVARCHAR(MAX) NULL,

    CONSTRAINT FK_Pagos_Apartado FOREIGN KEY (Apartado_Id) REFERENCES Apartados(Id) ON DELETE CASCADE,
    
    -- El monto de un abono no puede ser cero o negativo
    CONSTRAINT CHK_Monto_Positivo CHECK (Monto > 0)
);

CREATE TABLE Movimientos_Inventario (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    Tienda_Id UNIQUEIDENTIFIER NOT NULL,
    Producto_Id INT NOT NULL,
    Variacion_Id INT NULL, -- Por si el movimiento es de una talla especùfica
    TipoMovimiento NVARCHAR(20), -- 'ENTRADA', 'SALIDA', 'AJUSTE', 'DEVOLUCION'
    Cantidad INT NOT NULL,
    Motivo NVARCHAR(MAX),
    Fecha DATETIME DEFAULT GETDATE(),
    CONSTRAINT FK_Movs_Tienda FOREIGN KEY (Tienda_Id) REFERENCES Tiendas(Id),
    CONSTRAINT FK_Movs_Producto FOREIGN KEY (Producto_Id) REFERENCES Productos(Id)
);

