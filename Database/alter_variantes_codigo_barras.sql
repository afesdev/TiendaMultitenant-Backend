-- Agregar CodigoBarras a variantes de producto
-- Ejecutar en la base de datos TiendaMultitenant

USE TiendaMultitenant
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('Producto_Variaciones')
  AND name = 'CodigoBarras'
)
BEGIN
  ALTER TABLE Producto_Variaciones
  ADD CodigoBarras NVARCHAR(100) NULL;
END
GO
