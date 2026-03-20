-- Agregar columna Estado a Ventas
-- Valores sugeridos: Pendiente, EnProceso, Envio, Completado, Cancelado

USE TiendaMultitenant;
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('Ventas') AND name = 'Estado'
)
BEGIN
    ALTER TABLE Ventas
    ADD Estado NVARCHAR(50) NOT NULL DEFAULT 'Pendiente';
END
GO
